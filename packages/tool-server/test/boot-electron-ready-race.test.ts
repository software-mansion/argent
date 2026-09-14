/**
 * Regression tests for the ready-vs-exit race in `bootElectronApp`: a second
 * instance losing Electron's single-instance lock opens its
 * --remote-debugging-port listener during startup and only then quits, so the
 * CDP readiness probe can answer a beat before the child's exit event lands.
 * Boot must hold success for a short confirmation window and convert an exit
 * arriving inside it into the early-exit failure — never report a dead
 * instance as booted, tracked, or handle-registered.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { scopeTempHome } from "./helpers/temp-home";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";

scopeTempHome("argent-boot-electron-race-home-");

const spawnMock = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: (cmd: string, args: string[], opts: unknown) => spawnMock(cmd, args, opts),
  };
});
// Keep trackChromiumPort from persisting booted ports to on-disk state, and
// make "the dead instance was never tracked" assertable.
vi.mock("../src/utils/chromium-discovery", () => ({
  trackChromiumPort: vi.fn(),
  untrackChromiumPort: vi.fn(),
}));

import { bootElectronApp, killChromiumByPort } from "../src/tools/devices/boot-electron";
import { trackChromiumPort } from "../src/utils/chromium-discovery";

const FAKE_PID = 4242;

/** Boot pays the confirmation window on every success — mirror of the source constant. */
const BOOT_CONFIRM_WINDOW_MS = 300;

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
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-boot-electron-race-test-"));
  fs.writeFileSync(
    path.join(appDir, "package.json"),
    JSON.stringify({ name: "fake-electron-app", main: "main.js" })
  );
  fs.writeFileSync(path.join(appDir, "main.js"), "// fake\n");
});
afterAll(() => {
  if (appDir) fs.rmSync(appDir, { recursive: true, force: true });
});

// The confirmed-exit path runs killChildEscalating against a fake child
// carrying a stand-in pid, and its group sweep signals through process.kill —
// real signals must never escape onto whatever owns that pid. Never restored:
// the unref'd 2s escalation timer can fire after the test that armed it.
vi.spyOn(process, "kill").mockImplementation(() => true);

beforeEach(() => {
  spawnMock.mockReset();
  vi.mocked(trackChromiumPort).mockClear();
});

/**
 * Minimal CDP stub: only /json/version, which is all waitForCdpReady probes.
 * `served` resolves once the first probe has been answered, so a test can
 * sequence "CDP reported ready" against the child's exit.
 */
async function startCdpStub(): Promise<{ port: number; served: Promise<void>; close: () => void }> {
  let markServed!: () => void;
  const served = new Promise<void>((resolve) => (markServed = resolve));
  const srv = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/json/version") {
      res.end(JSON.stringify({ "Browser": "Chrome/Test", "Protocol-Version": "1.3" }));
      markServed();
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address() as { port: number };
  return { port, served, close: () => srv.close() };
}

describe("bootElectronApp — ready-vs-exit confirmation window", () => {
  it("rejects with the early-exit failure when the child exits just after CDP first answers (single-instance-lock quit)", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const { port, served, close } = await startCdpStub();

    let unhandled = 0;
    const onUnhandled = () => unhandled++;
    process.on("unhandledRejection", onUnhandled);
    try {
      const promise = bootElectronApp({ appPath: appDir, port, readyTimeoutMs: 5000 });
      promise.catch(() => {}); // observed via the assertions below

      // Let the probe response reach the client and settle the readiness race
      // on the success side — 50ms is loopback-safe and far inside the window.
      await served;
      await new Promise((r) => setTimeout(r, 50));

      // The lock-losing instance closes its listener and quits.
      child.exitCode = 0; // Node sets these synchronously before emitting 'exit'
      child.emit("exit", 0, null);

      await expect(promise).rejects.toThrow(/exited with code 0 before CDP was ready/);
      const signal = getFailureSignal(await promise.catch((e: unknown) => e));
      expect(signal?.error_code).toBe(FAILURE_CODES.CHROMIUM_ELECTRON_EXITED_BEFORE_READY);
      expect(signal?.failure_stage).toBe("electron_early_exit");

      // The dead instance must leave no trace of a successful boot: the port
      // is never tracked, and the cleanup SIGTERM comes from the catch path.
      expect(trackChromiumPort).not.toHaveBeenCalled();
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");

      // No handle was retained either — a teardown on this port must take the
      // raw-pid fallback instead of killing through the stale ChildProcess.
      const killsAfterCleanup = child.kill.mock.calls.length;
      killChromiumByPort(port, FAKE_PID);
      expect(child.kill.mock.calls.length).toBe(killsAfterCleanup);

      await new Promise((r) => setImmediate(r));
      expect(unhandled).toBe(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      close();
    }
  });

  it("still boots — after paying exactly the confirmation window — when no exit arrives inside it", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const { port, served, close } = await startCdpStub();

    try {
      const promise = bootElectronApp({ appPath: appDir, port, readyTimeoutMs: 5000 });
      await served;
      const readyAt = Date.now();

      const result = await promise;
      // Small epsilon: setTimeout can fire ~1ms shy of nominal.
      expect(Date.now() - readyAt).toBeGreaterThanOrEqual(BOOT_CONFIRM_WINDOW_MS - 5);
      expect(result.booted).toBe(true);
      expect(result.port).toBe(port);
      expect(result.pid).toBe(FAKE_PID);
      expect(trackChromiumPort).toHaveBeenCalledWith(port);
      // ...through the mock, and no further: one that calls through satisfies
      // the line above while still persisting the port for real.
      expect(fs.existsSync(path.join(os.homedir(), ".argent", "chromium-cdp-ports.json"))).toBe(
        false
      );

      // The handle was retained: teardown kills through it, not the raw pid.
      killChromiumByPort(port, FAKE_PID);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      close();
    }
  });
});
