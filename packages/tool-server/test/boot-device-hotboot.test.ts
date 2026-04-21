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

import { createBootDeviceTool } from "../src/tools/devices/boot-device";

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
    const result = await tool.execute!({}, { avdName: "Pixel_7_API_34", noWindow: true });

    expect(result).toMatchObject({
      platform: "android",
      serial: "emulator-5554",
      avdName: "Pixel_7_API_34",
      booted: true,
      coldBoot: false,
    });

    // Exactly one emulator spawn and it is the hot-boot arg set.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const hotArgs = spawnMock.mock.calls[0]![1];
    expect(hotArgs).toContain("-force-snapshot-load");
    expect(hotArgs).toContain("-no-snapshot-save");
    expect(hotArgs).not.toContain("-no-snapshot-load");
    expect(hotArgs).toContain("-no-window");
  });

  it("skips the hot-boot attempt and cold-boots when no snapshot exists on disk", async () => {
    hasSnapshotMock.mockResolvedValue(false);
    mockHappyBootChain();

    const tool = createBootDeviceTool(registry);
    const result = await tool.execute!({}, { avdName: "Pixel_7_API_34", noWindow: true });

    expect(result).toMatchObject({ coldBoot: true });
    expect(probeMock).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = spawnMock.mock.calls[0]![1];
    expect(args).toContain("-no-snapshot-load");
    expect(args).not.toContain("-force-snapshot-load");
  });

  it("skips the hot-boot attempt and cold-boots when -check-snapshot-loadable rejects", async () => {
    hasSnapshotMock.mockResolvedValue(true);
    probeMock.mockResolvedValue({ loadable: false, reason: "different renderer configured" });
    mockHappyBootChain();

    const tool = createBootDeviceTool(registry);
    const result = await tool.execute!({}, { avdName: "Pixel_7_API_34", noWindow: true });

    expect(result).toMatchObject({ coldBoot: true });
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
    const result = await tool.execute!({}, { avdName: "Pixel_7_API_34", noWindow: true });

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0]![1]).toContain("-force-snapshot-load");
    expect(spawnMock.mock.calls[1]![1]).toContain("-no-snapshot-load");
    expect(spawnMock.mock.calls[1]![1]).not.toContain("-force-snapshot-load");
    expect(result).toMatchObject({ coldBoot: true, serial: "emulator-5554" });
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
    const result = await tool.execute!({}, { avdName: "Pixel_7_API_34", noWindow: true });

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0]![1]).toContain("-force-snapshot-load");
    expect(spawnMock.mock.calls[1]![1]).toContain("-no-snapshot-load");
    expect(result).toMatchObject({ coldBoot: true, serial: "emulator-5556" });
  });

  it("returns the already-running emulator without spawning when the AVD is live", async () => {
    // adb devices reports the AVD already attached; getprop answers with the
    // matching AVD name. No snapshot probe, no filesystem check, no spawn.
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
      }
      return { stdout: "", stderr: "" };
    });

    const tool = createBootDeviceTool(registry);
    const result = await tool.execute!({}, { avdName: "Pixel_7_API_34", noWindow: true });

    expect(result).toMatchObject({
      platform: "android",
      serial: "emulator-5554",
      avdName: "Pixel_7_API_34",
      booted: true,
      coldBoot: false,
    });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(hasSnapshotMock).not.toHaveBeenCalled();
    expect(probeMock).not.toHaveBeenCalled();
  });

  it("coldBoot:true skips the already-running fast path and boots fresh", async () => {
    // Same already-running state as above, but coldBoot=true must NOT short-circuit.
    let spawnedYet = false;
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "adb" && args[0] === "version")
        return { stdout: "Android Debug Bridge\n", stderr: "" };
      if (cmd === "adb" && args[0] === "start-server") return { stdout: "", stderr: "" };
      if (cmd === "emulator" && args[0] === "-list-avds")
        return { stdout: "Pixel_7_API_34\n", stderr: "" };
      if (cmd === "adb" && args[0] === "devices") {
        // Pre-spawn the existing serial blocks the new-serial diff; post-spawn we
        // also report a second emulator on 5556 so the attempt can succeed.
        const emu = spawnedYet
          ? "emulator-5554\tdevice\nemulator-5556\tdevice\n"
          : "emulator-5554\tdevice\n";
        return { stdout: `List of devices attached\n${emu}`, stderr: "" };
      }
      if (cmd === "adb" && args[0] === "-s" && args[2] === "shell") {
        const shellCmd = args[3] ?? "";
        if (shellCmd === "getprop ro.boot.qemu.avd_name")
          return { stdout: "Pixel_7_API_34\n", stderr: "" };
        if (shellCmd.startsWith("getprop sys.boot_completed")) return { stdout: "1\n", stderr: "" };
        if (shellCmd.startsWith("getprop")) return { stdout: "unknown\n", stderr: "" };
        if (shellCmd === "pm path android")
          return { stdout: "package:/system/framework/framework-res.apk\n", stderr: "" };
      }
      if (cmd === "adb" && args[0] === "-s" && args[2] === "wait-for-device")
        return { stdout: "", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    spawnMock.mockImplementation(() => {
      spawnedYet = true;
      return fakeChild();
    });

    const tool = createBootDeviceTool(registry);
    const result = await tool.execute!(
      {},
      { avdName: "Pixel_7_API_34", coldBoot: true, noWindow: true }
    );

    expect(result).toMatchObject({ coldBoot: true, serial: "emulator-5556" });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]![1]).toContain("-no-snapshot-load");
  });

  it("coldBoot:true skips both the snapshot existence check and the probe entirely", async () => {
    mockHappyBootChain();

    const tool = createBootDeviceTool(registry);
    const result = await tool.execute!(
      {},
      { avdName: "Pixel_7_API_34", coldBoot: true, noWindow: true }
    );

    expect(hasSnapshotMock).not.toHaveBeenCalled();
    expect(probeMock).not.toHaveBeenCalled();
    expect(spawnMock.mock.calls[0]![1]).toContain("-no-snapshot-load");
    expect(result).toMatchObject({ coldBoot: true });
  });
});
