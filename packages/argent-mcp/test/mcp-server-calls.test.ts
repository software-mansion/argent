import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ToolsServerPaths } from "@argent/tools-client";

// Drives the real adapter (`startMcpServer`) over the SDK's in-memory transport
// against a stub tool-server, so the adapter's own call handling is exercised:
// the listing, a tool call that must upload, an error answer and the note.
//
// HOME is redirected before the import: the tools client builds its state and
// link paths from homedir() at module load, and the local cases write their
// state file there. The telemetry notice and the flags read HOME on each call,
// so the redirect covers them as well.
let startMcpServer: typeof import("../src/mcp-server.js").startMcpServer;
let toolsClient: typeof import("@argent/tools-client");
let TEST_HOME: string;
const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

beforeAll(async () => {
  TEST_HOME = mkdtempSync(join(tmpdir(), "argent-mcp-server-calls-test-"));
  process.env.HOME = TEST_HOME;
  process.env.USERPROFILE = TEST_HOME;
  vi.resetModules();
  ({ startMcpServer } = await import("../src/mcp-server.js"));
  toolsClient = await import("@argent/tools-client");
});

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(TEST_HOME, { recursive: true, force: true });
});

interface Recorded {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface Stub {
  url: string;
  port: number;
  requests: Recorded[];
  close: () => Promise<void>;
}

const LISTING = {
  tools: [
    {
      name: "reinstall-app",
      description: "Reinstall",
      inputSchema: { type: "object", properties: {} },
      fileInputs: [{ target: "appPath", path: "${appPath}", kind: "tar-upload" }],
    },
    { name: "reject", description: "Reject", inputSchema: { type: "object", properties: {} } },
    { name: "noted", description: "Noted", inputSchema: { type: "object", properties: {} } },
    { name: "e2e-execute", description: "Run", inputSchema: { type: "object", properties: {} } },
    // A former id, as the tool-server lists it.
    {
      name: "flow-execute",
      description: "Run",
      inputSchema: { type: "object", properties: {} },
      hideFromMcp: true,
      aliasOf: "e2e-execute",
    },
  ],
};

const RUN_REPORT = {
  ok: true,
  flow: "demo",
  device: "",
  passed: 1,
  failed: 0,
  skipped: 0,
  errored: 0,
  steps: [{ index: 0, kind: "echo", status: "pass", message: "hi" }],
  startedAt: 0,
  durationMs: 1,
};

type Route = (res: http.ServerResponse) => void | Promise<void>;

/**
 * A stub tool-server. With `token`, a request without that bearer token gets
 * 401. `routes` answers extra paths and `listing` replaces the tool list.
 */
async function startStub({
  token,
  routes = {},
  listing = LISTING,
}: { token?: string; routes?: Record<string, Route>; listing?: unknown } = {}): Promise<Stub> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const reqUrl = req.url ?? "";
      requests.push({ method: req.method ?? "", url: reqUrl, headers: req.headers, body });
      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (token !== undefined && req.headers.authorization !== `Bearer ${token}`) {
        return json(401, { error: "unauthorized" });
      }
      const route = routes[reqUrl];
      if (route) return void route(res);
      if (req.method === "GET" && reqUrl === "/tools") return json(200, listing);
      if (req.method === "POST" && reqUrl === "/upload") return json(200, { uploadId: "u-1" });
      if (req.method === "POST" && reqUrl === "/tools/reinstall-app") {
        return json(200, { data: { reinstalled: true, bundleId: "x" } });
      }
      if (req.method === "POST" && reqUrl === "/tools/reject") return json(422, { error: "nope" });
      if (
        req.method === "POST" &&
        (reqUrl === "/tools/e2e-execute" || reqUrl === "/tools/flow-execute")
      ) {
        return json(200, { data: RUN_REPORT });
      }
      if (req.method === "POST" && reqUrl === "/tools/noted") {
        return json(200, { data: { ok: true }, note: "a note" });
      }
      json(404, { error: "not found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function connect(paths: ToolsServerPaths): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await startMcpServer({ paths, transport: serverTransport });
  const client = new Client({ name: "probe", version: "1" });
  await client.connect(clientTransport);
  return client;
}

function makeApp(): string {
  const appPath = join(TEST_HOME, `MyApp-${randomUUID()}.app`);
  mkdirSync(appPath);
  writeFileSync(join(appPath, "Info.plist"), "<plist/>");
  return appPath;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

describe("startMcpServer tool calls", () => {
  let stub: Stub;
  let requests: Recorded[];
  let client: Client;
  let appPath: string;

  beforeEach(async () => {
    stub = await startStub();
    requests = stub.requests;
    // Remote-routed, so the adapter neither spawns a tool-server nor starts the
    // local health check, and the tools client uploads file inputs.
    vi.stubEnv("ARGENT_TOOLS_URL", stub.url);
    vi.stubEnv("ARGENT_MCP_LOG", join(TEST_HOME, "mcp-calls.log"));
    appPath = makeApp();
    // A bundle that does not exist: a local spawn fails at once instead of
    // starting a real tool-server.
    client = await connect({
      bundlePath: join(TEST_HOME, "missing", "tool-server.cjs"),
      simulatorServerDir: "",
      nativeDevtoolsDir: "",
    });
  });

  afterEach(async () => {
    await client.close();
    vi.unstubAllEnvs();
    await stub.close();
  });

  it("lists the tools of the tool-server", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["reinstall-app", "reject", "noted", "e2e-execute"]);
  });

  it("renders a run report the same whether called as flow-execute or e2e-execute", async () => {
    const byAlias = await client.callTool({ name: "flow-execute", arguments: {} });
    const byId = await client.callTool({ name: "e2e-execute", arguments: {} });

    expect(byAlias.isError).toBeFalsy();
    expect(textOf(byAlias)).toContain('Running e2e test "demo"');
    expect(textOf(byAlias)).not.toContain('"steps"');
    expect(byAlias.content).toEqual(byId.content);
  });

  it("uploads a tar-upload input and returns the tool result", async () => {
    const result = await client.callTool({
      name: "reinstall-app",
      arguments: { udid: "u", bundleId: "x", appPath },
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('"reinstalled": true');
    expect(requests.filter((r) => r.url === "/upload")).toHaveLength(1);
    const posts = requests.filter((r) => r.url === "/tools/reinstall-app");
    expect(posts).toHaveLength(1);
    const sent = JSON.parse(posts[0]!.body) as { appPath: Record<string, unknown> };
    expect(sent.appPath.__argentFileInput).toBe(true);
    expect(sent.appPath.uploadId).toBe("u-1");
    expect(posts[0]!.headers["x-argent-ai-client"]).toBe("other");
  });

  it("keeps uploading after the link is removed mid-session", async () => {
    vi.stubEnv("ARGENT_TOOLS_URL", "");

    const result = await client.callTool({
      name: "reinstall-app",
      arguments: { udid: "u", bundleId: "x", appPath },
    });

    expect(result.isError).toBeFalsy();
    expect(requests.filter((r) => r.url === "/upload")).toHaveLength(1);
  });

  it("does not start a local tool-server when the link is removed and its tool-server stops", async () => {
    vi.stubEnv("ARGENT_TOOLS_URL", "");
    await stub.close();

    const result = await client.callTool({ name: "noted", arguments: {} });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("fetch failed");
    expect(textOf(result)).not.toContain("gone from disk");
  });

  it("returns the tool-server's error text as an error result", async () => {
    const result = await client.callTool({ name: "reject", arguments: {} });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("nope");
    expect(requests.filter((r) => r.url === "/tools/reject")).toHaveLength(1);
  });

  it("puts the tool-server's note before the result", async () => {
    const result = await client.callTool({ name: "noted", arguments: {} });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]).toEqual({ type: "text", text: "a note" });
    expect(textOf(result)).toContain('"ok": true');
  });
});

describe("startMcpServer screen capture after an interaction", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const CAPTURE_LISTING = {
    tools: ["gesture-tap", "await-screen-idle", "screenshot", "describe"].map((name) => ({
      name,
      description: name,
      inputSchema: { type: "object", properties: {} },
    })),
  };
  let stub: Stub;
  let client: Client;
  let events: string[];
  let settled: boolean;
  let idleStatus: number;
  let screenshotStatus: number;

  const send = (res: http.ServerResponse, status: number, payload: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  const slow =
    (name: string, answer: (res: http.ServerResponse) => void): Route =>
    async (res) => {
      events.push(`${name} start`);
      await new Promise((r) => setTimeout(r, 100));
      events.push(`${name} end`);
      answer(res);
    };

  beforeEach(async () => {
    events = [];
    settled = true;
    idleStatus = 200;
    screenshotStatus = 200;
    stub = await startStub({
      routes: {
        "/tools/gesture-tap": (res) => send(res, 200, { data: { tapped: true } }),
        "/tools/await-screen-idle": (res) =>
          idleStatus === 200
            ? send(res, 200, { data: { settled, waitedMs: 1, polls: 1 } })
            : send(res, idleStatus, { error: "await-screen-idle is not supported" }),
        "/tools/screenshot": slow("screenshot", (res) =>
          screenshotStatus === 200
            ? send(res, 200, { data: { url: `${stub.url}/shot.png`, path: "/tmp/shot.png" } })
            : send(res, screenshotStatus, { error: "screenshot failed" })
        ),
        "/tools/describe": slow("describe", (res) =>
          send(res, 200, { data: { description: "button Done (0.1,0.2,0.3,0.1)" } })
        ),
        "/shot.png": (res) => {
          res.writeHead(200, { "Content-Type": "image/png" });
          res.end(PNG);
        },
      },
      listing: CAPTURE_LISTING,
    });
    vi.stubEnv("ARGENT_TOOLS_URL", stub.url);
    vi.stubEnv("ARGENT_MCP_LOG", join(TEST_HOME, "mcp-calls.log"));
    client = await connect({
      bundlePath: join(TEST_HOME, "missing", "tool-server.cjs"),
      simulatorServerDir: "",
      nativeDevtoolsDir: "",
    });
  });

  afterEach(async () => {
    await client.close();
    vi.unstubAllEnvs();
    await stub.close();
  });

  const tap = () =>
    client.callTool({ name: "gesture-tap", arguments: { udid: "u", x: 0.5, y: 0.5 } });

  it("appends the screenshot, then the element tree, after the tool result", async () => {
    const result = await tap();

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content.map((c) => (c.type === "image" ? "image" : c.text!.split("\n")[0]))).toEqual([
      "{",
      "--- Screen after action ---",
      "image",
      "Saved: /tmp/shot.png",
      "--- Elements after action (describe) ---",
    ]);
    expect(content[0]!.text).toContain('"tapped": true');
    expect(content.at(-1)!.text).toContain("button Done");
  });

  it("captures the screenshot and the tree at the same time once the screen settled", async () => {
    await tap();

    expect(events.slice(0, 2).sort()).toEqual(["describe start", "screenshot start"]);
  });

  it("captures the tree after the screenshot when the screen did not settle", async () => {
    settled = false;

    await tap();

    expect(events).toEqual([
      "screenshot start",
      "screenshot end",
      "describe start",
      "describe end",
    ]);
  });

  it("captures the tree after the screenshot when the settle wait fails", async () => {
    idleStatus = 400;

    await tap();

    expect(events).toEqual([
      "screenshot start",
      "screenshot end",
      "describe start",
      "describe end",
    ]);
  });

  it("keeps the tool result and the tree when the screenshot fails", async () => {
    screenshotStatus = 500;

    const result = await tap();

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain('"tapped": true');
    expect(text).not.toContain("--- Screen after action ---");
    expect(text).toContain("--- Elements after action (describe) ---");
  });
});

describe("startMcpServer with a local tool-server", () => {
  // No link and no ARGENT_TOOLS_URL: the adapter finds its tool-server through
  // the state file of its bundle, as an editor session does. The record names
  // this process's pid with `managed: "cli"`, so the launcher reuses it and
  // never signals it. The bundle does not exist, so the launcher cannot spawn.
  const paths: ToolsServerPaths = {
    bundlePath: "",
    simulatorServerDir: "",
    nativeDevtoolsDir: "",
  };
  let stubs: Stub[];
  let client: Client;

  async function startRecordedStub(token: string): Promise<Stub> {
    const stub = await startStub({ token });
    stubs.push(stub);
    await toolsClient.writeToolsServerState({
      port: stub.port,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      bundlePath: paths.bundlePath,
      host: "127.0.0.1",
      token,
      managed: "cli",
    });
    return stub;
  }

  const postsTo = (stub: Stub, path: string) =>
    stub.requests.filter((r) => r.method === "POST" && r.url === path);

  beforeEach(async () => {
    stubs = [];
    paths.bundlePath = join(TEST_HOME, `missing-${randomUUID()}`, "tool-server.cjs");
    vi.stubEnv("ARGENT_TOOLS_URL", "");
    vi.stubEnv("ARGENT_MCP_LOG", join(TEST_HOME, "mcp-calls.log"));
  });

  afterEach(async () => {
    await client.close();
    vi.unstubAllEnvs();
    await toolsClient.clearToolsServerState(paths.bundlePath);
    for (const stub of stubs) await stub.close();
  });

  it("sends the token of the local tool-server", async () => {
    const first = await startRecordedStub("tok-1");
    client = await connect(paths);

    const result = await client.callTool({ name: "noted", arguments: {} });

    expect(result.isError).toBeFalsy();
    const calls = postsTo(first, "/tools/noted");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.authorization).toBe("Bearer tok-1");
  });

  it("keeps reading file inputs in place after a link is added mid-session", async () => {
    const first = await startRecordedStub("tok-1");
    client = await connect(paths);
    vi.stubEnv("ARGENT_TOOLS_URL", first.url);
    const appPath = makeApp();

    const result = await client.callTool({
      name: "reinstall-app",
      arguments: { udid: "u", bundleId: "x", appPath },
    });

    expect(result.isError).toBeFalsy();
    expect(postsTo(first, "/upload")).toHaveLength(0);
    const sent = JSON.parse(postsTo(first, "/tools/reinstall-app")[0]!.body) as {
      appPath: Record<string, unknown>;
    };
    expect(sent.appPath.path).toBe(appPath);
    expect(sent.appPath).not.toHaveProperty("uploadId");
  });

  it("sends a call to the tool-server that replaced a dead one, with its new token", async () => {
    const first = await startRecordedStub("tok-1");
    client = await connect(paths);
    // The local tool-server dies and a new one takes its place on another port.
    const second = await startRecordedStub("tok-2");
    await first.close();

    const result = await client.callTool({ name: "noted", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('"ok": true');
    const calls = postsTo(second, "/tools/noted");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.authorization).toBe("Bearer tok-2");
  });
});
