import type { DescribeNode, DescribeFrame } from "./contract";

// Roles we treat as pure layout containers — they only matter when they carry
// a label, identifier, or value. The AX service emits AXGroup as the fallback
// for anything without a recognised trait, and uiautomator surfaces the raw
// Android layout class names; both classes commonly appear five-deep around
// the actually-meaningful leaves.
const STRUCTURAL_ROLES = new Set<string>([
  // iOS AX fallback
  "AXGroup",
  // Android view-hierarchy containers (uiautomator passes these through
  // verbatim from `class` when deriveUiAutomatorRole has no semantic mapping)
  "View",
  "ViewGroup",
  "FrameLayout",
  "LinearLayout",
  "RelativeLayout",
  "AbsoluteLayout",
  "TableLayout",
  "TableRow",
  "GridLayout",
  "ConstraintLayout",
  "MotionLayout",
  "CoordinatorLayout",
  "AppBarLayout",
  "CardView",
  "ViewPager",
  "ViewPager2",
  "ComposeView",
  "AndroidComposeView",
]);

// 4 decimals = 0.0001 of the screen ≈ 0.1px on a 1080-wide display, well under
// any tap target. Three would land in the same pixel as the next element on
// dense layouts; five+ keeps floating-point noise (the `.0796...199005` tails
// the AX service emits) without buying any usable precision.
const FRAME_PRECISION = 1e4;

function roundFrameComponent(value: number): number {
  return Math.round(value * FRAME_PRECISION) / FRAME_PRECISION;
}

function roundFrame(frame: DescribeFrame): DescribeFrame {
  return {
    x: roundFrameComponent(frame.x),
    y: roundFrameComponent(frame.y),
    width: roundFrameComponent(frame.width),
    height: roundFrameComponent(frame.height),
  };
}

function isNoiseWrapper(node: DescribeNode): boolean {
  if (!STRUCTURAL_ROLES.has(node.role)) return false;
  if (node.label) return false;
  if (node.identifier) return false;
  if (node.value) return false;
  return true;
}

function framesEqual(a: DescribeFrame, b: DescribeFrame): boolean {
  return (
    roundFrameComponent(a.x) === roundFrameComponent(b.x) &&
    roundFrameComponent(a.y) === roundFrameComponent(b.y) &&
    roundFrameComponent(a.width) === roundFrameComponent(b.width) &&
    roundFrameComponent(a.height) === roundFrameComponent(b.height)
  );
}

// Pure layout containers that exist only to hold one same-bounds child add no
// spatial information — `Screen → drag_layer → launcher → workspace → ...`
// is six levels of hand-walking just to reach the date widget. Collapse them.
// Targeting info (label / identifier) on the wrapper is forwarded to the
// surviving child if the child has none, so e.g. `id/launcher → unnamed View`
// becomes a single `View id=launcher` instead of vanishing the id entirely.
//
// Refuse to collapse only when both layers carry differing *labels* or
// *values*: an `AXGroup label="Calendar widget" → AXButton label="Open"`
// stack at the same bounds describes two semantically distinct entities and
// folding it to just the button would silently lose the widget context.
// Identifier conflicts between layers are common platform-internal noise —
// the launcher chain `id/content → id/launcher → id/drag_layer` carries a
// distinct resource-id at every level even though no agent would target the
// outer two. We tolerate that by keeping the child's identifier and dropping
// the wrapper's; the merge function below preserves the wrapper's id only
// when the child has none.
function shouldCollapseSingleChildWrapper(node: DescribeNode, only: DescribeNode): boolean {
  if (!STRUCTURAL_ROLES.has(node.role)) return false;
  if (!framesEqual(node.frame, only.frame)) return false;
  if (node.label !== undefined && only.label !== undefined && node.label !== only.label) {
    return false;
  }
  if (node.value !== undefined && only.value !== undefined && node.value !== only.value) {
    return false;
  }
  return true;
}

function mergeIdentityFromCollapsedWrapper(
  wrapper: DescribeNode,
  child: DescribeNode
): DescribeNode {
  return {
    ...child,
    ...(child.label === undefined && wrapper.label !== undefined ? { label: wrapper.label } : {}),
    ...(child.identifier === undefined && wrapper.identifier !== undefined
      ? { identifier: wrapper.identifier }
      : {}),
    ...(child.value === undefined && wrapper.value !== undefined ? { value: wrapper.value } : {}),
  };
}

// Stable structural fingerprint used to deduplicate sibling subtrees. The AX
// service emits widget contents twice on iOS home screens (the Map widget /
// "MONDAY, 04 MAY" / "No events today" trio repeats verbatim); a pure
// (role, frame, label) check would also fold non-duplicate siblings, so we
// hash the full subtree including descendants.
function fingerprintNode(node: DescribeNode): string {
  return JSON.stringify({
    role: node.role,
    frame: node.frame,
    label: node.label ?? null,
    identifier: node.identifier ?? null,
    value: node.value ?? null,
    children: node.children.map(fingerprintNode),
  });
}

function dedupSiblings(nodes: DescribeNode[]): DescribeNode[] {
  if (nodes.length < 2) return nodes;
  const seen = new Set<string>();
  const out: DescribeNode[] = [];
  for (const n of nodes) {
    const key = fingerprintNode(n);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

// Bottom-up rewrite. Each call returns the list of nodes that should appear
// in the parent's `children`: usually one node, zero if the subtree dropped
// to nothing, or many when a noise wrapper is promoted. The synthetic root
// is preserved by `compressDescribeTree` regardless of whether it itself
// looks like a wrapper — a tree without a root violates the contract.
function rewriteSubtree(node: DescribeNode): DescribeNode[] {
  const compressedChildren = dedupSiblings(node.children.flatMap(rewriteSubtree));

  if (isNoiseWrapper(node)) {
    return compressedChildren;
  }

  if (
    compressedChildren.length === 1 &&
    shouldCollapseSingleChildWrapper(node, compressedChildren[0]!)
  ) {
    return [mergeIdentityFromCollapsedWrapper(node, compressedChildren[0]!)];
  }

  return [
    {
      role: node.role,
      frame: roundFrame(node.frame),
      children: compressedChildren,
      ...(node.label !== undefined ? { label: node.label } : {}),
      ...(node.identifier !== undefined ? { identifier: node.identifier } : {}),
      ...(node.value !== undefined ? { value: node.value } : {}),
    },
  ];
}

/**
 * Compress a describe tree by collapsing pure-layout wrappers into their
 * children, deduplicating identical sibling subtrees, and rounding normalized
 * frame components to 4 decimals. Idempotent: a second pass returns an equal
 * tree.
 */
export function compressDescribeTree(root: DescribeNode): DescribeNode {
  const rewrittenChildren = dedupSiblings(root.children.flatMap(rewriteSubtree));
  return {
    role: root.role,
    frame: roundFrame(root.frame),
    children: rewrittenChildren,
    ...(root.label !== undefined ? { label: root.label } : {}),
    ...(root.identifier !== undefined ? { identifier: root.identifier } : {}),
    ...(root.value !== undefined ? { value: root.value } : {}),
  };
}
