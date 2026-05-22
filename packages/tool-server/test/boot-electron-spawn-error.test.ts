/**
 * Regression test: `bootElectronApp` must register an `'error'` event handler
 * on the spawned electron ChildProcess. Node's `spawn()` returns synchronously
 * but emits ENOENT / EACCES / EAGAIN asynchronously as an `'error'` event on
 * the next tick. EventEmitter convention: an unhandled `'error'` event escapes
 * as an uncaught exception — without a listener, the tool-server would crash
 * every time someone called `boot-device` with `electronAppPath` on a host
 * without electron on PATH.
 *
 * The boot promise must also reject (not hang), with a message that names the
 * cause and tells the agent how to fix it.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const spawnMock = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: (cmd: string, args: string[], opts: unknown) => spawnMock(cmd, args, opts),
  };
});

import { bootElectronApp } from "../src/tools/devices/boot-electron";

interface FakeChild extends EventEmitter {
  pid: number | undefined;
  stderr: EventEmitter;
  unref: () => void;
  kill: (sig?: NodeJS.Signals) => boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

function makeFakeChild(opts: { pid?: number | undefined } = {}): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  ee.pid = "pid" in opts ? opts.pid : 12345;
  ee.stderr = new EventEmitter();
  ee.unref = () => {};
  ee.kill = () => true;
  ee.exitCode = null;
  ee.signalCode = null;
  return ee;
}

let appDir: string;
beforeAll(() => {
  // resolveLauncher() fs-checks the app path before spawn, so the test needs
  // a real directory on disk. The spawn itself is mocked, so the contents
  // don't matter — only the path's existence.
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-boot-electron-test-"));
  fs.writeFileSync(
    path.join(appDir, "package.json"),
    JSON.stringify({ name: "fake-electron-app", main: "main.js" })
  );
  fs.writeFileSync(path.join(appDir, "main.js"), "// fake\n");
});
afterAll(() => {
  if (appDir) fs.rmSync(appDir, { recursive: true, force: true });
});

beforeEach(() => {
  spawnMock.mockReset();
});

describe("bootElectronApp — spawn error handling", () => {
  it("registers an `error` listener on the spawned electron child", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = bootElectronApp({
      appPath: appDir,
      port: 19222,
      readyTimeoutMs: 100,
    });
    promise.catch(() => {}); // detach so the test doesn't hang after assertion

    await new Promise((r) => setTimeout(r, 10));

    // Without an `error` listener, an emitted error escapes as an uncaught
    // exception and crashes the tool-server.
    expect(child.listenerCount("error")).toBeGreaterThan(0);
  });

  it("rejects with a clear, actionable message when spawn emits ENOENT", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = bootElectronApp({
      appPath: appDir,
      port: 19223,
      readyTimeoutMs: 30_000,
    });

    // Let the impl subscribe.
    await new Promise((r) => setTimeout(r, 10));

    const err = new Error("spawn ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    child.emit("error", err);

    await expect(promise).rejects.toThrow(/ENOENT/);
    await expect(promise).rejects.toThrow(/electron/i);
    await expect(promise).rejects.toThrow(/installed.*PATH/i);
  });

  it("rejects (rather than hangs) when spawn emits EACCES", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = bootElectronApp({
      appPath: appDir,
      port: 19224,
      readyTimeoutMs: 30_000,
    });
    await new Promise((r) => setTimeout(r, 10));

    const err = new Error("spawn EACCES") as NodeJS.ErrnoException;
    err.code = "EACCES";
    child.emit("error", err);

    await expect(promise).rejects.toThrow(/EACCES/);
  });

  it("still rejects when spawn returns a child with no pid (early-fail path)", async () => {
    // Some platforms produce a child without a pid AND no async error event.
    // The synchronous "no pid" guard catches that case.
    spawnMock.mockReturnValue(makeFakeChild({ pid: undefined }));

    await expect(
      bootElectronApp({
        appPath: appDir,
        port: 19225,
        readyTimeoutMs: 100,
      })
    ).rejects.toThrow(/spawn returned without a pid/);
  });

  it("detaches BOTH boot listeners after successful boot — child outliving the function must not leak rejections", async () => {
    // The child is detached + unref'd, so it survives beyond bootElectronApp.
    // When the user later closes the Electron window (a normal action), the
    // child emits 'exit'. Without symmetric cleanup, the earlyExit promise
    // would reject "exited with code 0" on an orphan — Node escalates to
    // uncaughtException with default --unhandled-rejections=throw.
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    // Mock waitForCdpReady → instant success via a real CDP server is overkill;
    // emit 'exit' immediately would also work, but we want to test the success
    // path. Use a tiny http server on `port` that satisfies ensureCdpReachable
    // + discoverPrimaryPage. Or, simpler: fire `Promise.race` to win on the
    // ready probe by exposing one. Easiest: just verify the no-leak property
    // by triggering a synthetic success — exit fires AFTER we've already
    // verified the listeners are detached.

    // Force the boot to complete by emitting `exit` only after we've awaited
    // a tick — to win the race naturally we'd need a live HTTP/CDP server,
    // which is outside the unit-test scope. Instead, simulate the post-boot
    // window by directly stubbing waitForCdpReady via a one-shot HTTP server.
    const http = await import("node:http");
    const srv = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/json/version") {
        res.end(JSON.stringify({ "Browser": "Chrome/Test", "Protocol-Version": "1.3" }));
        return;
      }
      if (req.url === "/json/list") {
        res.end(
          JSON.stringify([
            {
              id: "page1",
              type: "page",
              title: "T",
              url: "about:blank",
              webSocketDebuggerUrl: "ws://127.0.0.1:1/discard",
            },
          ])
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const realPort = (srv.address() as { port: number }).port;

    let unhandled = 0;
    const onUnhandled = () => unhandled++;
    process.on("unhandledRejection", onUnhandled);

    try {
      await bootElectronApp({
        appPath: appDir,
        port: realPort,
        readyTimeoutMs: 5000,
      });

      // After successful boot, both boot-time listeners MUST be detached.
      expect(child.listenerCount("error")).toBe(0);
      expect(child.listenerCount("exit")).toBe(0);

      // Simulate the user closing the Electron window — normal exit code 0.
      child.emit("exit", 0, null);

      // And simulate a late stray `'error'` event from the OS layer.
      const err = new Error("late ECONNRESET") as NodeJS.ErrnoException;
      err.code = "ECONNRESET";
      // 'error' is special — emit() throws if no listener. We're proving
      // the absence of a listener is correct here, so the emit itself
      // SHOULD throw locally rather than turning into an unhandled
      // rejection on an orphan promise.
      expect(() => child.emit("error", err)).toThrow(/late ECONNRESET/);

      await new Promise((r) => setImmediate(r));
      expect(unhandled).toBe(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      srv.close();
    }
  });

  it("detaches the error listener after the no-pid throw — a deferred 'error' must not become an unhandled rejection", async () => {
    // Real-world regression scenario: a hostile platform returns a Child with
    // no pid AND fires a deferred 'error' event after spawn returns. Before
    // the fix, the error listener would still be attached and would call
    // reject() on a promise that nobody is awaiting — Node's default
    // --unhandled-rejections=throw would then crash the tool-server.
    const child = makeFakeChild({ pid: undefined });
    spawnMock.mockReturnValue(child);

    let unhandledRejections = 0;
    const onUnhandled = () => {
      unhandledRejections++;
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      await expect(
        bootElectronApp({
          appPath: appDir,
          port: 19226,
          readyTimeoutMs: 100,
        })
      ).rejects.toThrow(/spawn returned without a pid/);

      // After the synchronous throw, no listener should remain on the child.
      expect(child.listenerCount("error")).toBe(0);

      // Fire the deferred error now — like Node would.
      const err = new Error("late ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      // emit() with no listener on a stock EventEmitter would throw, but the
      // test fake-child uses a vanilla EventEmitter, so emit just no-ops when
      // there are no listeners on a non-'error' channel. For 'error' events
      // specifically Node DOES throw — so guard the emit to confirm the
      // listener was actually detached.
      expect(() => child.emit("error", err)).toThrow(/late ENOENT/);

      // Give microtasks a tick to surface any unhandled rejection.
      await new Promise((r) => setImmediate(r));
      expect(unhandledRejections).toBe(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
