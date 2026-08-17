import { describe, it, expect, vi, beforeEach } from "vitest";

// The iOS branch shells out to `xcrun simctl spawn … notifyutil`. Stub the
// subprocess so the test asserts the argv wiring (which notification, how many
// times) without a booted simulator.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: vi.fn((_file: string, _args: string[], _opts: unknown, cb: (e: null) => void) =>
    cb(null)
  ),
}));

// Device-set resolution reads config off disk; pin it so argv is deterministic.
vi.mock("../src/utils/ios-device-sets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-device-sets")>()),
  simctlArgsForUdid: vi.fn(async (_udid: string, args: readonly string[]) => ["simctl", ...args]),
}));

// The remote branch shells out to the `sim-remote` CLI.
vi.mock("../src/utils/sim-remote", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/sim-remote")>()),
  simctlSpawn: vi.fn(async () => ({ pid: undefined, exitCode: 0, stdout: "", stderr: "" })),
  isRemoteTvOsSimulator: vi.fn(async () => false),
}));

// TV detection is an async runtime probe (`simctl list` / `adb`); default both
// to "not a TV" and flip them per-test.
vi.mock("../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-devices")>()),
  isTvOsSimulator: vi.fn(async () => false),
}));

// The Android branch drives the emulator console over adb.
vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  runAdb: vi.fn(async () => ({ stdout: "acceleration = 0:9.77631:0.812349\nOK\n", stderr: "" })),
  isAndroidTv: vi.fn(async () => false),
}));

// `dispatchByPlatform` preflights each branch's `requires`; CI has neither
// xcrun nor adb, so treat both as present.
vi.mock("../src/utils/check-deps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/check-deps")>()),
  ensureDep: vi.fn(async () => {}),
  ensureDeps: vi.fn(async () => {}),
}));

import { execFile } from "node:child_process";
import { shakeTool } from "../src/tools/shake";
import { SHAKE_NOTIFICATION } from "../src/tools/shake/platforms/ios";
import { androidImpl, parseAcceleration } from "../src/tools/shake/platforms/android";
import { iosRemoteImpl } from "../src/tools/shake/platforms/ios";
import { isAndroidTv, runAdb } from "../src/utils/adb";
import { isRemoteTvOsSimulator, simctlSpawn } from "../src/utils/sim-remote";
import { isTvOsSimulator } from "../src/utils/ios-devices";
import { UnsupportedOperationError } from "../src/utils/capability";

const iosUdid = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const androidEmulator = "emulator-5554";
const services = {} as never;

beforeEach(() => {
  vi.mocked(execFile).mockClear();
  vi.mocked(runAdb).mockClear();
  vi.mocked(simctlSpawn).mockClear();
});

describe("shake tool — iOS", () => {
  it("posts the SimulatorShake darwin notification inside the simulator", async () => {
    await expect(shakeTool.execute(services, { udid: iosUdid })).resolves.toEqual({
      shaken: true,
      count: 1,
    });

    expect(execFile).toHaveBeenCalledTimes(1);
    const [bin, args] = vi.mocked(execFile).mock.calls[0]!;
    expect(bin).toBe("xcrun");
    // The whole iOS implementation: `simctl spawn <udid> notifyutil -p <name>`.
    // No private framework, no simulator-server command, no host UI scripting.
    expect(args).toEqual(["simctl", "spawn", iosUdid, "notifyutil", "-p", SHAKE_NOTIFICATION]);
  });

  it("delivers one notification per requested gesture", async () => {
    await expect(shakeTool.execute(services, { udid: iosUdid, count: 3 })).resolves.toEqual({
      shaken: true,
      count: 3,
    });
    expect(execFile).toHaveBeenCalledTimes(3);
  });
});

describe("shake tool — remote iOS (sim-remote)", () => {
  const remoteUdid = "remote:9D2F4AEC-7C68-4C73-9BD9-06D1007FBF1F";

  it("runs the on-device notifyutil argv, uploading nothing", async () => {
    await expect(shakeTool.execute(services, { udid: remoteUdid })).resolves.toEqual({
      shaken: true,
      count: 1,
    });

    expect(simctlSpawn).toHaveBeenCalledTimes(1);
    const [udid, opts] = vi.mocked(simctlSpawn).mock.calls[0]!;
    expect(udid).toBe(remoteUdid);
    expect(opts.args).toEqual(["notifyutil", "-p", SHAKE_NOTIFICATION]);
    // `--bin` would upload a host binary; the point is to run the simulator's own.
    expect(opts.binPath).toBeUndefined();
    // The local xcrun path must not fire for a remote device.
    expect(execFile).not.toHaveBeenCalled();
  });

  it("fails loudly when the remote notifyutil exits non-zero", async () => {
    // `sim-remote spawn --json` exits 0 and reports the child's status in the
    // payload, so an unchecked exit code would report a shake that never
    // happened as a success.
    vi.mocked(simctlSpawn).mockResolvedValueOnce({
      pid: undefined,
      exitCode: 1,
      stdout: "",
      stderr: "notifyutil: command not found",
    });

    await expect(
      iosRemoteImpl.handler({} as never, { udid: remoteUdid }, {} as never)
    ).rejects.toThrow(/notifyutil exited 1: notifyutil: command not found/);
  });
});

describe("shake tool — Android", () => {
  it("bursts the accelerometer and restores the resting vector afterwards", async () => {
    await expect(shakeTool.execute(services, { udid: androidEmulator })).resolves.toEqual({
      shaken: true,
      count: 1,
    });

    const calls = vi.mocked(runAdb).mock.calls.map(([args]) => args as string[]);
    // First call reads the resting pose so it can be put back.
    expect(calls[0]).toEqual(["-s", androidEmulator, "emu", "sensor", "get", "acceleration"]);

    const sets = calls.filter((a) => a[4] === "set");
    // A single spike doesn't trip a shake detector — the burst must reverse
    // direction repeatedly.
    expect(sets.length).toBeGreaterThan(4);

    const axisX = (a: string[]) => Number(a[6]!.split(":")[0]);
    // Swings alternate sign around the resting vector.
    expect(axisX(sets[0]!)).toBeGreaterThan(10);
    expect(axisX(sets[1]!)).toBeLessThan(-10);

    // The override outlives the tool call, so the last write must be the
    // resting pose read at the start — otherwise the device is left tilted.
    expect(sets.at(-1)![6]).toBe("0.0000:9.7763:0.8123");
  });

  it("restores the resting vector even when a swing fails mid-burst", async () => {
    let call = 0;
    vi.mocked(runAdb).mockImplementation(async (args: string[]) => {
      call++;
      if (args.includes("get")) {
        return { stdout: "acceleration = 0:9.81:0\nOK\n", stderr: "" };
      }
      // Fail one swing in the middle of the burst.
      if (call === 3) throw new Error("console: connection reset");
      return { stdout: "OK\n", stderr: "" };
    });

    await expect(shakeTool.execute(services, { udid: androidEmulator })).rejects.toThrow(/shake/i);

    const sets = vi
      .mocked(runAdb)
      .mock.calls.map(([args]) => args as string[])
      .filter((a) => a[4] === "set");
    expect(sets.at(-1)![6]).toBe("0.0000:9.8100:0.0000");
  });

  it("rejects a physical device at the capability gate, before any adb traffic", async () => {
    // A phone's accelerometer is real hardware with no host-side hook, so the
    // matrix omits `android.device` and the dispatch never reaches the handler.
    await expect(shakeTool.execute(services, { udid: "R5CT80ZABCD" })).rejects.toThrow(
      /not supported on android device/i
    );
    expect(runAdb).not.toHaveBeenCalled();
  });

  it("backstops a non-emulator serial that slipped through as `unknown`", async () => {
    // `unknown` is allowed through the matrix (an unresolved serial may still be
    // an emulator), so the handler re-checks rather than letting `adb emu` fail
    // with an opaque console error.
    await expect(
      androidImpl.handler({} as never, { udid: "R5CT80ZABCD" }, {} as never)
    ).rejects.toThrow(/needs an Android emulator/i);
    expect(runAdb).not.toHaveBeenCalled();
  });

  it("restores a rotated device's own resting pose, exponent notation and all", async () => {
    // What a landscape emulator actually reports: the near-zero axis comes back
    // in scientific notation. Misread it and the restore writes a portrait
    // vector, which auto-rotates the device out of landscape mid-test.
    vi.mocked(runAdb).mockImplementation(async (args: string[]) =>
      args.includes("get")
        ? { stdout: "acceleration = 9.81:-1.90735e-06:0\r\nOK\r\n", stderr: "" }
        : { stdout: "OK\r\n", stderr: "" }
    );

    await expect(shakeTool.execute(services, { udid: androidEmulator })).resolves.toEqual({
      shaken: true,
      count: 1,
    });

    const sets = vi
      .mocked(runAdb)
      .mock.calls.map(([args]) => args as string[])
      .filter((a) => a[4] === "set");
    // Landscape gravity is back on X, not swapped onto Y.
    expect(sets.at(-1)![6]).toBe("9.8100:-0.0000:0.0000");
  });

  it("fails loudly when the console rejects a sensor write", async () => {
    // `adb emu` exits 0 even when the console refuses the command — the refusal
    // is only a `KO:` line in the reply. Unchecked, a shake that never reached
    // the device reports `{ shaken: true }`.
    vi.mocked(runAdb).mockImplementation(async (args: string[]) =>
      args.includes("get")
        ? { stdout: "acceleration = 0:9.81:0\r\nOK\r\n", stderr: "" }
        : { stdout: "KO: unknown sensor name: acceleration\r\n", stderr: "" }
    );

    await expect(shakeTool.execute(services, { udid: androidEmulator })).rejects.toThrow(
      /emulator console rejected/i
    );
  });

  it("reads the trailing verdict, not a stray KO earlier in the reply", async () => {
    // An auth banner can emit its own `KO:` ahead of a command that succeeds.
    vi.mocked(runAdb).mockImplementation(async (args: string[]) =>
      args.includes("get")
        ? {
            stdout: "KO: unknown command, try 'help'\r\nacceleration = 0:9.81:0\r\nOK\r\n",
            stderr: "",
          }
        : { stdout: "KO: unknown command, try 'help'\r\nOK\r\n", stderr: "" }
    );

    await expect(shakeTool.execute(services, { udid: androidEmulator })).resolves.toEqual({
      shaken: true,
      count: 1,
    });
  });

  it("falls back rather than adopting a resting vector left stuck by another process", async () => {
    // ~31.6 m/s² is a swung sample, not a pose. Adopting it would restore it,
    // and every later shake would re-capture and re-restore it forever.
    vi.mocked(runAdb).mockImplementation(async (args: string[]) =>
      args.includes("get")
        ? { stdout: "acceleration = -30:9.81:0\r\nOK\r\n", stderr: "" }
        : { stdout: "OK\r\n", stderr: "" }
    );

    await shakeTool.execute(services, { udid: androidEmulator });

    const sets = vi
      .mocked(runAdb)
      .mock.calls.map(([args]) => args as string[])
      .filter((a) => a[4] === "set");
    expect(sets.at(-1)![6]).toBe("0.0000:9.8100:0.0000");
  });

  it("serializes overlapping shakes so neither restores the other's swing", async () => {
    // Agents share an emulator. Unserialized, the second shake reads a mid-burst
    // sample as its resting vector and — finishing last — leaves the device
    // permanently tilted, with both calls reporting success.
    const REST = "0:9.81:0";
    let deviceVector = REST;
    vi.mocked(runAdb).mockImplementation(async (args: string[]) => {
      if (args.includes("get")) {
        return { stdout: `acceleration = ${deviceVector}\r\nOK\r\n`, stderr: "" };
      }
      deviceVector = args[6]!;
      return { stdout: "OK\r\n", stderr: "" };
    });

    // The short shake starts first; the long one begins mid-burst and finishes
    // last, so unserialized it is the long one's restore that survives — and it
    // captured a swung sample as "rest".
    const short = shakeTool.execute(services, { udid: androidEmulator, count: 1 });
    await new Promise((r) => setTimeout(r, 120));
    const long = shakeTool.execute(services, { udid: androidEmulator, count: 3 });
    await Promise.all([short, long]);

    expect(deviceVector).toBe("0.0000:9.8100:0.0000");
  });
});

describe("shake tool — TV targets are out of scope", () => {
  // A TV has no accelerometer and no shake gesture. Apple TV and Android TV are
  // NOT separate platforms — by id shape and device kind they are an ordinary
  // iOS simulator / Android emulator — so the capability matrix admits them and
  // each handler must probe the runtime. Left ungated, the underlying command
  // succeeds and the tool reports a shake that never happened.
  it("rejects an Apple TV simulator", async () => {
    vi.mocked(isTvOsSimulator).mockResolvedValueOnce(true);
    await expect(shakeTool.execute(services, { udid: iosUdid })).rejects.toBeInstanceOf(
      UnsupportedOperationError
    );
    expect(execFile).not.toHaveBeenCalled();
  });

  it("rejects a remote Apple TV simulator", async () => {
    vi.mocked(isRemoteTvOsSimulator).mockResolvedValueOnce(true);
    await expect(
      shakeTool.execute(services, { udid: "remote:9D2F4AEC-7C68-4C73-9BD9-06D1007FBF1F" })
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    expect(simctlSpawn).not.toHaveBeenCalled();
  });

  it("rejects an Android TV emulator before touching its sensors", async () => {
    vi.mocked(isAndroidTv).mockResolvedValueOnce(true);
    await expect(shakeTool.execute(services, { udid: androidEmulator })).rejects.toBeInstanceOf(
      UnsupportedOperationError
    );
    expect(runAdb).not.toHaveBeenCalled();
  });

  it("rejects a Vega (Fire TV) device at the capability matrix", async () => {
    // Vega IS its own platform, so the absent block is enough — no probe needed.
    await expect(shakeTool.execute(services, { udid: "vega-device-1" })).rejects.toThrow();
  });
});

describe("parseAcceleration", () => {
  it("parses the emulator console's reply", () => {
    expect(parseAcceleration("acceleration = 0:9.77631:0.812349\nOK\n")).toEqual({
      x: 0,
      y: 9.77631,
      z: 0.812349,
    });
  });

  it("handles negative components", () => {
    expect(parseAcceleration("acceleration = -1.5:9.8:-0.25\nOK\n")).toEqual({
      x: -1.5,
      y: 9.8,
      z: -0.25,
    });
  });

  it("parses the scientific notation a rotated emulator reports", () => {
    expect(parseAcceleration("acceleration = 9.81:-1.90735e-06:0\r\nOK\r\n")).toEqual({
      x: 9.81,
      y: -1.90735e-6,
      z: 0,
    });
  });

  it("returns null on unparseable output so the caller can fall back", () => {
    expect(parseAcceleration("KO: unknown sensor\n")).toBeNull();
  });
});
