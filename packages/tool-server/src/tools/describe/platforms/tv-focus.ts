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

/** What a wait tool says on an empty focus read; `describe` is the tool that repairs. */
export const TV_FOCUS_WAIT_EMPTY_HINT =
  "The TV focus engine reported no focusable elements (the app is likely still launching); " +
  "call `describe` once, then wait again.";

/** A focus read is "empty" when nothing actionable was reported. */
export function isEmptyFocus(res: TvDescribeResponse): boolean {
  return res.focusable.length === 0 && !res.focused;
}

/**
 * What the wait tools read as a non-zero on-screen frame. The daemon omits `frame`
 * for a zero-size element and keeps reporting a scrolled-away row, which `describe`
 * would have pruned, so both come out zero-area: `isVisible` then reports what the
 * tool description promises, and `hidden` can resolve on them.
 */
function frameOf(element: TvElement): DescribeNode["frame"] {
  const f = element.frame;
  if (!f) return { x: 0, y: 0, width: 0, height: 0 };
  const onScreen = f.x < 1 && f.y < 1 && f.x + f.width > 0 && f.y + f.height > 0;
  return onScreen ? f : { x: f.x, y: f.y, width: 0, height: 0 };
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

function toNode(element: TvElement): DescribeNode {
  const traits = [...(element.traits ?? [])];
  if (element.isFocused) traits.push(FOCUSED_TRAIT);
  return {
    // Traits are what a selector's `role` matches, exactly as on a phone.
    role: traits.length > 0 ? traits.join(",") : "element",
    frame: frameOf(element),
    children: [],
    ...(element.label ? { label: element.label } : {}),
    ...(element.value ? { value: element.value } : {}),
    // The cursor. `format-tree` already renders this as [focused], and it is
    // what makes "wait until focus lands on X" expressible.
    ...(element.isFocused ? { focused: true } : {}),
  };
}

/** Adapt a focus read into a describe tree. */
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
  // there — and the cursor would then match twice. It is the cursor whatever the
  // read marked on it, so mark it here or `role: "focused"` cannot match it.
  if (res.focused && !res.focusable.some((e) => e.isFocused)) {
    elements.push({ ...res.focused, isFocused: true });
  }

  const root = focusRoot();
  root.children = elements.map(toNode);
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
