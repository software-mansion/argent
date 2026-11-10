import type {
  TvControlApi,
  TvDescribeResponse,
  TvElement,
  TvHierarchyNode,
  TvHierarchyResponse,
} from "../../../blueprints/tv-control-types";
import type { DescribeNode, DescribeTreeData } from "../contract";

/**
 * What the wait tools read on an Apple TV: the focus view `describe` renders
 * (see `./tv.ts`), plus the text of the rest of the screen, adapted into the
 * ordinary `DescribeNode` tree they fingerprint and match against.
 *
 * `describeIos` short-circuits every tvOS read to an empty tree, so both wait
 * tools used to see a permanently empty screen (#620). The focus view alone is
 * not enough either: a "Loading" label is not focusable, and a screen may have
 * nothing focusable at all.
 */

/** Synthetic root the elements hang off, mirroring the other platforms' shape. */
function focusRoot(): DescribeNode {
  return { role: "AXGroup", frame: { x: 0, y: 0, width: 1, height: 1 }, children: [] };
}

/**
 * Said only when neither the focus view nor the hierarchy has anything. The hint
 * is load-bearing: `await-ui-element` treats a childless tree as untrustworthy
 * ONLY when a hint (or a prior match) says so, so without it `hidden` would pass
 * on the first poll of a still-launching app.
 */
export const TV_FOCUS_WAIT_EMPTY_HINT =
  "The Apple TV reports nothing on screen: the app may be launching, or the screen has no " +
  "text or focusable elements, which a screenshot can tell apart.";

/** A focus read is "empty" when nothing actionable was reported. */
export function isEmptyFocus(res: TvDescribeResponse): boolean {
  return res.focusable.length === 0 && !res.focused;
}

/**
 * tvOS AX labels are often compound multi-line strings, e.g.
 * "Home\nLander\nSide bar content item\n1 of 5\nselected": the first line is the
 * element's name and the rest is context. `describe` and the wait tools share
 * this split, so what one displays is what the other compares.
 */
export function splitTvLabel(label: string | undefined): { name?: string; context: string[] } {
  const lines = (label ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return { name: lines[0], context: lines.slice(1) };
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
  return isOnScreen(f) ? f : { x: f.x, y: f.y, width: 0, height: 0 };
}

function isOnScreen(f: NonNullable<TvElement["frame"]>): boolean {
  return f.x < 1 && f.y < 1 && f.x + f.width > 0 && f.y + f.height > 0;
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
  const frame = frameOf(element);
  const { name, context } = splitTvLabel(element.label);
  return {
    // Traits are what a selector's `role` matches, exactly as on a phone.
    role: traits.length > 0 ? traits.join(",") : "element",
    frame,
    // The context stays selectable (a tab's "selected"), and a `text` condition
    // that contains it still holds, but `equals` compares the name `describe` shows.
    children: context.map((label) => ({ role: "context", frame, children: [], label })),
    ...(name ? { label: name } : {}),
    ...(context.length > 0 && element.label ? { subtreeText: element.label } : {}),
    ...(element.value ? { value: element.value } : {}),
    // The cursor. `format-tree` already renders this as [focused], and it is
    // what makes "wait until focus lands on X" expressible.
    ...(element.isFocused ? { focused: true } : {}),
  };
}

/**
 * The labelled non-focusable elements of a hierarchy read, as `TvElement`s. The
 * root is the app itself. Frames arrive in points, unlike the focus view's. The
 * cursor stays the focus view's call, so `isFocused` is dropped here, and so are
 * traits: Settings' disabled chevrons carry `button`, and `role: "button"` should
 * keep meaning what the remote can reach.
 */
function contentElements(
  hierarchy: TvHierarchyResponse | null,
  focusText: Set<string>
): TvElement[] {
  const out: TvElement[] = [];
  const screen = hierarchy?.screenFrame;
  // `offScreen` is the frame of a scrolled-away ancestor. The daemon reports the
  // children of an off-screen cell at a made-up on-screen spot (Settings: y=154),
  // so they take the ancestor's frame instead, which `frameOf` reads as hidden.
  const walk = (node: TvHierarchyNode, offScreen?: TvElement["frame"]): void => {
    for (const child of node.children ?? []) {
      const f = child.frame;
      const frame =
        offScreen ??
        (f && screen?.width && screen.height
          ? {
              x: f.x / screen.width,
              y: f.y / screen.height,
              width: f.width / screen.width,
              height: f.height / screen.height,
            }
          : undefined);
      const text = child.label || child.value;
      if (text && !focusText.has(text)) {
        out.push({ label: child.label, value: child.value, ...(frame ? { frame } : {}) });
      }
      walk(child, offScreen ?? (frame && !isOnScreen(frame) ? frame : undefined));
    }
  };
  if (hierarchy?.tree) walk(hierarchy.tree);
  return out;
}

/** Adapt a focus read, and the hierarchy read beside it, into a describe tree. */
export function tvFocusTree(
  res: TvDescribeResponse,
  hierarchy: TvHierarchyResponse | null = null
): DescribeTreeData {
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

  // A focusable's label and value also appear as its own children in the hierarchy.
  const focusText = new Set<string>();
  for (const e of elements) {
    if (e.label) focusText.add(e.label);
    if (e.value) focusText.add(e.value);
  }
  const root = focusRoot();
  root.children = [...elements, ...contentElements(hierarchy, focusText)].map(toNode);
  if (root.children.length === 0) {
    return { tree: root, source: "tv-focus", hint: TV_FOCUS_WAIT_EMPTY_HINT };
  }
  // The daemon stops walking past its node cap, so text beyond it is missing.
  return (hierarchy?.nodeCount ?? 0) > TV_HIERARCHY_NODE_CAP
    ? { tree: root, source: "tv-focus", partial: true, hint: TV_HIERARCHY_CAPPED_HINT }
    : { tree: root, source: "tv-focus" };
}

/** `walkTree` in the tvOS ax daemon stops once it has visited this many nodes. */
const TV_HIERARCHY_NODE_CAP = 800;
const TV_HIERARCHY_CAPPED_HINT =
  "The Apple TV hierarchy stopped at its 800-element cap, so text past it was not read.";

/** Whether the focus engine has placed its cursor, on a tree from {@link tvFocusTree}. */
export function hasTvCursor(tree: DescribeNode): boolean {
  return tree.children.some((n) => n.focused);
}

/**
 * One bare read per poll, for the wait tools.
 *
 * Deliberately NOT `describeTv`: that sleeps between empty probes and can
 * respawn the tvOS ax daemon (`recycleAx`). Inside a 200ms poll loop the sleeps
 * are redundant and the respawn is destructive — it would drop the very state
 * the caller is waiting on. A wait only observes and reports.
 *
 * A failed hierarchy read fails the whole read: the focus view alone would drop
 * the screen's text for that poll, and `hidden` would pass on it. It is retried
 * once first, because the daemon's short listen backlog refuses connections
 * when several waits poll at once.
 */
export async function describeTvFocus(api: TvControlApi): Promise<DescribeTreeData> {
  const res = await api.describe();
  if (!api.hierarchy) return tvFocusTree(res);
  const hierarchy = await api.hierarchy().catch(async () => {
    await new Promise((r) => setTimeout(r, HIERARCHY_RETRY_MS));
    return api.hierarchy!();
  });
  return tvFocusTree(res, hierarchy);
}

const HIERARCHY_RETRY_MS = 30;
