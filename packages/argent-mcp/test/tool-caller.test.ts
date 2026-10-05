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
    { name: "slow-plain", description: "", inputSchema: {} },
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

/**
 * A stub tool-server. The routes in `dropFirst` destroy the socket of their
 * first request after they read it. As on the real tool-server, a call that
 * names an upload consumes it when its body is read, and `reinstall-app` waits
 * `installMs` before it answers.
 */
async function startStub(opts: { dropFirst?: string[]; installMs?: number } = {}): Promise<Stub> {
  const dropFirst = new Set(opts.dropFirst ?? ["/tools/fast"]);
  const requests: Recorded[] = [];
  const calls = new Map<string, number>();
  const uploads = new Set<string>();
  let slowPlainCalls = 0;
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const url = req.url ?? "";
    requests.push({ method: req.method ?? "", url, headers: req.headers, body });
    const nth = (calls.get(url) ?? 0) + 1;
    calls.set(url, nth);
    const named =
      url === "/tools/reinstall-app"
        ? (JSON.parse(body) as { appPath?: { uploadId?: string } }).appPath?.uploadId
        : undefined;
    const consumed = named !== undefined && uploads.delete(named);
    if (dropFirst.has(url) && nth === 1) {
      req.socket.destroy();
      return;
    }
    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.method === "GET" && url === "/tools") return json(200, LISTING);
    if (req.method === "POST" && url === "/upload") {
      const uploadId = `u-${uploads.size + 1}`;
      uploads.add(uploadId);
      return json(200, { uploadId });
    }
    if (req.method === "POST" && url === "/tools/reinstall-app") {
      if (named !== undefined && !consumed) {
        return json(422, { error: `Upload "${named}" was not found on the tool-server` });
      }
      setTimeout(
        () => json(200, { data: { reinstalled: true, bundleId: "x" } }),
        opts.installMs ?? 0
      );
      return;
    }
    if (req.method === "POST" && url === "/tools/slow") {
      setTimeout(() => json(200, { data: { ok: true } }), 80);
      return;
    }
    if (req.method === "POST" && url === "/tools/fast") return json(200, { data: { n: nth } });
    if (req.method === "POST" && url === "/tools/slow-plain") {
      // Slow only once, so a per-attempt timeout shows as one abort and one retry.
      slowPlainCalls += 1;
      setTimeout(() => json(200, { data: { n: slowPlainCalls } }), slowPlainCalls === 1 ? 80 : 0);
      return;
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
    const second = await startStub({ dropFirst: [] });
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

  it("aborts an ordinary tool after fetchTimeoutMs and retries it", async () => {
    const { callTool, reconnect } = caller({ fetchTimeoutMs: 40 });

    // Without the timeout the 80 ms first answer would be the result (n: 1) and
    // nothing would reconnect. The retry count is not pinned: after an aborted
    // attempt, fetch can stall the next attempt on the reused keep-alive socket
    // until its own timeout, which costs one more attempt.
    const { result } = await callTool("slow-plain", {});
    const n = (result as { n: number }).n;
    expect(n).toBeGreaterThanOrEqual(2);
    expect(postsTo("/tools/slow-plain")).toHaveLength(n);
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("gives an ordinary tool a 30 s per-attempt timeout by default", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    let posts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const headers = { "Content-Type": "application/json" };
        if (String(input).endsWith("/tools")) {
          return new Response(JSON.stringify(LISTING), { headers });
        }
        posts += 1;
        if (posts === 1) {
          signals.push(init!.signal!);
          return new Promise<Response>((_resolve, reject) => {
            init!.signal!.addEventListener("abort", () => reject(new Error("aborted")));
          });
        }
        return new Response(JSON.stringify({ data: { n: posts } }), { headers });
      })
    );
    try {
      const { callTool, reconnect } = caller({ fetchTimeoutMs: undefined });
      const pending = callTool("fast", {});

      await vi.advanceTimersByTimeAsync(29_999);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signals[0]!.aborted).toBe(true);

      await vi.advanceTimersByTimeAsync(250);
      await expect(pending).resolves.toEqual({ result: { n: 2 } });
      expect(reconnect).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("waits for a call that carried an upload instead of aborting and sending it again", async () => {
    const slow = await startStub({ installMs: 80 });
    try {
      vi.stubEnv("ARGENT_TOOLS_URL", slow.url);
      // The install outlasts this per-attempt timeout. A retry would name an
      // upload that the stub already consumed.
      const { callTool, reconnect } = caller({
        getHandle: () => ({ url: slow.url, token: "tok" }),
        fetchTimeoutMs: 40,
      });

      await expect(
        callTool("reinstall-app", { udid: "u", bundleId: "x", appPath })
      ).resolves.toEqual({ result: { reinstalled: true, bundleId: "x" } });

      expect(slow.requests.filter((r) => r.url === "/upload")).toHaveLength(1);
      expect(slow.requests.filter((r) => r.url === "/tools/reinstall-app")).toHaveLength(1);
      expect(reconnect).not.toHaveBeenCalled();
    } finally {
      await slow.close();
    }
  });

  it("sends a call that carried an upload once, even when its connection drops", async () => {
    const dropping = await startStub({ dropFirst: ["/tools/reinstall-app"] });
    try {
      vi.stubEnv("ARGENT_TOOLS_URL", dropping.url);
      const { callTool, reconnect } = caller({
        getHandle: () => ({ url: dropping.url, token: "tok" }),
      });

      // The stub consumed the upload before the connection dropped, so a
      // second attempt would only get "not found".
      await expect(
        callTool("reinstall-app", { udid: "u", bundleId: "x", appPath })
      ).rejects.toThrow("fetch failed");

      expect(dropping.requests.filter((r) => r.url === "/upload")).toHaveLength(1);
      expect(dropping.requests.filter((r) => r.url === "/tools/reinstall-app")).toHaveLength(1);
      expect(reconnect).not.toHaveBeenCalled();
    } finally {
      await dropping.close();
    }
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
