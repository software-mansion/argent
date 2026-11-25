import { asUiOrientation, type UiOrientation } from "../tools/describe/contract";
import type { UiOrientationRead } from "./ios-ui-orientation";
import {
  isTurned,
  nativeFrameToUi,
  nativePointToUi,
  uiPointToNative,
  uiScreenSize,
} from "./ui-orientation";

/**
 * The `native-*` tools on an iOS simulator, in the UI's upright space.
 *
 * The injected library reports, and takes, points in the screen's fixed
 * (portrait-native) space: a view's `screenFrame`, `describeScreen`'s element
 * `frame`, `tapPoint` and their normalized forms, the screen size beside them,
 * and the point `viewAtPoint` looks up. Every other tool hands agents the UI's
 * upright space (`utils/ios-ui-orientation.ts`), so these are turned at the
 * edge too: results on the way out, the looked-up point on the way in. A
 * view's `frame`, `windowFrame` and `bounds` are in its superview's, window's
 * and own space, which turn with the UI already, and are left alone.
 */

type Size = { width: number; height: number };
type Rect = { x: number; y: number; width: number; height: number };

/** How a result's fixed space maps to the UI's: the orientation, and the fixed screen size. */
export interface FixedSpace {
  orientation: UiOrientation;
  /** The screen in points on its portrait-native axes. */
  screen: Size;
}

function isRect(v: unknown): v is Rect {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.x === "number" &&
    typeof r.y === "number" &&
    typeof r.width === "number" &&
    typeof r.height === "number"
  );
}

function isSize(v: unknown): v is Size {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.width === "number" && typeof r.height === "number";
}

/** The fixed screen size in the UI's axes. */
function uiSize(space: FixedSpace): Size {
  return uiScreenSize(space.screen, space.orientation);
}

/** A rect in fixed points, in the UI's points. */
function turnPointsRect(rect: Rect, space: FixedSpace): Rect {
  const { width: w, height: h } = space.screen;
  if (!(w > 0 && h > 0)) return rect;
  const n = nativeFrameToUi(
    { x: rect.x / w, y: rect.y / h, width: rect.width / w, height: rect.height / h },
    space.orientation
  );
  const ui = uiSize(space);
  return {
    ...rect,
    x: n.x * ui.width,
    y: n.y * ui.height,
    width: n.width * ui.width,
    height: n.height * ui.height,
  };
}

/** A point in fixed points, in the UI's points. */
function turnPoints(p: { x: number; y: number }, space: FixedSpace): { x: number; y: number } {
  const { width: w, height: h } = space.screen;
  if (!(w > 0 && h > 0)) return p;
  const n = nativePointToUi({ x: p.x / w, y: p.y / h }, space.orientation);
  const ui = uiSize(space);
  return { ...p, x: n.x * ui.width, y: n.y * ui.height };
}

/**
 * The fixed space of a result: the orientation and screen size it reports
 * itself (`getFullHierarchy`'s `screen`, `describeScreen`'s `screenFrame`),
 * filled in from the accessibility read. Undefined when no turn is needed, or
 * when what the turn needs is not known.
 */
export function fixedSpaceOf(result: unknown, read: UiOrientationRead): FixedSpace | undefined {
  const r = (typeof result === "object" && result !== null ? result : {}) as Record<
    string,
    unknown
  >;
  const screen = isSize(r.screen) ? r.screen : undefined;
  const orientation =
    asUiOrientation(
      (screen as { interfaceOrientation?: unknown } | undefined)?.interfaceOrientation
    ) ?? read.orientation;
  if (!isTurned(orientation)) return undefined;
  const size = screen ?? (isSize(r.screenFrame) ? r.screenFrame : undefined) ?? read.nativeScreen;
  if (!size || !(size.width > 0 && size.height > 0)) return undefined;
  return { orientation, screen: { width: size.width, height: size.height } };
}

/**
 * A `ViewHierarchy.*` result with its fixed-space fields in the UI's space.
 * `describeScreen` elements carry `frame` and `tapPoint` in fixed points; a
 * view's `frame` is not, so those two are turned only in that method's
 * elements.
 */
export function uprightNativeResult<T>(method: string, result: T, space: FixedSpace): T {
  const describeScreen = method === "ViewHierarchy.describeScreen";
  const walk = (v: unknown, inElement: boolean): unknown => {
    if (Array.isArray(v)) return v.map((item) => walk(item, inElement));
    if (typeof v !== "object" || v === null) return v;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(v)) {
      if (key === "screenFrame" && isRect(value)) out[key] = turnPointsRect(value, space);
      else if (key === "screenFrame" && isSize(value))
        out[key] = uiScreenSize(value, space.orientation);
      else if (key === "screen" && isSize(value)) out[key] = uiScreenSize(value, space.orientation);
      else if (key === "normalizedFrame" && isRect(value))
        out[key] = { ...value, ...nativeFrameToUi(value, space.orientation) };
      else if (key === "normalizedTapPoint" && isPoint(value))
        out[key] = { ...value, ...nativePointToUi(value, space.orientation) };
      else if (inElement && key === "frame" && isRect(value))
        out[key] = turnPointsRect(value, space);
      else if (inElement && key === "tapPoint" && isPoint(value))
        out[key] = turnPoints(value, space);
      else out[key] = walk(value, describeScreen && key === "elements");
    }
    return out;
  };
  return walk(result, false) as T;
}

function isPoint(v: unknown): v is { x: number; y: number } {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.x === "number" && typeof r.y === "number";
}

/**
 * The fixed-space point `viewAtPoint` looks up, for a point the agent gave in
 * the UI's points. Unchanged when no turn is needed.
 */
export function fixedPointFromUpright(
  p: { x: number; y: number },
  space: FixedSpace
): { x: number; y: number } {
  const ui = uiSize(space);
  if (!(ui.width > 0 && ui.height > 0)) return p;
  const n = uiPointToNative({ x: p.x / ui.width, y: p.y / ui.height }, space.orientation);
  return { x: n.x * space.screen.width, y: n.y * space.screen.height };
}
