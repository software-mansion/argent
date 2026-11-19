import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { getFailureSignal, type Registry } from "@argent/registry";

// `readOnly` and `port` on an Android boot: the emulator args they add, which
// running emulator a boot may reuse, and the conflicts it refuses before a
// spawn. The fake world below answers adb, the emulator console and `ps` from
// one list of emulators, and a spawn adds the emulator it launches to it.

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

vi.mock("../src/utils/adb", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/adb")>("../src/utils/adb");
  return {
    ...actual,
    hasDefaultBootSnapshot: (...a: unknown[]) => hasSnapshotMock(...a),
    checkSnapshotLoadable: (...a: unknown[]) => probeMock(...a),
    emulatorSupportsFlag: async () => false,
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
  return { ...actual, isFlagEnabled: () => false };
});

import {
  __resetInFlightBootsForTesting,
  createBootDeviceTool,
} from "../src/tools/devices/boot-device";

const registry: Registry = { resolveService: async () => ({}) } as unknown as Registry;
const AVD = "Pixel_7_API_34";

interface FakeEmulator {
  serial: string;
  avdName: string;
  pid: number;
  readOnly: boolean;
  /** Launched with `-port`, so `ps` shows it. */
  portArg: boolean;
}

let world: FakeEmulator[] = [];
let nextPid = 1000;

function emulator(serial: string, opts: Partial<Omit<FakeEmulator, "serial">> = {}): FakeEmulator {
  return {
    serial,
    avdName: opts.avdName ?? AVD,
    pid: opts.pid ?? nextPid++,
    readOnly: opts.readOnly ?? false,
    portArg: opts.portArg ?? false,
  };
}

function psLine(e: FakeEmulator): string {
  const flags = [
    ...(e.readOnly ? ["-read-only"] : []),
    ...(e.portArg ? ["-port", e.serial.slice("emulator-".length)] : []),
  ];
  return `${e.pid} /Users/me/Library/Android/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd ${e.avdName} ${flags.join(" ")} -gpu auto\n`;
}

function shell(shellCmd: string, avdName: string) {
  if (shellCmd === "getprop ro.boot.qemu.avd_name") return { stdout: `${avdName}\n`, stderr: "" };
  if (shellCmd.startsWith("getprop sys.boot_completed")) return { stdout: "1\n", stderr: "" };
  if (shellCmd.startsWith("getprop")) return { stdout: "unknown\n", stderr: "" };
  if (shellCmd === "pm path android")
    return { stdout: "package:/system/framework/framework-res.apk\n", stderr: "" };
  if (shellCmd.startsWith("screencap")) return { stdout: "1\n", stderr: "" };
  return { stdout: "\n", stderr: "" };
}

function installWorld() {
  execFileMock.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === "emulator" && args[0] === "-list-avds")
      return { stdout: `${AVD}\nOther_AVD\n`, stderr: "" };
    if (cmd === "adb" && args[0] === "version")
      return { stdout: "Android Debug Bridge\n", stderr: "" };
    if (args.includes("pid=,command=")) return { stdout: world.map(psLine).join(""), stderr: "" };
    if (cmd === "adb" && args[0] === "devices") {
      const lines = world.map((e) => `${e.serial}\tdevice\n`).join("");
      return { stdout: `List of devices attached\n${lines}`, stderr: "" };
    }
    if (cmd === "adb" && args[0] === "-s") {
      const serial = args[1]!;
      const emu = world.find((e) => e.serial === serial);
      if (args[2] === "emu" && args[3] === "kill") {
        world = world.filter((e) => e.serial !== serial);
        return { stdout: "OK\n", stderr: "" };
      }
      if (args[2] === "emu" && args[3] === "avd") {
        if (!emu) {
          return new Error(
            `error: could not connect to TCP port ${serial.slice(9)}: Connection refused`
          );
        }
        return { stdout: `${emu.avdName}\nOK\n`, stderr: "" };
      }
      if (args[2] === "wait-for-device") return { stdout: "", stderr: "" };
      if (args[2] === "shell") {
        if (!emu) return new Error("error: closed");
        return shell(args[3] ?? "", emu.avdName);
      }
    }
    return { stdout: "", stderr: "" };
  });
}

interface FakeChild extends EventEmitter {
  pid: number;
  unref: () => void;
  kill: (sig?: string) => void;
  exitCode: number | null;
  signalCode: string | null;
}

// A spawn brings up an emulator on the `-port` it was given, else on the
// first free even port from 5554, as the real emulator does.
function installSpawn() {
  spawnMock.mockImplementation((_cmd: string, args: string[]) => {
    const proc = new EventEmitter() as FakeChild;
    proc.pid = nextPid++;
    proc.unref = () => {};
    proc.kill = () => {};
    proc.exitCode = null;
    proc.signalCode = null;
    const portIdx = args.indexOf("-port");
    let port: number;
    if (portIdx >= 0) port = Number(args[portIdx + 1]);
    else {
      port = 5554;
      while (world.some((e) => e.serial === `emulator-${port}`)) port += 2;
    }
    world.push(
      emulator(`emulator-${port}`, {
        avdName: args[args.indexOf("-avd") + 1]!,
        pid: proc.pid,
        readOnly: args.includes("-read-only"),
        portArg: portIdx >= 0,
      })
    );
    return proc;
  });
}

function spawnArgs(call = 0): string[] {
  return spawnMock.mock.calls[call]![1] as string[];
}

async function failureCode(pending: Promise<unknown>): Promise<string | undefined> {
  try {
    await pending;
  } catch (err) {
    return getFailureSignal(err)?.error_code;
  }
  throw new Error("expected the boot to fail");
}

async function boot(params: Record<string, unknown>) {
  const tool = createBootDeviceTool(registry);
  return tool.execute!({}, { avdName: AVD, ...params });
}

beforeEach(() => {
  execFileMock.mockReset();
  spawnMock.mockReset();
  hasSnapshotMock.mockReset();
  probeMock.mockReset();
  world = [];
  __resetInFlightBootsForTesting();
  installWorld();
  installSpawn();
  hasSnapshotMock.mockResolvedValue(true);
  probeMock.mockResolvedValue({ loadable: true, reason: null });
});

describe("boot-device Android — readOnly and port", () => {
  it("passes -read-only and -port to the snapshot probe and the hot-boot spawn", async () => {
    const result = await boot({ readOnly: true, port: 5584 });

    expect(result).toMatchObject({ platform: "android", serial: "emulator-5584", booted: true });
    const [, , probeOptions] = probeMock.mock.calls[0]!;
    expect(probeOptions.extraArgs).toEqual(expect.arrayContaining(["-read-only", "-port", "5584"]));
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnArgs()).toEqual(
      expect.arrayContaining(["-read-only", "-port", "5584", "-no-snapshot-save"])
    );
  });

  it("keeps a read-only cold boot from saving the AVD's snapshot", async () => {
    hasSnapshotMock.mockResolvedValue(false);

    await boot({ readOnly: true });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnArgs()).toEqual(
      expect.arrayContaining(["-no-snapshot-load", "-read-only", "-no-snapshot-save"])
    );
    expect(spawnArgs()).not.toContain("-port");
  });

  it("leaves a writable cold boot saving its snapshot, as before", async () => {
    hasSnapshotMock.mockResolvedValue(false);

    await boot({});

    expect(spawnArgs()).not.toContain("-read-only");
    expect(spawnArgs()).not.toContain("-no-snapshot-save");
  });

  it("returns the serial of the requested port, not another emulator registering at the same time", async () => {
    // Another emulator comes up on 5554 while ours registers on 5584.
    spawnMock.mockImplementationOnce((cmd: string, args: string[]) => {
      world.push(emulator("emulator-5554", { avdName: "Other_AVD" }));
      installSpawn();
      return spawnMock(cmd, args);
    });

    const result = await boot({ port: 5584 });

    expect(result).toMatchObject({ serial: "emulator-5584" });
  });

  it("refuses a read-only boot while the AVD runs writable, without spawning", async () => {
    world = [emulator("emulator-5554")];

    expect(await failureCode(boot({ readOnly: true }))).toBe("BOOT_ANDROID_READ_ONLY_CONFLICT");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("reuses a read-only emulator it booted, also one started without a port", async () => {
    const first = await boot({ readOnly: true });
    const second = await boot({ readOnly: true });

    expect(second).toMatchObject({ serial: (first as { serial: string }).serial });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("reuses a read-only emulator started by someone else with -port", async () => {
    world = [emulator("emulator-5590", { readOnly: true, portArg: true })];

    const result = await boot({ readOnly: true });

    expect(result).toMatchObject({ serial: "emulator-5590" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("boots a second read-only emulator of the AVD on another port", async () => {
    const [a, b] = await Promise.all([
      boot({ readOnly: true, port: 5584 }),
      boot({ readOnly: true, port: 5582 }),
    ]);

    expect(a).toMatchObject({ serial: "emulator-5584" });
    expect(b).toMatchObject({ serial: "emulator-5582" });
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("reuses only the emulator on the requested port", async () => {
    world = [emulator("emulator-5584", { readOnly: true, portArg: true })];

    const result = await boot({ readOnly: true, port: 5582 });

    expect(result).toMatchObject({ serial: "emulator-5582" });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a port another AVD's emulator holds", async () => {
    world = [emulator("emulator-5584", { avdName: "Other_AVD" })];

    expect(await failureCode(boot({ port: 5584 }))).toBe("BOOT_ANDROID_PORT_IN_USE");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("refuses a read-only boot on a port where the AVD runs writable, unless forced", async () => {
    world = [emulator("emulator-5584", { portArg: true })];

    expect(await failureCode(boot({ readOnly: true, port: 5584 }))).toBe(
      "BOOT_ANDROID_PORT_IN_USE"
    );
    expect(spawnMock).not.toHaveBeenCalled();

    const result = await boot({ readOnly: true, port: 5584, force: true });

    expect(result).toMatchObject({ serial: "emulator-5584" });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnArgs()).toContain("-read-only");
  });

  it("refuses a writable boot on a free port while the AVD runs read-only elsewhere", async () => {
    world = [emulator("emulator-5584", { readOnly: true, portArg: true })];

    expect(await failureCode(boot({ port: 5582 }))).toBe("BOOT_ANDROID_READ_ONLY_CONFLICT");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("lets a writable boot without a port reuse a running read-only emulator, as before", async () => {
    world = [emulator("emulator-5584", { readOnly: true, portArg: true })];

    const result = await boot({});

    expect(result).toMatchObject({ serial: "emulator-5584" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each([5555, 5552, 5684])("rejects port %i in the schema", (port) => {
    const tool = createBootDeviceTool(registry);
    expect(tool.zodSchema.safeParse({ avdName: AVD, port }).success).toBe(false);
  });
});
