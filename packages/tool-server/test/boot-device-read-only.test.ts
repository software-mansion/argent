import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
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

// Ports something listens on, for the gRPC port check of a boot with `port`.
const listeningPorts = new Set<number>();

vi.mock("node:net", async () => {
  const actual = await vi.importActual<typeof import("node:net")>("node:net");
  return {
    ...actual,
    createConnection: ({ port }: { port: number }) => {
      const socket = Object.assign(new EventEmitter(), {
        setTimeout: () => socket,
        destroy: () => {},
      });
      setImmediate(() =>
        listeningPorts.has(port)
          ? socket.emit("connect")
          : socket.emit("error", new Error("ECONNREFUSED"))
      );
      return socket;
    },
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
import { __restartReadOnlyBootsForTesting } from "../src/utils/android-read-only-boots";

const registry: Registry = { resolveService: async () => ({}) } as unknown as Registry;
const AVD = "Pixel_7_API_34";

interface FakeEmulator {
  serial: string;
  avdName: string;
  pid: number;
  readOnly: boolean;
  /** Launched with `-port`, so `ps` shows it. */
  portArg: boolean;
  /** Launched as `emulator @<avd>`: the argv names the AVD with `@`, not `-avd`. */
  shortForm: boolean;
  /**
   * A stale adb entry: adb lists it `offline`, and no emulator process, console
   * or listener stands behind it.
   */
  stale: boolean;
  /** False: running, but `ps` shows no process that names the AVD. */
  inPs: boolean;
}

let world: FakeEmulator[] = [];
let nextPid = 1000;
/** False: `ps` fails, as when it times out, or as on Windows where there is none. */
let psAvailable = true;
/** How many `lsof` calls still time out, as under host load. */
let lsofTimeouts = 0;

function emulator(serial: string, opts: Partial<Omit<FakeEmulator, "serial">> = {}): FakeEmulator {
  return {
    serial,
    avdName: opts.avdName ?? AVD,
    pid: opts.pid ?? nextPid++,
    readOnly: opts.readOnly ?? false,
    portArg: opts.portArg ?? false,
    shortForm: opts.shortForm ?? false,
    stale: opts.stale ?? false,
    inPs: opts.inPs ?? true,
  };
}

function psLine(e: FakeEmulator): string {
  if (e.stale || !e.inPs) return "";
  const flags = [
    ...(e.readOnly ? ["-read-only"] : []),
    ...(e.portArg ? ["-port", e.serial.slice("emulator-".length)] : []),
  ];
  const avd = e.shortForm ? `@${e.avdName}` : `-avd ${e.avdName}`;
  return `${e.pid} /Users/me/Library/Android/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 ${avd} ${flags.join(" ")} -gpu auto\n`;
}

/** What `lsof -iTCP:<port> -sTCP:LISTEN -Fp` answers: the emulator on that console port. */
function lsof(args: string[]) {
  const port = args.find((a) => a.startsWith("-iTCP:"))!.slice("-iTCP:".length);
  const emu = world.find((e) => e.serial === `emulator-${port}` && !e.stale);
  if (!emu) return Object.assign(new Error("lsof: no match"), { code: 1 });
  return { stdout: `p${emu.pid}\nf43\n`, stderr: "" };
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
    if (args.includes("pid=,command=")) {
      if (!psAvailable) return new Error("ps: timed out");
      return { stdout: world.map(psLine).join(""), stderr: "" };
    }
    if (args.includes("pid=,ppid=")) {
      if (!psAvailable) return new Error("ps: timed out");
      return { stdout: world.map((e) => `${e.pid} 1\n`).join(""), stderr: "" };
    }
    if (cmd.endsWith("lsof")) {
      if (lsofTimeouts > 0) {
        lsofTimeouts--;
        return Object.assign(new Error("lsof: timed out"), { killed: true, code: null });
      }
      return lsof(args);
    }
    if (cmd === "adb" && args[0] === "devices") {
      const lines = world.map((e) => `${e.serial}\t${e.stale ? "offline" : "device"}\n`).join("");
      return { stdout: `List of devices attached\n${lines}`, stderr: "" };
    }
    if (cmd === "adb" && args[0] === "-s") {
      const serial = args[1]!;
      const emu = world.find((e) => e.serial === serial && !e.stale);
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
  psAvailable = true;
  lsofTimeouts = 0;
  listeningPorts.clear();
  __resetInFlightBootsForTesting();
  installWorld();
  installSpawn();
  hasSnapshotMock.mockResolvedValue(true);
  probeMock.mockResolvedValue({ loadable: true, reason: null });
});

// The records file lives under the temp directory (see test/setup).
afterAll(() => __resetInFlightBootsForTesting());

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

  it("starts the gRPC server with a token next to a pinned console port", async () => {
    // With `-port` alone the emulator starts no gRPC server and writes no
    // discovery file, so simulator-server cannot reach it.
    await boot({ readOnly: true, port: 5584 });

    const args = spawnArgs();
    expect(args[args.indexOf("-grpc") + 1]).toBe("8584");
    expect(args).toContain("-grpc-use-token");
  });

  it("refuses a port whose gRPC port is in use, without spawning", async () => {
    listeningPorts.add(8584);

    expect(await failureCode(boot({ readOnly: true, port: 5584 }))).toBe(
      "BOOT_ANDROID_PORT_IN_USE"
    );
    expect(spawnMock).not.toHaveBeenCalled();
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

  it("leaves a read-only emulator pinned with -port to the calls that name its port", async () => {
    world = [emulator("emulator-5576", { readOnly: true, portArg: true })];

    const unpinned = await boot({ readOnly: true });
    expect(unpinned).not.toMatchObject({ serial: "emulator-5576" });
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const pinned = await boot({ readOnly: true, port: 5576 });
    expect(pinned).toMatchObject({ serial: "emulator-5576" });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("does not shut down another agent's pinned read-only emulator on force without a port", async () => {
    world = [emulator("emulator-5576", { readOnly: true, portArg: true })];

    await boot({ readOnly: true, force: true });

    expect(world.map((e) => e.serial)).toContain("emulator-5576");
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("gives a boot without a port its own emulator while a pinned boot registers", async () => {
    const [pinned, unpinned] = await Promise.all([
      boot({ readOnly: true, port: 5584 }),
      boot({ readOnly: true }),
    ]);

    expect(pinned).toMatchObject({ serial: "emulator-5584" });
    expect(unpinned).not.toMatchObject({ serial: "emulator-5584" });
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("fails with the port code, and kills no other emulator, when another one takes the port", async () => {
    // Another AVD binds 5578 after the pre-spawn check, and ours never comes up.
    spawnMock.mockImplementationOnce(() => {
      world.push(emulator("emulator-5578", { avdName: "Other_AVD" }));
      return Object.assign(new EventEmitter(), {
        pid: nextPid++,
        unref: () => {},
        kill: () => {},
        exitCode: null,
        signalCode: null,
      });
    });

    expect(await failureCode(boot({ readOnly: true, port: 5578 }))).toBe(
      "BOOT_ANDROID_PORT_IN_USE"
    );
    expect(world).toEqual([
      expect.objectContaining({ serial: "emulator-5578", avdName: "Other_AVD" }),
    ]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["exits", true],
    ["keeps running without a console", false],
  ])(
    "leaves another read-only emulator of the AVD that takes the port running when ours %s",
    async (_label, exits) => {
      // Someone starts the AVD read-only on 5584 while this boot spawns, and
      // theirs binds the port first. Ours loses it.
      const theirs = emulator("emulator-5584", { readOnly: true, portArg: true });
      const ours = Object.assign(new EventEmitter(), {
        pid: nextPid++,
        unref: () => {},
        kill: vi.fn(),
        exitCode: null,
        signalCode: null,
      });
      spawnMock.mockImplementationOnce(() => {
        world.push(theirs);
        if (exits) setTimeout(() => ours.emit("exit", null, "SIGSEGV"), 50);
        return ours;
      });

      expect(await failureCode(boot({ readOnly: true, port: 5584 }))).toBe(
        "BOOT_ANDROID_PORT_IN_USE"
      );
      expect(world).toEqual([theirs]);
      expect(ours.kill).toHaveBeenCalled();
      expect(spawnMock).toHaveBeenCalledTimes(1);
    }
  );

  describe("where the process table cannot be read (Windows)", () => {
    const platform = process.platform;
    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: "win32" });
      return () => Object.defineProperty(process, "platform", { value: platform });
    });

    it("does not reuse a writable emulator that replaced its read-only one", async () => {
      const first = await boot({ readOnly: true });
      const replaced = await boot({ force: true });
      expect(replaced).toMatchObject({ serial: (first as { serial: string }).serial });

      const again = await boot({ readOnly: true });

      expect(again).not.toMatchObject({ serial: (first as { serial: string }).serial });
      expect(spawnMock).toHaveBeenCalledTimes(3);
    });

    it("lets a boot without a port take the serial of a pinned emulator that exited", async () => {
      world = [emulator("emulator-5554", { avdName: "Other_AVD" })];
      await boot({ readOnly: true, port: 5556 });
      world = world.filter((e) => e.serial !== "emulator-5556");

      const result = await boot({});

      expect(result).toMatchObject({ serial: "emulator-5556" });
    });
  });

  it.each([
    ["without a process list", false],
    ["with a process list", true],
  ])("reuses its own pinned read-only emulator %s", async (_label, ps) => {
    await boot({ readOnly: true, port: 5584 });
    psAvailable = ps;

    const again = await boot({ readOnly: true, port: 5584 });

    expect(again).toMatchObject({ serial: "emulator-5584" });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("keeps reusing a read-only emulator without a port after one failed ps call", async () => {
    const first = await boot({ readOnly: true });
    psAvailable = false;
    await boot({ readOnly: true });
    psAvailable = true;

    const third = await boot({ readOnly: true });

    expect(third).toMatchObject({ serial: (first as { serial: string }).serial });
    expect(spawnMock).toHaveBeenCalledTimes(1);
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

  it("lets a writable boot without a port reuse a read-only emulator booted without one", async () => {
    const first = await boot({ readOnly: true });

    const result = await boot({});

    expect(result).toMatchObject({ serial: (first as { serial: string }).serial });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a writable boot on a port while the AVD runs writable on another one", async () => {
    world = [emulator("emulator-5560", { portArg: true })];

    expect(await failureCode(boot({ port: 5582 }))).toBe("BOOT_ANDROID_READ_ONLY_CONFLICT");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  // The AVD runs one writable instance at a time, so a writable boot that left
  // a pinned writable emulator alone could only fail.
  it("lets a writable boot without a port reuse, or force, a writable emulator started with -port", async () => {
    world = [emulator("emulator-5556", { portArg: true })];

    expect(await boot({})).toMatchObject({ serial: "emulator-5556" });
    expect(spawnMock).not.toHaveBeenCalled();

    const forced = await boot({ force: true });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(forced).toMatchObject({ booted: true });
    expect(world.map((e) => e.serial)).toEqual([(forced as { serial: string }).serial]);
  });

  it("still leaves a pinned writable emulator alone on a read-only boot without a port", async () => {
    world = [emulator("emulator-5556", { portArg: true })];

    expect(await failureCode(boot({ readOnly: true, force: true }))).toBe(
      "BOOT_ANDROID_READ_ONLY_CONFLICT"
    );
    expect(world.map((e) => e.serial)).toEqual(["emulator-5556"]);
  });

  // Shutting the emulator down would not let the boot go ahead, and other
  // agents may be using it.
  it.each([
    ["one argent booted", true],
    ["one started outside argent, told by its console listener", false],
  ])(
    "on force, shuts nothing down while another instance would still block the boot: %s",
    async (_label, ours) => {
      if (ours) await boot({ readOnly: true });
      else world.push(emulator("emulator-5554", { readOnly: true }));
      world.push(emulator("emulator-5584", { readOnly: true, portArg: true }));
      const spawnsBefore = spawnMock.mock.calls.length;

      const started = Date.now();
      expect(await failureCode(boot({ force: true }))).toBe("BOOT_ANDROID_READ_ONLY_CONFLICT");

      expect(Date.now() - started).toBeLessThan(5_000);
      expect(world.map((e) => e.serial).sort()).toEqual(["emulator-5554", "emulator-5584"]);
      expect(spawnMock.mock.calls.length).toBe(spawnsBefore);
    }
  );

  it("on force, still replaces the only instance in the way", async () => {
    const first = await boot({ readOnly: true });

    const forced = await boot({ force: true });

    expect(forced).toMatchObject({ booted: true });
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnArgs(1)).not.toContain("-read-only");
    expect(world.map((e) => e.serial)).toEqual([(first as { serial: string }).serial]);
  });

  it("reports the conflict, not a corrupted AVD, for concurrent boots in different modes", async () => {
    const [pinned, writable] = await Promise.allSettled([
      boot({ readOnly: true, port: 5584 }),
      boot({}),
    ]);

    expect(pinned).toMatchObject({ status: "fulfilled" });
    expect(writable.status).toBe("rejected");
    expect(getFailureSignal((writable as PromiseRejectedResult).reason)?.error_code).toBe(
      "BOOT_ANDROID_READ_ONLY_CONFLICT"
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("sees a writable emulator launched as `emulator @<avd>`", async () => {
    world = [emulator("emulator-5554", { shortForm: true })];

    expect(await failureCode(boot({ readOnly: true }))).toBe("BOOT_ANDROID_READ_ONLY_CONFLICT");
    expect(await failureCode(boot({ readOnly: true, port: 5554 }))).toBe(
      "BOOT_ANDROID_PORT_IN_USE"
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("does not take an emulator on the port for read-only when no process of the AVD shows", async () => {
    // Launched in a way the process table does not name the AVD in.
    world = [emulator("emulator-5554", { inPs: false })];

    expect(await failureCode(boot({ readOnly: true, port: 5554 }))).toBe(
      "BOOT_ANDROID_PORT_IN_USE"
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns its own emulator when another instance of the AVD registers during the boot", async () => {
    // Someone starts the same AVD read-only from a terminal while this boot
    // spawns, and theirs takes 5554 first.
    spawnMock.mockImplementationOnce((cmd: string, args: string[]) => {
      world.push(emulator("emulator-5554", { readOnly: true }));
      installSpawn();
      return spawnMock(cmd, args);
    });

    const result = await boot({ readOnly: true });

    expect(result).toMatchObject({ serial: "emulator-5556" });
  });

  it("never returns an emulator that ran before the boot, past stale adb entries", async () => {
    // Another agent's pinned emulator, and two `offline` entries whose console
    // does not answer, so they count as new. Ours registers a moment later.
    world = [
      emulator("emulator-5582", { readOnly: true, portArg: true }),
      emulator("emulator-5570", { stale: true }),
      emulator("emulator-5572", { stale: true }),
    ];
    const spawnNow = spawnMock.getMockImplementation()!;
    spawnMock.mockImplementationOnce((cmd: string, args: string[]) => {
      const proc = spawnNow(cmd, args);
      const ours = world.pop()!;
      setTimeout(() => world.push(ours), 200);
      return proc;
    });

    const result = await boot({ readOnly: true });

    expect(result).toMatchObject({ serial: "emulator-5554" });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("reuses a read-only emulator it booted without a port after the tool-server restarts", async () => {
    const first = await boot({ readOnly: true });
    __restartReadOnlyBootsForTesting();

    const again = await boot({ readOnly: true });

    expect(again).toMatchObject({ serial: (first as { serial: string }).serial });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("does not take a record an earlier tool-server left on trust where ps cannot confirm it", async () => {
    const first = await boot({ readOnly: true });
    __restartReadOnlyBootsForTesting();
    const platform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const again = await boot({ readOnly: true });

      expect(again).not.toMatchObject({ serial: (first as { serial: string }).serial });
      expect(spawnMock).toHaveBeenCalledTimes(2);
    } finally {
      Object.defineProperty(process, "platform", { value: platform });
    }
  });

  it("does not take another instance of the AVD for its own while the listener probe times out", async () => {
    // Theirs takes 5554 first, and the probes that would tell the two apart
    // time out for a while. The AVD name is the same for both, so it decides
    // nothing.
    spawnMock.mockImplementationOnce((cmd: string, args: string[]) => {
      world.push(emulator("emulator-5554", { readOnly: true }));
      lsofTimeouts = 3;
      installSpawn();
      return spawnMock(cmd, args);
    });

    const result = await boot({ readOnly: true });

    expect(result).toMatchObject({ serial: "emulator-5556" });
  });

  it("does not take another instance on its pinned port for its own while the listener probe times out", async () => {
    const theirs = emulator("emulator-5584", { readOnly: true, portArg: true });
    const ours = Object.assign(new EventEmitter(), {
      pid: nextPid++,
      unref: () => {},
      kill: vi.fn(),
      exitCode: null,
      signalCode: null,
    });
    spawnMock.mockImplementationOnce(() => {
      world.push(theirs);
      lsofTimeouts = 2;
      return ours;
    });

    expect(await failureCode(boot({ readOnly: true, port: 5584 }))).toBe(
      "BOOT_ANDROID_PORT_IN_USE"
    );
    expect(world).toEqual([theirs]);
  });

  it("does not start a boot that clashes with one queued ahead of it", async () => {
    // Another AVD's boot holds 5556. A read-only boot of ours on 5556 queues
    // behind it, and a writable boot of ours queues behind that one, though it
    // does not clash with the boot in flight.
    let release!: () => void;
    spawnMock.mockImplementationOnce((_cmd: string, args: string[]) => {
      const proc = Object.assign(new EventEmitter(), {
        pid: nextPid++,
        unref: () => {},
        kill: () => {},
        exitCode: null,
        signalCode: null,
      });
      release = () =>
        world.push(
          emulator("emulator-5556", {
            avdName: args[args.indexOf("-avd") + 1]!,
            pid: proc.pid,
            portArg: true,
          })
        );
      return proc;
    });
    const other = boot({ avdName: "Other_AVD", port: 5556 });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    const queued = boot({ readOnly: true, port: 5556 });
    const writable = boot({});
    await new Promise((r) => setTimeout(r, 300));

    expect(spawnMock).toHaveBeenCalledTimes(1);

    release();
    const results = await Promise.allSettled([other, queued, writable]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("counts the wait for a clashing boot against bootTimeoutMs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      // Every emulator spawned hangs before it registers with adb.
      spawnMock.mockImplementation(() =>
        Object.assign(new EventEmitter(), {
          pid: nextPid++,
          unref: () => {},
          kill: () => {},
          exitCode: null,
          signalCode: null,
        })
      );
      const first = boot({ readOnly: true, port: 5584, bootTimeoutMs: 300_000 });
      first.catch(() => {});
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
      const started = Date.now();
      let settledAt = -1;
      const second = boot({ port: 5584, bootTimeoutMs: 30_000 }).finally(() => {
        settledAt = Date.now();
      });
      second.catch(() => {});
      for (let i = 0; i < 400 && settledAt < 0; i++) await vi.advanceTimersByTimeAsync(500);

      expect(settledAt - started).toBeLessThanOrEqual(31_000);
      expect(await failureCode(second)).toBe("BOOT_ANDROID_PORT_IN_USE");

      let firstDone = false;
      void first.catch(() => {}).finally(() => (firstDone = true));
      for (let i = 0; i < 1_000 && !firstDone; i++) await vi.advanceTimersByTimeAsync(500);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([5555, 5552, 5586])("refuses port %i on Android without spawning", async (port) => {
    expect(await failureCode(boot({ port }))).toBe("BOOT_ANDROID_PORT_INVALID");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("lets a non-Android target through with a port outside the emulator range", () => {
    // An agent may echo the `port` of a Chromium result, such as 9222; the key
    // is ignored off Android, so it must not fail validation there.
    const tool = createBootDeviceTool(registry);
    expect(tool.zodSchema!.safeParse({ electronAppPath: "/tmp/App.app", port: 9222 }).success).toBe(
      true
    );
  });
});
