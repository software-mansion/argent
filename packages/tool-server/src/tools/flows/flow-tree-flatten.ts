import type { DescribeNode } from "../describe/contract";
import { includesCI } from "../../utils/ui-tree-match";

/**
 * Shared flatten + text-hoisting skeleton for the flow tree adapters
 * (`flow-ios-tree` on iOS, `flow-android-tree` on Android). Both walk a raw
 * platform tree and emit the flat-leaves-under-one-root shape the describe layer
 * expects, hoisting a container's descendant text onto its leaf so an
 * `assert`/`text` check can read what the container visibly shows. The two
 * platforms differ only in how they read a node's fields and build its leaf —
 * that lives in the per-adapter {@link NodeProjection}; the traversal and the
 * (subtle) hoisting/scoping invariant live here, in one place.
 */

/** What a platform adapter derives from one raw node for the shared traversal. */
export interface FlatNode<T> {
  /** Drop this node and its whole subtree (invisible / system chrome). */
  skip: boolean;
  /** Children to recurse into (already tag-filtered where the source needs it). */
  children: T[];
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

/**
 * Flatten `node`'s subtree into `out`, hoisting descendant text onto container
 * leaves. Post-order: a node's children contribute their text first, then the
 * node's own text plus that child text becomes its `subtreeText` — the own text
 * is dropped when the child text already contains it (a label the child also
 * renders), and the result is stamped only when it adds something over the
 * node's own text (so a plain leaf gets none).
 * Returns the text this node contributes to its parent: `""` when it shields.
 */
export function flattenHoisting<T>(
  node: T,
  project: NodeProjection<T>,
  out: DescribeNode[]
): string {
  const view = project(node);
  if (view.skip) return "";

  const childText: string[] = [];
  for (const child of view.children) {
    const t = flattenHoisting(child, project, out);
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
