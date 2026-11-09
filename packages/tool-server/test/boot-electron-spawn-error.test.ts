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
 * cause.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { scopeTempHome } from "./helpers/temp-home";
import { createCdpStub } from "./helpers/cdp-stub";

/**
 * CDP port for the boots below, which must never reach a live endpoint: when
 * the readiness probe succeeds, `bootElectronApp` resolves and the synthetic
 * spawn error under test never becomes its rejection.
 *
 * Node's fetch refuses port 1 as a WHATWG "bad port" before it opens a socket,
 * so `ensureCdpReachable` fails whatever the host happens to be running.
 * Privilege is not the mechanism and would not be enough on its own: 2 and
 * 1023 are equally privileged yet dial normally.
 *
 * The no-pid boots throw before the probe is reached, so the value is inert
 * there; they take the constant for uniformity.
 */
const UNREACHABLE_CDP_PORT = 1;

const spawnMock = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: (cmd: string, args: string[], opts: unknown) => spawnMock(cmd, args, opts),
  };
});

// Keep trackChromiumPort from persisting booted ports to on-disk state — the
// success-path test below completes a boot, and persistPorts writes to
// os.homedir()/.argent/chromium-cdp-ports.json. Same mock, same reason, as
// boot-electron-kill and boot-electron-ready-race.
vi.mock("../src/utils/chromium-discovery", () => ({
  trackChromiumPort: vi.fn(),
  untrackChromiumPort: vi.fn(),
}));

import { bootElectronApp as bootElectronAppImpl } from "../src/tools/devices/boot-electron";

// A boot a failed test leaves pending keeps port 1 claimed for every later
// test, which then fails with PORT_IN_USE instead, so afterEach settles them.
// One with no error listener to fire settles at readyTimeoutMs, hence 5 s
// rather than anything near the 10 s hook timeout.
const startedBoots: Promise<unknown>[] = [];
function bootElectronApp(options: Parameters<typeof bootElectronAppImpl>[0]) {
  const boot = bootElectronAppImpl(options);
  startedBoots.push(boot.catch(() => {}));
  return boot;
}

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
  // Records the signal as the exit it would cause, so a later boot on the port sees it gone.
  ee.kill = (sig?: NodeJS.Signals) => {
    ee.signalCode ??= sig ?? "SIGTERM";
    return true;
  };
  ee.exitCode = null;
  ee.signalCode = null;
  return ee;
}

scopeTempHome("argent-boot-electron-home-");

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

// Every boot-failure test runs killChildEscalating against a fake child
// carrying a stand-in pid, and its group sweep signals through process.kill —
// real signals must never escape onto whatever owns that pid. Never restored:
// the unref'd 2s escalation timer can fire after the test that armed it.
vi.spyOn(process, "kill").mockImplementation(() => true);

beforeEach(() => {
  spawnMock.mockReset();
});
afterEach(async () => {
  vi.useRealTimers();
  for (const { value: child } of spawnMock.mock.results) {
    if (child instanceof EventEmitter && child.listenerCount("error") > 0) {
      child.emit("error", new Error("test teardown"));
    }
  }
  await Promise.all(startedBoots.splice(0));
});

/** Spawn runs only after the fixed-port probe resolves, so wait for its listener. */
async function untilErrorListener(child: FakeChild): Promise<void> {
  await vi.waitFor(() => expect(child.listenerCount("error")).toBeGreaterThan(0));
}

describe("bootElectronApp — spawn error handling", () => {
  it("registers an `error` listener on the spawned electron child", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = bootElectronApp({
      appPath: appDir,
      port: UNREACHABLE_CDP_PORT,
      readyTimeoutMs: 100,
    });
    promise.catch(() => {}); // detach so the test doesn't hang after assertion

    // Without an `error` listener, an emitted error escapes as an uncaught
    // exception and crashes the tool-server.
    await untilErrorListener(child);
    await promise.catch(() => {});
  });

  it("strips ELECTRON_RUN_AS_NODE from the spawned electron env (GUI boot, not Node mode)", async () => {
    // Regression: an Electron-based MCP host (VS Code / Cursor / Codex desktop)
    // spawns the tool-server with ELECTRON_RUN_AS_NODE=1. If that leaks into the
    // Electron app we boot, the binary runs in Node mode — it never comes up as
    // a browser with a CDP endpoint, so boot-device fails instead of the app
    // launching. The env must strip the flag while keeping the per-launch
    // override (ELECTRON_ENABLE_LOGGING).
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const prev = process.env.ELECTRON_RUN_AS_NODE;
    process.env.ELECTRON_RUN_AS_NODE = "1";
    try {
      const promise = bootElectronApp({
        appPath: appDir,
        // Unreachable port → the readiness race rejects fast; we only care about
        // the spawn env, so detach and swallow the rejection.
        port: UNREACHABLE_CDP_PORT,
        readyTimeoutMs: 50,
      });
      promise.catch(() => {});

      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
      const spawnEnv = (spawnMock.mock.calls[0]![2] as { env: NodeJS.ProcessEnv }).env;
      expect(spawnEnv.ELECTRON_RUN_AS_NODE).toBeUndefined();
      expect(spawnEnv.ELECTRON_ENABLE_LOGGING).toBe("1");

      await promise.catch(() => {});
    } finally {
      if (prev === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
      else process.env.ELECTRON_RUN_AS_NODE = prev;
    }
  });

  it("passes anti-throttling switches so a backgrounded window stays testable", async () => {
    // Chromium throttles an unfocused or occluded window's compositor:
    // mouse-input acks stall ~5s per event and wheel scrolls hang. These
    // switches disable that; minimization is outside their reach (see
    // ANTI_THROTTLING_ARGS).
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = bootElectronApp({
      appPath: appDir,
      port: UNREACHABLE_CDP_PORT,
      readyTimeoutMs: 50,
      extraArgs: ["--user-flag"],
    });
    promise.catch(() => {});

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).toContain("--disable-background-timer-throttling");
    expect(args).toContain("--disable-backgrounding-occluded-windows");
    expect(args).toContain("--disable-renderer-backgrounding");
    // User extras survive alongside the defaults.
    expect(args).toContain("--user-flag");
    expect(args).toContain(`--remote-debugging-port=${UNREACHABLE_CDP_PORT}`);

    await promise.catch(() => {});
  });

  it("rejects with a clear, actionable message when spawn emits ENOENT", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = bootElectronApp({
      appPath: appDir,
      port: UNREACHABLE_CDP_PORT,
      readyTimeoutMs: 5_000,
    });
    await untilErrorListener(child);

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
      port: UNREACHABLE_CDP_PORT,
      readyTimeoutMs: 5_000,
    });
    await untilErrorListener(child);

    const err = new Error("spawn EACCES") as NodeJS.ErrnoException;
    err.code = "EACCES";
    child.emit("error", err);

    await expect(promise).rejects.toThrow(/EACCES/);
    await expect(promise).rejects.not.toThrow(/installed/);
  });

  it("omits the install-electron hint when the launcher is the app's own binary", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = bootElectronApp({
      appPath: path.join(appDir, "main.js"),
      port: UNREACHABLE_CDP_PORT,
      readyTimeoutMs: 5_000,
    });
    await untilErrorListener(child);

    const err = new Error("spawn ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    child.emit("error", err);

    await expect(promise).rejects.toThrow(/main\.js \(ENOENT\)/);
    await expect(promise).rejects.not.toThrow(/installed/);
  });

  it("falls back to the no-pid rejection when a pidless child never emits 'error'", async () => {
    // Node always follows a missing pid with a next-tick 'error'; this pins the
    // bounded fallback for a runtime that breaks that contract.
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    spawnMock.mockReturnValue(makeFakeChild({ pid: undefined }));

    const settled = bootElectronApp({
      appPath: appDir,
      port: UNREACHABLE_CDP_PORT,
      readyTimeoutMs: 100,
    }).catch((e: unknown) => e);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(1000);

    const signal = getFailureSignal(await settled);
    expect(signal?.error_code).toBe(FAILURE_CODES.CHROMIUM_ELECTRON_SPAWN_FAILED);
    expect(signal?.failure_stage).toBe("electron_spawn_no_pid");
  });

  it("detaches BOTH boot listeners after successful boot — child outliving the function must not leak rejections", async () => {
    // The child is detached + unref'd, so it survives beyond bootElectronApp.
    // When the user later closes the Electron window (a normal action), the
    // child emits 'exit'. Without symmetric cleanup, the earlyExit promise
    // would reject "exited with code 0" on an orphan — Node escalates to
    // uncaughtException with default --unhandled-rejections=throw.
    const child = makeFakeChild();
    // A stub CDP endpoint lets the boot complete for real, so the post-boot exit
    // below happens after the listeners were detached.
    const {
      port: realPort,
      listen,
      close,
    } = await createCdpStub({
      "/json/list": [
        {
          id: "page1",
          type: "page",
          title: "T",
          url: "about:blank",
          webSocketDebuggerUrl: "ws://127.0.0.1:1/discard",
        },
      ],
    });
    spawnMock.mockImplementation(() => {
      listen();
      return child;
    });

    let unhandled = 0;
    const onUnhandled = () => unhandled++;
    process.on("unhandledRejection", onUnhandled);

    try {
      await bootElectronApp({
        appPath: appDir,
        port: realPort,
        readyTimeoutMs: 5000,
      });

      // A completed boot persists its port. Two guards keep it out of the
      // developer's real ~/.argent/chromium-cdp-ports.json — the mock above,
      // and the scoped HOME that makes this about the run's own writes — and
      // asserting the absence is what fails when either stops working.
      expect(fs.existsSync(path.join(os.homedir(), ".argent", "chromium-cdp-ports.json"))).toBe(
        false
      );

      // After successful boot, both boot-time listeners MUST be detached.
      // Exactly one 'exit' listener remains: the kill-registry cleanup hook
      // installed for killChromiumByPort. It only evicts the retained handle —
      // it can't reject anything, which the unhandled-rejection count below
      // proves when we emit 'exit'.
      expect(child.listenerCount("error")).toBe(0);
      expect(child.listenerCount("exit")).toBe(1);

      // Simulate the user closing the Electron window — normal exit code 0.
      // The once() cleanup listener runs (evicting the handle) and detaches.
      child.emit("exit", 0, null);
      expect(child.listenerCount("exit")).toBe(0);

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
      close();
    }
  });

  it("detaches BOTH boot listeners after a FAILURE path too (CDP-ready timeout) — no orphan rejections on the cleanup kill", async () => {
    // Companion to the success-path test above. The catch branch in
    // bootElectronApp runs detachBootListeners() before killChildEscalating;
    // confirm both listeners come off and the synthetic post-kill 'exit'
    // doesn't refire any stale handler.
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    let unhandled = 0;
    const onUnhandled = () => unhandled++;
    process.on("unhandledRejection", onUnhandled);

    try {
      // The readiness probe cannot be answered, so waitForCdpReady exhausts
      // readyTimeoutMs and the boot takes the catch path; earlyExit and
      // spawnError aren't fired by us. Pin the code: a failure raised before
      // spawn attaches no listener, so the assertions below go vacuous.
      const signal = getFailureSignal(
        await bootElectronApp({
          appPath: appDir,
          port: UNREACHABLE_CDP_PORT,
          readyTimeoutMs: 100,
        }).catch((e: unknown) => e)
      );
      expect(signal?.error_code).toBe(FAILURE_CODES.CHROMIUM_ELECTRON_CDP_TIMEOUT);
      expect(signal?.failure_stage).toBe("electron_cdp_ready");

      // Both listeners must be detached in the catch path.
      expect(child.listenerCount("error")).toBe(0);
      expect(child.listenerCount("exit")).toBe(0);

      // killChildEscalating already fired SIGTERM on the (mock) child; in
      // production that would cause the kernel to deliver `'exit'` shortly
      // after. Simulate it now — the detached listener must NOT chain into
      // an earlyExit rejection (which would arrive as an unhandled
      // rejection on an orphan promise).
      child.emit("exit", null, "SIGTERM");

      await new Promise((r) => setImmediate(r));
      expect(unhandled).toBe(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("reports the deferred spawn error of a pidless child - errno and install hint, no unhandled rejection", async () => {
    // Node reports an unresolvable binary both ways: `spawn()` returns a child
    // with no pid AND emits ENOENT on the next tick. That event carries the
    // cause, so it must become the rejection rather than escape as an uncaught
    // `error` event, which would kill the whole tool-server.
    const child = makeFakeChild({ pid: undefined });
    spawnMock.mockImplementation(() => {
      process.nextTick(() => {
        const err = new Error("spawn electron ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        child.emit("error", err);
      });
      return child;
    });

    let unhandledRejections = 0;
    const onUnhandled = () => {
      unhandledRejections++;
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const err = await bootElectronApp({
        appPath: appDir,
        port: UNREACHABLE_CDP_PORT,
        readyTimeoutMs: 100,
      }).catch((e: unknown) => e);
      expect((err as Error).message).toMatch(
        /failed to launch electron \(ENOENT\).*installed.*PATH/
      );
      expect(getFailureSignal(err)?.failure_stage).toBe("electron_spawn_error");

      // Give microtasks a tick to surface any unhandled rejection.
      await new Promise((r) => setImmediate(r));
      expect(unhandledRejections).toBe(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
