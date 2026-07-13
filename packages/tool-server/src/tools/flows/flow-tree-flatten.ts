import type { DescribeNode } from "../describe/contract";
import { includesCI } from "../../utils/ui-tree-match";
// Generic rect math, defined next to its reference use (the describe path's
// scroll-clip prune) so the two trees can never drift on what "scrolled out
// of a container's viewport" means.
import { rectFullyOutside } from "../describe/platforms/android/uiautomator-parser";

/**
 * Shared flatten + text-hoisting skeleton for the flow tree adapters
 * (`flow-ios-tree` on iOS, `flow-android-tree` on Android). Both walk a raw
 * platform tree and emit the flat-leaves-under-one-root shape the describe layer
 * expects, hoisting a container's descendant text onto its leaf so an
 * `assert`/`text` check can read what the container visibly shows. The two
 * platforms differ only in how they read a node's fields and build its leaf —
 * that lives in the per-adapter {@link NodeProjection}; the traversal, the
 * (subtle) hoisting/scoping invariant, and the scroll-clip prune live here, in
 * one place.
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
  /** Children to recurse into (already tag-filtered where the source needs it). */
  children: T[];
  /**
   * The node's bounds in the adapter's device pixel/point space — UNCLIPPED,
   * exactly as the platform reports them — for the scroll-clip prune. Omit (or
   * null) when unknown: the node is then never scroll-pruned and, when it
   * `scrolls`, imposes no clip (mirroring `pruneSubtree`'s bounds-less case).
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
   * The leaf to emit for this node WITHOUT `subtreeText` — or null when the node
   * is pure scaffolding (no id/label) or has no on-screen frame. The traversal
   * stamps `subtreeText` on it before pushing.
   */
  leaf: DescribeNode | null;
  /**
   * True when this node claims its subtree's text and contributes nothing
   * upward — an identified node (or an Android password field). This is what
   * scopes hoisted text to a node's *nearest identified ancestor*, so a broad
   * container can't swallow the text of every self-identified component in it.
   */
  shield: boolean;
}

export type NodeProjection<T> = (node: T) => FlatNode<T>;

// Intersection of a scroller's rect with the clip inherited from any outer
// scrollers (null = unclipped). Never empty in practice: a scroller fully
// outside the inherited clip is dropped before its children are walked, so a
// scroller that reaches here always overlaps it.
function intersectClip(rect: ClipRect, clip: ClipRect | null): ClipRect {
  if (!clip) return rect;
  const x1 = Math.max(rect.x, clip.x);
  const y1 = Math.max(rect.y, clip.y);
  const x2 = Math.min(rect.x + rect.w, clip.x + clip.w);
  const y2 = Math.min(rect.y + rect.h, clip.y + clip.h);
  return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
}

/**
 * Flatten `node`'s subtree into `out`, hoisting descendant text onto container
 * leaves. Post-order: a node's children contribute their text first, then the
 * node's own text plus that child text becomes its `subtreeText` — the own text
 * is dropped when the child text already contains it (a label the child also
 * renders), and the result is stamped only when it adds something over the
 * node's own text (so a plain leaf gets none).
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
  // `pruneSubtree` → `rectFullyOutside` → `scrollHidden` (see
  // describe/platforms/android/uiautomator-parser). A node fully outside its
  // nearest scrollable ancestor's window has been scrolled out of that
  // container's viewport even when its bounds still fall on the device screen:
  // keeping it would falsely fail an `assert { hidden }`, falsely pass
  // `visible`, hoist its text onto the container, and resolve a tap point
  // outside the scroller. Drop it with its whole subtree, as describe does.
  // Only a partial overlap survives (again matching describe, which keeps the
  // full screen-clipped frame). Two deliberate divergences from `pruneSubtree`:
  //   - the clip applies from the scroll's DIRECT children down, one level
  //     earlier than `pruneSubtree` (whose interactables trim makes a
  //     scrolled-out layout row evaporate as an empty passthrough anyway) —
  //     flows deliberately keep the testID-only containers that trim discards,
  //     so the prune must fire at the scroll itself or scrolled-out testID rows
  //     would survive. Non-scrollable parents never clip: an overlay or badge
  //     hanging outside its parent's bounds is kept;
  //   - a nested scroll INTERSECTS the inherited clip with its own rect where
  //     `pruneSubtree` replaces it. Replacing would re-admit everything inside
  //     an inner scroller whose rect extends past the outer viewport — a
  //     content-sized embedded RecyclerView / UICollectionView straddling the
  //     outer fold would report rows below the fold as visible: the original
  //     bug one nesting level deeper. (`pruneSubtree` only escapes that
  //     because it applies each clip one level later, so the outer check stays
  //     alive for the inner scroller's direct children — with the prune firing
  //     at the scroll itself, the outer viewport must be carried into the
  //     intersection instead.) A node thus survives only if it overlaps EVERY
  //     scroll ancestor's viewport on its branch; this diverges from describe
  //     only where describe wrongly keeps invisible nested content.
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
  // `equals` assert against exactly what the screen shows. Drop the own label
  // when the joined descendant text already contains it (case-insensitive,
  // mirroring the matcher's `contains` semantics); an additive label
  // ("Volume" over "50%") is still preserved.
  const descendantText = childText.join(" ");
  const subtree =
    view.ownText && !includesCI(descendantText, view.ownText)
      ? [view.ownText, descendantText].filter(Boolean).join(" ")
      : descendantText || view.ownText;
  if (view.leaf) {
    if (subtree && subtree !== view.ownText) view.leaf.subtreeText = subtree;
    out.push(view.leaf);
  }
  return view.shield ? "" : subtree;
}
