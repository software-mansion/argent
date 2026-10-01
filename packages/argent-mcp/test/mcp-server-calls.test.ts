import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Drives the real adapter (`startMcpServer`) over the SDK's in-memory transport
// against a stub tool-server, so the adapter's own call handling is exercised:
// the listing, a tool call that must upload, an error answer and the note.
//
// HOME is redirected before the import: the tools client, the telemetry notice
// and the flags all build their paths from homedir() at module load.
let startMcpServer: typeof import("../src/mcp-server.js").startMcpServer;
let TEST_HOME: string;
const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

beforeAll(async () => {
  TEST_HOME = mkdtempSync(join(tmpdir(), "argent-mcp-server-calls-test-"));
  process.env.HOME = TEST_HOME;
  process.env.USERPROFILE = TEST_HOME;
  vi.resetModules();
  ({ startMcpServer } = await import("../src/mcp-server.js"));
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
  ],
};

let server: http.Server;
let url: string;
let requests: Recorded[];
let client: Client;
let appPath: string;

beforeEach(async () => {
  requests = [];
  server = http.createServer((req, res) => {
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
      if (req.method === "GET" && reqUrl === "/tools") return json(200, LISTING);
      if (req.method === "POST" && reqUrl === "/upload") return json(200, { uploadId: "u-1" });
      if (req.method === "POST" && reqUrl === "/tools/reinstall-app") {
        return json(200, { data: { reinstalled: true, bundleId: "x" } });
      }
      if (req.method === "POST" && reqUrl === "/tools/reject") return json(422, { error: "nope" });
      if (req.method === "POST" && reqUrl === "/tools/noted") {
        return json(200, { data: { ok: true }, note: "a note" });
      }
      json(404, { error: "not found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Remote-routed, so the adapter neither spawns a tool-server nor starts the
  // local health check, and the tools client uploads file inputs.
  vi.stubEnv("ARGENT_TOOLS_URL", url);
  vi.stubEnv("ARGENT_MCP_LOG", join(TEST_HOME, "mcp-calls.log"));

  appPath = join(TEST_HOME, `MyApp-${Date.now()}.app`);
  mkdirSync(appPath);
  writeFileSync(join(appPath, "Info.plist"), "<plist/>");

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await startMcpServer({ paths: {} as never, transport: serverTransport });
  client = new Client({ name: "probe", version: "1" });
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

describe("startMcpServer tool calls", () => {
  it("lists the tools of the tool-server", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["reinstall-app", "reject", "noted"]);
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
