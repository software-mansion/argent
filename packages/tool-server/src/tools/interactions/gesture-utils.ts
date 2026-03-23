import type { SimulatorServerApi } from "../../blueprints/simulator-server";
import { sendCommand } from "../../utils/simulator-client";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
 * Insert `steps` linearly interpolated Move events between each consecutive
 * pair of events. Down/Up types are preserved; interpolated frames are Move.
 * Delay is distributed evenly across the interpolated segment.
 */
export function interpolateEvents(
  events: TouchEvent[],
  steps: number
): TouchEvent[] {
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

/**
 * Send a single touch command over WebSocket.
 */
export function sendTouchEvent(
  api: SimulatorServerApi,
  type: "Down" | "Move" | "Up",
  x: number,
  y: number,
  x2?: number,
  y2?: number
): void {
  sendCommand(api, {
    cmd: "touch",
    type,
    x,
    y,
    second_x: x2 ?? null,
    second_y: y2 ?? null,
  });
}
