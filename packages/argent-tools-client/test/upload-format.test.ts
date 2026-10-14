import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createToolsClient } from "../src/tools-client.js";

let server: Server | undefined;
let tmpDir: string;

interface Upload {
  contentType: string | undefined;
  magic: string;
}

/**
 * Stub remote tool-server advertising one tar-upload tool. `uploadFormats` is
 * what its `GET /tools` lists; undefined plays a server that predates it.
 */
async function startServer(uploadFormats: string[] | undefined): Promise<Upload[]> {
  const uploads: Upload[] = [];
  server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET" && req.url === "/tools") {
      const tools = [
        {
          name: "install",
          description: "",
          inputSchema: {},
          fileInputs: [{ target: "appPath", path: "${appPath}", kind: "tar-upload" }],
        },
      ];
      res.end(JSON.stringify(uploadFormats ? { tools, uploadFormats } : { tools }));
      return;
    }
    if (req.method === "POST" && req.url === "/upload") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        uploads.push({
          contentType: req.headers["content-type"],
          magic: body.subarray(0, 4).toString("hex"),
        });
        res.end(JSON.stringify({ uploadId: "u1" }));
      });
      return;
    }
    res.end(JSON.stringify({ data: { ok: true } }));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server!.address() as AddressInfo;
  vi.stubEnv("ARGENT_TOOLS_URL", `http://127.0.0.1:${port}`);
  return uploads;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "upload-format-"));
  await fs.mkdir(path.join(tmpDir, "MyApp.app"));
  await fs.writeFile(path.join(tmpDir, "MyApp.app", "Info.plist"), "<plist/>");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("callTool tar-upload format", () => {
  it("uploads zstd to a server that lists it", async () => {
    const uploads = await startServer(["zstd", "gzip"]);
    await createToolsClient().callTool("install", { appPath: path.join(tmpDir, "MyApp.app") });
    expect(uploads).toEqual([{ contentType: "application/zstd", magic: "28b52ffd" }]);
  });

  it("uploads gzip to a server that lists no formats", async () => {
    const uploads = await startServer(undefined);
    await createToolsClient().callTool("install", { appPath: path.join(tmpDir, "MyApp.app") });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.contentType).toBe("application/gzip");
    expect(uploads[0]!.magic.startsWith("1f8b")).toBe(true);
  });
});
