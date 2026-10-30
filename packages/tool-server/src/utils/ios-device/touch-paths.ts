import {
  pinchContacts,
  rotateContacts,
  type Contacts,
  type PinchGeometry,
  type RotateGeometry,
} from "../gesture-utils";
import { toPoints, type RunnerTouchFinger, type RunnerViewport } from "./runner-commands";

/**
 * Builders for the runner's `touchPaths` command: one waypoint timeline per
 * finger, in the absolute points of the app's viewport. Frames are 16 ms
 * apart, the cadence the simulator and emulator paths use, so a gesture lasts
 * as long on hardware as it does there.
 */

const FRAME_MS = 16;

/** One finger of a hand-written touch train, in normalized 0-1 coordinates. */
export interface TrainEvent {
  type: "Down" | "Move" | "Up";
  x: number;
  y: number;
  x2?: number;
  y2?: number;
  delayMs?: number;
}

function frameCount(durationMs: number): number {
  return Math.max(1, Math.round(durationMs / FRAME_MS));
}

/** Both fingers of every frame of a two-finger gesture, as two paths. */
function twoFingerPaths(
  viewport: RunnerViewport,
  durationMs: number,
  contactsAt: (t: number) => Contacts
): RunnerTouchFinger[] {
  const steps = frameCount(durationMs);
  const first: RunnerTouchFinger = { points: [] };
  const second: RunnerTouchFinger = { points: [] };

  for (let i = 0; i <= steps; i++) {
    const contacts = contactsAt(i / steps);
    const tMs = (i * durationMs) / steps;

    first.points.push({ ...toPoints(viewport, contacts.first.x, contacts.first.y), tMs });
    second.points.push({ ...toPoints(viewport, contacts.second.x, contacts.second.y), tMs });
  }

  return [first, second];
}

export function pinchPaths(
  params: PinchGeometry,
  viewport: RunnerViewport,
  durationMs: number
): RunnerTouchFinger[] {
  return twoFingerPaths(viewport, durationMs, (t) => pinchContacts(params, t));
}

export function rotatePaths(
  params: RotateGeometry,
  viewport: RunnerViewport,
  durationMs: number
): RunnerTouchFinger[] {
  return twoFingerPaths(viewport, durationMs, (t) => rotateContacts(params, t));
}

/**
 * Turn a Down/Move/Up train into finger paths. The first finger follows every
 * event from the Down to the Up. The second follows the events that carry
 * x2/y2: it touches down at the first of them, which may be after the Down,
 * and lifts after the last, which may be before the Up. Each event waits its
 * `delayMs` (default 16) after the one before, and the Down starts at 0.
 *
 * @throws Error naming the problem when the train is not a Down, any Moves,
 *   then an Up, or when an event carries only one of x2/y2.
 */
export function trainPaths(events: TrainEvent[], viewport: RunnerViewport): RunnerTouchFinger[] {
  const down = events[0];
  const up = events[events.length - 1];

  if (down?.type !== "Down" || up?.type !== "Up" || events.length < 2) {
    throw new Error("A touch train starts with a Down and ends with an Up.");
  }

  if (events.slice(1, -1).some((event) => event.type !== "Move")) {
    throw new Error("A touch train has only Move events between its Down and its Up.");
  }

  const first: RunnerTouchFinger = { points: [] };
  const second: RunnerTouchFinger = { points: [] };
  let tMs = 0;

  events.forEach((event, index) => {
    if ((event.x2 === undefined) !== (event.y2 === undefined)) {
      throw new Error(`Event ${index} has only one of x2 and y2; give both or neither.`);
    }

    if (index > 0) {
      tMs += event.delayMs ?? FRAME_MS;
    }

    first.points.push({ ...toPoints(viewport, event.x, event.y), tMs });

    if (event.x2 !== undefined && event.y2 !== undefined) {
      second.points.push({ ...toPoints(viewport, event.x2, event.y2), tMs });
    }
  });

  return second.points.length > 0 ? [first, second] : [first];
}
