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
let requests: Array<{
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}>;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

beforeEach(async () => {
  requests = [];
  server = createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
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
          {
            name: "run-flow",
            description: "",
            inputSchema: {},
            fileInputs: [{ target: "flow_path", path: "${flow_path}", kind: "file" }],
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
    if (req.method === "POST" && req.url === "/tools/run-flow") return json({ data: { ok: true } });
    if (req.method === "POST" && req.url === "/tools/proxy-page") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>Sign in</html>");
      return;
    }
    if (req.method === "POST" && req.url === "/tools/cut-answer") {
      // The headers promise more than arrives before the connection drops.
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "5000" });
      res.write('{"data":{"reinst');
      setTimeout(() => res.socket?.destroy(), 20);
      return;
    }
    if (req.method === "POST" && req.url === "/tools/gateway-page") {
      res.writeHead(502, { "Content-Type": "text/html" });
      res.end("<html>Bad gateway</html>");
      return;
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
    const withOverride = createToolsClient({
      baseUrl: async () => ({ url, token: "t", remote: false }),
    });
    const tools = await withOverride.fetchTools();
    expect(tools.map((t) => t.name)).toEqual(["slow", "reinstall-app", "run-flow"]);

    const withoutOverride = createToolsClient();
    await expect(withoutOverride.fetchTools()).rejects.toThrow(
      /cannot spawn tool-server without `paths`/
    );
  });

  it("routes GET /tools and POST /tools/:name through fetchImpl with the tool's longRunning flag", async () => {
    const fetchImpl = vi.fn((u: string, init: RequestInit) => fetch(u, init));
    const { callTool } = createToolsClient({
      baseUrl: async () => ({ url, token: "t", remote: false }),
      fetchImpl,
    });

    await callTool("slow", {});

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(1, `${url}/tools`, expect.any(Object), {
      longRunning: false,
      carriesUpload: false,
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      `${url}/tools/slow`,
      expect.objectContaining({ method: "POST" }),
      { longRunning: true, carriesUpload: false }
    );
  });

  it("does not route POST /upload through fetchImpl", async () => {
    const appPath = join(TEST_HOME, "MyApp.app");
    mkdirSync(appPath, { recursive: true });
    writeFileSync(join(appPath, "Info.plist"), "<plist/>");
    const fetchImpl = vi.fn((u: string, init: RequestInit) => fetch(u, init));
    const { callTool } = createToolsClient({
      baseUrl: async () => ({ url, token: "t", remote: true }),
      fetchImpl,
    });

    await callTool("reinstall-app", { appPath });

    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual([
      `${url}/tools`,
      `${url}/tools/reinstall-app`,
    ]);
    expect(requests.filter((r) => r.url === "/upload")).toHaveLength(1);
    // The tool call names the upload, which the tool-server consumes once.
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      `${url}/tools/reinstall-app`,
      expect.objectContaining({ method: "POST" }),
      { longRunning: false, carriesUpload: true }
    );
  });

  it("takes the file-input mode from the baseUrl override, not from the link config", async () => {
    const appPath = join(TEST_HOME, "MyApp.app");
    mkdirSync(appPath, { recursive: true });
    writeFileSync(join(appPath, "Info.plist"), "<plist/>");

    vi.stubEnv("ARGENT_TOOLS_URL", url);
    const local = createToolsClient({ baseUrl: async () => ({ url, token: "t", remote: false }) });
    await local.callTool("reinstall-app", { appPath });
    expect(requests.filter((r) => r.url === "/upload")).toHaveLength(0);

    vi.stubEnv("ARGENT_TOOLS_URL", "");
    const routed = createToolsClient({ baseUrl: async () => ({ url, token: "t", remote: true }) });
    await routed.callTool("reinstall-app", { appPath });
    expect(requests.filter((r) => r.url === "/upload")).toHaveLength(1);
  });

  it("inlines a file input's content only when the override says remote", async () => {
    const flowPath = join(TEST_HOME, "login.yaml");
    writeFileSync(flowPath, "steps: []\n");

    for (const remote of [true, false]) {
      const { callTool } = createToolsClient({
        baseUrl: async () => ({ url, token: "t", remote }),
      });
      await callTool("run-flow", { flow_path: flowPath });
    }

    const [routed, local] = requests
      .filter((r) => r.url === "/tools/run-flow")
      .map((r) => (JSON.parse(r.body) as { flow_path: Record<string, unknown> }).flow_path);
    expect(Buffer.from(routed!.content as string, "base64").toString("utf8")).toBe("steps: []\n");
    expect(local).toMatchObject({ __argentFileInput: true, path: flowPath });
    expect(local).not.toHaveProperty("content");
  });

  it("rejects a 2xx answer whose body cannot be read", async () => {
    const { callTool } = createToolsClient({
      baseUrl: async () => ({ url, token: "t", remote: false }),
    });

    await expect(callTool("proxy-page", {})).rejects.toThrow(
      /^The tool-server answered 200 OK to proxy-page, but the answer could not be read \(.+\)\. The tool may have run;/
    );
    await expect(callTool("cut-answer", {})).rejects.toThrow(
      /^The tool-server answered 200 OK to cut-answer, but the answer could not be read/
    );
  });

  it("names the status of an error answer whose body is not JSON", async () => {
    const { callTool } = createToolsClient({
      baseUrl: async () => ({ url, token: "t", remote: false }),
    });

    await expect(callTool("gateway-page", {})).rejects.toThrow(/^502 Bad Gateway$/);
  });

  it("marks each POST /tools/:name of a call over a link as linked, and nothing else", async () => {
    // A link to 127.0.0.1 included: only the header tells the tool-server.
    const overLink = createToolsClient({
      baseUrl: async () => ({ url, token: "t", remote: true }),
    });
    await overLink.callTool("slow", {});
    await overLink.callTool("slow", {}, { onProgress: () => {} });
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    await createToolsClient().callTool("slow", {});
    vi.stubEnv("ARGENT_TOOLS_URL", "");
    const local = createToolsClient({ baseUrl: async () => ({ url, token: "t", remote: false }) });
    await local.callTool("slow", {});

    expect(requests.map((r) => [r.method, r.url, r.headers["x-argent-linked"] ?? null])).toEqual([
      ["GET", "/tools", null],
      ["POST", "/tools/slow", "1"],
      ["GET", "/tools", null],
      ["POST", "/tools/slow", "1"],
      ["GET", "/tools", null],
      ["POST", "/tools/slow", "1"],
      ["GET", "/tools", null],
      ["POST", "/tools/slow", null],
    ]);
    // The call carries no client_services: the header does not depend on them.
    expect(requests.filter((r) => r.method === "POST").map((r) => JSON.parse(r.body))).toEqual([
      {},
      {},
      {},
      {},
    ]);
  });

  it("returns outputHint from the listing on the buffered and the streamed path", async () => {
    const { callTool } = createToolsClient({
      baseUrl: async () => ({ url, token: "t", remote: false }),
    });

    const buffered = await callTool("slow", {});
    const streamed = await callTool("slow", {}, { onProgress: () => {} });

    expect(buffered.outputHint).toBe("image");
    expect(streamed).toEqual({ data: { ok: true }, outputHint: "image" });
  });
});
