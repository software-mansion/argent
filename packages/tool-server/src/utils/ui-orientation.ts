import type { DescribeFrame, DescribeNode, UiOrientation } from "../tools/describe/contract";

/**
 * The maps between an iOS simulator's two spaces. The simulator captures,
 * frames and takes touches in the screen's fixed (portrait-native) space,
 * whatever the interface orientation; agents, flows and every tool result use
 * the UI's own upright space (see `ios-ui-orientation.ts`). With a portrait UI
 * the two coincide. With a landscape UI (a rotated iPhone, or a foldable
 * unfolded, whose inner panel is portrait-native under a landscape UI) the
 * UI's vertical axis lies along the native horizontal one.
 *
 * The orientation is UIKit's name for the interface's. The maps below were
 * checked on the simulator against a touch probe: in `landscapeRight` (home
 * side on the right, a rotated iPhone) a UI point (u, v), normalized, is the
 * native point (1 - v, u); in `landscapeLeft` (the unfolded iPhone Duo),
 * (v, 1 - u).
 */

export const screenEdges = ["top", "right", "bottom", "left"] as const;
export type ScreenEdge = (typeof screenEdges)[number];

export function uiEdgeToNative(edge: ScreenEdge, orientation: UiOrientation): ScreenEdge {
  const turns = { portrait: 0, landscapeRight: 1, portraitUpsideDown: 2, landscapeLeft: 3 };
  return screenEdges[(screenEdges.indexOf(edge) + turns[orientation]) % 4];
}

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
 * turns and a half turn). The frame unchanged for a portrait UI, and when no
 * orientation was reported.
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

/** A native-space point in the UI's own space: {@link uiPointToNative} run backwards. */
export function nativePointToUi(p: Vec, orientation: UiOrientation | undefined): Vec {
  switch (orientation) {
    case "landscapeRight":
      // native (x, y) = (1 - v, u), so u = y and v = 1 - x.
      return { x: p.y, y: 1 - p.x };
    case "landscapeLeft":
      // native (x, y) = (v, 1 - u), so u = 1 - y and v = x.
      return { x: 1 - p.y, y: p.x };
    case "portraitUpsideDown":
      return { x: 1 - p.x, y: 1 - p.y };
    default:
      return { x: p.x, y: p.y };
  }
}

/** Whether a UI in this orientation is turned on the native space at all. */
export function isTurned(orientation: UiOrientation | undefined): orientation is UiOrientation {
  return orientation !== undefined && orientation !== "portrait";
}

/**
 * The `rotation` a simulator-server capture takes to come out upright for a UI
 * in this orientation, or undefined when the native capture already is.
 *
 * simulator-server names the device's orientation, UIKit the interface's, and
 * the two name the landscape sides oppositely (the home side on the right is
 * the device's LandscapeLeft and the interface's landscapeRight). Checked on
 * an iOS 27 simulator: rotated with `rotate` LandscapeLeft, Safari reports
 * landscapeRight and a capture with rotation LandscapeLeft is upright.
 */
export function uprightCaptureRotation(
  orientation: UiOrientation | undefined
): "LandscapeLeft" | "LandscapeRight" | "PortraitUpsideDown" | undefined {
  switch (orientation) {
    case "landscapeRight":
      return "LandscapeLeft";
    case "landscapeLeft":
      return "LandscapeRight";
    case "portraitUpsideDown":
      return "PortraitUpsideDown";
    default:
      return undefined;
  }
}

/** A native-space tree in the UI's own space: every frame through {@link nativeFrameToUi}. */
export function nativeTreeToUi(node: DescribeNode, orientation: UiOrientation): DescribeNode {
  return {
    ...node,
    frame: nativeFrameToUi(node.frame, orientation),
    children: node.children.map((child) => nativeTreeToUi(child, orientation)),
  };
}

/** A native-axes size on the UI's axes: width and height swap under a quarter turn. */
export function uiScreenSize<T extends { width: number; height: number }>(
  size: T,
  orientation: UiOrientation | undefined
): T {
  return orientation === "landscapeLeft" || orientation === "landscapeRight"
    ? { ...size, width: size.height, height: size.width }
    : size;
}
