import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Registry } from "@argent/registry";

const execFileMock = vi.fn();
const spawnMock = vi.fn();
const hasSnapshotMock = vi.fn();
const probeMock = vi.fn();
// Controls what `isFlagEnabled("boot-sound")` reports — the tests below flip
// this instead of touching real flags.json files on disk.
const flagEnabledMock = vi.fn((_name: string) => false);

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
      const result = execFileMock(cmd, args);
      if (result instanceof Error) callback(result, { stdout: "", stderr: "" });
      else callback(null, result ?? { stdout: "", stderr: "" });
    },
    spawn: (cmd: string, args: string[], opts: unknown) => spawnMock(cmd, args, opts),
  };
});

// Same partial-mock shape as boot-device-hotboot.test.ts: stub the snapshot
// probes so no real ~/.android I/O or emulator spawn happens.
vi.mock("../src/utils/adb", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/adb")>("../src/utils/adb");
  return {
    ...actual,
    hasDefaultBootSnapshot: (...a: unknown[]) => hasSnapshotMock(...a),
    checkSnapshotLoadable: (...a: unknown[]) => probeMock(...a),
  };
});

vi.mock("../src/utils/android-binary", () => ({
  resolveAndroidBinary: vi.fn(async (name: "adb" | "emulator") => name),
  __resetAndroidBinaryCacheForTesting: () => {},
}));

vi.mock("@argent/configuration-core", async () => {
  const actual = await vi.importActual<typeof import("@argent/configuration-core")>(
    "@argent/configuration-core"
  );
  return { ...actual, isFlagEnabled: (name: string) => flagEnabledMock(name) };
});

import {
  __resetInFlightBootsForTesting,
  createBootDeviceTool,
} from "../src/tools/devices/boot-device";

const registry: Registry = { resolveService: async () => ({}) } as unknown as Registry;

function fakeChild() {
  const proc = new EventEmitter() as EventEmitter & {
    unref: () => void;
    kill: (sig?: string) => void;
    exitCode: number | null;
    signalCode: string | null;
  };
  proc.unref = () => {};
  proc.kill = () => {};
  proc.exitCode = null;
  proc.signalCode = null;
  return proc;
}

// Happy-path adb/emulator mock, same shape as boot-device-hotboot.test.ts.
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

beforeEach(() => {
  execFileMock.mockReset();
  spawnMock.mockReset();
  hasSnapshotMock.mockReset();
  probeMock.mockReset();
  flagEnabledMock.mockReset();
  flagEnabledMock.mockReturnValue(false);
  spawnMock.mockImplementation(() => fakeChild());
  __resetInFlightBootsForTesting();
});

function spawnedArgs(): string[] {
  expect(spawnMock).toHaveBeenCalledTimes(1);
  return spawnMock.mock.calls[0]![1] as string[];
}

describe("boot-device Android — `sound` argument", () => {
  it("mutes by default: cold-boot args carry -noaudio when sound is unset and the flag is off", async () => {
    hasSnapshotMock.mockResolvedValue(false);
    mockHappyBootChain();

    const tool = createBootDeviceTool(registry);
    await tool.execute!({}, { avdName: "Pixel_7_API_34" });

    expect(spawnedArgs()).toContain("-noaudio");
  });

  it("sound:true drops -noaudio from BOTH the snapshot probe and the hot-boot spawn", async () => {
    // Probe/boot argv parity is the invariant here: if only one side dropped
    // `-noaudio`, the loadability probe would resolve a different qemu device
    // topology than the boot and reject (or wrongly accept) the snapshot.
    hasSnapshotMock.mockResolvedValue(true);
    probeMock.mockResolvedValue({ loadable: true, reason: null });
    mockHappyBootChain();

    const tool = createBootDeviceTool(registry);
    await tool.execute!({}, { avdName: "Pixel_7_API_34", sound: true });

    expect(probeMock).toHaveBeenCalledTimes(1);
    const [, , probeOptions] = probeMock.mock.calls[0]! as [
      string,
      string,
      { extraArgs: string[] },
    ];
    expect(probeOptions.extraArgs).not.toContain("-noaudio");

    const hotArgs = spawnedArgs();
    expect(hotArgs).not.toContain("-noaudio");
    // The rest of the hardening set must survive the sound opt-in untouched.
    expect(hotArgs).toEqual(expect.arrayContaining(["-no-boot-anim", "-netfast", "-no-metrics"]));
  });

  it("sound:true drops -noaudio from the cold-boot spawn too", async () => {
    hasSnapshotMock.mockResolvedValue(false);
    mockHappyBootChain();

    const tool = createBootDeviceTool(registry);
    await tool.execute!({}, { avdName: "Pixel_7_API_34", sound: true });

    const coldArgs = spawnedArgs();
    expect(coldArgs).not.toContain("-noaudio");
    expect(coldArgs).toEqual(expect.arrayContaining(["-no-boot-anim", "-netfast", "-no-metrics"]));
  });

  it("the boot-sound flag flips the DEFAULT: unset sound boots with audio when enabled", async () => {
    flagEnabledMock.mockImplementation((name: string) => name === "boot-sound");
    hasSnapshotMock.mockResolvedValue(false);
    mockHappyBootChain();

    const tool = createBootDeviceTool(registry);
    await tool.execute!({}, { avdName: "Pixel_7_API_34" });

    expect(flagEnabledMock).toHaveBeenCalledWith("boot-sound");
    expect(spawnedArgs()).not.toContain("-noaudio");
  });

  it("an explicit sound:false beats the boot-sound flag — the flag only moves the default", async () => {
    flagEnabledMock.mockImplementation((name: string) => name === "boot-sound");
    hasSnapshotMock.mockResolvedValue(false);
    mockHappyBootChain();

    const tool = createBootDeviceTool(registry);
    await tool.execute!({}, { avdName: "Pixel_7_API_34", sound: false });

    expect(spawnedArgs()).toContain("-noaudio");
  });
});
