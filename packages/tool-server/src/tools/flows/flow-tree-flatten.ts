import type { DescribeNode } from "../describe/contract";
// Shared with the describe path's scroll-clip prune so the two trees can never
// drift on what "scrolled out of a container's viewport" means.
import { rectFullyOutside } from "../describe/platforms/android/uiautomator-parser";

/**
 * Shared flatten + text-hoisting skeleton for the flow tree adapters (iOS,
 * Android, Chromium, Vega): descendant text is hoisted onto a container's leaf
 * so an `assert`/`text` check can read what the container visibly shows. Each
 * adapter only supplies a {@link NodeProjection}; the traversal, the (subtle)
 * hoisting/scoping invariant and the scroll-clip prune live here, in one place.
 */

/** Axis-aligned rect in an adapter's own device pixel/point space. */
export interface ClipRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What a platform adapter derives from one raw node for the shared traversal. */
export interface FlatNode<T> {
  /** Drop this node and its whole subtree (invisible / system chrome). */
  skip: boolean;
  children: T[];
  /**
   * Bounds in the adapter's device pixel/point space — UNCLIPPED, exactly as
   * the platform reports them — for the scroll-clip prune. Omit (or null) when
   * unknown: the node is then never scroll-pruned and, when it `scrolls`, adds
   * no clip of its own (mirroring `pruneSubtree`'s bounds-less case).
   */
  rect?: ClipRect | null;
  /**
   * True when the node is a scrolling container. Content it has scrolled out
   * of view is still in the raw tree with out-of-window (but often on-screen)
   * bounds, so its `rect` — intersected with any outer scroller's clip —
   * becomes the clip window its subtree is checked against.
   */
  scrolls?: boolean;
  /**
   * The node's own visible text (label plus any distinct value); "" if none.
   * INVARIANT: must be "" when the node has no on-screen frame — hoisted text
   * feeds `assert`/`text` checks, which guard what the screen shows, so text
   * from a mounted-but-scrolled-off or zero-area node must never bubble up.
   */
  ownText: string;
  /**
   * The leaf to emit for this node WITHOUT `subtreeText`, or null to emit none.
   * The traversal stamps `subtreeText` on it before pushing.
   */
  leaf: DescribeNode | null;
  /**
   * True when this node claims its subtree's text and contributes nothing
   * upward. This is what scopes hoisted text to a node's *nearest identified
   * ancestor*, so a broad container can't swallow the text of every
   * self-identified component in it.
   */
  shield: boolean;
}

export type NodeProjection<T> = (node: T) => FlatNode<T>;

// Intersection of a scroller's rect with the clip inherited from any outer
// scrollers (null = unclipped).
function intersectClip(rect: ClipRect, clip: ClipRect | null): ClipRect {
  if (!clip) return rect;
  const x1 = Math.max(rect.x, clip.x);
  const y1 = Math.max(rect.y, clip.y);
  const x2 = Math.min(rect.x + rect.w, clip.x + clip.w);
  const y2 = Math.min(rect.y + rect.h, clip.y + clip.h);
  return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
}

// Whole-word, case-insensitive `includes`, for the own-label dedup in
// `flattenHoisting`. A bare substring test would also drop an own label that
// merely appears INSIDE a descendant word — "Save" inside "Saved
// successfully", "Setting" inside "Settings" — silently losing a label the
// screen does show. Word characters are Unicode letters and digits: "Submit"
// is word-contained in "Submit now" and "Submit!" but not in "Submitted".
function includesWordsCI(haystack: string, needle: string): boolean {
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (!n) return false;
  const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);
  for (let at = h.indexOf(n); at !== -1; at = h.indexOf(n, at + 1)) {
    if (!isWordChar(h[at - 1]) && !isWordChar(h[at + n.length])) return true;
  }
  return false;
}

/**
 * Flatten `node`'s subtree into `out`, hoisting descendant text onto container
 * leaves. Post-order: a node's children contribute their text first, then the
 * node's own text plus that child text becomes its `subtreeText` — the own text
 * is dropped when the child text already contains it as whole words, and the
 * result is stamped only when it adds something over the node's own text (so a
 * plain leaf gets none).
 * Returns the text this node contributes to its parent: `""` when it shields.
 *
 * `scrollClip` is the viewport of the node's nearest scrollable ancestor (in
 * the adapter's pixel space), threaded down the recursion — callers start with
 * the default `null`.
 */
export function flattenHoisting<T>(
  node: T,
  project: NodeProjection<T>,
  out: DescribeNode[],
  scrollClip: ClipRect | null = null
): string {
  const view = project(node);
  if (view.skip) return "";

  // Scroll-clip prune — the flow-tree counterpart of the describe path's
  // `pruneSubtree` → `rectFullyOutside` → `scrollHidden`. A node fully outside
  // its nearest scrollable ancestor's window has been scrolled out of that
  // container's viewport even when its bounds still fall on the device screen:
  // keeping it would falsely fail an `assert { hidden }`, falsely pass
  // `visible`, hoist its text onto the container, and resolve a tap point
  // outside the scroller. Two deliberate divergences from `pruneSubtree`:
  //   - the clip applies from the scroll's DIRECT children down, one level
  //     earlier, because flows deliberately keep the testID-only containers
  //     describe's interactables trim discards — otherwise scrolled-out testID
  //     rows would survive. Non-scrollable parents never clip: an overlay or
  //     badge hanging outside its parent's bounds is kept;
  //   - a nested scroll INTERSECTS the inherited clip with its own rect where
  //     `pruneSubtree` replaces it. Replacing would re-admit everything inside
  //     an inner scroller whose rect extends past the outer viewport — a
  //     content-sized embedded RecyclerView / UICollectionView straddling the
  //     outer fold would report rows below the fold as visible.
  if (scrollClip && view.rect && rectFullyOutside(view.rect, scrollClip)) return "";
  const childClip = view.scrolls && view.rect ? intersectClip(view.rect, scrollClip) : scrollClip;

  const childText: string[] = [];
  for (const child of view.children) {
    const t = flattenHoisting(child, project, out, childClip);
    if (t) childText.push(t);
  }

  // A labelled container often wraps a child that renders the same text (a
  // testID button labelled "Submit" over a `<Text>Submit</Text>`): prepending
  // the own label unconditionally would hoist "Submit Submit", failing an
  // `equals` assert against exactly what the screen shows. Whole words, not a
  // bare substring: a label that only appears inside a descendant word ("Save"
  // over "Saved successfully") is information the child does not render and
  // must be kept, like the plainly additive label ("Volume" over "50%").
  const descendantText = childText.join(" ");
  const subtree =
    view.ownText && !includesWordsCI(descendantText, view.ownText)
      ? [view.ownText, descendantText].filter(Boolean).join(" ")
      : descendantText || view.ownText;
  if (view.leaf) {
    if (subtree && subtree !== view.ownText) view.leaf.subtreeText = subtree;
    out.push(view.leaf);
  }
  return view.shield ? "" : subtree;
}
