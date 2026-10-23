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
import { setFlag } from "@argent/configuration-core";

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
  /** When the request arrived and when its answer was sent (ms since epoch). */
  at: number;
  doneAt?: number;
}

/** Knobs for the stub's gesture-tap and describe routes; reset after each case. */
const stubBehavior = {
  tapDelayMs: 0,
  describeDelayMs: 0,
  describeFails: false,
  describeNote: undefined as string | undefined,
};

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

/** A stub tool-server. With `token`, a request without that bearer token gets 401. */
async function startStub(token?: string): Promise<Stub> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const reqUrl = req.url ?? "";
      const record: Recorded = {
        method: req.method ?? "",
        url: reqUrl,
        headers: req.headers,
        body,
        at: Date.now(),
      };
      requests.push(record);
      const json = (status: number, payload: unknown) => {
        record.doneAt = Date.now();
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const later = (ms: number, fn: () => void) => (ms > 0 ? setTimeout(fn, ms) : fn());
      if (token !== undefined && req.headers.authorization !== `Bearer ${token}`) {
        return json(401, { error: "unauthorized" });
      }
      if (req.method === "GET" && reqUrl === "/tools") return json(200, LISTING);
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
      if (req.method === "POST" && reqUrl === "/tools/gesture-tap") {
        return later(stubBehavior.tapDelayMs, () => json(200, { data: { tapped: true } }));
      }
      if (req.method === "POST" && reqUrl === "/tools/await-screen-idle") {
        return json(200, { data: { settled: true } });
      }
      if (req.method === "POST" && reqUrl === "/tools/describe") {
        return later(stubBehavior.describeDelayMs, () =>
          stubBehavior.describeFails
            ? json(500, { error: "boom" })
            : json(200, {
                data: { description: "ROOT AXGroup" },
                ...(stubBehavior.describeNote ? { note: stubBehavior.describeNote } : {}),
              })
        );
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

describe("startMcpServer warming the screen reader", () => {
  const SIM = "A1B2C3D4-0000-4000-8000-000000000001";
  const SIM2 = "A1B2C3D4-0000-4000-8000-000000000002";
  let stub: Stub;
  let client: Client | undefined;

  const tap = (udid: string, extra: Record<string, unknown> = {}) =>
    client!.callTool({ name: "gesture-tap", arguments: { udid, x: 0.5, y: 0.5, ...extra } });
  const describeRequests = () => stub.requests.filter((r) => r.url === "/tools/describe");
  const describes = () => describeRequests().length;
  const settle = () => new Promise((r) => setTimeout(r, 100));

  async function start(flags: { autoDescribe: boolean }): Promise<void> {
    // Off: the screenshot is not under test, and the stub has no screenshot route.
    setFlag("disable-auto-screenshot", true, "global", { homeDir: TEST_HOME });
    setFlag("disable-auto-describe", !flags.autoDescribe, "global", { homeDir: TEST_HOME });
    client = await connect({
      bundlePath: join(TEST_HOME, "missing", "tool-server.cjs"),
      simulatorServerDir: "",
      nativeDevtoolsDir: "",
    });
  }

  beforeEach(async () => {
    stub = await startStub();
    vi.stubEnv("ARGENT_TOOLS_URL", stub.url);
    vi.stubEnv("ARGENT_MCP_LOG", join(TEST_HOME, "mcp-calls.log"));
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
    Object.assign(stubBehavior, {
      tapDelayMs: 0,
      describeDelayMs: 0,
      describeFails: false,
      describeNote: undefined,
    });
    setFlag("disable-auto-screenshot", false, "global", { homeDir: TEST_HOME });
    setFlag("disable-auto-describe", false, "global", { homeDir: TEST_HOME });
    vi.unstubAllEnvs();
    await stub.close();
  });

  it("reads the screen in the background on a simulator's first action only", async () => {
    await start({ autoDescribe: true });

    const first = await tap(SIM);
    expect(textOf(first)).toContain("ROOT AXGroup");
    // The background read plus the element tree attached to the result.
    await vi.waitFor(() => expect(describes()).toBe(2));

    await tap(SIM);
    expect(describes()).toBe(3);

    await tap(SIM2);
    await vi.waitFor(() => expect(describes()).toBe(5));
  });

  it("sends the read to the tapped device, alongside the action", async () => {
    stubBehavior.tapDelayMs = 300;
    stubBehavior.describeDelayMs = 300;
    await start({ autoDescribe: true });

    await tap(SIM);

    const tapReq = stub.requests.find((r) => r.url === "/tools/gesture-tap")!;
    const warm = describeRequests()[0]!;
    expect(JSON.parse(warm.body)).toMatchObject({ udid: SIM });
    // Overlapping, neither awaited before the other started.
    expect(warm.at).toBeLessThan(tapReq.doneAt!);
    expect(tapReq.at).toBeLessThan(warm.doneAt!);
  });

  it.each([
    ["an Android emulator", "emulator-5554"],
    ["a physical Android phone", "R58M123ABC"],
    ["a physical iPhone", "00008110-000978540290401E"],
    ["a Vega device", "amazon-abc123"],
    ["a Chromium app", "chromium-cdp-9222"],
  ])("does not warm %s", async (_label, udid) => {
    await start({ autoDescribe: true });

    await tap(udid);
    await settle();

    // Only the element tree attached to the result.
    expect(describes()).toBe(1);
  });

  it("does not warm on a tool that gets no element tree", async () => {
    await start({ autoDescribe: true });

    await client!.callTool({ name: "boot-device", arguments: { udid: SIM } });
    await client!.callTool({ name: "stop-simulator-server", arguments: { udid: SIM } });
    await settle();

    expect(describes()).toBe(0);
  });

  it("does not warm a call that types a secret", async () => {
    await start({ autoDescribe: true });

    await client!.callTool({
      name: "keyboard",
      arguments: { udid: SIM, text: "{{secret:PASSWORD}}" },
    });
    await settle();

    expect(describes()).toBe(0);
  });

  it.each(["describe", "await-ui-element", "native-describe-screen"])(
    "does not warm a device the agent already read with %s",
    async (name) => {
      await start({ autoDescribe: true });

      await client!.callTool({ name, arguments: { udid: SIM } });
      const before = describes();
      await tap(SIM);
      await settle();

      expect(describes()).toBe(before + 1);
    }
  );

  it("survives a failed read and warms again on the next action", async () => {
    stubBehavior.describeFails = true;
    await start({ autoDescribe: true });

    const first = await tap(SIM);
    expect(first.isError).toBeFalsy();
    // One attempt only: no resend of the background read.
    await vi.waitFor(() => expect(describes()).toBe(2));
    await settle();
    expect(describes()).toBe(2);

    await tap(SIM);
    await vi.waitFor(() => expect(describes()).toBe(4));
  });

  it("passes a note from the background read on to the agent", async () => {
    stubBehavior.describeNote = "update available";
    stubBehavior.tapDelayMs = 200;
    await start({ autoDescribe: true });

    const first = await tap(SIM);

    const text = textOf(first);
    expect(text.match(/update available/g)).toHaveLength(1);
  });

  it("does not warm when the element tree is turned off", async () => {
    await start({ autoDescribe: false });

    await tap(SIM);
    await settle();

    expect(describes()).toBe(0);
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
    const stub = await startStub(token);
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
