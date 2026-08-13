import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { consolePortFromAdbSerial, isAndroidTv, runAdb } from "../../../utils/adb";
import { UnsupportedOperationError } from "../../../utils/capability";
import type { ShakeParams, ShakeResult, ShakeServices } from "../types";

/**
 * Android has no OS-level "shake" event — every shake feature (React Native's
 * dev menu, bug reporters) is an app-side detector reading the accelerometer.
 * So a shake here means: drive the accelerometer hard enough, and with enough
 * direction changes, that those detectors fire.
 *
 * The emulator console (`adb emu sensor set`) is the injection point. It
 * OVERRIDES the virtual sensor until set again, which is why the resting vector
 * is captured up front and always restored — otherwise the device would be left
 * permanently tilted and auto-rotation would misbehave for every later test.
 */

/** Peak |acceleration| per axis swing, in m/s². Well above any shake threshold in the wild. */
const SHAKE_AMPLITUDE = 30;

/**
 * Direction changes per gesture. Detectors don't trigger on a single spike —
 * React Native's, for one, wants several reversals inside a short window — so a
 * gesture is a burst, not one sample.
 */
const SWINGS_PER_SHAKE = 8;

/** Spacing between samples. 50ms ≈ 20Hz, comfortably inside every detector's window. */
const SWING_INTERVAL_MS = 50;

/** Fallback resting vector (portrait, face up) if the console read can't be parsed. */
const DEFAULT_REST = { x: 0, y: 9.81, z: 0 };

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Parse `acceleration = 0:9.77631:0.812349` (the console echoes `OK` on the next line). */
export function parseAcceleration(stdout: string): Vec3 | null {
  const match = /acceleration\s*=\s*(-?[\d.eE+]+):(-?[\d.eE+]+):(-?[\d.eE+]+)/.exec(stdout);
  if (!match) return null;
  const [x, y, z] = [match[1]!, match[2]!, match[3]!].map(Number);
  if (![x, y, z].every((n) => Number.isFinite(n))) return null;
  return { x: x!, y: y!, z: z! };
}

/** `emu sensor set` wants plain decimals; toFixed keeps exponent notation out of the wire format. */
const fmt = (v: Vec3) => `${v.x.toFixed(4)}:${v.y.toFixed(4)}:${v.z.toFixed(4)}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const androidImpl: PlatformImpl<ShakeServices, ShakeParams, ShakeResult> = {
  requires: ["adb"],
  async handler(_services, params, device): Promise<ShakeResult> {
    const serial = params.udid;
    const count = params.count ?? 1;

    // An Android TV emulator is a `platform: "android"`, `kind: "emulator"`
    // serial like any other, so the capability matrix can't exclude it. A TV
    // has no accelerometer and is focus-driven; its emulator console would
    // accept the sensor writes and change nothing observable, reporting a
    // shake that never happened.
    if (await isAndroidTv(serial)) {
      throw new UnsupportedOperationError(
        "shake",
        device,
        "Android TV has no shake gesture — a TV is focus-driven, use tv-remote"
      );
    }

    // Physical phones expose no emulator console — their accelerometer is real
    // hardware. Reject up front: `adb emu` against a device serial fails with an
    // opaque console error, and the capability matrix can't catch a serial that
    // resolved as `unknown`.
    if (consolePortFromAdbSerial(serial) === null) {
      throw new FailureError(`Cannot shake ${serial}: sensor injection needs an Android emulator.`, {
        error_code: FAILURE_CODES.ANDROID_SHAKE_FAILED,
        failure_stage: "android_shake_not_emulator",
        failure_area: "tool_server",
        error_kind: "validation",
      });
    }

    const setAcceleration = async (v: Vec3) => {
      await runAdb(["-s", serial, "emu", "sensor", "set", "acceleration", fmt(v)], {
        timeoutMs: 10_000,
      });
    };

    let rest: Vec3;
    try {
      const { stdout } = await runAdb(["-s", serial, "emu", "sensor", "get", "acceleration"], {
        timeoutMs: 10_000,
      });
      rest = parseAcceleration(stdout) ?? DEFAULT_REST;
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
          // Alternate the X axis around the resting vector, leaving gravity on
          // the other axes so the pose still reads as "held upright, jerked
          // sideways" rather than "tumbling".
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
      // Always hand the device back at rest, even if a swing failed midway —
      // a stuck override outlives this tool call and would skew every later one.
      await setAcceleration(rest).catch(() => {});
    }

    return { shaken: true, count };
  },
};
