import type { DescribeFrame, UiOrientation } from "../describe/contract";

/**
 * A flow's directions are the UI's: `swipe: down` moves the finger towards
 * the bottom of what the user sees, `scroll-to` `direction: down` reveals
 * what is below it. So is its reading order: the element `after` or `next`
 * to another follows it as the user reads, and a `text` condition reads the
 * match the user sees first. The frames a flow acts on, and the touches it
 * sends, are in the screen's fixed (portrait-native) space on an iOS
 * simulator — the space the simulator takes touches in, whatever the
 * interface orientation. With a portrait UI the two coincide. With a landscape
 * UI (a rotated iPhone, or a foldable unfolded, whose inner panel is
 * portrait-native under a landscape UI) the UI's vertical axis lies along the
 * frame space's horizontal one: a direction has to be turned before it is
 * dispatched, and a frame has to be turned back before it is compared with
 * another in reading order.
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

/**
 * A native-space frame in the UI's own space: {@link uiPointToNative} run
 * backwards over a rectangle, so a rectangle comes out (the maps are quarter
 * turns and a half turn). The selector relations and picks that go by reading
 * order (`ui-tree-match.ts`) compare frames through this, so that "below" and
 * "to the right" are the user's on a landscape UI, while the frame itself
 * stays in the space touches are sent in. The frame unchanged for a portrait
 * UI, and when no orientation was reported.
 */
export function nativeFrameToUi(
  f: DescribeFrame,
  orientation: UiOrientation | undefined
): DescribeFrame {
  switch (orientation) {
    case "landscapeRight":
      // native (x, y) = (1 - v, u), so u = y and v = 1 - x.
      return { x: f.y, y: snap(1 - f.x - f.width), width: f.height, height: f.width };
    case "landscapeLeft":
      // native (x, y) = (v, 1 - u), so u = 1 - y and v = x.
      return { x: snap(1 - f.y - f.height), y: f.x, width: f.height, height: f.width };
    case "portraitUpsideDown":
      return {
        x: snap(1 - f.x - f.width),
        y: snap(1 - f.y - f.height),
        width: f.width,
        height: f.height,
      };
    default:
      return f;
  }
}

/**
 * A turned edge, free of float noise: `1 - y - height` for two frames that
 * share an edge in the native space can differ by one unit in the last place,
 * and the reading-order comparisons in `ui-tree-match.ts` are exact, so that
 * noise would decide a tie instead of the frame's area. Frames are normalized
 * to at most 12 decimals; a billionth is well below any real difference.
 */
function snap(v: number): number {
  return Math.round(v * 1e9) / 1e9;
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
