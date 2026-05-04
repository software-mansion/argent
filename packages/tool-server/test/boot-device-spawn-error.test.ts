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
    const promise = tool.execute!(
      {},
      { avdName: "Pixel_7_API_34", bootTimeoutMs: 30_000, noWindow: true }
    );
    promise.catch(() => {}); // detach so the test doesn't hang after assertion

    // Give the impl one tick to subscribe to the proc.
    await new Promise((r) => setTimeout(r, 50));

    // Without an `error` listener, an emitted error escapes as an uncaught
    // exception and crashes the tool-server.
    expect(proc.listenerCount("error")).toBeGreaterThan(0);
  }, 5_000);

  it("rejects the boot promise and clears the in-flight entry when spawn emits `error`", async () => {
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
    const promise = tool.execute!(
      {},
      { avdName: "Pixel_7_API_34", bootTimeoutMs: 30_000, noWindow: true }
    );

    // Let attemptBoot subscribe to the proc.
    await new Promise((r) => setTimeout(r, 50));

    // Simulate ENOENT — emulator binary missing/exec failure.
    const spawnErr = new Error("spawn ENOENT") as NodeJS.ErrnoException;
    spawnErr.code = "ENOENT";
    proc.emit("error", spawnErr);

    // The boot promise must reject (not hang) — the error must surface to the caller.
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

    const second = tool.execute!(
      {},
      { avdName: "Pixel_7_API_34", bootTimeoutMs: 30_000, noWindow: true }
    );
    second.catch(() => {}); // detach

    // Give the second call a tick to reach spawn.
    await new Promise((r) => setTimeout(r, 50));
    expect(spawnMock).toHaveBeenCalled();
  }, 10_000);
});
