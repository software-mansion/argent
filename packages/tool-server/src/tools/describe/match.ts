import type { DescribeNode } from "./contract";

// Pure tree-matching primitives shared by the tools that locate a node in the
// `describe` accessibility / DOM tree (`await-ui-element`, `find`). Kept free of
// any selector / locator shape so each consumer can supply its own predicate
// while reusing the one hardened copy of the root-exclusion walk, the
// reading-order comparator, and the visibility proxy.

// Case-insensitive substring test. Undefined haystack never matches.
export function includesCI(haystack: string | undefined, needle: string): boolean {
  return Boolean(haystack) && haystack!.toLowerCase().includes(needle.toLowerCase());
}

// The element's visible text — label and value joined. Used for `text`-style
// assertions and diagnostics.
export function nodeText(node: DescribeNode): string {
  return [node.label, node.value].filter(Boolean).join(" ");
}

// describe prunes off-screen / zero-size nodes on Chromium and the compressed
// Android dump, and iOS AX only returns on-screen leaves — so a non-zero frame
// area is a cheap, reliable proxy for "visible".
export function isVisible(node: DescribeNode): boolean {
  return node.frame.width > 0 && node.frame.height > 0;
}

function collect(
  node: DescribeNode,
  predicate: (n: DescribeNode) => boolean,
  acc: DescribeNode[]
): void {
  if (predicate(node)) acc.push(node);
  for (const child of node.children) collect(child, predicate, acc);
}

// Every node satisfying `predicate` in the subtree, EXCLUDING `root` itself.
//
// `root` is the top-level container describe puts at the head of the tree. On
// iOS / Android it's a synthetic full-screen node (iOS `AXGroup`, Android
// `hierarchy`/`Screen`; frame `0,0,1,1`); on Chromium it's the REAL `<html>`
// element (`describeChromium` walks `document.documentElement`), framed from
// `getBoundingClientRect` rather than a synthetic `0,0,1,1`. Whatever its frame,
// `describe` renders this node only as a non-selectable `ROOT` header line, never
// as a matchable element, and its frame always passes `isVisible`. Matching it
// would let a role predicate that is a substring of the root role (e.g.
// `AXGroup`, also iOS's default role for untyped elements) satisfy
// `visible`/`exists` on any screen — including an empty AX tree — and make
// `hidden` impossible. So we skip it, walking `root.children` only — the one rule
// we share with format-tree. (Chromium side effect: the `<html>` element's own
// id / aria-label / author role sit on this excluded root, so a predicate
// targeting those attributes matches nothing there.)
//
// Past that root exclusion we do NOT mirror describe's rendered body: describe
// drops structural / unlabeled nodes through a content-and-role filter before
// printing, but `walkMatches` tests every remaining node. So a role- or
// identifier-only predicate can match a container (e.g. an unlabeled `AXGroup`)
// that never appears in describe's output — keep that in mind when a predicate is
// broad.
export function walkMatches(
  root: DescribeNode,
  predicate: (n: DescribeNode) => boolean
): DescribeNode[] {
  const acc: DescribeNode[] = [];
  for (const child of root.children) collect(child, predicate, acc);
  return acc;
}

// Reading order: top-to-bottom, then left-to-right — the order describe's
// `renderFlat` sorts iOS leaves into, so "first" here is the element the agent
// "saw first" at the top of describe's output. Returns a NEW array.
export function sortReadingOrder(matches: DescribeNode[]): DescribeNode[] {
  return matches.slice().sort((a, b) => a.frame.y - b.frame.y || a.frame.x - b.frame.x);
}

// The single topmost-then-leftmost match (smallest y, then x). Returns undefined
// for an empty set. Equivalent to `sortReadingOrder(matches)[0]` but without the
// allocation.
export function firstInReadingOrder(matches: DescribeNode[]): DescribeNode | undefined {
  let best: DescribeNode | undefined;
  for (const n of matches) {
    if (
      best === undefined ||
      n.frame.y < best.frame.y ||
      (n.frame.y === best.frame.y && n.frame.x < best.frame.x)
    ) {
      best = n;
    }
  }
  return best;
}
