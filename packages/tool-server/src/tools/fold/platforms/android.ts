import { FAILURE_CODES, FailureError, type DeviceInfo } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { runAdb } from "../../../utils/adb";
import { runEmuConsole } from "../../../utils/emulator-console";

/**
 * A foldable Android emulator is folded through its emulator console. A
 * posture preset goes through `posture <id>`, which moves the hinge sensor to
 * the angle the AVD profile defines for it (0°, 90°, 180° on the Pixel folds;
 * 15°, 90°, 165° on the generic foldables). An angle goes to the hinge sensor
 * itself (`sensor set hinge-angle0`), and the guest derives its posture from
 * the angle the same way.
 *
 * Either way the console answers before the guest reacts, so the committed
 * device state is the verification: it is what `WindowManager`'s
 * `FoldingFeature` and the display switch derive from. Its ids differ per
 * profile (the Pixel folds number `CLOSED` 0, the generic foldables 1), so
 * they are looked up by name.
 */

const POSTURES = ["closed", "half-open", "open"] as const;
type Posture = (typeof POSTURES)[number];

/** The console's posture id and the device state the guest commits for it. */
const EMULATOR_POSTURES: Record<Posture, { id: string; state: string }> = {
  "closed": { id: "1", state: "CLOSED" },
  "half-open": { id: "2", state: "HALF_OPENED" },
  "open": { id: "3", state: "OPENED" },
};

/** Poll spacing, and the budget the guest gets to commit the state and light the screen. */
const POLL_MS = 250;
const SETTLE_TIMEOUT_MS = 15_000;

/**
 * Reads that must agree before the fold is done: the same device state with
 * the screen fully on. A Pixel fold turns one panel off and the other on,
 * which takes 0.3-0.5 s after the state commits; until then the guest takes
 * no input. An angle has no state to wait for, so the agreement is also what
 * tells a committed state from one the guest has not left yet. An asleep
 * device has a dark screen by right (a fold to closed leaves it asleep, and
 * not every image wakes on unfold), so the screen must be on only while the
 * device is awake.
 */
const STABLE_READS = 3;

/**
 * `wm dismiss-keyguard` calls, their spacing, and how long the lock screen may
 * stay up before a fold's lock screen counts as one argent cannot dismiss (a
 * PIN keeps it up). A swipe lock screen can take 3-4 s to clear on a loaded
 * emulator, so the calls are spread over the wait rather than sent at once.
 */
const MAX_DISMISS_ATTEMPTS = 3;
const DISMISS_SPACING_MS = 1_000;
const DISMISS_TIMEOUT_MS = 5_000;

/**
 * Extra reads an asleep result needs when the device was asleep before an
 * unfold. An image that wakes on unfold reports `Awake` up to about a second
 * after the state commits; without them the fold ends on the dark screen
 * before the wake.
 */
const WAKE_GRACE_READS = 2;

export interface AndroidFoldParams {
  udid: string;
  posture?: Posture;
  angle?: number;
}

export interface AndroidFoldResult {
  /** The posture the guest committed, as apps see it. Absent for a state outside the three. */
  posture?: Posture;
  /** The device state the guest committed, by name (`CLOSED`, `HALF_OPENED`, `OPENED`, ...). */
  deviceState: string;
  /** The hinge angle as the sensor reads it. */
  hingeAngle?: number;
  /** Set when the lock screen is up after the fold, or the state did not settle. */
  warning?: string;
}

const abortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new Error("The fold was cancelled.");

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(abortReason(signal));
      },
      { once: true }
    );
  });

function unsupported(message: string, stage: string): FailureError {
  return new FailureError(message, {
    error_code: FAILURE_CODES.ANDROID_FOLD_UNSUPPORTED,
    failure_stage: stage,
    failure_area: "tool_server",
    error_kind: "unsupported",
  });
}

function failed(message: string, stage: string, cause?: unknown): FailureError {
  return new FailureError(
    message,
    {
      error_code: FAILURE_CODES.ANDROID_FOLD_FAILED,
      failure_stage: stage,
      failure_area: "tool_server",
      error_kind: "subprocess",
    },
    cause instanceof Error ? { cause } : undefined
  );
}

async function shell(serial: string, command: string): Promise<string> {
  const { stdout } = await runAdb(["-s", serial, "shell", command], { timeoutMs: 10_000 });
  return stdout;
}

/** The device states the guest can commit, by name, as `cmd device_state print-states` lists them. */
export function parseDeviceStates(stdout: string): Map<string, string> {
  const states = new Map<string, string>();
  for (const match of stdout.matchAll(/identifier=(\d+), name='([A-Z_]+)'/g)) {
    states.set(match[2]!, match[1]!);
  }
  return states;
}

interface Snapshot {
  state: string | undefined;
  screenOn: boolean;
  /** `mWakefulness` is `Awake` (or `Dreaming`), not `Asleep` or `Dozing`. */
  awake: boolean;
  /** Unknown when `dumpsys window` printed no `isKeyguardShowing=` line, as it can right after a fold. */
  keyguard: boolean | undefined;
}

/**
 * One read of the state, the screen, the wakefulness and the lock screen.
 * `mScreenOnFully` is absent on an image that does not report it, which
 * counts as on: a missing signal must not stall every fold for the whole
 * budget. A missing `mWakefulness` follows the screen for the same reason;
 * on such an image a screen that stays dark ends the fold as asleep, with a
 * warning, not as a failure. A missing `isKeyguardShowing` leaves the lock
 * screen unknown.
 */
export function parseSnapshot(stdout: string): Snapshot {
  const screenOn = !/mScreenOnFully=false/.test(stdout);
  const wakefulness = /mWakefulness=([A-Za-z]+)/.exec(stdout)?.[1];
  const keyguard = /isKeyguardShowing=([a-z]+)/.exec(stdout)?.[1];
  return {
    state: /^\s*(\d+)\s*$/m.exec(stdout)?.[1],
    screenOn,
    awake: wakefulness ? !/^(Asleep|Dozing)$/.test(wakefulness) : screenOn,
    keyguard: keyguard === undefined ? undefined : keyguard === "true",
  };
}

/**
 * The shell's exit status is the last command's, so a grep that matches
 * nothing (a line `dumpsys` skips for a moment after a fold) would fail the
 * read; `; true` leaves a missing line to the parse.
 */
async function readSnapshot(serial: string): Promise<Snapshot> {
  return parseSnapshot(
    await shell(
      serial,
      "cmd device_state print-state; " +
        "dumpsys window displays | grep -o 'mScreenOnFully=[a-z]*'; " +
        "dumpsys power | grep -o 'mWakefulness=[A-Za-z]*'; " +
        "dumpsys window | grep -o 'isKeyguardShowing=[a-z]*'; true"
    )
  );
}

/** The hinge sensor as the console reports it: `hinge-angle0 = <degrees>`. */
export function parseHingeAngle(stdout: string): number | undefined {
  const match = /hinge-angle0\s*=\s*(-?\d+(?:\.\d+)?)/.exec(stdout);
  return match ? Number(match[1]) : undefined;
}

/** A read the fold can end on: a state (the expected one), lit unless the device is asleep. */
function isReady(read: Snapshot, expected: string | undefined): boolean {
  return (
    read.state !== undefined &&
    (read.screenOn || !read.awake) &&
    (expected === undefined || read.state === expected)
  );
}

/**
 * Poll until the guest holds one device state (the expected one, when the
 * request names it) and one wakefulness for {@link STABLE_READS} ready reads,
 * plus {@link WAKE_GRACE_READS} for an asleep result away from `closedId` on
 * a device that was asleep before. A device that wakes on unfold restarts the
 * count, so the fold does not end on the dark screen before the wake. A read
 * still ready at the deadline is a settled fold too, but not a `steady` one:
 * a screen that keeps resetting the count must not fail a fold that ended
 * where it should. The first read waits a poll: the console answered before
 * the guest reacted.
 */
async function awaitSettled(
  serial: string,
  expected: string | undefined,
  wake: { wasAsleep: boolean; closedId: string | undefined },
  signal: AbortSignal | undefined
): Promise<{ last: Snapshot | undefined; settled: boolean; steady: boolean }> {
  let last: Snapshot | undefined;
  let agreeing = 0;
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS, signal);
    const read = await readSnapshot(serial);
    const same = read.state === last?.state && read.awake === last?.awake;
    if (!isReady(read, expected)) agreeing = 0;
    else agreeing = agreeing > 0 && same ? agreeing + 1 : 1;
    last = read;
    const mayWake = wake.wasAsleep && !read.awake && read.state !== wake.closedId;
    if (agreeing >= STABLE_READS + (mayWake ? WAKE_GRACE_READS : 0)) {
      return { last, settled: true, steady: true };
    }
  }
  const settled = last !== undefined && isReady(last, expected);
  return { last, settled, steady: false };
}

/**
 * A fold to the cover panel can raise the lock screen ("Swipe up to
 * continue"), Android's continue-apps-on-fold behaviour. Left up, every later
 * capture reads the lock screen instead of the app, so it is dismissed the way
 * the swipe would. A keyguard already up before the fold is not the fold's to
 * clear, and one with a PIN cannot be: that is a warning, the fold itself
 * succeeded. A read that does not say whether the lock screen is up neither
 * counts as clear nor triggers a dismissal.
 */
async function dismissFoldLockScreen(
  serial: string,
  signal: AbortSignal | undefined
): Promise<string | undefined> {
  let clear = 0;
  let attempts = 0;
  let lastAttempt = -Infinity;
  const deadline = Date.now() + DISMISS_TIMEOUT_MS;
  for (;;) {
    const { keyguard } = await readSnapshot(serial);
    if (keyguard === false) {
      if (++clear >= STABLE_READS) return undefined;
    } else {
      clear = 0;
      if (Date.now() >= deadline) {
        if (keyguard) break;
        return undefined;
      }
      if (
        keyguard &&
        attempts < MAX_DISMISS_ATTEMPTS &&
        Date.now() - lastAttempt >= DISMISS_SPACING_MS
      ) {
        attempts++;
        lastAttempt = Date.now();
        await shell(serial, "wm dismiss-keyguard");
      }
    }
    await sleep(POLL_MS, signal);
  }
  return "The fold raised the lock screen and argent could not dismiss it (a PIN or password keeps it up). Unlock the device before the next action.";
}

function targetLabel(params: AndroidFoldParams): string {
  return params.posture ?? `${params.angle}°`;
}

/**
 * Serializes folds per device. Two folds that overlap send their console
 * commands back to back, and the one that loses waits for a state the guest
 * has already left. Agents share an emulator, so overlap is ordinary; a waiter
 * costs the fold ahead of it.
 */
const inFlightByDevice = new Map<string, Promise<unknown>>();

function withDeviceLock<T>(serial: string, fn: () => Promise<T>): Promise<T> {
  const previous = inFlightByDevice.get(serial) ?? Promise.resolve();
  // A failed fold must not wedge the queue.
  const run = previous.then(fn, fn);
  const settled = run.catch(() => {});
  inFlightByDevice.set(serial, settled);
  void settled.then(() => {
    if (inFlightByDevice.get(serial) === settled) inFlightByDevice.delete(serial);
  });
  return run;
}

/**
 * What `cmd device_state` prints on an image without the service (before
 * Android 12), or without `cmd` itself.
 */
const NO_DEVICE_STATE_SERVICE =
  /Can't find service: device_state|cmd: not found|No shell command implementation/i;

/**
 * The device states the guest lists. An image without `cmd device_state` has
 * no foldable states either; every other failure (a lost device, a daemon
 * restart, a timeout) stays adb's.
 */
async function readDeviceStates(serial: string): Promise<Map<string, string>> {
  try {
    return parseDeviceStates(await shell(serial, "cmd device_state print-states"));
  } catch (err) {
    if (!NO_DEVICE_STATE_SERVICE.test(err instanceof Error ? err.message : String(err))) throw err;
    return new Map();
  }
}

async function fold(
  serial: string,
  params: AndroidFoldParams,
  device: DeviceInfo,
  signal: AbortSignal | undefined
): Promise<AndroidFoldResult> {
  // A fold cancelled while it waited for the lock must not move the hinge.
  signal?.throwIfAborted();
  const states = await readDeviceStates(serial);
  const byId = new Map([...states].map(([name, id]) => [id, name]));
  const supported = POSTURES.filter((p) => states.has(EMULATOR_POSTURES[p].state));
  if (supported.length === 0) {
    throw unsupported(
      `${device.id} is not a foldable emulator: it lists no CLOSED, HALF_OPENED or OPENED device state. ` +
        "Boot a foldable AVD (a Pixel Fold or a generic foldable profile); `list-devices` marks them with `foldable: true`.",
      "android_fold_not_foldable"
    );
  }
  const expected = params.posture ? states.get(EMULATOR_POSTURES[params.posture].state) : undefined;
  if (params.posture && expected === undefined) {
    throw unsupported(
      `${device.id} has no ${EMULATOR_POSTURES[params.posture].state} device state for the ${params.posture} posture; it supports ${supported.join(", ")}.`,
      "android_fold_posture_unsupported"
    );
  }

  // A lock screen already up before the fold is not the fold's to clear. One
  // this read cannot see counts as down.
  const before = await readSnapshot(serial);

  signal?.throwIfAborted();
  try {
    if (params.posture) {
      await runEmuConsole(serial, ["posture", EMULATOR_POSTURES[params.posture].id]);
    } else {
      await runEmuConsole(serial, ["sensor", "set", "hinge-angle0", String(params.angle)]);
    }
  } catch (err) {
    throw failed(
      `Failed to fold ${serial} to ${targetLabel(params)}: ${err instanceof Error ? err.message : String(err)}`,
      "android_fold_console",
      err
    );
  }

  const { last, settled, steady } = await awaitSettled(
    serial,
    expected,
    { wasAsleep: !before.awake, closedId: states.get("CLOSED") },
    signal
  );
  const stateName = last?.state !== undefined ? (byId.get(last.state) ?? last.state) : "unknown";
  // Not ready with a state means the device is awake and its screen was dark
  // at the end: it never came on, or it came on and went off again.
  const darkAwake = last?.state !== undefined && last.awake && !last.screenOn;
  const budget = `${SETTLE_TIMEOUT_MS / 1000} s`;

  // `wm dismiss-keyguard` cannot clear the lock screen of an asleep device;
  // the screen-off warning covers that case. It runs before a fold whose
  // screen stayed dark fails, so that failure does not leave the lock screen
  // the fold raised.
  let lockScreen = last?.keyguard ?? false;
  let lockScreenWarning: string | undefined;
  if (stateName === "CLOSED" && !before.keyguard && last?.awake) {
    lockScreen = false;
    lockScreenWarning = await dismissFoldLockScreen(serial, signal);
  }

  if (!settled && expected !== undefined) {
    throw failed(
      last?.state === expected
        ? `${serial} reached device state ${stateName} for the ${params.posture} posture, but the device is awake ` +
            `and the screen did not stay on within ${budget}. Take a screenshot before the next action.` +
            (lockScreenWarning ? ` ${lockScreenWarning}` : "")
        : `${serial} did not reach the ${params.posture} posture: the guest still reports device state ${stateName}. ` +
            "Fold again; a screenshot shows what the device renders.",
      "android_fold_unverified"
    );
  }

  const warnings: string[] = [];
  if (!settled) {
    warnings.push(
      darkAwake
        ? `The device state is ${stateName}, but the screen did not stay on within ${budget}. Take a screenshot before the next action.`
        : `The device state did not settle within ${budget}; it last read ${stateName}. Take a screenshot before the next action.`
    );
  } else if (!steady) {
    warnings.push(
      `The screen did not hold steady within ${budget}. Take a screenshot before the next action.`
    );
  }

  if (lockScreenWarning) warnings.push(lockScreenWarning);
  // A lock screen that was up before the fold is not the fold's to clear, but
  // every later tap lands on it.
  const screenOff = settled && last !== undefined && !last.screenOn;
  if (screenOff && lockScreen) {
    warnings.push(
      "The screen is off and the lock screen is showing after the fold. Wake and unlock the device before the next action."
    );
  } else if (screenOff) {
    warnings.push("The screen is off after the fold. Wake the device before the next action.");
  } else if (lockScreen) {
    warnings.push(
      "The lock screen is showing after the fold. Unlock or dismiss it before the next action."
    );
  }

  let hingeAngle: number | undefined;
  try {
    hingeAngle = parseHingeAngle(await runEmuConsole(serial, ["sensor", "get", "hinge-angle0"]));
  } catch {
    // The fold is verified by the state; the angle is only reported.
  }

  const posture = POSTURES.find((p) => EMULATOR_POSTURES[p].state === stateName);
  return {
    ...(posture ? { posture } : {}),
    deviceState: stateName,
    ...(hingeAngle !== undefined ? { hingeAngle } : {}),
    ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
  };
}

export const androidImpl: PlatformImpl<unknown, AndroidFoldParams, AndroidFoldResult> = {
  requires: ["adb"],
  async handler(_services, params, device: DeviceInfo, options): Promise<AndroidFoldResult> {
    const serial = params.udid;
    const signal = options?.signal;

    // A physical foldable has no console to drive its hinge; it is folded by
    // hand. The capability lets a serial that resolved as `unknown` through.
    // `adb emu` takes only an `emulator-<port>` serial, so a loopback one
    // (`127.0.0.1:<port>`), which the capability already reads as a device,
    // is rejected the same way.
    if (!/^emulator-\d+$/.test(serial)) {
      throw unsupported(
        `Cannot fold ${serial}: only an Android emulator's hinge can be moved; fold a physical device by hand.`,
        "android_fold_not_emulator"
      );
    }

    return withDeviceLock(serial, () => fold(serial, params, device, signal));
  },
};
