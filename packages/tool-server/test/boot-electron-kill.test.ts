/**
 * Teardown-path tests for runner-booted Chromium: `killChromiumByPort` must
 * prefer the ChildProcess handle retained at boot — whose exitCode/signalCode
 * guard skips the delayed leader SIGKILL once the child has exited, while the
 * group sweep escalates on a signal-0 liveness probe of the group — and only
 * fall back to group signalling on the raw pid (group SIGTERM, then a
 * probe-gated group SIGKILL) once the child has left the registry.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { scopeTempHome } from "./helpers/temp-home";

scopeTempHome("argent-boot-electron-kill-home-");

const spawnMock = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: (cmd: string, args: string[], opts: unknown) => spawnMock(cmd, args, opts),
  };
});
// Keep trackChromiumPort from persisting booted ports to on-disk state.
vi.mock("../src/utils/chromium-discovery", () => ({
  trackChromiumPort: vi.fn(),
  untrackChromiumPort: vi.fn(),
}));

import {
  bootElectronApp,
  killChromiumByPort,
  killChromiumByPortAndWait,
} from "../src/tools/devices/boot-electron";

const FAKE_PID = 4242;

interface FakeChild extends EventEmitter {
  pid: number | undefined;
  stderr: EventEmitter;
  unref: () => void;
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

function makeFakeChild(): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  ee.pid = FAKE_PID;
  ee.stderr = new EventEmitter();
  ee.unref = () => {};
  ee.kill = vi.fn(() => true);
  ee.exitCode = null;
  ee.signalCode = null;
  return ee;
}

let appDir: string;
beforeAll(() => {
  // resolveLauncher() fs-checks the app path before spawn, so the test needs
  // a real directory on disk. The spawn itself is mocked, so the contents
  // don't matter — only the path's existence.
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-boot-electron-kill-test-"));
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
  // Teardown sweeps the child's process group. The fake children carry a
  // stand-in pid, so real signals must never escape the test; individual tests
  // re-spy when they need to assert on the calls.
  vi.spyOn(process, "kill").mockImplementation(() => true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * Minimal CDP stub: only /json/version, which is all waitForCdpReady probes.
 * Booting against it lands the fake child in the boot-electron handle
 * registry, which is the state under test.
 */
async function bootFakeChild(): Promise<{ child: FakeChild; port: number; close: () => void }> {
  const child = makeFakeChild();
  spawnMock.mockReturnValue(child);

  const srv = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/json/version") {
      res.end(JSON.stringify({ "Browser": "Chrome/Test", "Protocol-Version": "1.3" }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address() as { port: number };

  await bootElectronApp({ appPath: appDir, port, readyTimeoutMs: 5000 });
  // Both guards are load-bearing: the mock above has to actually intercept
  // trackChromiumPort — deleted or calling through, it is invisible — and the
  // scoped HOME keeps the port every boot here persists out of the real file.
  expect(fs.existsSync(path.join(os.homedir(), ".argent", "chromium-cdp-ports.json"))).toBe(false);
  return { child, port, close: () => srv.close() };
}

describe("killChromiumByPort — handle path", () => {
  it("kills through the retained handle: SIGTERM, then SIGKILL once the grace period elapses with the child still running", async () => {
    const { child, port, close } = await bootFakeChild();
    try {
      vi.useFakeTimers();
      killChromiumByPort(port, FAKE_PID);

      // The handle path was taken (child.kill, not process.kill on a raw pid).
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");

      // Child ignores the SIGTERM (exitCode stays null) → escalate after 2s.
      vi.advanceTimersByTime(2000);
      expect(child.kill).toHaveBeenCalledTimes(2);
      expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
    } finally {
      close();
    }
  });

  it("skips the delayed SIGKILL when the child exits within the grace period (the recycled-pid guard)", async () => {
    const { child, port, close } = await bootFakeChild();
    try {
      vi.useFakeTimers();
      killChromiumByPort(port, FAKE_PID);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");

      // The SIGTERM lands: the child exits before the escalation timer fires.
      child.exitCode = 0;
      vi.advanceTimersByTime(2000);

      expect(child.kill).toHaveBeenCalledTimes(1); // no SIGKILL
    } finally {
      close();
    }
  });

  it("sends no group SIGTERM while the handle is live — the wrapper forwards it for a clean quit", async () => {
    // A group SIGTERM here would hit the browser and every Chromium helper
    // directly, bypassing Electron's quit sequence (before-quit/will-quit
    // never run). The handle SIGTERM alone must carry the graceful request.
    const { child, port, close } = await bootFakeChild();
    try {
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
      vi.useFakeTimers();

      killChromiumByPort(port, FAKE_PID);

      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(-FAKE_PID, "SIGTERM");
    } finally {
      close();
    }
  });

  it("sends the group SIGTERM when the child already exited, so orphaned survivors get a graceful request", async () => {
    // The boot-failure path's shape: the child died (or was never viable)
    // before the kill, so child.kill reaches nothing and the group SIGTERM
    // must carry the graceful request to any surviving helpers.
    const { child, port, close } = await bootFakeChild();
    try {
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
      vi.useFakeTimers();
      child.exitCode = 0;

      killChromiumByPort(port, FAKE_PID);

      expect(killSpy).toHaveBeenCalledWith(-FAKE_PID, "SIGTERM");
    } finally {
      close();
    }
  });

  it("escalates the group to SIGKILL when anything in it outlives the grace period", async () => {
    const { child, port, close } = await bootFakeChild();
    try {
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
      vi.useFakeTimers();
      killChromiumByPort(port, FAKE_PID);
      // The leader exits promptly; a helper does not. The old exit-status guard
      // alone would skip the escalation and strand it.
      child.exitCode = 0;
      vi.advanceTimersByTime(2000);

      expect(child.kill).toHaveBeenCalledTimes(1); // no SIGKILL on the leader
      expect(killSpy).toHaveBeenCalledWith(-FAKE_PID, 0); // group liveness probe
      expect(killSpy).toHaveBeenCalledWith(-FAKE_PID, "SIGKILL");
    } finally {
      close();
    }
  });

  it("does not escalate a group that already emptied", async () => {
    const { child, port, close } = await bootFakeChild();
    try {
      const killSpy = vi.spyOn(process, "kill").mockImplementation(((
        _pid: number,
        signal: NodeJS.Signals | 0
      ) => {
        if (signal === 0) {
          const err: NodeJS.ErrnoException = new Error("no such process");
          err.code = "ESRCH";
          throw err;
        }
        return true;
      }) as typeof process.kill);
      vi.useFakeTimers();
      killChromiumByPort(port, FAKE_PID);
      child.exitCode = 0;
      vi.advanceTimersByTime(2000);

      const signals = killSpy.mock.calls.map((c) => c[1]);
      expect(signals).not.toContain("SIGKILL");
    } finally {
      close();
    }
  });
});

describe("killChromiumByPort — raw-pid fallback", () => {
  it("falls back to group signalling after the child's exit evicted the handle, and the liveness probe suppresses the SIGKILL", async () => {
    const { child, port, close } = await bootFakeChild();
    try {
      // Natural exit (e.g. the user closed the window): the cleanup listener
      // must drop the handle from the registry.
      child.emit("exit", 0, null);

      const killSpy = vi
        .spyOn(process, "kill")
        .mockImplementation((_pid: number, signal?: string | number) => {
          if (signal === 0) {
            // By probe time the group is empty.
            const err = new Error("kill ESRCH") as NodeJS.ErrnoException;
            err.code = "ESRCH";
            throw err;
          }
          return true;
        });

      vi.useFakeTimers();
      killChromiumByPort(port, FAKE_PID);

      // Handle gone → raw-pid fallback, never the stale ChildProcess.
      expect(child.kill).not.toHaveBeenCalled();
      expect(killSpy).toHaveBeenCalledWith(-FAKE_PID, "SIGTERM");

      vi.advanceTimersByTime(2000);

      // The 0-probe reported ESRCH → the SIGKILL must be suppressed so it
      // cannot land on a recycled pgid.
      expect(killSpy).toHaveBeenCalledWith(-FAKE_PID, 0);
      const signals = killSpy.mock.calls.map((c) => c[1]);
      expect(signals).not.toContain("SIGKILL");
    } finally {
      close();
    }
  });

  it("escalates the fallback to a group SIGKILL when the group is still alive at probe time", () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.useFakeTimers();

    // Port never registered → straight to the pid fallback.
    killChromiumByPort(59999, FAKE_PID);
    expect(killSpy).toHaveBeenCalledWith(-FAKE_PID, "SIGTERM");

    vi.advanceTimersByTime(2000);
    expect(killSpy).toHaveBeenCalledWith(-FAKE_PID, 0);
    expect(killSpy).toHaveBeenCalledWith(-FAKE_PID, "SIGKILL");
  });

  it("still arms the group escalation when the leader pid is already gone but the group is not", async () => {
    // The asymmetric leak: the wrapper died independently (external kill -9,
    // OOM kill), evicting the handle, and its bare pid reports ESRCH — while
    // the browser and helpers keep the group alive. A leader-only fallback
    // would return early here and never signal any of them.
    const { child, port, close } = await bootFakeChild();
    try {
      child.emit("exit", null, "SIGKILL");

      const killSpy = vi.spyOn(process, "kill").mockImplementation(((
        pid: number,
        _signal: NodeJS.Signals | 0
      ) => {
        if (pid === FAKE_PID) {
          const err: NodeJS.ErrnoException = new Error("no such process");
          err.code = "ESRCH";
          throw err; // the leader is gone; only group members survive
        }
        return true;
      }) as typeof process.kill);

      vi.useFakeTimers();
      killChromiumByPort(port, FAKE_PID);

      expect(child.kill).not.toHaveBeenCalled();
      expect(killSpy).toHaveBeenCalledWith(-FAKE_PID, "SIGTERM");

      vi.advanceTimersByTime(2000);
      expect(killSpy).toHaveBeenCalledWith(-FAKE_PID, 0);
      expect(killSpy).toHaveBeenCalledWith(-FAKE_PID, "SIGKILL");
    } finally {
      close();
    }
  });

  it("is a no-op when no handle is registered and no pid is provided", () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    killChromiumByPort(58888);
    expect(killSpy).not.toHaveBeenCalled();
  });
});

/** When the faked process group starts reporting ESRCH, in the raw-pid poll tests. */
const GONE_AFTER_MS = 40;

describe("killChromiumByPortAndWait", () => {
  it("resolves only once the child has actually exited", async () => {
    const { child, port, close } = await bootFakeChild();
    try {
      let settled = false;
      const waited = killChromiumByPortAndWait(port, FAKE_PID).then(() => {
        settled = true;
      });

      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      // The signal is out, but the process is still holding its lock. Flushed
      // through a macrotask so a wait that never awaits the child at all shows
      // up here as already-settled rather than passing on microtask timing.
      await new Promise((r) => setTimeout(r, 20));
      expect(settled).toBe(false);

      child.exitCode = 0;
      child.emit("exit", 0, null);
      await waited;
      expect(settled).toBe(true);
    } finally {
      close();
    }
  });

  it("gives up after the timeout so a wedged process can't stall a run", async () => {
    const { child, port, close } = await bootFakeChild();
    try {
      // Child never emits exit — the wait must still resolve.
      await killChromiumByPortAndWait(port, FAKE_PID, 20);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      close();
    }
  });

  it("returns immediately when the child already exited", async () => {
    const { child, port, close } = await bootFakeChild();
    try {
      child.exitCode = 0;
      // No exit event is ever emitted here, so a wait that didn't notice the
      // already-exited child would hang past the test timeout.
      await killChromiumByPortAndWait(port, FAKE_PID, 30_000);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      close();
    }
  });

  it("polls the group when no handle is held, and stops once it reports ESRCH", async () => {
    let alive = true;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((
      _pid: number,
      signal: NodeJS.Signals | 0
    ) => {
      if (signal === 0 && !alive) {
        const err: NodeJS.ErrnoException = new Error("no such process");
        err.code = "ESRCH";
        throw err;
      }
      return true;
    }) as typeof process.kill);
    setTimeout(() => {
      alive = false;
    }, GONE_AFTER_MS).unref();

    // Port never registered → the raw-pid path, which has no exit event to await.
    const started = Date.now();
    await killChromiumByPortAndWait(59998, FAKE_PID, 2000);
    const elapsed = Date.now() - started;

    expect(killSpy).toHaveBeenCalledWith(-FAKE_PID, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(-FAKE_PID, 0);
    // Two-sided: it must not return while the group is still alive (the whole
    // point — the replacement would race the lock), and must not burn the whole
    // budget once it is gone (every handle-less retire would stall the flow).
    expect(elapsed).toBeGreaterThanOrEqual(GONE_AFTER_MS);
    expect(elapsed).toBeLessThan(1000);
  });

  it("does not return while the group is still alive, even though the leader itself is gone", async () => {
    // The single-instance lock the wait guards is held by the browser — a
    // group member — so leader liveness is the wrong signal: here the bare pid
    // reports ESRCH from the start while the group lives on for a while.
    let groupAlive = true;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((
      pid: number,
      signal: NodeJS.Signals | 0
    ) => {
      const err: NodeJS.ErrnoException = new Error("no such process");
      err.code = "ESRCH";
      if (pid === FAKE_PID) throw err; // the leader is already dead
      if (signal === 0 && !groupAlive) throw err;
      return true;
    }) as typeof process.kill);
    setTimeout(() => {
      groupAlive = false;
    }, GONE_AFTER_MS).unref();

    const started = Date.now();
    await killChromiumByPortAndWait(59997, FAKE_PID, 2000);
    const elapsed = Date.now() - started;

    expect(killSpy).toHaveBeenCalledWith(-FAKE_PID, 0);
    expect(elapsed).toBeGreaterThanOrEqual(GONE_AFTER_MS);
    expect(elapsed).toBeLessThan(1000);
  });
});
