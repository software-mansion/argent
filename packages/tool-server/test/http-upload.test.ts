import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import supertest from "supertest";
import * as fs from "node:fs/promises";
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
    const upload = await supertest(handle.app)
      .post("/upload")
      .set("Content-Type", "application/gzip")
      .send(body);
    const { uploadId } = upload.body;

    const call = await supertest(handle.app)
      .post("/tools/install")
      .send({ appPath: { __argentFileInput: true, path: "/client/MyApp.app", uploadId } });

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
});
