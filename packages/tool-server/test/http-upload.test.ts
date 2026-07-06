import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import supertest from "supertest";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHttpApp, type HttpAppHandle } from "../src/http";
import type { Registry } from "@argent/registry";

vi.mock("../src/utils/update-checker", () => ({
  getUpdateState: vi.fn(() => ({ updateInstallable: false, currentVersion: "1.0.0" })),
  isUpdateNoteSuppressed: vi.fn(() => true),
  suppressUpdateNote: vi.fn(),
}));

const execFileAsync = promisify(execFile);

// A registry exposing one tool whose `appPath` is a tar-upload input and which
// echoes back the resolved path, so we can prove the upload round-trips into a
// tool call.
function stubRegistry(): Registry {
  return {
    getSnapshot: vi.fn(() => ({ services: new Map(), namespaces: [], tools: ["install"] })),
    getTool: vi.fn((id: string) =>
      id === "install"
        ? {
            id: "install",
            description: "",
            fileInputs: [{ target: "appPath", path: "${appPath}", kind: "tar-upload" }],
          }
        : undefined
    ),
    invokeTool: vi.fn(async (_name: string, args: Record<string, unknown>) => ({
      received: args.appPath,
    })),
  } as unknown as Registry;
}

let tmpDir: string;
async function tarballOf(name: string, contents: string): Promise<Buffer> {
  await fs.writeFile(path.join(tmpDir, name), contents);
  const tarPath = path.join(tmpDir, "payload.tar.gz");
  await execFileAsync("tar", ["-czf", tarPath, "-C", tmpDir, name]);
  return fs.readFile(tarPath);
}

describe("POST /upload", () => {
  let handle: HttpAppHandle;
  let originalToken: string | undefined;

  beforeEach(async () => {
    originalToken = process.env.ARGENT_AUTH_TOKEN;
    delete process.env.ARGENT_AUTH_TOKEN; // dev mode — auth is covered elsewhere
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "http-upload-test-"));
    handle = createHttpApp(stubRegistry());
  });

  afterEach(async () => {
    handle?.dispose();
    await fs.rm(tmpDir, { recursive: true, force: true });
    if (originalToken === undefined) delete process.env.ARGENT_AUTH_TOKEN;
    else process.env.ARGENT_AUTH_TOKEN = originalToken;
  });

  it("accepts a streamed tarball and returns an uploadId", async () => {
    const body = await tarballOf("MyApp", "app-bytes");
    const res = await supertest(handle.app)
      .post("/upload")
      .set("Content-Type", "application/gzip")
      .send(body);

    expect(res.status).toBe(200);
    expect(typeof res.body.uploadId).toBe("string");
    expect(res.body.uploadId.length).toBeGreaterThan(0);
  });

  it("round-trips: an uploaded bundle is extracted and handed to the tool", async () => {
    const body = await tarballOf("MyApp.app", "app-bytes");
    const contentHash = createHash("sha256").update(body).digest("hex");
    const upload = await supertest(handle.app)
      .post("/upload")
      .set("Content-Type", "application/gzip")
      .send(body);
    const { uploadId } = upload.body;

    const call = await supertest(handle.app)
      .post("/tools/install")
      .send({
        appPath: {
          __argentFileInput: true,
          path: "/client/MyApp.app",
          uploadId,
          contentHash,
        },
      });

    expect(call.status).toBe(200);
    expect(path.basename(call.body.data.received)).toBe("MyApp.app");
  });

  it("rejects an upload larger than the configured limit with 413", async () => {
    handle.dispose();
    handle = createHttpApp(stubRegistry(), { maxUploadBytes: 8 });

    const res = await supertest(handle.app)
      .post("/upload")
      .set("Content-Type", "application/gzip")
      .send(Buffer.alloc(64));

    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/exceeds/i);
  });

  it("rejects new uploads once total pending storage exceeds the cap", async () => {
    handle.dispose();
    const body = await tarballOf("MyApp.app", "app-bytes");
    // Cap sized to exactly one tarball: the first fills it, the second is over.
    handle = createHttpApp(stubRegistry(), { maxPendingUploadBytes: body.length });

    const first = await supertest(handle.app)
      .post("/upload")
      .set("Content-Type", "application/gzip")
      .send(body);
    expect(first.status).toBe(200);

    const second = await supertest(handle.app)
      .post("/upload")
      .set("Content-Type", "application/gzip")
      .send(body);
    expect(second.status).toBe(507);
    expect(second.body.error).toMatch(/pending uploads/i);
  });

  it("removes pending upload tars and stops the sweeper on dispose", async () => {
    const body = await tarballOf("MyApp.app", "app-bytes");
    const res = await supertest(handle.app)
      .post("/upload")
      .set("Content-Type", "application/gzip")
      .send(body);
    const tarFile = path.join(os.tmpdir(), `argent-upload-${res.body.uploadId}.tar.gz`);
    expect(await fs.stat(tarFile)).toBeTruthy();

    handle.dispose();

    await vi.waitFor(async () => {
      await expect(fs.stat(tarFile)).rejects.toThrow();
    });
  });

  it("discards the partial file when the client disconnects mid-upload", async () => {
    const uploadFiles = async (): Promise<Set<string>> => {
      const entries = await fs.readdir(os.tmpdir());
      return new Set(entries.filter((e) => e.startsWith("argent-upload-")));
    };
    const before = await uploadFiles();

    const server = handle.app.listen(0);
    try {
      const { port } = server.address() as { port: number };
      await new Promise<void>((resolve) => {
        const req = http.request({
          port,
          path: "/upload",
          method: "POST",
          headers: { "Content-Type": "application/gzip", "Content-Length": 1024 },
        });
        req.on("error", () => {});
        req.write(Buffer.alloc(16)); // less than Content-Length, then vanish
        setTimeout(() => {
          req.destroy();
          resolve();
        }, 50);
      });

      // Cleanup is async — poll briefly for the partial file to disappear.
      await vi.waitFor(async () => {
        const after = await uploadFiles();
        const leaked = [...after].filter((f) => !before.has(f));
        expect(leaked).toEqual([]);
      });
    } finally {
      server.close();
    }
  });
});
