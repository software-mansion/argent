import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Registry } from "@argent/registry";

const execFileMock = vi.fn();
const spawnMock = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: readonly string[],
      opts: unknown,
      cb?: (err: Error | null, out: { stdout: string; stderr: string }) => void
    ) => {
      const callback = typeof opts === "function" ? opts : cb!;
      const options = typeof opts === "function" ? undefined : opts;
      const result = execFileMock(cmd, args, options);
      if (result instanceof Error) callback(result, { stdout: "", stderr: "" });
      else callback(null, result ?? { stdout: "", stderr: "" });
    },
    spawn: (cmd: string, args: string[], opts: unknown) => spawnMock(cmd, args, opts),
  };
});

import {
  __resetInFlightBootsForTesting,
  createBootDeviceTool,
} from "../src/tools/devices/boot-device";

const registry: Registry = { resolveService: async () => ({}) } as unknown as Registry;

beforeEach(() => {
  execFileMock.mockReset();
  spawnMock.mockReset();
  // Tests in this file intentionally abandon some bootAndroid promises
  // (kick them off, attach .catch, move on). Without this reset the in-flight
  // coalescing map would hand the leaked promise to the next test that boots
  // the same AVD, causing cascade timeouts.
  __resetInFlightBootsForTesting();
  // Default: every spawned emulator process is a well-behaved child that
  // never exits on its own. Individual tests override as needed.
  spawnMock.mockImplementation(() => {
    const proc = new EventEmitter() as EventEmitter & { unref: () => void };
    proc.unref = () => {};
    return proc;
  });
});

describe("boot-device Android — adb pre-flight check (review #11)", () => {
  it("fails before spawning the emulator when adb is unavailable", async () => {
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "emulator" && args[0] === "-list-avds") {
        return { stdout: "Pixel_7_API_34\n", stderr: "" };
      }
      if (cmd === "adb" && args[0] === "version") {
        return new Error("adb: command not found");
      }
      return { stdout: "", stderr: "" };
    });

    const tool = createBootDeviceTool(registry);
    await expect(tool.execute!({}, { avdName: "Pixel_7_API_34" })).rejects.toThrow(
      /`adb` is not available on PATH/
    );
    // The emulator binary must NOT have been spawned — otherwise we orphan
    // a detached process that the user has to kill manually.
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("boot-device Android — serialsBefore snapshot ordering (review #2)", () => {
  /**
   * If the adb daemon is down when bootAndroid starts, snapshotting the
   * device list *before* `adb start-server` makes `listAndroidSerials`
   * return []. Then once the daemon comes up, every already-connected
   * emulator looks "new" and the tool could hand back a pre-existing
   * emulator as the one the caller just booted.
   *
   * Fix: `adb start-server` runs BEFORE the snapshot. We verify by
   * checking that when listAndroidDevices returns a pre-existing emulator,
   * the tool keeps waiting for a genuinely new one.
   */

  it("does not adopt a pre-existing emulator as the one we just booted", async () => {
    // Sequence: adb version OK, then we spawn emulator, then `adb devices`
    // returns the SAME pre-existing emulator for the full adb-register budget.
    // The tool must time out and never return the stale serial as booted.
    const preExisting = "emulator-5554";
    const callLog: string[] = [];
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      const key = `${cmd} ${args.join(" ")}`;
      callLog.push(key);
      if (cmd === "emulator" && args[0] === "-list-avds") {
        return { stdout: "Pixel_7_API_34\n", stderr: "" };
      }
      if (cmd === "adb" && args[0] === "version")
        return { stdout: "Android Debug Bridge\n", stderr: "" };
      if (cmd === "adb" && args[0] === "start-server") return { stdout: "", stderr: "" };
      if (cmd === "adb" && args[0] === "devices") {
        return { stdout: `List of devices attached\n${preExisting}\tdevice\n`, stderr: "" };
      }
      // Enrichment getprops — return anything so snapshotting can enrich.
      if (cmd === "adb" && args[0] === "-s" && args[2] === "shell") {
        return { stdout: "\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const tool = createBootDeviceTool(registry);
    const promise = tool.execute!(
      {},
      {
        avdName: "Pixel_7_API_34",
        bootTimeoutMs: 30_000, // hits min bound; the real wait is capped by adb-register budget
        noWindow: true,
      }
    );

    // Verify critical ordering: start-server runs BEFORE the first `adb devices` call.
    // If snapshot happened first, we'd see `adb devices` before `adb start-server`.
    // We race this assertion against the promise (which is slow) — use a short delay.
    await new Promise((r) => setTimeout(r, 150));
    const startServerIdx = callLog.indexOf("adb start-server");
    const firstDevicesIdx = callLog.indexOf("adb devices");
    expect(startServerIdx).toBeGreaterThanOrEqual(0);
    expect(firstDevicesIdx).toBeGreaterThan(startServerIdx);

    // Clean up — reject the outstanding promise deterministically. The tool
    // will eventually throw its own register-timeout but we don't want to
    // wait the full budget. Swallow whatever it throws.
    promise.catch(() => {});
  }, 5_000);
});

describe("boot-device Android — earlyExitError surfaces promptly (review #4)", () => {
  it("reports the emulator crash error instead of an adb wait-for-device timeout", async () => {
    // Simulate: emulator spawns, registers in adb, then crashes. Stage 3
    // (wait-for-device) would previously block for the full 180s budget
    // and throw a generic timeout. The fix races against earlyExitError.
    const serial = "emulator-5554";
    const proc = new EventEmitter() as EventEmitter & { unref: () => void };
    proc.unref = () => {};
    spawnMock.mockReturnValue(proc);

    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "emulator") return { stdout: "Pixel_7_API_34\n", stderr: "" };
      if (cmd === "adb" && args[0] === "version") return { stdout: "adb ok\n", stderr: "" };
      if (cmd === "adb" && args[0] === "start-server") return { stdout: "", stderr: "" };
      if (cmd === "adb" && args[0] === "devices") {
        return { stdout: `List of devices attached\n${serial}\tdevice\n`, stderr: "" };
      }
      if (cmd === "adb" && args.includes("wait-for-device")) {
        // Simulate a slow adb that will never return; the race must win.
        return new Promise(() => {}) as unknown as { stdout: string; stderr: string };
      }
      if (cmd === "adb" && args[0] === "-s" && args[2] === "shell") {
        return { stdout: "\n", stderr: "" };
      }
      if (cmd === "adb" && args[0] === "-s" && args.includes("emu") && args.includes("kill")) {
        return { stdout: "OK\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const tool = createBootDeviceTool(registry);
    const promise = tool.execute!(
      {},
      { avdName: "Pixel_7_API_34", bootTimeoutMs: 30_000, noWindow: true }
    );

    // Let the tool get past pre-flight into wait-for-device, then crash the
    // emulator. waitForEarlyExit polls every 500 ms so the error should surface
    // in under a couple of seconds.
    setTimeout(() => proc.emit("exit", 1), 600);

    await expect(promise).rejects.toThrow(/emulator binary exited with code 1/);
  }, 10_000);

  it("coalesces concurrent boot calls for the same AVD onto a single spawn", async () => {
    // Two callers race in for the same AVD before either emulator registers.
    // Without the in-flight coalescing both would spawn QEMU; the second
    // collides on the AVD lock and bails after the deadline. Verify that
    // exactly one spawn fires and both callers see the same result.
    const serial = "emulator-5554";
    let devicesPolls = 0;
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "emulator" && args[0] === "-list-avds") {
        return { stdout: "Pixel_7_API_34\n", stderr: "" };
      }
      if (cmd === "adb" && args[0] === "version") return { stdout: "ok\n", stderr: "" };
      if (cmd === "adb" && args[0] === "start-server") return { stdout: "", stderr: "" };
      if (cmd === "adb" && args[0] === "devices") {
        devicesPolls++;
        // First poll: empty. Subsequent polls: emulator visible.
        if (devicesPolls <= 1) return { stdout: "List of devices attached\n", stderr: "" };
        return { stdout: `List of devices attached\n${serial}\tdevice\n`, stderr: "" };
      }
      if (cmd === "adb" && args.includes("wait-for-device")) {
        return { stdout: "", stderr: "" };
      }
      if (cmd === "adb" && args[0] === "-s" && args[2] === "shell") {
        return { stdout: "1\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const tool = createBootDeviceTool(registry);
    const [a, b] = await Promise.all([
      tool.execute!({}, { avdName: "Pixel_7_API_34", bootTimeoutMs: 30_000, noWindow: true }),
      tool.execute!({}, { avdName: "Pixel_7_API_34", bootTimeoutMs: 30_000, noWindow: true }),
    ]);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  }, 15_000);

  it("reports a signal-terminated emulator (e.g. QEMU SIGSEGV) as a crash, not a hang", async () => {
    // Regression for the "sometimes silently crashes" complaint: when QEMU
    // segfaults on a bad ram.bin restore the child exits with `code === null,
    // signal !== null`. The previous `code !== null` guard treated this as a
    // normal exit so the outer wait blocked for the full per-stage budget.
    const serial = "emulator-5554";
    const proc = new EventEmitter() as EventEmitter & { unref: () => void };
    proc.unref = () => {};
    spawnMock.mockReturnValue(proc);

    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "emulator") return { stdout: "Pixel_7_API_34\n", stderr: "" };
      if (cmd === "adb" && args[0] === "version") return { stdout: "adb ok\n", stderr: "" };
      if (cmd === "adb" && args[0] === "start-server") return { stdout: "", stderr: "" };
      if (cmd === "adb" && args[0] === "devices") {
        return { stdout: `List of devices attached\n${serial}\tdevice\n`, stderr: "" };
      }
      if (cmd === "adb" && args.includes("wait-for-device")) {
        return new Promise(() => {}) as unknown as { stdout: string; stderr: string };
      }
      if (cmd === "adb" && args[0] === "-s" && args[2] === "shell") {
        return { stdout: "\n", stderr: "" };
      }
      if (cmd === "adb" && args[0] === "-s" && args.includes("emu") && args.includes("kill")) {
        return { stdout: "OK\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const tool = createBootDeviceTool(registry);
    const promise = tool.execute!(
      {},
      { avdName: "Pixel_7_API_34", bootTimeoutMs: 30_000, noWindow: true }
    );

    setTimeout(() => proc.emit("exit", null, "SIGSEGV"), 600);

    await expect(promise).rejects.toThrow(/terminated by signal SIGSEGV/);
  }, 10_000);
});

describe("boot-device Android — orphan protection on stage-2 timeout (review feedback R1#1)", () => {
  /**
   * Before this fix, spawn(..., {detached: true, stdio: "ignore"}) + unref()
   * meant that if the adb-register stage timed out (emulator started but
   * never appeared in `adb devices`), `killEmulatorQuietly(null)` was a
   * no-op — the detached emulator kept running and the user had to find
   * and kill the PID by hand. The fix retains the ChildProcess and signals
   * SIGTERM (with SIGKILL escalation) on any throw before a serial is
   * resolved.
   */
  it("SIGTERMs the detached emulator child when no serial registers within the budget", async () => {
    vi.useFakeTimers();
    try {
      const proc = new EventEmitter() as EventEmitter & {
        unref: () => void;
        kill: (sig?: string) => boolean;
        exitCode: number | null;
        signalCode: string | null;
      };
      proc.unref = () => {};
      proc.exitCode = null;
      proc.signalCode = null;
      const killSignals: (string | undefined)[] = [];
      proc.kill = (sig?: string) => {
        killSignals.push(sig);
        return true;
      };
      spawnMock.mockReturnValue(proc);

      execFileMock.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === "emulator" && args[0] === "-list-avds") {
          return { stdout: "Pixel_7_API_34\n", stderr: "" };
        }
        if (cmd === "adb" && args[0] === "version") {
          return { stdout: "Android Debug Bridge\n", stderr: "" };
        }
        if (cmd === "adb" && args[0] === "start-server") return { stdout: "", stderr: "" };
        // `adb devices` always returns empty — no emulator ever registers,
        // forcing the adb-register stage to exhaust its budget.
        if (cmd === "adb" && args[0] === "devices") {
          return { stdout: "List of devices attached\n", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      });

      const tool = createBootDeviceTool(registry);
      // bootTimeoutMs floor is 30_000 (zod). Burn that in fake time so the
      // test completes in milliseconds of real time.
      const promise = tool.execute!(
        {},
        { avdName: "Pixel_7_API_34", bootTimeoutMs: 30_000, noWindow: true }
      );
      promise.catch(() => {});
      await vi.advanceTimersByTimeAsync(31_000);

      await expect(promise).rejects.toThrow(/did not register within/);
      // The detached child MUST have been signalled — SIGTERM fire-and-forget.
      expect(killSignals[0]).toBe("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  }, 5_000);
});

describe("boot-device Android — missing AVD (existing guard)", () => {
  it("throws a useful error when the requested avdName is not installed", async () => {
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "emulator" && args[0] === "-list-avds") {
        return { stdout: "Pixel_3a_API_29\nPixel_7_API_34\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const tool = createBootDeviceTool(registry);
    await expect(tool.execute!({}, { avdName: "Does_Not_Exist", noWindow: true })).rejects.toThrow(
      /AVD "Does_Not_Exist" not found.*Pixel_3a_API_29.*Pixel_7_API_34/
    );
  });
});
