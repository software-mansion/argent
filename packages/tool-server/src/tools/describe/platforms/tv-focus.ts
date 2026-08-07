import type {
  TvControlApi,
  TvDescribeResponse,
  TvElement,
} from "../../../blueprints/tv-control-types";
import type { DescribeNode, DescribeTreeData } from "../contract";

/**
 * The TV focus view, adapted into the ordinary `DescribeNode` tree so the wait
 * tools can poll it.
 *
 * `describe` renders this same source for humans (see `./tv.ts`); this module
 * exists because `await-screen-idle` / `await-ui-element` need a *tree* to
 * fingerprint and match against, and because they must NOT inherit describe's
 * retry-and-recycle behaviour — see {@link describeTvFocus}.
 *
 * Why they need it at all: `describeIos` short-circuits every tvOS read to an
 * empty tree (the iOS accessibility service cannot drive an Apple TV), so both
 * wait tools saw a permanently empty screen and could never settle or match —
 * issue #620.
 */

/** Synthetic root the focusables hang off, mirroring the other platforms' shape. */
function focusRoot(): DescribeNode {
  return { role: "AXGroup", frame: { x: 0, y: 0, width: 1, height: 1 }, children: [] };
}

/**
 * Shared cause text for an empty focus set, so `describe` and the wait tools
 * explain it the same way. Kept separate from the advice, which differs: only
 * `describe` actually performs the retry-and-recycle it can then talk about.
 */
export const TV_EMPTY_FOCUS_CAUSE =
  "The app is most likely still launching (splash / loading screen) or mid-transition — a React " +
  "Native app only exposes focus once its JS bundle has rendered.";

/** What a wait tool says: it diagnoses, and points at the tool that repairs. */
export const TV_FOCUS_WAIT_EMPTY_HINT =
  `The TV focus engine reported no focusable elements. ${TV_EMPTY_FOCUS_CAUSE} ` +
  "Call `describe` once — it retries and recycles the tvOS read path — then wait again.";

/** A focus read is "empty" when nothing actionable was reported. */
export function isEmptyFocus(res: TvDescribeResponse): boolean {
  return res.focusable.length === 0 && !res.focused;
}

/**
 * The tvOS daemon reports a normalized frame per element, but `TvElement` has
 * historically not declared it (the JSON is passed through by reference, so the
 * data is there at runtime). Read it defensively: Android TV's focus backend
 * genuinely omits bounds, and the tvOS daemon drops `frame` for a zero-size
 * element.
 */
function frameOf(element: TvElement, index: number, total: number): DescribeNode["frame"] {
  const raw = element.frame;
  if (raw && raw.width > 0 && raw.height > 0) {
    return { x: raw.x, y: raw.y, width: raw.width, height: raw.height };
  }
  // Fallback: a non-degenerate band per element, ordered by enumeration index.
  // `isVisible` requires a non-zero area, and both backends enumerate in
  // traversal order, so index order IS reading order (android-tv-control.ts
  // reverses its child push specifically to guarantee that).
  const slots = Math.max(total, 1);
  return { x: 0, y: index / slots, width: 1, height: 1 / slots };
}

/**
 * Synthetic trait marking the cursor. Carried in `role` — rather than only in
 * the `focused` field — so it does two jobs the field cannot:
 *
 *  - it is selectable, making "wait until focus lands on X" expressible as
 *    `{ selector: { text: "X", role: "focused" }, condition: "exists" }`, which
 *    is the wait a TV `run-sequence` actually needs between `tv-remote` and
 *    `select`;
 *  - it puts the cursor into the idle fingerprint, so a screen whose focus is
 *    still moving does not read as settled.
 *
 * Safe as a `role` token: role matching is a case-insensitive substring, and no
 * real trait on either backend contains "focused" (`_focusGuide` and
 * `_tvFocusable` do not).
 */
const FOCUSED_TRAIT = "focused";

function toNode(element: TvElement, index: number, total: number): DescribeNode {
  const traits = [...(element.traits ?? [])];
  if (element.isFocused) traits.push(FOCUSED_TRAIT);
  return {
    // Traits are what a selector's `role` matches, exactly as on a phone.
    role: traits.length > 0 ? traits.join(",") : "element",
    frame: frameOf(element, index, total),
    children: [],
    ...(element.label ? { label: element.label } : {}),
    ...(element.value ? { value: element.value } : {}),
    // The cursor. `format-tree` already renders this as [focused], and it is
    // what makes "wait until focus lands on X" expressible.
    ...(element.isFocused ? { focused: true } : {}),
  };
}

/**
 * Adapt a focus read into a describe tree.
 *
 * The root carries the foreground bundle id, so a wait notices the app itself
 * changing underneath it — a TV transition often swaps the whole app, not just
 * the focusable set.
 */
export function tvFocusTree(res: TvDescribeResponse): DescribeTreeData {
  if (isEmptyFocus(res)) {
    // The hint is load-bearing, not decoration: `await-ui-element` treats an
    // empty tree as an untrustworthy read ONLY when a hint (or a prior match)
    // says so. Without it, `condition: "hidden"` would report success on the
    // very first poll of a still-launching app — a false pass that would
    // release a gated interaction.
    return { tree: focusRoot(), source: "tv-focus", hint: TV_FOCUS_WAIT_EMPTY_HINT };
  }

  const elements = [...res.focusable];
  // Some reads report a focused element that is absent from the focusable list;
  // it still has to be matchable, and it is the single most useful node here.
  //
  // Detect that by looking for a focusable already MARKED focused, not by object
  // identity: the two arrive as separate objects from the same JSON payload, so
  // an identity check would append a duplicate of an element that is already
  // there — and the cursor would then match twice.
  if (res.focused && !res.focusable.some((e) => e.isFocused)) elements.push(res.focused);

  const root = focusRoot();
  root.children = elements.map((el, i) => toNode(el, i, elements.length));
  if (res.bundleId) root.label = res.bundleId;
  return { tree: root, source: "tv-focus" };
}

/**
 * One bare focus read, for the wait tools.
 *
 * Deliberately NOT `describeTv`: that sleeps between empty probes and can
 * respawn the tvOS ax daemon (`recycleAx`). Inside a 200ms poll loop the sleeps
 * are redundant and the respawn is destructive — it would drop the very state
 * the caller is waiting on. Repair stays in the one-shot tool; a wait only
 * observes and reports.
 */
export async function describeTvFocus(api: TvControlApi): Promise<DescribeTreeData> {
  return tvFocusTree(await api.describe());
}
