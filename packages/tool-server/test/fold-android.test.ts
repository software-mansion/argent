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
  /** `mScreenOnFully`; `darkens` turns it off for good at the fold. */
  screenOn: boolean;
  darkens: boolean;
  /** `mWakefulness`. An unfold wakes an asleep device `wakeAfter` reads later. */
  awake: boolean;
  wakeAfter: number;
  /** A fold to closed puts the device to sleep. */
  sleepsOnClose: boolean;
  /** After the fold (or the wake), the screen stays dark for this many reads. */
  screenLag: number;
  /** The screen of an awake device flips on every read. */
  flaps: boolean;
  /** Countdowns the reads drive. */
  wakeIn: number | null;
  darkFor: number;
  /** The fold to closed raises the lock screen; `stuck` keeps it up. */
  raisesKeyguard: boolean;
  stuck: boolean;
  /** The guest never commits what the console asked for. */
  ignoresPosture: boolean;
  dismissals: number;
  consoleRefuses: boolean;
  /** `cmd device_state` fails: the image has no such service, or adb lost the device. */
  deviceStateFails?: "no-service" | "no-device" | "transient";
  /** A stuck lock screen clears this long after the first dismissal. */
  clearsAfterMs?: number;
  clearAt?: number;
  /** This many reads print no `isKeyguardShowing=` line, as `dumpsys window` can right after a fold. */
  keyguardLineMissing?: number;
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
    awake: true,
    wakeAfter: 0,
    sleepsOnClose: false,
    screenLag: 0,
    flaps: false,
    wakeIn: null,
    darkFor: 0,
    raisesKeyguard: false,
    stuck: false,
    ignoresPosture: false,
    dismissals: 0,
    consoleRefuses: false,
    ...overrides,
  };
}

/** What a fold to `state` does to the screen and the wakefulness. */
function afterFold(state: string): void {
  if (state === "0" && emu.sleepsOnClose) {
    emu.awake = false;
    emu.screenOn = false;
  } else if (!emu.awake && state !== "0") {
    emu.wakeIn = emu.wakeAfter;
  } else if (emu.awake && emu.screenLag > 0) {
    emu.screenOn = false;
    emu.darkFor = emu.screenLag;
  }
  if (emu.darkens) emu.screenOn = false;
}

const snapshotReads = () =>
  runAdbMock.mock.calls.filter(([args]) => args[3]?.startsWith("cmd device_state print-state;"))
    .length;

/** One snapshot read moves the guest a step on. */
function advance(): void {
  emu.state = emu.pending;
  if (emu.flaps) {
    emu.screenOn = !emu.screenOn;
  } else if (emu.wakeIn !== null) {
    if (emu.wakeIn-- > 0) return;
    emu.wakeIn = null;
    emu.awake = true;
    if (emu.screenLag > 0) emu.darkFor = emu.screenLag;
    else emu.screenOn = true;
  } else if (emu.darkFor > 0 && --emu.darkFor === 0) {
    emu.screenOn = true;
  }
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
      afterFold(target.state);
      return { stdout: "OK\n", stderr: "" };
    }
    if (rest[0] === "sensor" && rest[1] === "set") {
      emu.angle = Number(rest[3]);
      emu.pending = emu.angle < 30 ? "0" : emu.angle < 150 ? "1" : "2";
      afterFold(emu.pending);
      return { stdout: "OK\n", stderr: "" };
    }
    if (rest[0] === "sensor" && rest[1] === "get") {
      return { stdout: `hinge-angle0 = ${emu.angle}\nOK\n`, stderr: "" };
    }
  }
  if (kind === "shell") {
    const command = rest.join(" ");
    if (command === "cmd device_state print-states") {
      if (emu.deviceStateFails === "no-service") {
        throw new Error(`adb ${args.join(" ")} failed: cmd: Can't find service: device_state`);
      }
      if (emu.deviceStateFails === "transient") {
        throw new Error(`adb ${args.join(" ")} failed: adb: protocol fault (couldn't read status)`);
      }
      if (emu.deviceStateFails === "no-device") {
        throw new Error(`adb ${args.join(" ")} failed: adb: device '${args[1]}' not found`);
      }
      return { stdout: emu.states, stderr: "" };
    }
    if (command.startsWith("cmd device_state print-state;")) {
      if (emu.clearAt !== undefined && Date.now() >= emu.clearAt) emu.keyguard = false;
      const wakefulness = emu.awake ? "Awake" : "Asleep";
      let read = `${emu.state}\nmScreenOnFully=${emu.screenOn}\nmWakefulness=${wakefulness}\n`;
      if (emu.keyguardLineMissing && emu.keyguardLineMissing-- > 0) {
        // The shell exits with the last grep's status, which found nothing.
        if (!command.endsWith("; true")) throw new Error(`adb ${args.join(" ")} failed: ${read}`);
      } else {
        read += `isKeyguardShowing=${emu.keyguard}\n`;
      }
      advance();
      return { stdout: read, stderr: "" };
    }
    if (command === "wm dismiss-keyguard") {
      emu.dismissals++;
      if (emu.clearsAfterMs !== undefined) emu.clearAt ??= Date.now() + emu.clearsAfterMs;
      else if (!emu.stuck) emu.keyguard = false;
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
  androidImpl,
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

async function fold(params: Record<string, unknown>, signal?: AbortSignal) {
  const pending = foldTool.execute!(
    {},
    { udid: SERIAL, ...params } as never,
    {
      signal,
    } as never
  );
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
    expect(
      parseSnapshot("1\nmScreenOnFully=false\nmWakefulness=Dozing\nisKeyguardShowing=true\n")
    ).toEqual({ state: "1", screenOn: false, awake: false, keyguard: true });
    expect(parseSnapshot("1\nmScreenOnFully=false\nmWakefulness=Awake\n")).toMatchObject({
      screenOn: false,
      awake: true,
    });
    expect(parseSnapshot("3\n")).toStrictEqual({
      state: "3",
      screenOn: true,
      awake: true,
      keyguard: undefined,
    });
    expect(parseSnapshot("3\nisKeyguardShowing=false\n").keyguard).toBe(false);
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
    const started = Date.now();
    const result = await fold({ posture: "closed" });

    expect(result).toMatchObject({ posture: "closed", deviceState: "CLOSED" });
    expect(result.warning).toMatch(/could not dismiss it/);
    expect(emu.dismissals).toBeLessThanOrEqual(3);
    // Settling takes about a second; the dismissal gives up five seconds later.
    expect(Date.now() - started).toBeLessThan(7_000);
  });

  it("waits for a lock screen that clears seconds after the dismissal", async () => {
    emu = fresh({ raisesKeyguard: true, clearsAfterMs: 3_000 });
    const result = await fold({ posture: "closed" });

    expect(result).toEqual({ posture: "closed", deviceState: "CLOSED", hingeAngle: 0 });
    expect(emu.keyguard).toBe(false);
    // One call a second until it clears.
    expect(emu.dismissals).toBe(3);
  });

  it("takes reads without the lock screen line as unknown, not as a failed fold", async () => {
    emu = fresh({ raisesKeyguard: true, keyguardLineMissing: 4 });
    const result = await fold({ posture: "closed" });

    expect(result).toEqual({ posture: "closed", deviceState: "CLOSED", hingeAngle: 0 });
    expect(emu.dismissals).toBe(1);
    expect(emu.keyguard).toBe(false);
  });

  it("does not count reads without the lock screen line as a cleared lock screen", async () => {
    // The pre-fold read and the four settling reads, then five during the dismissal.
    emu = fresh({ raisesKeyguard: true, stuck: true, keyguardLineMissing: 10 });
    const result = await fold({ posture: "closed" });

    expect(result).toMatchObject({ posture: "closed", deviceState: "CLOSED" });
    expect(result.warning).toMatch(/could not dismiss it/);
    expect(emu.dismissals).toBeGreaterThan(0);
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
    emu = fresh({ screenOn: false, awake: false, keyguard: true });
    const started = Date.now();
    const result = await fold({ posture: "closed" });

    expect(result).toMatchObject({ posture: "closed", deviceState: "CLOSED" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(emu.screenOn).toBe(false);
    expect(result.warning).toBe(
      "The screen is off and the lock screen is showing after the fold. Wake and unlock the device before the next action."
    );
  });

  it("waits for an asleep device that wakes a second after the unfold", async () => {
    emu = fresh({
      state: "0",
      pending: "0",
      angle: 0,
      screenOn: false,
      awake: false,
      wakeAfter: 3,
    });
    const result = await fold({ posture: "open" });

    expect(result).toEqual({ posture: "open", deviceState: "OPENED", hingeAngle: 180 });
    expect(emu.awake).toBe(true);
    // One read before the fold, one of the old state, three asleep ones the
    // grace reads hold back, three awake ones that agree.
    expect(snapshotReads()).toBe(8);
  });

  it("waits for the screen of a device that wakes on unfold", async () => {
    emu = fresh({
      state: "0",
      pending: "0",
      angle: 0,
      screenOn: false,
      awake: false,
      screenLag: 6,
    });
    const result = await fold({ posture: "open" });

    expect(result).toEqual({ posture: "open", deviceState: "OPENED", hingeAngle: 180 });
    expect(emu.screenOn).toBe(true);
    // One read before the fold, one of the old state, six awake and dark
    // ones, three lit ones that agree.
    expect(snapshotReads()).toBe(11);
  });

  it("settles a fold whose screen flaps, with a warning, when it ends lit", async () => {
    emu = fresh({ flaps: true, screenOn: true });
    const result = await fold({ posture: "half-open" });

    expect(result).toMatchObject({ posture: "half-open", deviceState: "HALF_OPENED" });
    expect(result.warning).toMatch(/did not hold steady/);
  });

  it("fails a fold whose screen flaps when it ends dark", async () => {
    emu = fresh({ flaps: true, screenOn: false });
    const err = await fold({ posture: "half-open" }).catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.ANDROID_FOLD_FAILED);
    expect(String(err)).toMatch(/reached device state HALF_OPENED.*screen did not stay on/);
  });

  it("settles an angle fold that puts the device to sleep, and warns", async () => {
    emu = fresh({ sleepsOnClose: true });
    const started = Date.now();
    const result = await fold({ angle: 10 });

    expect(result).toMatchObject({ posture: "closed", deviceState: "CLOSED", hingeAngle: 10 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.warning).toBe(
      "The screen is off after the fold. Wake the device before the next action."
    );
  });

  it("does not try to dismiss the lock screen of a device the fold put to sleep", async () => {
    emu = fresh({ sleepsOnClose: true, raisesKeyguard: true });
    const started = Date.now();
    const result = await fold({ posture: "closed" });

    expect(result).toMatchObject({ posture: "closed", deviceState: "CLOSED" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(emu.dismissals).toBe(0);
    expect(result.warning).toMatch(/screen is off and the lock screen is showing/);
    expect(result.warning).not.toMatch(/PIN/);
  });

  it("says the state was reached when only the screen stays off", async () => {
    emu = fresh({ darkens: true });
    const err = await fold({ posture: "closed" }).catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.ANDROID_FOLD_FAILED);
    expect(String(err)).toMatch(/reached device state CLOSED.*screen did not stay on/);
    expect(String(err)).not.toMatch(/did not reach/);
  });

  it("dismisses the lock screen a fold to closed raised before failing on a dark screen", async () => {
    emu = fresh({ darkens: true, raisesKeyguard: true });
    const err = await fold({ posture: "closed" }).catch((e: unknown) => e);

    expect(String(err)).toMatch(/reached device state CLOSED.*screen did not stay on/);
    expect(emu.dismissals).toBe(1);
    expect(emu.keyguard).toBe(false);
  });

  it("does not move the hinge for a fold cancelled while it waited", async () => {
    const first = foldTool.execute!({}, { udid: SERIAL, posture: "closed" } as never);
    const controller = new AbortController();
    controller.abort();
    const second = foldTool.execute!(
      {},
      { udid: SERIAL, posture: "open" } as never,
      {
        signal: controller.signal,
      } as never
    );
    second.catch(() => {});
    await vi.runAllTimersAsync();

    expect(await first).toMatchObject({ posture: "closed" });
    await expect(second).rejects.toBeDefined();
    expect(runAdbMock).not.toHaveBeenCalledWith(["-s", SERIAL, "emu", "posture", "3"]);

    // The lock is free again.
    expect(await fold({ posture: "open" })).toMatchObject({ posture: "open" });
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

  it("rejects a loopback serial, which `adb emu` cannot address", async () => {
    const udid = "127.0.0.1:5581";
    // Through the tool, the capability reads it as a device.
    const gated = await foldTool.execute!({}, { udid, posture: "open" } as never).catch(
      (e: unknown) => e
    );
    expect(getFailureSignal(gated)?.error_code).toBe(
      FAILURE_CODES.TOOL_CAPABILITY_UNSUPPORTED_OPERATION
    );
    // Past the gate, as an `unknown` serial, the handler rejects it.
    const err = await androidImpl
      .handler({}, { udid, posture: "open" }, { id: udid, platform: "android", kind: "unknown" })
      .catch((e: unknown) => e);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.ANDROID_FOLD_UNSUPPORTED);
    expect(String(err)).toMatch(/only an Android emulator's hinge can be moved/);
    expect(runAdbMock).not.toHaveBeenCalled();
  });

  it("rejects an image without device states as not foldable", async () => {
    emu = fresh({ deviceStateFails: "no-service" });
    const err = await fold({ posture: "open" }).catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.ANDROID_FOLD_UNSUPPORTED);
    expect(String(err)).toMatch(/not a foldable emulator/);
  });

  it("keeps adb's error for a device adb cannot find", async () => {
    emu = fresh({ deviceStateFails: "no-device" });
    const err = await fold({ posture: "open" }).catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).not.toBe(FAILURE_CODES.ANDROID_FOLD_UNSUPPORTED);
    expect(String(err)).toMatch(/device 'emulator-5580' not found/);
  });

  it("keeps adb's error for a transient adb failure", async () => {
    emu = fresh({ deviceStateFails: "transient" });
    const err = await fold({ posture: "open" }).catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).not.toBe(FAILURE_CODES.ANDROID_FOLD_UNSUPPORTED);
    expect(String(err)).toMatch(/protocol fault/);
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
    avd("Generic", "hw.device.name = 7.6in Foldable\nhw.sensor.hinge = true\n");
    expect(await isFoldableAvd("Generic")).toBe(true);
  });

  it("is false for a phone, and for an AVD it cannot find", async () => {
    avd("Phone", "hw.device.name = pixel_9\nhw.sensor.hinge = no\n");
    expect(await isFoldableAvd("Phone")).toBe(false);
    expect(await isFoldableAvd("Missing")).toBe(false);
  });
});
