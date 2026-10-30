import type { DeviceInfo } from "@argent/registry";
import type { SimulatorServerApi } from "../blueprints/simulator-server";
import { UnsupportedOperationError } from "./capability";
import { sendCommand, type SendCommandOutcome } from "./simulator-client";

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

export function assertTwoFingerTouchSupported(
  api: SimulatorServerApi,
  toolId: string,
  device: DeviceInfo
): void {
  if (!api.singleTouchOnly) return;
  throw new UnsupportedOperationError(
    toolId,
    device,
    "Argent could not find this emulator's gRPC bridge, so it drives the emulator over adb " +
      "like a physical phone. That path cannot lift two fingers: they would stay down and " +
      "block every later touch. To use two-finger gestures, stop the emulator from the account " +
      "that started it, then start it with boot-device or with the same user and HOME as Argent"
  );
}

export function sendTouchEvent(
  api: SimulatorServerApi,
  type: "Down" | "Move" | "Up",
  x: number,
  y: number,
  x2?: number,
  y2?: number
): Promise<SendCommandOutcome> {
  return sendCommand(api, {
    cmd: "touch",
    type,
    x,
    y,
    second_x: x2 ?? null,
    second_y: y2 ?? null,
  });
}
