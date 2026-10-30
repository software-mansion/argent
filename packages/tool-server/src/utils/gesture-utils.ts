import { FAILURE_CODES, FailureError, type DeviceInfo } from "@argent/registry";
import type { SimulatorServerApi } from "../blueprints/simulator-server";
import { sendCommand, type SendCommandOutcome } from "./simulator-client";
import { readAndroidSurfaceRotation } from "./device-orientation";

interface TouchPoint {
  x: number;
  y: number;
  x2?: number;
  y2?: number;
}

interface TouchEvent extends TouchPoint {
  type: "Down" | "Move" | "Up";
  delayMs?: number;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Insert `steps` interpolated Move events between each pair of events,
 * splitting the segment's delay evenly across the frames it becomes.
 */
export function interpolateEvents(events: TouchEvent[], steps: number): TouchEvent[] {
  if (events.length < 2 || steps < 1) return events;

  const result: TouchEvent[] = [];

  for (let i = 0; i < events.length; i++) {
    const current = events[i];

    if (i === 0) {
      result.push(current);
      continue;
    }

    const prev = events[i - 1];
    const segmentDelay = current.delayMs ?? 16;
    const frameDelay = segmentDelay / (steps + 1);

    for (let s = 1; s <= steps; s++) {
      const t = s / (steps + 1);
      const interp: TouchEvent = {
        type: "Move",
        x: lerp(prev.x, current.x, t),
        y: lerp(prev.y, current.y, t),
        delayMs: frameDelay,
      };
      if (prev.x2 != null && current.x2 != null) {
        interp.x2 = lerp(prev.x2, current.x2, t);
      }
      if (prev.y2 != null && current.y2 != null) {
        interp.y2 = lerp(prev.y2, current.y2, t);
      }
      result.push(interp);
    }

    result.push({ ...current, delayMs: frameDelay });
  }

  return result;
}

type TouchSender = (
  type: "Down" | "Move" | "Up",
  x: number,
  y: number,
  x2?: number,
  y2?: number
) => Promise<SendCommandOutcome>;

/** Read once per gesture so every frame and both fingers use the same orientation. */
export async function createTouchSender(
  api: SimulatorServerApi,
  device: DeviceInfo
): Promise<TouchSender> {
  const rotation =
    device.platform === "android" && device.kind === "device"
      ? await readAndroidSurfaceRotation(device.id)
      : 0;
  if (rotation === null) {
    throw new FailureError(
      `Cannot read screen rotation for Android device ${device.id}. ` +
        "No touch was sent. Check the ADB connection and retry.",
      {
        error_code: FAILURE_CODES.ANDROID_TOUCH_ROTATION_UNAVAILABLE,
        failure_stage: "android_touch_rotation",
        failure_area: "tool_server",
        error_kind: "subprocess",
      }
    );
  }

  // The screen-sharing agent expects natural-display coordinates and rotates
  // them itself (JetBrains android/streaming: AdjustedDisplayCoordinates).
  const toNatural = (x: number, y: number): [number, number] => {
    switch (rotation) {
      case 1:
        return [1 - y, x];
      case 2:
        return [1 - x, 1 - y];
      case 3:
        return [y, 1 - x];
      default:
        return [x, y];
    }
  };

  return (type, x, y, x2, y2) => {
    const [naturalX, naturalY] = toNatural(x, y);
    const second = x2 != null && y2 != null ? toNatural(x2, y2) : null;
    return sendCommand(api, {
      cmd: "touch",
      type,
      x: naturalX,
      y: naturalY,
      second_x: second?.[0] ?? null,
      second_y: second?.[1] ?? null,
    });
  };
}
