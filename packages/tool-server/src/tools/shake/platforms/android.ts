import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { consolePortFromAdbSerial, isAndroidTv, runAdb } from "../../../utils/adb";
import { UnsupportedOperationError } from "../../../utils/capability";
import type { ShakeParams, ShakeResult, ShakeServices } from "../types";

/**
 * Android has no OS-level shake event — every shake feature (React Native's dev
 * menu, bug reporters) is an app-side accelerometer detector, so a shake here
 * means driving the sensor hard enough, with enough direction changes, to fire
 * them.
 *
 * `adb emu sensor set` OVERRIDES the virtual sensor until set again, so the
 * resting vector is captured up front and always restored — otherwise the device
 * is left permanently tilted and auto-rotation misbehaves for every later test.
 */

/** Peak |acceleration| per axis swing, in m/s². Well above any shake threshold in the wild. */
const SHAKE_AMPLITUDE = 30;

/**
 * Direction changes per gesture. Detectors want several reversals inside a short
 * window (React Native's among them), not one spike.
 */
const SWINGS_PER_SHAKE = 8;

/** Sample spacing. 50ms ≈ 20Hz, inside every detector's window. */
const SWING_INTERVAL_MS = 50;

/** Fallback resting vector (upright portrait) when the console read can't be trusted. */
const DEFAULT_REST = { x: 0, y: 9.81, z: 0 };

/**
 * Plausible resting magnitude band, in m/s². Gravity reads ~9.81 whichever way
 * the device is held, so a vector outside the band is an override some other
 * process left behind (a swung sample reads ~31.6). Restoring it would pin the
 * device in a nonsense attitude that every later read re-captures; falling back
 * heals the stuck state.
 */
const MIN_REST_MAGNITUDE = 5;
const MAX_REST_MAGNITUDE = 15;

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Signed decimal with an optional exponent. A rotated emulator reports near-zero
 * axes in scientific notation (`acceleration = 9.81:-1.90735e-06:0`); leave the
 * `-` of `e-06` out of the pattern and the read fails into the portrait
 * fallback, which then rotates a landscape device back to portrait.
 */
const DECIMAL = String.raw`[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?`;
const ACCELERATION_RE = new RegExp(
  String.raw`acceleration\s*=\s*(${DECIMAL}):(${DECIMAL}):(${DECIMAL})`
);

/** Parse `acceleration = 0:9.77631:0.812349` (the console echoes `OK` on the next line). */
export function parseAcceleration(stdout: string): Vec3 | null {
  const match = ACCELERATION_RE.exec(stdout);
  if (!match) return null;
  const [x, y, z] = [match[1]!, match[2]!, match[3]!].map(Number);
  if (![x, y, z].every((n) => Number.isFinite(n))) return null;
  return { x: x!, y: y!, z: z! };
}

/** A read is only usable as a resting pose if it looks like gravity and nothing else. */
function restingVectorFrom(stdout: string): Vec3 {
  const read = parseAcceleration(stdout);
  if (!read) return DEFAULT_REST;
  const magnitude = Math.hypot(read.x, read.y, read.z);
  if (magnitude < MIN_REST_MAGNITUDE || magnitude > MAX_REST_MAGNITUDE) return DEFAULT_REST;
  return read;
}

/** `emu sensor set` wants plain decimals; toFixed keeps exponent notation out of the wire format. */
const fmt = (v: Vec3) => `${v.x.toFixed(4)}:${v.y.toFixed(4)}:${v.z.toFixed(4)}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run an emulator-console command, failing when the console rejects it.
 *
 * `adb emu` exits 0 even on refusal — the only sign is a `KO:` line in the reply,
 * so `runAdb`, which inspects the exit code alone, reads a rejected sensor write
 * as a successful one and the tool reports a shake that never reached the device.
 *
 * Only the LAST non-empty line is the verdict: an unrelated `KO:` (an
 * authentication banner, say) can precede a command that then succeeds with `OK`.
 */
async function emuConsole(serial: string, args: string[]): Promise<string> {
  const { stdout } = await runAdb(["-s", serial, "emu", ...args], { timeoutMs: 10_000 });
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const verdict = lines[lines.length - 1];
  if (verdict?.startsWith("KO:")) {
    throw new Error(`emulator console rejected \`${args.join(" ")}\` — ${verdict}`);
  }
  return stdout;
}

/**
 * Serializes shakes per device.
 *
 * A burst is not atomic: it overrides the accelerometer, then restores the
 * vector it read at the start. An overlapping shake captures a *swung* sample as
 * its resting vector and, finishing last, leaves the device permanently tilted —
 * a state every later shake re-captures and re-restores. Agents share an
 * emulator here, so overlap is ordinary. Queueing costs a waiter the burst ahead
 * of it and makes capture-burst-restore atomic within this process.
 */
const inFlightByDevice = new Map<string, Promise<unknown>>();

function withDeviceLock<T>(serial: string, fn: () => Promise<T>): Promise<T> {
  const previous = inFlightByDevice.get(serial) ?? Promise.resolve();
  // Run `fn` whether the previous holder resolved or rejected — a failed shake
  // must not wedge the queue.
  const run = previous.then(fn, fn);
  const settled = run.catch(() => {});
  inFlightByDevice.set(serial, settled);
  void settled.then(() => {
    if (inFlightByDevice.get(serial) === settled) inFlightByDevice.delete(serial);
  });
  return run;
}

export const androidImpl: PlatformImpl<ShakeServices, ShakeParams, ShakeResult> = {
  requires: ["adb"],
  async handler(_services, params, device): Promise<ShakeResult> {
    const serial = params.udid;
    const count = params.count ?? 1;

    // An Android TV emulator is an ordinary `android`/`emulator` serial, so the
    // capability matrix can't exclude it. A TV has no accelerometer: its console
    // would accept the sensor writes and change nothing observable, reporting a
    // shake that never happened.
    if (await isAndroidTv(serial)) {
      throw new UnsupportedOperationError(
        "shake",
        device,
        "Android TV has no shake gesture — a TV is focus-driven, use tv-remote"
      );
    }

    // Physical phones expose no emulator console. Reject up front: `adb emu`
    // against a device serial fails with an opaque console error, and the
    // capability matrix lets a serial that resolved as `unknown` through.
    if (consolePortFromAdbSerial(serial) === null) {
      throw new FailureError(
        `Cannot shake ${serial}: sensor injection needs an Android emulator.`,
        {
          error_code: FAILURE_CODES.ANDROID_SHAKE_FAILED,
          failure_stage: "android_shake_not_emulator",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }

    const setAcceleration = async (v: Vec3) => {
      await emuConsole(serial, ["sensor", "set", "acceleration", fmt(v)]);
    };

    // Capture, burst and restore are one critical section: a concurrent shake
    // would read a mid-burst sample as its resting vector and restore that.
    return withDeviceLock(serial, async () => {
      let rest: Vec3;
      try {
        rest = restingVectorFrom(await emuConsole(serial, ["sensor", "get", "acceleration"]));
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new FailureError(
          `Failed to read the accelerometer on ${serial}: ${detail.trim()}`,
          {
            error_code: FAILURE_CODES.ANDROID_SHAKE_FAILED,
            failure_stage: "android_shake_sensor_get",
            failure_area: "tool_server",
            error_kind: "subprocess",
          },
          { cause: err instanceof Error ? err : new Error(String(err)) }
        );
      }

      try {
        for (let gesture = 0; gesture < count; gesture++) {
          for (let swing = 0; swing < SWINGS_PER_SHAKE; swing++) {
            // Alternate on X around the resting vector, leaving gravity on the
            // other axes, so the pose reads as "jerked sideways", not "tumbling".
            const direction = swing % 2 === 0 ? 1 : -1;
            await setAcceleration({
              x: rest.x + direction * SHAKE_AMPLITUDE,
              y: rest.y,
              z: rest.z,
            });
            await sleep(SWING_INTERVAL_MS);
          }
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new FailureError(
          `Failed to shake ${serial}: ${detail.trim()}`,
          {
            error_code: FAILURE_CODES.ANDROID_SHAKE_FAILED,
            failure_stage: "android_shake_sensor_set",
            failure_area: "tool_server",
            error_kind: "subprocess",
          },
          { cause: err instanceof Error ? err : new Error(String(err)) }
        );
      } finally {
        // Hand the device back at rest even if a swing failed midway — a stuck
        // override outlives this tool call and would skew every later one.
        await setAcceleration(rest).catch(() => {});
      }

      return { shaken: true, count };
    });
  },
};
