/**
 * The idle timer must not fire while a tool call is still mid-execution.
 *
 * Long-running tools (e.g. `xctrace export`, RN builds) can exceed the
 * idle window. Touching the timer at request START is not enough: the
 * periodic check would still see lastActivityAt as stale and trigger
 * onIdle — wired to a server shutdown — half-way through a response.
 */
import http from "node:http";
import { describe, it, expect, vi, afterEach } from "vitest";
import { createHttpApp, type HttpAppHandle } from "../src/http";
import type { Registry } from "@argent/registry";

vi.mock("../src/utils/update-checker", () => ({
  getUpdateState: vi.fn(() => ({
    updateAvailable: false,
    latestVersion: null,
    currentVersion: "1.0.0",
  })),
  isUpdateNoteSuppressed: vi.fn(() => true),
  suppressUpdateNote: vi.fn(),
}));

describe("idle timer should not fire while a tool call is in flight", () => {
  let handle: HttpAppHandle | undefined;
  let server: http.Server | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    handle?.dispose();
    handle = undefined;
    if (server) {
      // closeAllConnections drops any sockets the test left hanging
      // (the in-flight request that we never resolved on a failure
      // path), so server.close() can return promptly.
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it("does not call onIdle while a long-running tool is still executing", async () => {
    // Fake the timer + Date now, BEFORE createHttpApp, so the idle
    // timer's setInterval is registered against the fake clock and
    // vi.advanceTimersByTime can drive it. Leave setImmediate / I/O
    // timers alone so the real HTTP server can accept the request.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });

    const onIdle = vi.fn();

    // A tool whose execute() resolves only when we manually flip the latch.
    let resolveTool: (value: unknown) => void = () => {};
    const toolPromise = new Promise((resolve) => {
      resolveTool = resolve;
    });

    let invokeStartResolve: () => void = () => {};
    const invokeStarted$ = new Promise<void>((r) => {
      invokeStartResolve = r;
    });

    const registry = {
      getSnapshot: vi.fn(() => ({ services: new Map(), namespaces: [], tools: ["slow-tool"] })),
      getTool: vi.fn(() => ({
        id: "slow-tool",
        description: "slow",
        inputSchema: { type: "object", properties: {} },
        services: () => ({}),
        execute: async () => toolPromise,
      })),
      // invokeTool is what http.ts actually awaits. Signal once the
      // middleware has entered, then park indefinitely on toolPromise.
      invokeTool: ((..._args: unknown[]) => {
        invokeStartResolve();
        return toolPromise;
      }) as Registry["invokeTool"],
    } as unknown as Registry;

    handle = createHttpApp(registry, {
      idleTimeoutMs: 5 * 60_000,
      onIdle,
    });

    // Spin up a real loopback server so the request runs through Express
    // middleware end-to-end (only setInterval is faked, so socket I/O
    // still progresses).
    server = http.createServer(handle.app);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;

    const requestPromise = new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/tools/slow-tool",
          headers: { "content-type": "application/json", "content-length": "2" },
        },
        (res) => {
          res.on("data", () => {});
          res.on("end", () => resolve());
        }
      );
      req.on("error", reject);
      req.write("{}");
      req.end();
    });

    // Wait for the middleware to actually accept the request and reach
    // invokeTool — only then is the in-flight bookkeeping in place. We
    // must do this without using any setTimeout (faked) or setInterval
    // (faked); a Promise.race against invokeStarted$ uses microtasks +
    // real I/O completion, both of which are unaffected by our fakes.
    await invokeStarted$;

    // Advance fake time past the idle threshold while the tool is still
    // mid-execution. With the bug, the IDLE_CHECK_INTERVAL fires and
    // sees lastActivityAt as older than 5min — triggering onIdle().
    vi.advanceTimersByTime(6 * 60_000);

    expect(onIdle).not.toHaveBeenCalled();

    // Cleanup: let the tool resolve and the request finish. Swallow any
    // socket error from the still-faked Date — the bookkeeping is what
    // we care about, the response body is incidental.
    vi.useRealTimers();
    resolveTool({ ok: true });
    await requestPromise.catch(() => {});
  });
});
