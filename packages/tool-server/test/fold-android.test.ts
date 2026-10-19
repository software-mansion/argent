import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";

/**
 * A scripted foldable emulator behind `adb`: the console moves the posture,
 * the guest commits the matching state on the next read, and the lock screen
 * can be raised by a fold to closed.
 */
const PIXEL_FOLD_STATES = `Supported states: [
  DeviceState{identifier=0, name='CLOSED', app_accessible=true},
  DeviceState{identifier=1, name='HALF_OPENED', app_accessible=true},
  DeviceState{identifier=2, name='OPENED', app_accessible=true},
  DeviceState{identifier=3, name='REAR_DISPLAY_MODE', app_accessible=true},
]`;
const PHONE_STATES = `Supported states: [
  DeviceState{identifier=0, name='DEFAULT', app_accessible=true},
]`;

interface FakeEmulator {
  states: string;
  /** Committed state id; follows `pending` on the next read. */
  state: string;
  pending: string;
  angle: number;
  keyguard: boolean;
  /** `mScreenOnFully`; a fold to open wakes an asleep device, `darkens` turns it off. */
  screenOn: boolean;
  darkens: boolean;
  /** The fold to closed raises the lock screen; `stuck` keeps it up. */
  raisesKeyguard: boolean;
  stuck: boolean;
  /** The guest never commits what the console asked for. */
  ignoresPosture: boolean;
  dismissals: number;
  consoleRefuses: boolean;
}

const POSTURE_TO_STATE: Record<string, { state: string; angle: number }> = {
  "1": { state: "0", angle: 0 },
  "2": { state: "1", angle: 90 },
  "3": { state: "2", angle: 180 },
};

let emu: FakeEmulator;

function fresh(overrides: Partial<FakeEmulator> = {}): FakeEmulator {
  return {
    states: PIXEL_FOLD_STATES,
    state: "2",
    pending: "2",
    angle: 180,
    keyguard: false,
    screenOn: true,
    darkens: false,
    raisesKeyguard: false,
    stuck: false,
    ignoresPosture: false,
    dismissals: 0,
    consoleRefuses: false,
    ...overrides,
  };
}

const runAdbMock = vi.fn(async (args: string[]) => {
  const [, , kind, ...rest] = args;
  if (kind === "emu") {
    if (emu.consoleRefuses) return { stdout: "KO: unknown command\n", stderr: "" };
    if (rest[0] === "posture") {
      const target = POSTURE_TO_STATE[rest[1]!]!;
      if (!emu.ignoresPosture) emu.pending = target.state;
      emu.angle = target.angle;
      if (target.state === "0" && emu.raisesKeyguard) emu.keyguard = true;
      if (target.state === "2") emu.screenOn = true;
      if (emu.darkens) emu.screenOn = false;
      return { stdout: "OK\n", stderr: "" };
    }
    if (rest[0] === "sensor" && rest[1] === "set") {
      emu.angle = Number(rest[3]);
      emu.pending = emu.angle < 30 ? "0" : emu.angle < 150 ? "1" : "2";
      return { stdout: "OK\n", stderr: "" };
    }
    if (rest[0] === "sensor" && rest[1] === "get") {
      return { stdout: `hinge-angle0 = ${emu.angle}\nOK\n`, stderr: "" };
    }
  }
  if (kind === "shell") {
    const command = rest.join(" ");
    if (command === "cmd device_state print-states") return { stdout: emu.states, stderr: "" };
    if (command.startsWith("cmd device_state print-state;")) {
      const read = `${emu.state}\nmScreenOnFully=${emu.screenOn}\nisKeyguardShowing=${emu.keyguard}\n`;
      emu.state = emu.pending;
      return { stdout: read, stderr: "" };
    }
    if (command === "wm dismiss-keyguard") {
      emu.dismissals++;
      if (!emu.stuck) emu.keyguard = false;
      return { stdout: "", stderr: "" };
    }
  }
  throw new Error(`unexpected adb ${args.join(" ")}`);
});

vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  runAdb: (args: string[]) => runAdbMock(args),
}));
vi.mock("../src/utils/check-deps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/check-deps")>()),
  ensureDeps: vi.fn(async () => {}),
}));

import { foldTool } from "../src/tools/fold";
import {
  parseDeviceStates,
  parseHingeAngle,
  parseSnapshot,
} from "../src/tools/fold/platforms/android";
import { isFoldableAvd } from "../src/utils/adb";

const SERIAL = "emulator-5580";

beforeEach(() => {
  vi.useFakeTimers();
  emu = fresh();
  runAdbMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

async function fold(params: Record<string, unknown>) {
  const pending = foldTool.execute!({}, { udid: SERIAL, ...params } as never);
  // Swallow here so a rejection is not reported before the test awaits it.
  pending.catch(() => {});
  await vi.runAllTimersAsync();
  return pending;
}

describe("fold on Android — parsing", () => {
  it("reads the device states by name", () => {
    expect([...parseDeviceStates(PIXEL_FOLD_STATES)]).toEqual([
      ["CLOSED", "0"],
      ["HALF_OPENED", "1"],
      ["OPENED", "2"],
      ["REAR_DISPLAY_MODE", "3"],
    ]);
  });

  it("reads one snapshot, taking a missing screen flag as on", () => {
    expect(parseSnapshot("1\nmScreenOnFully=false\nisKeyguardShowing=true\n")).toEqual({
      state: "1",
      screenOn: false,
      keyguard: true,
    });
    expect(parseSnapshot("3\n")).toEqual({ state: "3", screenOn: true, keyguard: false });
  });

  it("reads the hinge angle", () => {
    expect(parseHingeAngle("hinge-angle0 = 15\nOK")).toBe(15);
    expect(parseHingeAngle("KO: no sensor")).toBeUndefined();
  });
});

describe("fold on Android — execute", () => {
  it("folds to a posture through the console and waits for the committed state", async () => {
    emu = fresh({ state: "2", pending: "2" });
    const result = await fold({ posture: "closed" });

    expect(result).toEqual({ posture: "closed", deviceState: "CLOSED", hingeAngle: 0 });
    expect(runAdbMock).toHaveBeenCalledWith(["-s", SERIAL, "emu", "posture", "1"]);
  });

  it("moves the hinge sensor for an angle and reports the state the guest derived", async () => {
    const result = await fold({ angle: 120 });

    expect(result).toEqual({ posture: "half-open", deviceState: "HALF_OPENED", hingeAngle: 120 });
    expect(runAdbMock).toHaveBeenCalledWith([
      "-s",
      SERIAL,
      "emu",
      "sensor",
      "set",
      "hinge-angle0",
      "120",
    ]);
  });

  it("dismisses a lock screen the fold to closed raised", async () => {
    emu = fresh({ raisesKeyguard: true });
    const result = await fold({ posture: "closed" });

    expect(emu.dismissals).toBe(1);
    expect(result.warning).toBeUndefined();
  });

  it("warns, without failing the fold, when the lock screen stays up", async () => {
    emu = fresh({ raisesKeyguard: true, stuck: true });
    const result = await fold({ posture: "closed" });

    expect(result).toMatchObject({ posture: "closed", deviceState: "CLOSED" });
    expect(result.warning).toMatch(/lock screen/);
  });

  it("leaves a lock screen that was up before the fold alone, and warns about it", async () => {
    emu = fresh({ keyguard: true });
    const result = await fold({ posture: "closed" });

    expect(emu.dismissals).toBe(0);
    expect(result).toMatchObject({ posture: "closed", deviceState: "CLOSED" });
    expect(result.warning).toMatch(/lock screen is showing/);
  });

  it("warns when the lock screen is up after a fold to open", async () => {
    emu = fresh({ state: "0", pending: "0", angle: 0, keyguard: true });
    const result = await fold({ posture: "open" });

    expect(emu.dismissals).toBe(0);
    expect(result).toMatchObject({ posture: "open", deviceState: "OPENED" });
    expect(result.warning).toMatch(/lock screen is showing/);
  });

  it("folds an asleep device to closed without waiting for the screen", async () => {
    emu = fresh({ screenOn: false, keyguard: true });
    const started = Date.now();
    const result = await fold({ posture: "closed" });

    expect(result).toMatchObject({ posture: "closed", deviceState: "CLOSED" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(emu.screenOn).toBe(false);
  });

  it("says the state was reached when only the screen stays off", async () => {
    emu = fresh({ darkens: true });
    const err = await fold({ posture: "closed" }).catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.ANDROID_FOLD_FAILED);
    expect(String(err)).toMatch(/reached device state CLOSED.*screen did not turn on/);
    expect(String(err)).not.toMatch(/did not reach/);
  });

  it("runs two overlapping folds on one device one after the other", async () => {
    const first = foldTool.execute!({}, { udid: SERIAL, posture: "closed" } as never);
    const second = foldTool.execute!({}, { udid: SERIAL, posture: "open" } as never);
    await vi.runAllTimersAsync();

    expect(await first).toMatchObject({ posture: "closed", deviceState: "CLOSED" });
    expect(await second).toMatchObject({ posture: "open", deviceState: "OPENED" });
    const calls = runAdbMock.mock.calls.map(([args]) => args.slice(2).join(" "));
    const firstDone = calls.indexOf("emu sensor get hinge-angle0");
    expect(firstDone).toBeGreaterThan(-1);
    expect(calls.indexOf("emu posture 3")).toBeGreaterThan(firstDone);
  });

  it("fails when the guest never commits the posture", async () => {
    emu = fresh({ ignoresPosture: true });
    const err = await fold({ posture: "closed" }).catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.ANDROID_FOLD_FAILED);
    expect(String(err)).toMatch(/did not reach the closed posture.*OPENED/);
    expect(String(err)).not.toMatch(/screen off/);
  });

  it("fails when the console refuses the posture", async () => {
    emu = fresh({ consoleRefuses: true });
    const err = await fold({ posture: "open" }).catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.ANDROID_FOLD_FAILED);
  });

  it("rejects a phone profile as unsupported", async () => {
    emu = fresh({ states: PHONE_STATES });
    const err = await fold({ posture: "open" }).catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.ANDROID_FOLD_UNSUPPORTED);
    expect(String(err)).toMatch(/not a foldable emulator/);
    expect(runAdbMock).not.toHaveBeenCalledWith(expect.arrayContaining(["emu"]));
  });

  it("rejects a physical device before touching it", async () => {
    // The capability gate stops a serial known to be a phone; one that resolved
    // as `unknown` reaches the handler, which needs a console port.
    for (const udid of ["R3CX307G84M", "192.168.1.20:5555"]) {
      const err = await foldTool.execute!({}, { udid, posture: "open" } as never).catch(
        (e: unknown) => e
      );
      expect([
        FAILURE_CODES.TOOL_CAPABILITY_UNSUPPORTED_OPERATION,
        FAILURE_CODES.ANDROID_FOLD_UNSUPPORTED,
      ]).toContain(getFailureSignal(err)?.error_code);
    }
    expect(runAdbMock).not.toHaveBeenCalled();
  });
});

describe("isFoldableAvd", () => {
  let root: string;
  const saved = process.env.ANDROID_AVD_HOME;

  beforeEach(() => {
    vi.useRealTimers();
    root = mkdtempSync(join(tmpdir(), "avd-"));
    process.env.ANDROID_AVD_HOME = root;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.ANDROID_AVD_HOME;
    else process.env.ANDROID_AVD_HOME = saved;
    rmSync(root, { recursive: true, force: true });
  });

  function avd(name: string, config: string): void {
    const dir = join(root, `${name}.avd`);
    mkdirSync(dir);
    writeFileSync(join(root, `${name}.ini`), `path=${dir}\n`);
    writeFileSync(join(dir, "config.ini"), config);
  }

  it("is true for a profile with a hinge", async () => {
    avd("Fold", "hw.device.name = pixel_9_pro_fold\nhw.sensor.hinge = yes\n");
    expect(await isFoldableAvd("Fold")).toBe(true);
  });

  it("is false for a phone, and for an AVD it cannot find", async () => {
    avd("Phone", "hw.device.name = pixel_9\nhw.sensor.hinge = no\n");
    expect(await isFoldableAvd("Phone")).toBe(false);
    expect(await isFoldableAvd("Missing")).toBe(false);
  });
});
