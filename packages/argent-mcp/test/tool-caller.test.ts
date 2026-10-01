import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The tools client captures ~/.argent/link.json from homedir() at module load.
// HOME is redirected before the import, so a developer's real link cannot turn
// the co-located cases into remote ones.
let createToolCaller: typeof import("../src/tool-caller.js").createToolCaller;
let TEST_HOME: string;
const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

beforeAll(async () => {
  TEST_HOME = mkdtempSync(join(tmpdir(), "argent-tool-caller-test-"));
  process.env.HOME = TEST_HOME;
  process.env.USERPROFILE = TEST_HOME;
  vi.resetModules();
  ({ createToolCaller } = await import("../src/tool-caller.js"));
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
  requests: Recorded[];
  close: () => Promise<void>;
}

const LISTING = {
  tools: [
    {
      name: "reinstall-app",
      description: "",
      inputSchema: {},
      fileInputs: [{ target: "appPath", path: "${appPath}", kind: "tar-upload" }],
    },
    { name: "slow", description: "", inputSchema: {}, longRunning: true },
    { name: "fast", description: "", inputSchema: {} },
    { name: "reject", description: "", inputSchema: {} },
    { name: "hinted", description: "", inputSchema: {}, outputHint: "image" },
  ],
};

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

/** A stub tool-server. `fast` drops its first connection unless `dropFirstFast` is false. */
async function startStub(opts: { dropFirstFast?: boolean } = {}): Promise<Stub> {
  const dropFirstFast = opts.dropFirstFast ?? true;
  const requests: Recorded[] = [];
  let fastCalls = 0;
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const url = req.url ?? "";
    requests.push({ method: req.method ?? "", url, headers: req.headers, body });
    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.method === "GET" && url === "/tools") return json(200, LISTING);
    if (req.method === "POST" && url === "/upload") return json(200, { uploadId: "u-1" });
    if (req.method === "POST" && url === "/tools/reinstall-app") {
      return json(200, { data: { reinstalled: true, bundleId: "x" } });
    }
    if (req.method === "POST" && url === "/tools/slow") {
      setTimeout(() => json(200, { data: { ok: true } }), 80);
      return;
    }
    if (req.method === "POST" && url === "/tools/fast") {
      fastCalls += 1;
      if (dropFirstFast && fastCalls === 1) {
        req.socket.destroy();
        return;
      }
      return json(200, { data: { n: fastCalls } });
    }
    if (req.method === "POST" && url === "/tools/reject") return json(422, { error: "nope" });
    if (req.method === "POST" && url === "/tools/hinted") {
      return json(200, { data: { a: 1 }, note: "n" });
    }
    json(404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

let stub: Stub;
let appPath: string;

beforeEach(async () => {
  stub = await startStub();
  appPath = join(TEST_HOME, `MyApp-${Date.now()}.app`);
  mkdirSync(appPath);
  writeFileSync(join(appPath, "Info.plist"), "<plist/>");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await stub.close();
});

function caller(overrides: Partial<Parameters<typeof createToolCaller>[0]> = {}) {
  const reconnect = vi.fn(async () => {});
  const made = createToolCaller({
    getHandle: () => ({ url: stub.url, token: "tok" }),
    reconnect,
    extraHeaders: () => ({ "X-Argent-AI-Client": "test" }),
    fetchTimeoutMs: 2_000,
    ...overrides,
  });
  return { ...made, reconnect: overrides.reconnect ?? reconnect };
}

const postsTo = (path: string) =>
  stub.requests.filter((r) => r.method === "POST" && r.url === path);

describe("createToolCaller", () => {
  it("uploads a tar-upload input to POST /upload when routed to a remote server", async () => {
    vi.stubEnv("ARGENT_TOOLS_URL", stub.url);
    const { callTool } = caller();

    const out = await callTool("reinstall-app", { udid: "u", bundleId: "x", appPath });

    const uploads = postsTo("/upload");
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.headers.authorization).toBe("Bearer tok");
    expect(uploads[0]!.body.length).toBeGreaterThan(0);

    const calls = postsTo("/tools/reinstall-app");
    expect(calls).toHaveLength(1);
    const sent = JSON.parse(calls[0]!.body) as { appPath: Record<string, unknown> };
    expect(sent.appPath.__argentFileInput).toBe(true);
    expect(sent.appPath.uploadId).toBe("u-1");
    expect(sent.appPath.contentHash).toMatch(/^[a-f0-9]{64}$/);

    expect(out).toEqual({ result: { reinstalled: true, bundleId: "x" } });
  });

  it("sends a path-only wrapper and no upload for a co-located session", async () => {
    vi.stubEnv("ARGENT_TOOLS_URL", "");
    const { callTool } = caller();

    await callTool("reinstall-app", { udid: "u", bundleId: "x", appPath });

    expect(postsTo("/upload")).toHaveLength(0);
    const sent = JSON.parse(postsTo("/tools/reinstall-app")[0]!.body) as {
      appPath: Record<string, unknown>;
    };
    expect(sent.appPath.__argentFileInput).toBe(true);
    expect(sent.appPath.path).toBe(appPath);
    expect(sent.appPath).not.toHaveProperty("uploadId");
    expect(sent.appPath).not.toHaveProperty("content");
  });

  it("adds the auth header and the extra headers to the listing and the tool call", async () => {
    const { fetchTools, callTool } = caller();

    const tools = await fetchTools();
    await callTool("hinted", {});

    expect(tools.map((t) => t.name)).toContain("hinted");
    for (const r of [
      ...stub.requests.filter((r) => r.url === "/tools"),
      ...postsTo("/tools/hinted"),
    ]) {
      expect(r.headers.authorization).toBe("Bearer tok");
      expect(r.headers["x-argent-ai-client"]).toBe("test");
    }
  });

  it("disables the per-attempt timeout for a longRunning tool", async () => {
    // The stub answers `slow` after 80 ms, past this per-attempt timeout.
    const { callTool, reconnect } = caller({ fetchTimeoutMs: 40 });

    await expect(callTool("slow", {})).resolves.toEqual({ result: { ok: true } });
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("retries the request and calls reconnect after the first failure", async () => {
    const { callTool, reconnect } = caller();

    await expect(callTool("fast", {})).resolves.toEqual({ result: { n: 2 } });
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(postsTo("/tools/fast")).toHaveLength(2);
  });

  it("sends a retry to the handle a reconnect installed, with its token", async () => {
    const second = await startStub({ dropFirstFast: false });
    try {
      let handle = { url: stub.url, token: "tok" };
      const { callTool, reconnect } = caller({
        getHandle: () => handle,
        reconnect: vi.fn(async () => {
          handle = { url: second.url, token: "tok2" };
        }),
      });

      // `fast` drops the first connection, which lands on the first server.
      await expect(callTool("fast", {})).resolves.toEqual({ result: { n: 1 } });
      expect(reconnect).toHaveBeenCalledTimes(1);
      expect(postsTo("/tools/fast")).toHaveLength(1);
      const retried = second.requests.filter((r) => r.url === "/tools/fast");
      expect(retried).toHaveLength(1);
      expect(retried[0]!.headers.authorization).toBe("Bearer tok2");
    } finally {
      await second.close();
    }
  });

  it("returns the server error text for a non-2xx status without a retry", async () => {
    const { callTool, reconnect } = caller();

    await expect(callTool("reject", {})).rejects.toThrow("nope");
    expect(postsTo("/tools/reject")).toHaveLength(1);
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("carries outputHint and note", async () => {
    const { callTool } = caller();

    await expect(callTool("hinted", {})).resolves.toEqual({
      result: { a: 1 },
      outputHint: "image",
      note: "n",
    });
  });
});
