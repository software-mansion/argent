/**
 * Vega (Fire TV) directional-focus model — reproduces the on-device "highlight"
 * engine so we can compute D-pad navigation cues (which button presses move
 * focus to a target element).
 *
 * The engine is a near-1:1 port of Android's `android.view.FocusFinder`. It was
 * reverse-engineered from `libaplviewhost.so` (`volta::components::RenderFocus`)
 * AND empirically verified on a real Vega Virtual Device (SDK 0.23.8128): a
 * controlled grid of absolutely-positioned focusables reproduced 12/12 directional
 * transitions under the model below. Key empirical findings:
 *   - the per-direction candidate filter is the AOSP edge test (see `isCandidate`);
 *   - the score is the AOSP *weighted* distance `K*major^2 + minor^2`, where the
 *     major axis (along the press) is weighted MORE — device data forces K >= ~6,
 *     and K = 13 (AOSP's `MAJOR_AXIS_WEIGHT`) reproduces every observed transition;
 *   - the minimum-distance candidate wins; ties go to the first in iteration order;
 *   - there is NO hard "in-beam beats out-of-beam" override (an out-of-beam, near-
 *     axis element beat an in-beam far one on the device).
 *
 * IMPORTANT — coordinate space. The engine works in DEVICE PIXELS. `describe`'s
 * normalized frames divide x by screen width and y by screen height *separately*,
 * which distorts the aspect ratio the engine never sees — so this model must be
 * fed pixel-space rects (the Vega source parser has raw `x/y/width/height` before
 * normalization). All inputs here are pixels.
 *
 * SCOPE — what this model can and cannot predict. It is exact for FREE-SPATIAL
 * layouts: focusables that are all on-screen, not inside a scrolling/paging
 * container, and not subject to app-authored focus overrides. It deliberately
 * does NOT try to predict:
 *   - scrolling / paging / virtualized lists (a press scrolls the container,
 *     coordinates change, and off-screen items aren't in the tree);
 *   - app focus overrides (`nextFocusUp/Down/Left/Right`, `hasTVPreferredFocus`,
 *     focus traps / `Navigable`) — these short-circuit the geometric search and
 *     are not observable in the page source.
 * Callers must treat a computed cue as a high-confidence prior and confirm against
 * the device after the press in those cases. See `FOCUS_NAV_CAVEATS`.
 */

/** Empirically-verified AOSP major-axis weight (see file header). */
export const MAJOR_AXIS_WEIGHT = 13;

export type FocusDirection = "up" | "down" | "left" | "right";

/** A focusable's bounding box in DEVICE PIXELS. */
export interface FocusRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Focusable<T = string> {
  id: T;
  rect: FocusRect;
}

export const FOCUS_NAV_CAVEATS =
  "Exact only for free-spatial, on-screen focusables outside scrolling/paging " +
  "containers and without app focus-overrides; otherwise confirm against the device.";

const mid = (lo: number, hi: number): number => (lo + hi) / 2;

/**
 * Is `dst` a focus candidate from `src` in `dir`? AOSP `FocusFinder.isCandidate`:
 * the candidate must be strictly farther in the press direction (leading edge
 * past the source's leading edge) AND not behind it (trailing edge at/past the
 * source's trailing edge).
 */
function isCandidate(dir: FocusDirection, src: FocusRect, dst: FocusRect): boolean {
  switch (dir) {
    case "up":
      return dst.bottom <= src.bottom && dst.top < src.top;
    case "down":
      return dst.top >= src.top && dst.bottom > src.bottom;
    case "left":
      return dst.right <= src.right && dst.left < src.left;
    case "right":
      return dst.left >= src.left && dst.right > src.right;
  }
}

/** Distance ALONG the press axis (leading edge of src to leading edge of dst). */
function majorAxisDistance(dir: FocusDirection, src: FocusRect, dst: FocusRect): number {
  switch (dir) {
    case "up":
      return Math.abs(src.top - dst.bottom);
    case "down":
      return Math.abs(dst.top - src.bottom);
    case "left":
      return Math.abs(src.left - dst.right);
    case "right":
      return Math.abs(dst.left - src.right);
  }
}

/** Distance PERPENDICULAR to the press axis (center to center). */
function minorAxisDistance(dir: FocusDirection, src: FocusRect, dst: FocusRect): number {
  if (dir === "up" || dir === "down") {
    return Math.abs(mid(src.left, src.right) - mid(dst.left, dst.right));
  }
  return Math.abs(mid(src.top, src.bottom) - mid(dst.top, dst.bottom));
}

/** AOSP weighted distance: the engine picks the candidate that minimizes this. */
export function focusDistance(dir: FocusDirection, src: FocusRect, dst: FocusRect): number {
  const major = majorAxisDistance(dir, src, dst);
  const minor = minorAxisDistance(dir, src, dst);
  return MAJOR_AXIS_WEIGHT * major * major + minor * minor;
}

/**
 * The element that receives focus when `dir` is pressed while `sourceId` is
 * focused, or `null` if the press moves focus nowhere (no candidate). Pure
 * geometry — see SCOPE in the file header for when this is exact.
 */
export function nextFocus<T>(
  dir: FocusDirection,
  sourceId: T,
  focusables: ReadonlyArray<Focusable<T>>
): T | null {
  const source = focusables.find((f) => f.id === sourceId);
  if (!source) return null;
  let best: T | null = null;
  let bestDist = Infinity;
  for (const f of focusables) {
    if (f.id === sourceId || !isCandidate(dir, source.rect, f.rect)) continue;
    const dist = focusDistance(dir, source.rect, f.rect);
    if (dist < bestDist) {
      // strict `<`: the first candidate at a given distance wins on ties
      bestDist = dist;
      best = f.id;
    }
  }
  return best;
}

const DIRECTIONS: FocusDirection[] = ["up", "down", "left", "right"];

/**
 * Shortest D-pad press sequence to move focus from `fromId` to `targetId`, or
 * `null` if unreachable within `maxSteps`. BFS over the static directional-focus
 * graph induced by `nextFocus` — exact for a free-spatial layout whose geometry
 * does not change as you navigate (see SCOPE).
 */
export function pathTo<T>(
  targetId: T,
  fromId: T,
  focusables: ReadonlyArray<Focusable<T>>,
  maxSteps = 64
): FocusDirection[] | null {
  if (fromId === targetId) return [];
  const seen = new Set<T>([fromId]);
  const queue: { id: T; path: FocusDirection[] }[] = [{ id: fromId, path: [] }];
  while (queue.length > 0) {
    const { id, path } = queue.shift()!;
    if (path.length >= maxSteps) continue;
    for (const dir of DIRECTIONS) {
      const next = nextFocus(dir, id, focusables);
      if (next === null || seen.has(next)) continue;
      const nextPath = [...path, dir];
      if (next === targetId) return nextPath;
      seen.add(next);
      queue.push({ id: next, path: nextPath });
    }
  }
  return null;
}
