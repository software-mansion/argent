import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ARTIFACT_MARKER, type ArtifactHandle } from "@argent/tools-client";
import { AUTO_DESCRIBE_HEADER } from "../src/auto-capture.js";
import { startMcpServer } from "../src/mcp-server.js";

// startMcpServer builds its own transport, so hand it the server half of an
// in-memory pair and drive it with a real MCP client.
const linked = vi.hoisted(() => ({ serverTransport: undefined as object | undefined }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {
    constructor() {
      return linked.serverTransport!;
    }
  },
}));

describe("mcp-server module", () => {
  it("exports startMcpServer as an async function", async () => {
    const mod = await import("../src/mcp-server.js");
    expect(typeof mod.startMcpServer).toBe("function");
  });
});

const AUTO_DEVICE = "SIM-AUTO";
const DESCRIPTION = "Button, label=OK";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11, 0x22, 0x33]);

const TOOLS = [
  { name: "gesture-tap", description: "", inputSchema: { type: "object", properties: {} } },
  {
    name: "screenshot",
    description: "",
    inputSchema: { type: "object", properties: {} },
    outputHint: "image",
  },
  { name: "describe", description: "", inputSchema: { type: "object", properties: {} } },
  { name: "await-screen-idle", description: "", inputSchema: { type: "object", properties: {} } },
];

interface ServerState {
  /** The `data` a `screenshot` call answers with. */
  screenshotData: unknown;
  /** Device the stub resolves for a call that named none, echoed as `device`. */
  autoDevice?: string;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
}

function dataFor(name: string, state: ServerState): unknown {
  if (name === "screenshot") return state.screenshotData;
  if (name === "describe") return { description: DESCRIPTION };
  if (name === "await-screen-idle") return { idle: true };
  return { ok: true };
}

function startServer(state: ServerState): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    if (url === "/tools" && req.method === "GET") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ tools: TOOLS }));
      return;
    }
    if (url.startsWith("/artifacts/") && req.method === "GET") {
      res.setHeader("content-type", "image/png");
      res.end(PNG);
      return;
    }
    if (url.startsWith("/tools/") && req.method === "POST") {
      const name = url.slice("/tools/".length);
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const args = JSON.parse(body || "{}") as Record<string, unknown>;
        state.calls.push({ name, args });
        // The tool-server resolves — and echoes — a device only for a call that named none.
        const echo = state.autoDevice && !args.udid ? { device: state.autoDevice } : {};
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: dataFor(name, state), ...echo }));
      });
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe("a call that named no device still gets one", () => {
  let server: { url: string; close: () => Promise<void> };
  let state: ServerState;
  let client: Client;
  let homeDir: string; // HOME: flag storage and the call log
  let artRoot: string; // ARGENT_ARTIFACTS_DIR (where downloads land)
  let hostDir: string; // stands in for the tool-server host's filesystem
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  const opts = { paths: {} as never }; // unused: ARGENT_TOOLS_URL is set

  beforeEach(async () => {
    state = { screenshotData: null, calls: [] };
    server = await startServer(state);
    homeDir = await mkdtemp(join(tmpdir(), "mcp-home-"));
    artRoot = await mkdtemp(join(tmpdir(), "mcp-art-"));
    hostDir = await mkdtemp(join(tmpdir(), "mcp-host-"));
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    // Auto-screenshot and auto-describe are opt-out flags read from the home
    // dir at startup: a developer who set either would otherwise see this fail.
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.ARGENT_TELEMETRY = "0";
    process.env.ARGENT_TOOLS_URL = server.url;
    process.env.ARGENT_ARTIFACTS_DIR = artRoot;

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    linked.serverTransport = serverTransport;
    await startMcpServer(opts);
    client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    delete process.env.ARGENT_TELEMETRY;
    delete process.env.ARGENT_TOOLS_URL;
    delete process.env.ARGENT_ARTIFACTS_DIR;
    await server.close();
    await rm(homeDir, { recursive: true, force: true });
    await rm(artRoot, { recursive: true, force: true });
    await rm(hostDir, { recursive: true, force: true });
  });

  async function localScreenshotHandle(): Promise<ArtifactHandle> {
    const hostPath = join(hostDir, "shot.png");
    await writeFile(hostPath, PNG);
    const st = await stat(hostPath);
    return {
      [ARTIFACT_MARKER]: true,
      id: "loc-1",
      filename: "shot.png",
      mimeType: "image/png",
      size: st.size,
      hostPath,
      mtimeMs: st.mtimeMs,
    };
  }

  function udidsOf(name: string): unknown[] {
    return state.calls.filter((c) => c.name === name).map((c) => c.args.udid);
  }

  // The SDK's result type also admits the legacy content-less `toolResult` arm,
  // which no argent tool returns.
  function textOf(res: Awaited<ReturnType<Client["callTool"]>>): string {
    const blocks = (res.content ?? []) as Array<{ type: string; text?: string }>;
    return blocks
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  }

  it("takes the post-action screenshot and element tree on the resolved device", async () => {
    state.autoDevice = AUTO_DEVICE;
    state.screenshotData = { image: await localScreenshotHandle() };

    const res = await client.callTool({ name: "gesture-tap", arguments: { x: 0.5, y: 0.5 } });

    // The tap named no device, so the echoed one is the only id these three
    // follow-up calls can be made on — without it there is no capture at all.
    expect(udidsOf("await-screen-idle")).toEqual([AUTO_DEVICE]);
    expect(udidsOf("screenshot")).toEqual([AUTO_DEVICE]);
    expect(udidsOf("describe")).toEqual([AUTO_DEVICE]);
    const text = textOf(res);
    expect(text).toContain("--- Screen after action ---");
    expect(text).toContain(`${AUTO_DESCRIBE_HEADER}\n${DESCRIPTION}`);
  });

  it("caches a downloaded artifact under the resolved device, not the session root", async () => {
    state.autoDevice = AUTO_DEVICE;
    state.screenshotData = {
      image: {
        [ARTIFACT_MARKER]: true,
        id: "rem-1",
        filename: "shot.png",
        mimeType: "image/png",
        size: PNG.length,
        hostPath: join(hostDir, "not-here.png"), // absent → gate miss → download
        mtimeMs: 123,
      } satisfies ArtifactHandle,
    };

    const res = await client.callTool({ name: "screenshot", arguments: {} });

    // The payload named no device, so the per-device segment can only come from
    // the response — without it the download lands in the session root.
    const saved = textOf(res).match(/Saved: (\S+)/)?.[1];
    expect(saved).toBeDefined();
    expect(saved).toContain(`${sep}${AUTO_DEVICE}${sep}`);
    expect(existsSync(saved!)).toBe(true);
  });
});
