import type { SimulatorServerApi } from "../blueprints/simulator-server";
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

/** Two fingers, each a normalized 0-1 point. */
export interface Contacts {
  first: { x: number; y: number };
  second: { x: number; y: number };
}

export interface PinchGeometry {
  centerX: number;
  centerY: number;
  startDistance: number;
  endDistance: number;
  endCenterX?: number;
  endCenterY?: number;
  angle?: number;
}

/** Linear in `t`, so the endpoints alone determine the path HarmonyOS draws as two lines. */
export function pinchContacts(params: PinchGeometry, t: number): Contacts {
  const angleRad = ((params.angle ?? 0) * Math.PI) / 180;
  const cosA = Math.cos(angleRad);
  const sinA = Math.sin(angleRad);
  const halfDist = (params.startDistance + (params.endDistance - params.startDistance) * t) / 2;
  const cx = params.centerX + ((params.endCenterX ?? params.centerX) - params.centerX) * t;
  const cy = params.centerY + ((params.endCenterY ?? params.centerY) - params.centerY) * t;
  return {
    first: { x: cx - halfDist * cosA, y: cy - halfDist * sinA },
    second: { x: cx + halfDist * cosA, y: cy + halfDist * sinA },
  };
}

export interface RotateGeometry {
  centerX: number;
  centerY: number;
  radiusX: number;
  radiusY: number;
  startAngle: number;
  endAngle: number;
}

/** Two fingers opposite each other on an arc, swept from `startAngle` to `endAngle`. */
export function rotateContacts(params: RotateGeometry, t: number): Contacts {
  const angleDeg = params.startAngle + (params.endAngle - params.startAngle) * t;
  const angleRad = (angleDeg * Math.PI) / 180;
  const dx = params.radiusX * Math.cos(angleRad);
  const dy = params.radiusY * Math.sin(angleRad);
  return {
    first: { x: params.centerX + dx, y: params.centerY + dy },
    second: { x: params.centerX - dx, y: params.centerY - dy },
  };
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
