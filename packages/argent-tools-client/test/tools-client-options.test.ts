import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redirectHomeTo } from "./helpers/home-redirect.js";

// link-config.ts captures ~/.argent/link.json at module load; an isolated HOME
// keeps a developer's real link out of the "never spawns" case.
let createToolsClient: typeof import("../src/tools-client.js").createToolsClient;
let TEST_HOME: string;
let restoreHome: () => void;

beforeAll(async () => {
  TEST_HOME = mkdtempSync(join(tmpdir(), "argent-tools-client-options-test-"));
  restoreHome = redirectHomeTo(TEST_HOME);
  vi.resetModules();
  ({ createToolsClient } = await import("../src/tools-client.js"));
});

afterAll(() => {
  restoreHome();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

let server: Server;
let url: string;
let requests: Array<{ method: string; url: string }>;

function readBody(req: IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    req.on("data", () => {});
    req.on("end", () => resolve());
  });
}

beforeEach(async () => {
  requests = [];
  server = createServer(async (req, res) => {
    await readBody(req);
    requests.push({ method: req.method ?? "", url: req.url ?? "" });
    const json = (payload: unknown, contentType = "application/json") => {
      res.writeHead(200, { "Content-Type": contentType });
      res.end(JSON.stringify(payload));
    };
    if (req.method === "GET" && req.url === "/tools") {
      return json({
        tools: [
          {
            name: "slow",
            description: "",
            inputSchema: {},
            longRunning: true,
            outputHint: "image",
          },
          {
            name: "reinstall-app",
            description: "",
            inputSchema: {},
            fileInputs: [{ target: "appPath", path: "${appPath}", kind: "tar-upload" }],
          },
        ],
      });
    }
    if (req.method === "POST" && req.url === "/upload") return json({ uploadId: "u-1" });
    if (req.method === "POST" && req.url === "/tools/slow") {
      if (req.headers.accept?.includes("application/x-ndjson")) {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.end(`${JSON.stringify({ event: "result", data: { ok: true } })}\n`);
        return;
      }
      return json({ data: { ok: true } });
    }
    if (req.method === "POST" && req.url === "/tools/reinstall-app") {
      return json({ data: { reinstalled: true } });
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("createToolsClient options", () => {
  it("uses the baseUrl override and never spawns", async () => {
    const withOverride = createToolsClient({ baseUrl: async () => ({ url, token: "t" }) });
    const tools = await withOverride.fetchTools();
    expect(tools.map((t) => t.name)).toEqual(["slow", "reinstall-app"]);

    const withoutOverride = createToolsClient();
    await expect(withoutOverride.fetchTools()).rejects.toThrow(
      /cannot spawn tool-server without `paths`/
    );
  });

  it("routes GET /tools and POST /tools/:name through fetchImpl with the tool's longRunning flag", async () => {
    const fetchImpl = vi.fn((u: string, init: RequestInit) => fetch(u, init));
    const { callTool } = createToolsClient({
      baseUrl: async () => ({ url, token: "t" }),
      fetchImpl,
    });

    await callTool("slow", {});

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(1, `${url}/tools`, expect.any(Object), {
      longRunning: false,
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      `${url}/tools/slow`,
      expect.objectContaining({ method: "POST" }),
      { longRunning: true }
    );
  });

  it("does not route POST /upload through fetchImpl", async () => {
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    const appPath = join(TEST_HOME, "MyApp.app");
    mkdirSync(appPath, { recursive: true });
    writeFileSync(join(appPath, "Info.plist"), "<plist/>");
    const fetchImpl = vi.fn((u: string, init: RequestInit) => fetch(u, init));
    const { callTool } = createToolsClient({
      baseUrl: async () => ({ url, token: "t" }),
      fetchImpl,
    });

    await callTool("reinstall-app", { appPath });

    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual([
      `${url}/tools`,
      `${url}/tools/reinstall-app`,
    ]);
    expect(requests.filter((r) => r.url === "/upload")).toHaveLength(1);
  });

  it("returns outputHint from the listing on the buffered and the streamed path", async () => {
    const { callTool } = createToolsClient({ baseUrl: async () => ({ url, token: "t" }) });

    const buffered = await callTool("slow", {});
    const streamed = await callTool("slow", {}, { onProgress: () => {} });

    expect(buffered.outputHint).toBe("image");
    expect(streamed).toEqual({ data: { ok: true }, outputHint: "image" });
  });
});
