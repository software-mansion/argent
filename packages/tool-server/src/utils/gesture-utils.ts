import type { SimulatorServerApi } from "../blueprints/simulator-server";
import { sendCommand } from "./simulator-client";

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

/** One dispatched frame of a two-finger gesture, in normalized coordinates. */
export interface TwoFingerFrame {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Tolerance for the on-screen check. A gesture spanning the full screen lands
 * exactly on 0 or 1, and the arithmetic that gets there can drift a few ulps
 * (a real rotate frame produces 0.09999999999999998), so the comparison is
 * inclusive with a little slack rather than a bare `< 0`.
 */
const ON_SCREEN_EPSILON = 1e-9;

/**
 * First finger position in `frames` that falls outside the screen, or undefined
 * if every one is on it.
 *
 * Checked against the frames that will actually be dispatched rather than
 * derived analytically: a pinch is affine in time so its endpoints would bound
 * it, but a rotate sweep is not — an arc from 0° to 180° has both endpoints near
 * the centre line while the frame at 90° reaches a full radius away.
 *
 * Callers must run this BEFORE dispatching anything. A finger that goes
 * off-screen mid-gesture is reported by Android as a system gesture (the
 * notification shade, back, or home) instead of reaching the app, and rejecting
 * after the first `Down` would leave a synthetic finger held on the glass.
 */
export function findOffScreenFinger(
  frames: TwoFingerFrame[]
):
  | { frameIndex: number; frameCount: number; finger: 1 | 2; axis: "x" | "y"; value: number }
  | undefined {
  for (const [frameIndex, frame] of frames.entries()) {
    const candidates = [
      { finger: 1 as const, axis: "x" as const, value: frame.x1 },
      { finger: 1 as const, axis: "y" as const, value: frame.y1 },
      { finger: 2 as const, axis: "x" as const, value: frame.x2 },
      { finger: 2 as const, axis: "y" as const, value: frame.y2 },
    ];
    for (const candidate of candidates) {
      if (candidate.value < -ON_SCREEN_EPSILON || candidate.value > 1 + ON_SCREEN_EPSILON) {
        // Rounded for the message: the raw sum carries float noise
        // (-0.025000000000000022), which reads as false precision.
        return {
          frameIndex,
          frameCount: frames.length,
          ...candidate,
          value: Number(candidate.value.toFixed(6)),
        };
      }
    }
  }
  return undefined;
}

/** How far past which edge a coordinate went, for an error message. */
export function describeOffScreenEdge(axis: "x" | "y", value: number): string {
  const past = value < 0 ? -value : value - 1;
  const edge = axis === "y" ? (value < 0 ? "top" : "bottom") : value < 0 ? "left" : "right";
  return `${past.toFixed(3).replace(/\.?0+$/, "")} past the ${edge} edge`;
}
