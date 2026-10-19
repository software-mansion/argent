import { FAILURE_CODES, FailureError, type DeviceInfo } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { consolePortFromAdbSerial, runAdb } from "../../../utils/adb";
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
 * tells a committed state from one the guest has not left yet. A device that
 * was asleep before the fold need not wake (a fold to closed leaves it dark),
 * so there the screen only has to hold still.
 */
const STABLE_READS = 3;

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
  keyguard: boolean;
}

/**
 * One read of the state, the screen and the lock screen. `mScreenOnFully` is
 * absent on an image that does not report it, which counts as on: a missing
 * signal must not stall every fold for the whole budget.
 */
export function parseSnapshot(stdout: string): Snapshot {
  return {
    state: /^\s*(\d+)\s*$/m.exec(stdout)?.[1],
    screenOn: !/mScreenOnFully=false/.test(stdout),
    keyguard: /isKeyguardShowing=true/.test(stdout),
  };
}

async function readSnapshot(serial: string): Promise<Snapshot> {
  return parseSnapshot(
    await shell(
      serial,
      "cmd device_state print-state; " +
        "dumpsys window displays | grep -o 'mScreenOnFully=[a-z]*'; " +
        "dumpsys window | grep -o 'isKeyguardShowing=[a-z]*'"
    )
  );
}

/** The hinge sensor as the console reports it: `hinge-angle0 = <degrees>`. */
export function parseHingeAngle(stdout: string): number | undefined {
  const match = /hinge-angle0\s*=\s*(-?\d+(?:\.\d+)?)/.exec(stdout);
  return match ? Number(match[1]) : undefined;
}

/**
 * Poll until the guest holds one device state (the expected one, when the
 * request names it) and one screen state, fully on when `screenOn` asks for
 * it, for {@link STABLE_READS} reads. The first read waits a poll: the console
 * answered before the guest reacted.
 */
async function awaitSettled(
  serial: string,
  expected: string | undefined,
  screenOn: boolean,
  signal: AbortSignal | undefined
): Promise<{ last: Snapshot | undefined; settled: boolean }> {
  let last: Snapshot | undefined;
  let agreeing = 0;
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS, signal);
    const read = await readSnapshot(serial);
    const ready =
      read.state !== undefined &&
      (read.screenOn || !screenOn) &&
      (expected === undefined || read.state === expected);
    const same = read.state === last?.state && read.screenOn === last?.screenOn;
    if (!ready) agreeing = 0;
    else agreeing = agreeing > 0 && same ? agreeing + 1 : 1;
    last = read;
    if (agreeing >= STABLE_READS) return { last, settled: true };
  }
  return { last, settled: false };
}

/**
 * A fold to the cover panel can raise the lock screen ("Swipe up to
 * continue"), Android's continue-apps-on-fold behaviour. Left up, every later
 * capture reads the lock screen instead of the app, so it is dismissed the way
 * the swipe would. A keyguard already up before the fold is not the fold's to
 * clear, and one with a PIN cannot be: that is a warning, the fold itself
 * succeeded.
 */
async function dismissFoldLockScreen(
  serial: string,
  signal: AbortSignal | undefined
): Promise<string | undefined> {
  let clear = 0;
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await readSnapshot(serial)).keyguard) {
      if (++clear >= STABLE_READS) return undefined;
    } else {
      clear = 0;
      await shell(serial, "wm dismiss-keyguard");
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

async function fold(
  serial: string,
  params: AndroidFoldParams,
  device: DeviceInfo,
  signal: AbortSignal | undefined
): Promise<AndroidFoldResult> {
  const states = parseDeviceStates(await shell(serial, "cmd device_state print-states"));
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

  // The screen and the lock screen before the fold decide what the fold must
  // leave: a lit screen stays lit, and a lock screen already up stays up.
  const before = await readSnapshot(serial);

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

  const { last, settled } = await awaitSettled(serial, expected, before.screenOn, signal);
  const stateName = last?.state !== undefined ? (byId.get(last.state) ?? last.state) : "unknown";
  if (!settled && expected !== undefined) {
    throw failed(
      last?.state === expected
        ? `${serial} reached device state ${stateName} for the ${params.posture} posture, but ` +
            (last.screenOn ? "the state did not hold" : "the screen did not turn on") +
            ` within ${SETTLE_TIMEOUT_MS / 1000} s. Take a screenshot before the next action.`
        : `${serial} did not reach the ${params.posture} posture: the guest still reports device state ${stateName}. ` +
            "Fold again; a screenshot shows what the device renders.",
      "android_fold_unverified"
    );
  }

  let warning: string | undefined;
  if (!settled) {
    warning = `The device state did not settle within ${SETTLE_TIMEOUT_MS / 1000} s; it last read ${stateName}. Take a screenshot before the next action.`;
  } else if (stateName === "CLOSED" && !before.keyguard) {
    warning = await dismissFoldLockScreen(serial, signal);
  } else if (last?.keyguard) {
    // A lock screen that was up before the fold is not the fold's to clear,
    // but every later tap lands on it.
    warning =
      "The lock screen is showing after the fold. Unlock or dismiss it before the next action.";
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
    ...(warning ? { warning } : {}),
  };
}

export const androidImpl: PlatformImpl<unknown, AndroidFoldParams, AndroidFoldResult> = {
  requires: ["adb"],
  async handler(_services, params, device: DeviceInfo, options): Promise<AndroidFoldResult> {
    const serial = params.udid;
    const signal = options?.signal;

    // A physical foldable has no console to drive its hinge; it is folded by
    // hand. The capability lets a serial that resolved as `unknown` through.
    if (consolePortFromAdbSerial(serial) === null) {
      throw unsupported(
        `Cannot fold ${serial}: only an Android emulator's hinge can be moved; fold a physical device by hand.`,
        "android_fold_not_emulator"
      );
    }

    return withDeviceLock(serial, () => fold(serial, params, device, signal));
  },
};
