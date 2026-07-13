/**
 * Teardown-path tests for runner-booted Chromium: `killChromiumByPort` must
 * prefer the ChildProcess handle retained at boot — whose exitCode/signalCode
 * guard lets killChildEscalating skip the delayed SIGKILL once the child has
 * exited, so it can never land on a recycled pid — and only fall back to
 * raw-pid signalling (with a signal-0 liveness re-probe before the SIGKILL)
 * once the child has left the registry.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as http from "node:http";
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
// Keep trackChromiumPort from persisting booted ports to on-disk state.
vi.mock("../src/utils/chromium-discovery", () => ({
  trackChromiumPort: vi.fn(),
  untrackChromiumPort: vi.fn(),
}));

import { bootElectronApp, killChromiumByPort } from "../src/tools/devices/boot-electron";

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
});

describe("killChromiumByPort — raw-pid fallback", () => {
  it("falls back to pid signalling after the child's exit evicted the handle, and the liveness probe suppresses the SIGKILL", async () => {
    const { child, port, close } = await bootFakeChild();
    try {
      // Natural exit (e.g. the user closed the window): the cleanup listener
      // must drop the handle from the registry.
      child.emit("exit", 0, null);

      const killSpy = vi
        .spyOn(process, "kill")
        .mockImplementation((_pid: number, signal?: string | number) => {
          if (signal === 0) {
            // By probe time the process is gone.
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
      expect(killSpy).toHaveBeenCalledWith(FAKE_PID, "SIGTERM");

      vi.advanceTimersByTime(2000);

      // The 0-probe reported ESRCH → the SIGKILL must be suppressed so it
      // cannot land on a recycled pid.
      expect(killSpy).toHaveBeenCalledWith(FAKE_PID, 0);
      const signals = killSpy.mock.calls.map((c) => c[1]);
      expect(signals).not.toContain("SIGKILL");
    } finally {
      close();
    }
  });

  it("escalates the fallback to SIGKILL when the pid is still alive at probe time", () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.useFakeTimers();

    // Port never registered → straight to the pid fallback.
    killChromiumByPort(59999, FAKE_PID);
    expect(killSpy).toHaveBeenCalledWith(FAKE_PID, "SIGTERM");

    vi.advanceTimersByTime(2000);
    expect(killSpy).toHaveBeenCalledWith(FAKE_PID, 0);
    expect(killSpy).toHaveBeenCalledWith(FAKE_PID, "SIGKILL");
  });

  it("is a no-op when no handle is registered and no pid is provided", () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    killChromiumByPort(58888);
    expect(killSpy).not.toHaveBeenCalled();
  });
});
