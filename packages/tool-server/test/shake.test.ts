import { describe, it, expect, vi, beforeEach } from "vitest";

// The iOS branch shells out to `xcrun simctl spawn … notifyutil`. Stub the
// subprocess so the test asserts the argv wiring (which notification, how many
// times) without a booted simulator.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: vi.fn((_file: string, _args: string[], _opts: unknown, cb: (e: null) => void) => cb(null)),
}));

// Device-set resolution reads config off disk; pin it so argv is deterministic.
vi.mock("../src/utils/ios-device-sets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-device-sets")>()),
  simctlArgsForUdid: vi.fn(async (_udid: string, args: readonly string[]) => ["simctl", ...args]),
}));

// The Android branch drives the emulator console over adb.
vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  runAdb: vi.fn(async () => ({ stdout: "acceleration = 0:9.77631:0.812349\nOK\n", stderr: "" })),
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
import { runAdb } from "../src/utils/adb";

const iosUdid = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const androidEmulator = "emulator-5554";
const services = {} as never;

beforeEach(() => {
  vi.mocked(execFile).mockClear();
  vi.mocked(runAdb).mockClear();
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

  it("returns null on unparseable output so the caller can fall back", () => {
    expect(parseAcceleration("KO: unknown sensor\n")).toBeNull();
  });
});
