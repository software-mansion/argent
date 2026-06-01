/**
 * Regression test: `attemptBoot` in `boot-device.ts` must register an `error`
 * event handler on the spawned `emulator` ChildProcess. Node's spawn emits an
 * `error` event when the binary cannot be exec'd (e.g. ENOENT/EACCES — emulator
 * binary removed or permission flipped mid-flight, transient FS hiccup).
 * EventEmitter convention is that an unhandled `error` event escapes as an
 * uncaught exception that crashes the host process; without a listener, the
 * tool-server would crash instead of returning a clean error to the caller.
 *
 * The boot promise must also reject (not hang) and the in-flight Map entry
 * must be cleared so a retry doesn't coalesce into the dead promise.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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
      if (result instanceof Error) {
        const e = result as Error & { stderr?: string; stdout?: string };
        callback(e, { stdout: e.stdout ?? "", stderr: e.stderr ?? "" });
      } else callback(null, result ?? { stdout: "", stderr: "" });
    },
    spawn: (cmd: string, args: string[], opts: unknown) => spawnMock(cmd, args, opts),
  };
});

// `boot-device` now goes through `resolveAndroidBinary` for both ensureDep
// and the spawn path. Stub the resolver to return the bare name so existing
// `cmd === "adb" / "emulator"` and `spawnMock("emulator", ...)` matchers fire
// regardless of host SDK install state.
vi.mock("../src/utils/android-binary", () => ({
  resolveAndroidBinary: vi.fn(async (name: "adb" | "emulator") => name),
  __resetAndroidBinaryCacheForTesting: () => {},
}));

// Stub the snapshot probes so pre-flight does no real ~/.android filesystem
// I/O. That keeps the whole boot path on microtasks + faked timers, which
// vitest fake timers drive deterministically. Returning `false` forces the
// cold path — behaviour-identical to the real probe for a fake AVD that has
// no default_boot snapshot on disk. (Same partial-mock shape used in
// boot-device-hotboot.test.ts.)
vi.mock("../src/utils/adb", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/adb")>("../src/utils/adb");
  return {
    ...actual,
    hasDefaultBootSnapshot: async () => false,
    checkSnapshotLoadable: async () => ({ loadable: false, reason: "test" }),
  };
});

import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";
import {
  __resetInFlightBootsForTesting,
  createBootDeviceTool,
} from "../src/tools/devices/boot-device";
import type { Registry } from "@argent/registry";
import { EventEmitter } from "node:events";

beforeEach(() => {
  execFileMock.mockReset();
  spawnMock.mockReset();
  __resetDepCacheForTests();
  __primeDepCacheForTests(["adb"]);
  __resetInFlightBootsForTesting();
});

describe("boot-device — spawn error handling", () => {
  it("registers an `error` listener on the spawned emulator child", async () => {
    vi.useFakeTimers();
    try {
      const proc = new EventEmitter() as EventEmitter & {
        unref: () => void;
        kill: (sig?: string) => boolean;
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
      };
      proc.unref = () => {};
      proc.kill = () => true;
      proc.exitCode = null;
      proc.signalCode = null;
      spawnMock.mockReturnValue(proc);

      execFileMock.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === "emulator" && args[0] === "-list-avds") {
          return { stdout: "Pixel_7_API_34\n", stderr: "" };
        }
        if (cmd === "adb" && args[0] === "version") {
          return { stdout: "Android Debug Bridge\n", stderr: "" };
        }
        if (cmd === "adb" && args[0] === "start-server") return { stdout: "", stderr: "" };
        if (cmd === "adb" && args[0] === "devices") {
          return { stdout: "List of devices attached\n", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      });

      const registry: Registry = { resolveService: async () => ({}) } as unknown as Registry;
      const tool = createBootDeviceTool(registry);
      const promise = tool.execute!({}, { avdName: "Pixel_7_API_34", bootTimeoutMs: 30_000 });
      promise.catch(() => {}); // detach so the test doesn't hang after assertion

      // Flush pre-flight microtasks so attemptBoot spawns the child and
      // synchronously attaches its listeners (adb is mocked → no real I/O).
      await vi.advanceTimersByTimeAsync(10);

      // Without an `error` listener, an emitted error escapes as an uncaught
      // exception and crashes the tool-server.
      expect(proc.listenerCount("error")).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  }, 5_000);

  it("rejects the boot promise and clears the in-flight entry when spawn emits `error`", async () => {
    vi.useFakeTimers();
    try {
      const proc = new EventEmitter() as EventEmitter & {
        unref: () => void;
        kill: (sig?: string) => boolean;
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
      };
      proc.unref = () => {};
      proc.kill = () => true;
      proc.exitCode = null;
      proc.signalCode = null;
      spawnMock.mockReturnValue(proc);

      execFileMock.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === "emulator" && args[0] === "-list-avds") {
          return { stdout: "Pixel_7_API_34\n", stderr: "" };
        }
        if (cmd === "adb" && args[0] === "version") {
          return { stdout: "Android Debug Bridge\n", stderr: "" };
        }
        if (cmd === "adb" && args[0] === "start-server") return { stdout: "", stderr: "" };
        if (cmd === "adb" && args[0] === "devices") {
          return { stdout: "List of devices attached\n", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      });

      const registry: Registry = { resolveService: async () => ({}) } as unknown as Registry;
      const tool = createBootDeviceTool(registry);
      const promise = tool.execute!({}, { avdName: "Pixel_7_API_34", bootTimeoutMs: 30_000 });
      promise.catch(() => {}); // detach so the rejection can't escape between advances

      // Reach spawn (the impl attaches the `error` listener synchronously
      // right after spawn(); adb is mocked so pre-flight is microtasks only).
      await vi.advanceTimersByTimeAsync(10);

      // Simulate ENOENT — emulator binary missing/exec failure.
      const spawnErr = new Error("spawn ENOENT") as NodeJS.ErrnoException;
      spawnErr.code = "ENOENT";
      proc.emit("error", spawnErr);

      // Stage-2 is parked on the adb-register poll; advancing past one poll
      // (>1s, the production cadence) wakes it so it throws the earlyExitError
      // instead of hanging. The boot promise must reject, not hang.
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(promise).rejects.toThrow(/ENOENT|spawn|emulator/i);

      // The in-flight Map entry must be cleared so a retry doesn't coalesce
      // into the dead promise. We assert this indirectly: a second call for the
      // same AVD must invoke spawn again rather than awaiting the prior promise.
      spawnMock.mockClear();

      const secondProc = new EventEmitter() as EventEmitter & {
        unref: () => void;
        kill: (sig?: string) => boolean;
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
      };
      secondProc.unref = () => {};
      secondProc.kill = () => true;
      secondProc.exitCode = null;
      secondProc.signalCode = null;
      spawnMock.mockReturnValue(secondProc);

      const second = tool.execute!({}, { avdName: "Pixel_7_API_34", bootTimeoutMs: 30_000 });
      second.catch(() => {}); // detach

      // Give the second call enough fake time to reach spawn.
      await vi.advanceTimersByTimeAsync(10);
      expect(spawnMock).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);
});
