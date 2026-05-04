import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Registry } from "@argent/registry";

const execFileMock = vi.fn();
const spawnMock = vi.fn();
const hasSnapshotMock = vi.fn();
const probeMock = vi.fn();

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

// Stub the two filesystem/probe helpers so tests don't depend on a real AVD or
// a real `emulator -check-snapshot-loadable` spawn.
vi.mock("../src/utils/adb", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/adb")>("../src/utils/adb");
  return {
    ...actual,
    hasDefaultBootSnapshot: (...a: unknown[]) => hasSnapshotMock(...a),
    checkSnapshotLoadable: (...a: unknown[]) => probeMock(...a),
  };
});

import {
  __resetInFlightBootsForTesting,
  createBootDeviceTool,
} from "../src/tools/devices/boot-device";

const registry: Registry = { resolveService: async () => ({}) } as unknown as Registry;

interface FakeChild extends EventEmitter {
  unref: () => void;
  kill: (sig?: string) => void;
  exitCode: number | null;
  signalCode: string | null;
}

function fakeChild(): FakeChild {
  const proc = new EventEmitter() as FakeChild;
  proc.unref = () => {};
  proc.kill = () => {};
  proc.exitCode = null;
  proc.signalCode = null;
  return proc;
}

beforeEach(() => {
  execFileMock.mockReset();
  spawnMock.mockReset();
  hasSnapshotMock.mockReset();
  probeMock.mockReset();
  spawnMock.mockImplementation(() => fakeChild());
  // Per-AVD in-flight coalescing carries leaked promises across tests; reset
  // so each test starts with an empty boot map. (See note in adjacent
  // boot-device-hardening.test.ts.)
  __resetInFlightBootsForTesting();
});

/**
 * Common happy-path mock: AVD exists, adb is healthy, `adb devices` reveals
 * one new emulator after spawn, wait-for-device succeeds, getprop returns 1,
 * pm path answers. Used to isolate the branch-selection logic under test.
 */
function mockHappyBootChain(newSerial = "emulator-5554") {
  let devicesCalls = 0;
  execFileMock.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === "emulator" && args[0] === "-list-avds") {
      return { stdout: "Pixel_7_API_34\n", stderr: "" };
    }
    if (cmd === "adb" && args[0] === "version") {
      return { stdout: "Android Debug Bridge\n", stderr: "" };
    }
    if (cmd === "adb" && args[0] === "start-server") return { stdout: "", stderr: "" };
    if (cmd === "adb" && args[0] === "devices") {
      devicesCalls += 1;
      const emuLine = devicesCalls >= 2 ? `${newSerial}\tdevice\n` : "";
      return { stdout: `List of devices attached\n${emuLine}`, stderr: "" };
    }
    if (cmd === "adb" && args[0] === "-s" && args[2] === "wait-for-device") {
      return { stdout: "", stderr: "" };
    }
    if (cmd === "adb" && args[0] === "-s" && args[2] === "shell") {
      const shellCmd = args[3] ?? "";
      if (shellCmd.startsWith("getprop sys.boot_completed")) {
        return { stdout: "1\n", stderr: "" };
      }
      if (shellCmd.startsWith("getprop")) return { stdout: "unknown\n", stderr: "" };
      if (shellCmd === "pm path android") {
        return { stdout: "package:/system/framework/framework-res.apk\n", stderr: "" };
      }
      if (shellCmd.startsWith("screencap")) return { stdout: "1\n", stderr: "" };
      return { stdout: "\n", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });
}

describe("boot-device Android — hot-boot with cold-boot fallback", () => {
  it("picks the hot-boot spawn args when a default_boot snapshot probes as Loadable", async () => {
    hasSnapshotMock.mockResolvedValue(true);
    probeMock.mockResolvedValue({ loadable: true, reason: null });
    mockHappyBootChain();

    const tool = createBootDeviceTool(registry);
    const result = await tool.execute!({}, { avdName: "Pixel_7_API_34" });

    expect(result).toMatchObject({
      platform: "android",
      serial: "emulator-5554",
      avdName: "Pixel_7_API_34",
      booted: true,
    });

    // Exactly one emulator spawn and it is the hot-boot arg set.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const hotArgs = spawnMock.mock.calls[0]![1];
    expect(hotArgs).toContain("-force-snapshot-load");
    expect(hotArgs).toContain("-no-snapshot-save");
    expect(hotArgs).not.toContain("-no-snapshot-load");
    // Window is always visible — `-no-window` must never appear in spawn args.
    expect(hotArgs).not.toContain("-no-window");
  });

  it("skips the hot-boot attempt and cold-boots when no snapshot exists on disk", async () => {
    hasSnapshotMock.mockResolvedValue(false);
    mockHappyBootChain();

    const tool = createBootDeviceTool(registry);
    await tool.execute!({}, { avdName: "Pixel_7_API_34" });

    expect(probeMock).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = spawnMock.mock.calls[0]![1];
    expect(args).toContain("-no-snapshot-load");
    expect(args).not.toContain("-force-snapshot-load");
    expect(args).not.toContain("-no-window");
  });

  it("skips the hot-boot attempt and cold-boots when -check-snapshot-loadable rejects", async () => {
    hasSnapshotMock.mockResolvedValue(true);
    probeMock.mockResolvedValue({ loadable: false, reason: "different renderer configured" });
    mockHappyBootChain();

    const tool = createBootDeviceTool(registry);
    await tool.execute!({}, { avdName: "Pixel_7_API_34" });

    // One spawn, and it is cold-boot args (no -force-snapshot-load).
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]![1]).toContain("-no-snapshot-load");
  });

  it("falls back to cold boot when hot-boot child exits early (ram.bin corruption class)", async () => {
    hasSnapshotMock.mockResolvedValue(true);
    probeMock.mockResolvedValue({ loadable: true, reason: null });
    // First spawn crashes immediately. Second spawn is healthy.
    let spawnCount = 0;
    spawnMock.mockImplementation(() => {
      const child = fakeChild();
      spawnCount += 1;
      if (spawnCount === 1) {
        setTimeout(() => child.emit("exit", 134, null), 10);
      }
      return child;
    });

    // Device-list mock must be spawn-aware: while the first (crashing) hot
    // attempt is in flight, `adb devices` shows no new emulator so the inner
    // boot loop stays in the wait and observes earlyExitError. Once the
    // second (cold) spawn happens, the new serial appears.
    let coldSerialVisible = false;
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "emulator" && args[0] === "-list-avds")
        return { stdout: "Pixel_7_API_34\n", stderr: "" };
      if (cmd === "adb" && args[0] === "version")
        return { stdout: "Android Debug Bridge\n", stderr: "" };
      if (cmd === "adb" && args[0] === "start-server") return { stdout: "", stderr: "" };
      if (cmd === "adb" && args[0] === "devices") {
        if (spawnCount >= 2) coldSerialVisible = true;
        const line = coldSerialVisible ? "emulator-5554\tdevice\n" : "";
        return { stdout: `List of devices attached\n${line}`, stderr: "" };
      }
      if (cmd === "adb" && args[0] === "-s" && args[2] === "wait-for-device") {
        return { stdout: "", stderr: "" };
      }
      if (cmd === "adb" && args[0] === "-s" && args[2] === "shell") {
        const shellCmd = args[3] ?? "";
        if (shellCmd.startsWith("getprop sys.boot_completed")) return { stdout: "1\n", stderr: "" };
        if (shellCmd === "pm path android")
          return { stdout: "package:/system/framework/framework-res.apk\n", stderr: "" };
        return { stdout: "\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const tool = createBootDeviceTool(registry);
    const result = await tool.execute!({}, { avdName: "Pixel_7_API_34" });

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0]![1]).toContain("-force-snapshot-load");
    expect(spawnMock.mock.calls[1]![1]).toContain("-no-snapshot-load");
    expect(spawnMock.mock.calls[1]![1]).not.toContain("-force-snapshot-load");
    expect(result).toMatchObject({ serial: "emulator-5554" });
  });

  it("falls back to cold boot when hot-restore leaves screencap returning a blank frame", async () => {
    hasSnapshotMock.mockResolvedValue(true);
    probeMock.mockResolvedValue({ loadable: true, reason: null });

    // First spawn (hot) boots cleanly but screencap returns a blank frame —
    // the SurfaceFlinger composite-restore artefact. Second spawn (cold) is
    // fully healthy. Each spawn registers a distinct serial so the cold-boot
    // poll picks up a genuinely new emulator.
    let spawnCount = 0;
    spawnMock.mockImplementation(() => {
      spawnCount += 1;
      return fakeChild();
    });

    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "emulator" && args[0] === "-list-avds")
        return { stdout: "Pixel_7_API_34\n", stderr: "" };
      if (cmd === "adb" && args[0] === "version")
        return { stdout: "Android Debug Bridge\n", stderr: "" };
      if (cmd === "adb" && args[0] === "start-server") return { stdout: "", stderr: "" };
      if (cmd === "adb" && args[0] === "devices") {
        let lines = "";
        if (spawnCount >= 1) lines += "emulator-5554\tdevice\n";
        if (spawnCount >= 2) lines += "emulator-5556\tdevice\n";
        return { stdout: `List of devices attached\n${lines}`, stderr: "" };
      }
      if (cmd === "adb" && args[0] === "-s" && args[2] === "wait-for-device")
        return { stdout: "", stderr: "" };
      if (cmd === "adb" && args[0] === "-s" && args[2] === "shell") {
        const serial = args[1];
        const shellCmd = args[3] ?? "";
        if (shellCmd.startsWith("getprop sys.boot_completed")) return { stdout: "1\n", stderr: "" };
        if (shellCmd.startsWith("getprop")) return { stdout: "unknown\n", stderr: "" };
        if (shellCmd === "pm path android")
          return { stdout: "package:/system/framework/framework-res.apk\n", stderr: "" };
        if (shellCmd.startsWith("screencap")) {
          return { stdout: serial === "emulator-5554" ? "0\n" : "1\n", stderr: "" };
        }
        return { stdout: "\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const tool = createBootDeviceTool(registry);
    const result = await tool.execute!({}, { avdName: "Pixel_7_API_34" });

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0]![1]).toContain("-force-snapshot-load");
    expect(spawnMock.mock.calls[1]![1]).toContain("-no-snapshot-load");
    expect(result).toMatchObject({ serial: "emulator-5556" });
  });

  it("returns the already-running emulator without spawning when the AVD is live and its framebuffer is healthy", async () => {
    // adb devices reports the AVD already attached; getprop answers with the
    // matching AVD name. screencap returns a healthy frame ("1") so the
    // wedged-framebuffer guard passes. No snapshot probe, no spawn.
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "adb" && args[0] === "version")
        return { stdout: "Android Debug Bridge\n", stderr: "" };
      if (cmd === "adb" && args[0] === "start-server") return { stdout: "", stderr: "" };
      if (cmd === "emulator" && args[0] === "-list-avds")
        return { stdout: "Pixel_7_API_34\n", stderr: "" };
      if (cmd === "adb" && args[0] === "devices") {
        return { stdout: "List of devices attached\nemulator-5554\tdevice\n", stderr: "" };
      }
      if (cmd === "adb" && args[0] === "-s" && args[2] === "shell") {
        const shellCmd = args[3] ?? "";
        if (shellCmd === "getprop ro.boot.qemu.avd_name")
          return { stdout: "Pixel_7_API_34\n", stderr: "" };
        if (shellCmd.startsWith("getprop")) return { stdout: "unknown\n", stderr: "" };
        if (shellCmd.startsWith("screencap")) return { stdout: "1\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const tool = createBootDeviceTool(registry);
    const result = await tool.execute!({}, { avdName: "Pixel_7_API_34" });

    expect(result).toMatchObject({
      platform: "android",
      serial: "emulator-5554",
      avdName: "Pixel_7_API_34",
      booted: true,
    });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(hasSnapshotMock).not.toHaveBeenCalled();
    expect(probeMock).not.toHaveBeenCalled();
  });

  it("kills the running AVD and respawns when its framebuffer is wedged on the reuse path", async () => {
    // The fast-path's BUG GUARD: if a long-running emulator drifts into the
    // sticky-blank screencap state, returning that serial unchanged would
    // hand the caller a device whose screenshots are silently all-zero.
    // The guard kills the wedged emulator and falls through to a fresh boot.
    hasSnapshotMock.mockResolvedValue(false); // force the cold-boot path post-kill
    let killed = false;
    let spawned = false;
    spawnMock.mockImplementation(() => {
      spawned = true;
      return fakeChild();
    });
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "adb" && args[0] === "version")
        return { stdout: "Android Debug Bridge\n", stderr: "" };
      if (cmd === "adb" && args[0] === "start-server") return { stdout: "", stderr: "" };
      if (cmd === "emulator" && args[0] === "-list-avds")
        return { stdout: "Pixel_7_API_34\n", stderr: "" };
      if (cmd === "adb" && args[0] === "devices") {
        // Pre-kill: wedged emulator-5554 is listed. After kill but before
        // the cold-boot spawn registers: empty (so emulator-5556 is *new*
        // when it appears). Post-spawn: emulator-5556 is listed.
        let line = "";
        if (!killed) line = "emulator-5554\tdevice\n";
        else if (spawned) line = "emulator-5556\tdevice\n";
        return { stdout: `List of devices attached\n${line}`, stderr: "" };
      }
      if (cmd === "adb" && args[0] === "-s" && args[2] === "wait-for-device")
        return { stdout: "", stderr: "" };
      if (cmd === "adb" && args[0] === "-s" && args.includes("emu") && args.includes("kill")) {
        killed = true;
        return { stdout: "OK\n", stderr: "" };
      }
      if (cmd === "adb" && args[0] === "-s" && args[2] === "shell") {
        const serial = args[1];
        const shellCmd = args[3] ?? "";
        if (shellCmd === "getprop ro.boot.qemu.avd_name")
          return { stdout: "Pixel_7_API_34\n", stderr: "" };
        if (shellCmd.startsWith("getprop sys.boot_completed")) return { stdout: "1\n", stderr: "" };
        if (shellCmd.startsWith("getprop")) return { stdout: "unknown\n", stderr: "" };
        if (shellCmd === "pm path android")
          return { stdout: "package:/system/framework/framework-res.apk\n", stderr: "" };
        if (shellCmd.startsWith("screencap")) {
          // Wedged frame on the original serial; healthy on the respawn.
          return { stdout: serial === "emulator-5554" ? "0\n" : "1\n", stderr: "" };
        }
      }
      return { stdout: "", stderr: "" };
    });

    const tool = createBootDeviceTool(registry);
    const result = await tool.execute!({}, { avdName: "Pixel_7_API_34" });

    expect(killed).toBe(true);
    // Exactly one fresh spawn (the cold-boot fallback after the kill).
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]![1]).toContain("-no-snapshot-load");
    expect(result).toMatchObject({ serial: "emulator-5556" });
  });
});
