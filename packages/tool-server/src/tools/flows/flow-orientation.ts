import type { UiOrientation } from "../describe/contract";

/**
 * A flow's directions are the UI's: `swipe: down` moves the finger towards
 * the bottom of what the user sees, `scroll-to` `direction: down` reveals
 * what is below it. The frames a flow acts on, and the touches it sends, are
 * in the screen's fixed (portrait-native) space on an iOS simulator — the
 * space the simulator takes touches in, whatever the interface orientation.
 * With a portrait UI the two coincide. With a landscape UI (a rotated iPhone,
 * or a foldable unfolded, whose inner panel is portrait-native under a
 * landscape UI) the UI's vertical axis lies along the frame space's
 * horizontal one, and a direction has to be turned before it is dispatched.
 *
 * The orientation is UIKit's name for the interface's (as the injected
 * framework reports it; see `flow-ios-tree.ts`). The maps below were checked on
 * the simulator against a touch probe: in `landscapeRight` (home side on the
 * right, a rotated iPhone) a UI point (u, v), normalized, is the native point
 * (1 - v, u); in `landscapeLeft` (the unfolded iPhone Duo), (v, 1 - u).
 */

type Direction = "up" | "down" | "left" | "right";

/** A normalized point or vector in some space. */
interface Vec {
  x: number;
  y: number;
}

/** A UI-space point (normalized to the UI's own width and height) in the native space. */
export function uiPointToNative(p: Vec, orientation: UiOrientation | undefined): Vec {
  switch (orientation) {
    case "landscapeRight":
      return { x: 1 - p.y, y: p.x };
    case "landscapeLeft":
      return { x: p.y, y: 1 - p.x };
    case "portraitUpsideDown":
      return { x: 1 - p.x, y: 1 - p.y };
    default:
      return { x: p.x, y: p.y };
  }
}

/** A UI-space displacement in the native space: the point map without its offsets. */
export function uiVectorToNative(v: Vec, orientation: UiOrientation | undefined): Vec {
  switch (orientation) {
    case "landscapeRight":
      return { x: -v.y, y: v.x };
    case "landscapeLeft":
      return { x: v.y, y: -v.x };
    case "portraitUpsideDown":
      return { x: -v.x, y: -v.y };
    default:
      return { x: v.x, y: v.y };
  }
}

const DIRECTION_VECTOR: Record<Direction, Vec> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

/**
 * The native-space direction a UI-space one becomes. The same map serves a
 * swipe (where the direction is the finger's) and a scroll (where it is the
 * content's, the finger going the other way), since turning a direction and
 * reversing it commute.
 */
export function nativeDirection(d: Direction, orientation: UiOrientation | undefined): Direction {
  const v = uiVectorToNative(DIRECTION_VECTOR[d], orientation);
  if (v.x > 0) return "right";
  if (v.x < 0) return "left";
  if (v.y > 0) return "down";
  return "up";
}
