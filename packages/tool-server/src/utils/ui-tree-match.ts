import { z } from "zod";
import type { DeviceInfo, Registry } from "@argent/registry";
import type { DescribeFrame, DescribeNode, DescribeTreeData } from "../tools/describe/contract";
import { describeIos } from "../tools/describe/platforms/ios";
import { describeAndroid } from "../tools/describe/platforms/android";
import { describeChromium } from "../tools/describe/platforms/chromium";
import { describeVega } from "../tools/describe/platforms/vega";
import { LAYOUT_CONTAINER_ROLES } from "../tools/describe/platforms/android/uiautomator-parser";
import { chromiumCdpRef, type ChromiumCdpApi } from "../blueprints/chromium-cdp";

/**
 * Shared tree matching: `await-ui-element`, the flow directives (`tap`, `type`,
 * `assert`) and the recorder's reverse lookup all resolve selectors through it.
 */

/**
 * True when `text` contains at least one visibly-rendered character. Icon fonts
 * expose glyphs as Private Use Area code points and zero-width / format
 * characters render as nothing: a constraint made only of those displays as
 * EMPTY in flow YAML and at replay matches an element no reader can predict.
 */
export function hasVisibleText(text: string): boolean {
  return text.replace(/[\p{Cf}\p{Co}\p{Cc}]/gu, "").trim().length > 0;
}

/**
 * The fields every selector representation shares, without the non-empty
 * refinement, so a flow-only text constraint can replace `text` while reusing
 * the same identifier/role validation.
 */
export const selectorFieldsSchema = z
  .object({
    text: z
      .string()
      .min(1)
      .refine(hasVisibleText, {
        message:
          "text must contain at least one visible character (icon-font/private-use and " +
          "zero-width characters render as nothing) — select by identifier or role instead",
      })
      .optional()
      .describe("Case-insensitive substring of the element's visible label or value."),
    identifier: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The element's identifier (accessibilityIdentifier / resource-id / testid), matched case-insensitively as the exact identifier or the unqualified resource-id name ('submit' matches 'com.example.app:id/submit')."
      ),
    role: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Case-insensitive substring of the element's role (e.g. AXButton, button, TextView)."
      ),
  })
  .strict();

export const selectorSchema = selectorFieldsSchema.refine(
  (s) => Boolean(s.text || s.identifier || s.role),
  {
    message: "selector needs at least one of text, identifier, or role",
  }
);

export type Selector = z.infer<typeof selectorSchema> & {
  /**
   * Flow-only regex text locator (`{ text: { matches: '<pattern>' } }` in flow
   * YAML), tested unanchored and case-sensitive against the node's OWN
   * label/value, deliberately not the hoisted `subtreeText`: subtree matching
   * would make every unshielded ancestor of a text leaf match too, degrading
   * the exact-beats-substring ranking actions rely on. A type-level extension,
   * not a schema field, so the `await-ui-element` tool surface doesn't grow.
   */
  textMatches?: string;
  /**
   * Flow-only container scope (`{ text: "Delete", within: { id: "card" } }` in
   * flow YAML): the node's frame must sit inside the frame of a DISTINCT
   * element matching this selector. Geometric, not tree-ancestry: the flow
   * adapters flatten every platform tree into leaves under one synthetic root
   * (see `flow-tree-flatten`), so ancestry does not survive to replay. Scopes
   * chain outward (`a within b within c`). Resolved by {@link findAll}, which
   * sees the whole tree; {@link matchNode} evaluates own fields only.
   */
  within?: Selector;
  /**
   * Flow-only general-sibling scope (`{ role: Switch, after: { text: "Wi-Fi" } }`
   * in flow YAML) — the CSS `~` combinator: the node must FOLLOW a distinct
   * element matching this selector in reading order (see {@link followKind}).
   * Geometric for the same reason `within` is. Resolved by {@link findAll}.
   */
  after?: Selector;
  /**
   * Flow-only adjacent-sibling scope (`{ role: Switch, next: { text: "Wi-Fi" } }`
   * in flow YAML) — the CSS `+` combinator: like {@link after}, but only the
   * NEAREST following match is kept per anchor. The "control belonging to this
   * row's label" locator. Resolved by {@link findAll}.
   */
  next?: Selector;
};

export type WaitCondition = "exists" | "visible" | "hidden" | "text";

// `contains` (default) and `equals` are case-insensitive; `matches` is a JS
// regex tested unanchored and CASE-SENSITIVELY — a regex carries its semantics
// in the pattern, and forcing `i` would betray `\d{2}`-style precision.
// `matches` is flow-only; the await-ui-element schema stays contains/equals.
export type TextMatchMode = "contains" | "equals" | "matches";

export function nodeText(node: DescribeNode): string {
  return [node.label, node.value].filter(Boolean).join(" ");
}

// Text a `text` condition reads (and its failure messages quote). Prefers
// `subtreeText` — hoisted from descendants by the flow adapters — so a check
// against a testID container reads the text it visibly wraps rather than its
// own (empty) label. Selector matching stays on `nodeText`, so `tap`/`{ text }`
// targeting is unaffected.
export function assertText(node: DescribeNode): string {
  return node.subtreeText ?? nodeText(node);
}

function includesCI(haystack: string | undefined, needle: string): boolean {
  return Boolean(haystack) && haystack!.toLowerCase().includes(needle.toLowerCase());
}

function equalsCI(actual: string | undefined, expected: string): boolean {
  return (actual ?? "").toLowerCase() === expected.toLowerCase();
}

/**
 * Case-insensitive EXACT match, or the unqualified name of an Android
 * resource-id (`submit` matches `com.example.app:id/submit`), so a caller never
 * needs the package prefix. Deliberately not a substring test: a short needle
 * would capture unrelated ids (`save` must not match `autosave-banner`).
 */
export function identifierMatches(actual: string | undefined, needle: string): boolean {
  if (!actual) return false;
  return equalsCI(actual, needle) || actual.toLowerCase().endsWith(`:id/${needle.toLowerCase()}`);
}

/** @internal Seam for asserting regex compilation lifetime in tests. */
export const uiTreeMatchInternals = {
  createRegExp(pattern: string): RegExp {
    return new RegExp(pattern);
  },
};

// Absent/empty text is never a regex haystack, matching `includesCI`.
function regexMatchesNonEmpty(regex: RegExp, actual: string | undefined): boolean {
  if (!actual) return false;
  return regex.test(actual);
}

/** Compare an element's text to the expected string under the chosen mode. */
export function textMatches(
  actual: string | undefined,
  expected: string,
  mode: TextMatchMode
): boolean {
  // Patterns are validated at flow parse time, so construction cannot throw.
  if (mode === "matches") {
    return regexMatchesNonEmpty(uiTreeMatchInternals.createRegExp(expected), actual);
  }
  return mode === "equals" ? equalsCI(actual, expected) : includesCI(actual, expected);
}

/**
 * Does the selector constrain WHICH element it matches, rather than only where
 * to look? False exactly for the universal selector (flow YAML's `any: true`).
 */
function hasOwnConstraint(selector: Selector): boolean {
  return (
    selector.text !== undefined ||
    selector.textMatches !== undefined ||
    selector.identifier !== undefined ||
    selector.role !== undefined
  );
}

function matchNodeWithRegex(
  node: DescribeNode,
  selector: Selector,
  textRegex: RegExp | undefined
): boolean {
  if (selector.text !== undefined) {
    if (!includesCI(node.label, selector.text) && !includesCI(node.value, selector.text)) {
      return false;
    }
  }
  if (textRegex !== undefined) {
    if (
      !regexMatchesNonEmpty(textRegex, node.label) &&
      !regexMatchesNonEmpty(textRegex, node.value)
    ) {
      return false;
    }
  }
  if (
    selector.identifier !== undefined &&
    !identifierMatches(node.identifier, selector.identifier)
  ) {
    return false;
  }
  if (selector.role !== undefined && !includesCI(node.role, selector.role)) {
    return false;
  }
  return true;
}

function selectorTextRegex(selector: Selector): RegExp | undefined {
  return selector.textMatches === undefined
    ? undefined
    : uiTreeMatchInternals.createRegExp(selector.textMatches);
}

/**
 * Single-node predicate over the selector's OWN fields. The relational scopes
 * need the tree and are resolved by {@link findAll}; they are ignored here.
 *
 * A selector with no own fields matches EVERY node — the universal selector
 * (CSS `*`, `any: true` in flow YAML), which `selectorSchema` and the flow
 * parser only admit behind an explicit `any: true` paired with a relation.
 */
export function matchNode(node: DescribeNode, selector: Selector): boolean {
  return matchNodeWithRegex(node, selector, selectorTextRegex(selector));
}

// Frame-comparison tolerance (normalized units): a hair of overhang — a border,
// a shadow, sub-pixel rounding — must not change what the eye plainly sees.
// `frameWithin` reads it as containment slack; `frameAbove` reads it as the
// row-band merge threshold. Same magnitude as flow-actions' EDGE_EPS.
const WITHIN_EPS = 0.005;

/** Is `inner` contained in `outer`, within {@link WITHIN_EPS} per edge? */
function frameWithin(inner: DescribeFrame, outer: DescribeFrame): boolean {
  return (
    inner.x >= outer.x - WITHIN_EPS &&
    inner.y >= outer.y - WITHIN_EPS &&
    inner.x + inner.width <= outer.x + outer.width + WITHIN_EPS &&
    inner.y + inner.height <= outer.y + outer.height + WITHIN_EPS
  );
}

// A naive `within` scan tests every candidate against every container, which a
// broad container selector (`within: { role: <common role> }`) drives quadratic
// on a flow tree of up to 12k nodes — and findAll re-runs on every settle/poll.
// Above a small container count, index the containers in a coarse uniform grid
// so a candidate only tests the containers registered in its own top-left cell.
// Only a `within` selector ever builds this.
const CONTAINMENT_GRID_N = 16; // cells per axis over the normalized [0,1]² frame
const CONTAINMENT_GRID_MIN = 32; // fewer containers than this: a direct scan wins

// The grid column/row a normalized coordinate falls in, clamped to [0, N):
// a frame can sit a hair off-screen and must still map to a real cell.
function gridCell(coord: number): number {
  const c = Math.floor(coord * CONTAINMENT_GRID_N);
  return c < 0 ? 0 : c >= CONTAINMENT_GRID_N ? CONTAINMENT_GRID_N - 1 : c;
}

/**
 * Build a predicate `inside(node)` — true when the node's frame sits inside a
 * DISTINCT container in `containers`. Below {@link CONTAINMENT_GRID_MIN} it
 * scans directly; larger sets are indexed in a coarse grid keyed by top-left
 * cell.
 *
 * A container is registered in every cell its frame covers, PADDED by
 * {@link WITHIN_EPS}: a candidate may overhang a container edge by up to the
 * tolerance, so its top-left corner can land one cell before the container's
 * unpadded coverage. The grid only PRUNES — the exact `frameWithin` check on
 * the bucket decides — so the padding never admits a false containment.
 */
function containmentTester(containers: DescribeNode[]): (node: DescribeNode) => boolean {
  if (containers.length < CONTAINMENT_GRID_MIN) {
    return (node) => containers.some((c) => c !== node && frameWithin(node.frame, c.frame));
  }
  const cells = new Map<number, DescribeNode[]>();
  for (const c of containers) {
    const f = c.frame;
    const colEnd = gridCell(f.x + f.width + WITHIN_EPS);
    const rowEnd = gridCell(f.y + f.height + WITHIN_EPS);
    for (let row = gridCell(f.y - WITHIN_EPS); row <= rowEnd; row++) {
      for (let col = gridCell(f.x - WITHIN_EPS); col <= colEnd; col++) {
        const key = row * CONTAINMENT_GRID_N + col;
        const bucket = cells.get(key);
        if (bucket) bucket.push(c);
        else cells.set(key, [c]);
      }
    }
  }
  return (node) => {
    const bucket = cells.get(gridCell(node.frame.y) * CONTAINMENT_GRID_N + gridCell(node.frame.x));
    return (
      bucket !== undefined && bucket.some((c) => c !== node && frameWithin(node.frame, c.frame))
    );
  };
}

/**
 * Is `a` entirely above `b`, within {@link WITHIN_EPS}? The vertical half of
 * reading order. Frames for which this fails BOTH ways share a row band and are
 * ordered horizontally instead — that band rule is what makes "the switch after
 * the Wi-Fi label" work, since a row's control and its label rarely share a top
 * edge and a raw top-y comparison would order them by which is taller.
 */
function frameAbove(a: DescribeFrame, b: DescribeFrame): boolean {
  return a.y + a.height <= b.y + WITHIN_EPS;
}

/** Where `node` sits relative to an anchor in reading order. */
type FollowKind = "below" | "band" | "no";

/**
 * Does `node` FOLLOW `anchor` in reading order, and how — on a row below it, or
 * sharing its row band and entirely to its right? The geometric reading of a
 * CSS sibling combinator on a flattened tree.
 *
 * ONE classification, read by both {@link frameAfter} and {@link nearestAfter},
 * so the follower test and the grouping of followers can never disagree.
 *
 * A mutual verdict on either axis never decides: frames thinner than the
 * tolerance and closer together than it read as ordered BOTH ways, which would
 * otherwise let an element to the anchor's LEFT follow it. Vertically such a
 * pair falls through to the row rule; horizontally it means no order at all.
 * The relation is therefore antisymmetric, which the `next` reduction relies on.
 *
 * Mostly not a containment test, but a child flush with the anchor's bottom or
 * right edge and no thicker than the tolerance (a hairline divider) both
 * follows the anchor and sits {@link frameWithin} it.
 */
function followKind(node: DescribeFrame, anchor: DescribeFrame): FollowKind {
  const below = frameAbove(anchor, node);
  const above = frameAbove(node, anchor);
  if (below !== above) return below ? "below" : "no";
  const right = anchor.x + anchor.width <= node.x + WITHIN_EPS;
  const left = node.x + node.width <= anchor.x + WITHIN_EPS;
  return right !== left && right ? "band" : "no";
}

function frameAfter(node: DescribeFrame, anchor: DescribeFrame): boolean {
  return followKind(node, anchor) !== "no";
}

/**
 * Build a predicate `follows(node)` — true when the node follows a DISTINCT
 * anchor in reading order (the CSS `~` an `after` scope needs).
 *
 * A direct scan, deliberately: unlike {@link containmentTester}'s grid, an
 * index buys nothing here — the pruning it could offer is already subsumed by
 * the `some` short-circuit on the first matching anchor.
 */
function afterTester(anchors: DescribeNode[]): (node: DescribeNode) => boolean {
  return (node) => anchors.some((a) => a !== node && frameAfter(node.frame, a.frame));
}

// Ranking among an anchor's followers. Position first, then frame AREA so that
// coincident top-left corners — a container and the label leaf flush inside it,
// an everyday flattened-tree shape — resolve to the smaller, more specific
// element (the "smallest frame wins" doctrine `selectorToFrame` and
// `nodeAtPoint` rank by), then the individual extents, which separate shapes
// equal area cannot. Only frames identical on all four fields fall back to tree
// order, and those are indistinguishable to act on anyway.
function comparePick(a: DescribeFrame, b: DescribeFrame): number {
  return frameArea(a) - frameArea(b) || a.width - b.width || a.height - b.height;
}

function compareBandPick(a: DescribeFrame, b: DescribeFrame): number {
  return a.x - b.x || a.y - b.y || comparePick(a, b);
}

function compareBelowPick(a: DescribeFrame, b: DescribeFrame): number {
  return a.y - b.y || a.x - b.x || comparePick(a, b);
}

/**
 * The CSS `+` reduction: keep only the nearest candidate following each anchor,
 * unioned over anchors, returned in the candidates' own order.
 *
 * "Nearest" splits the followers the way a reader does: one sharing the
 * anchor's row band beats anything on the rows below, because that is the row's
 * own control — the locator `next` exists for. Within each group the leftmost
 * (band) / topmost (below) wins, then the smaller frame.
 *
 * A direct scan per anchor: unlike {@link afterTester} it cannot short-circuit,
 * but the index this replaced was a second implementation of the rules above
 * and the two disagreed on frames near the tolerance. The quadratic tail only
 * bites when the anchor selector matches essentially every node.
 *
 * The pick is made over ALL candidates, visible or not — it reduces the match
 * SET before any condition looks at it. Where the flow adapter keeps zero-area
 * nodes (Vega), a ghost node between the anchor and the real control therefore
 * wins the pick and a `visible` check on it fails — scope by
 * {@link Selector.after} or {@link Selector.within} there instead.
 */
function nearestAfter(candidates: DescribeNode[], anchors: DescribeNode[]): DescribeNode[] {
  if (candidates.length === 0 || anchors.length === 0) return [];
  const picked = new Set<DescribeNode>();
  for (const anchor of anchors) {
    const af = anchor.frame;
    let band: DescribeNode | undefined;
    let below: DescribeNode | undefined;
    for (const c of candidates) {
      if (c === anchor) continue;
      const f = c.frame;
      const kind = followKind(f, af);
      if (kind === "band") {
        if (band === undefined || compareBandPick(f, band.frame) < 0) band = c;
      } else if (kind === "below") {
        if (below === undefined || compareBelowPick(f, below.frame) < 0) below = c;
      }
    }
    const best = band ?? below;
    if (best !== undefined) picked.add(best);
  }
  return candidates.filter((c) => picked.has(c));
}

// Every node matching the selector, EXCLUDING `root` — the synthetic
// full-screen container at the head of a describe tree. Matching it would let a
// broad role selector satisfy `visible`/`exists` on any screen, and would make
// `within` vacuous since the root wraps everything.
//
// Every relation requires a DISTINCT node (`a within a` needs two nested
// elements), and each nests: `within: { id: b, within: c }` resolves c's
// containers first, then keeps only the b's sitting inside one of them.
export function findAll(root: DescribeNode, selector: Selector): DescribeNode[] {
  const all: DescribeNode[] = [];
  const collect = (node: DescribeNode): void => {
    all.push(node);
    for (const child of node.children) collect(child);
  };
  for (const child of root.children) collect(child);
  return resolveSelector(all, selector);
}

/**
 * The relational scopes a selector can carry, in the order
 * {@link resolveSelector} applies them. Shared with flow YAML's parser,
 * serializer and loose-alternative expansion so the layers cannot drift on
 * which keys are relations.
 */
export const SELECTOR_RELATIONS = ["within", "after", "next"] as const;

export type SelectorRelation = (typeof SELECTOR_RELATIONS)[number];

/**
 * How each scope narrows a match set. `within` and `after` are per-node
 * predicates; `next` reduces the SET, which is why the order above applies it
 * last — `{ any: true, next: X, within: Y }` means "the first element inside Y
 * that follows X", not "the first element after X, if it is inside Y".
 *
 * Keyed by the relation union, so adding a scope without teaching the engine
 * what it means is a compile error rather than a silently ignored constraint.
 */
const RELATION_RESOLVERS: Record<
  SelectorRelation,
  (matches: DescribeNode[], scope: DescribeNode[]) => DescribeNode[]
> = {
  within: (matches, scope) => matches.filter(containmentTester(scope)),
  after: (matches, scope) => matches.filter(afterTester(scope)),
  next: (matches, scope) => nearestAfter(matches, scope),
};

/** Own-field matches from `all`, narrowed by every scope the selector carries. */
function resolveSelector(all: DescribeNode[], selector: Selector): DescribeNode[] {
  const regex = selectorTextRegex(selector);
  let matches = all.filter((n) => matchNodeWithRegex(n, selector, regex));
  for (const relation of SELECTOR_RELATIONS) {
    const scope = selector[relation];
    if (scope === undefined) continue;
    matches = RELATION_RESOLVERS[relation](matches, resolveSelector(all, scope));
  }
  return matches;
}

// describe prunes off-screen nodes, so a non-zero frame area stands in for
// "visible".
export function isVisible(node: DescribeNode): boolean {
  return node.frame.width > 0 && node.frame.height > 0;
}

// The element a reader "sees first": smallest (y, then x), matching the order
// format-tree renders flat iOS leaves in.
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

// Evaluated over ALL elements matching a selector. `visible` holds if ANY match
// is on-screen; `hidden` only if NONE is; `text` reads the first VISIBLE match
// in reading order (the first overall if none is visible), so a stale zero-area
// node can't shadow the element the check meant to read, and the failure
// messages (flow assertReason, await-ui-element's timeout note) quote the same
// node.
export function evaluateCondition(
  condition: WaitCondition,
  expectedText: string | undefined,
  matches: DescribeNode[],
  textMatch: TextMatchMode = "contains"
): boolean {
  switch (condition) {
    case "exists":
      return matches.length > 0;
    case "visible":
      return matches.some(isVisible);
    case "hidden":
      return !matches.some(isVisible);
    case "text": {
      const first = firstInReadingOrder(matches.filter(isVisible)) ?? firstInReadingOrder(matches);
      if (first === undefined || expectedText === undefined) return false;
      // Hoisted subtree text is ADDITIVE: a check the element's own
      // label/value satisfies on a plain describe tree must not start failing
      // because the flow adapters stamped a compound `subtreeText` on the node.
      return (
        textMatches(assertText(first), expectedText, textMatch) ||
        textMatches(nodeText(first), expectedText, textMatch)
      );
    }
    default:
      return false;
  }
}

/**
 * A fingerprint of the tree's structure — every node's role, rounded frame and
 * text/identifier. Two consecutive identical fingerprints mean the UI has
 * settled: the flow runner waits out a fling before tapping, so a tap can't
 * land mid-deceleration (a scroll view would swallow it to halt the scroll) and
 * a resolved frame can't already be stale. Frames are rounded so sub-pixel
 * jitter does not read as motion.
 *
 * The optional `include` predicate restricts the fingerprint to a subset of
 * nodes (children of an excluded node are still walked) — the end-of-scroll
 * check fingerprints only the scrolled region, so an animating node elsewhere
 * can't keep the fingerprint changing and mask the end of the scroll.
 */
export function treeFingerprint(
  root: DescribeNode,
  include?: (node: DescribeNode) => boolean
): string {
  const parts: string[] = [];
  const round = (n: number): number => Math.round(n * 1000) / 1000;
  const walk = (node: DescribeNode): void => {
    if (!include || include(node)) {
      const f = node.frame;
      parts.push(
        `${node.role}|${round(f.x)},${round(f.y)},${round(f.width)},${round(f.height)}` +
          `|${node.label ?? ""}|${node.value ?? ""}|${node.identifier ?? ""}`
      );
    }
    for (const child of node.children) walk(child);
  };
  walk(root);
  return parts.join("\n");
}

export function frameContains(frame: DescribeFrame, x: number, y: number): boolean {
  return x >= frame.x && x <= frame.x + frame.width && y >= frame.y && y <= frame.y + frame.height;
}

export function frameArea(frame: DescribeFrame): number {
  return frame.width * frame.height;
}

/**
 * Reverse lookup for recording: the smallest visible node whose frame contains
 * the tapped point — the most specific element (a button over its container).
 * Skips the synthetic root.
 */
export function nodeAtPoint(
  root: DescribeNode,
  point: { x: number; y: number }
): DescribeNode | undefined {
  let best: DescribeNode | undefined;
  const walk = (node: DescribeNode): void => {
    if (isVisible(node) && frameContains(node.frame, point.x, point.y)) {
      if (best === undefined || frameArea(node.frame) < frameArea(best.frame)) best = node;
    }
    for (const child of node.children) walk(child);
  };
  for (const child of root.children) walk(child);
  return best;
}

// Does the regex consume the WHOLE non-empty string? The regex analog of an
// exact text match, for ranking: a full hit on a leaf must beat a container
// whose aggregated label merely contains the same text. The `(?:…)` wrapper is
// non-capturing, so backreference numbering is unchanged.
function fullConsumptionRegex(selector: Selector): RegExp | undefined {
  return selector.textMatches === undefined
    ? undefined
    : uiTreeMatchInternals.createRegExp(`^(?:${selector.textMatches})$`);
}

// How many of the selector's provided fields this node matches exactly rather
// than merely as a substring.
function exactFieldCount(
  node: DescribeNode,
  selector: Selector,
  fullTextRegex: RegExp | undefined
): number {
  let count = 0;
  if (
    selector.text !== undefined &&
    (equalsCI(node.label, selector.text) || equalsCI(node.value, selector.text))
  ) {
    count++;
  }
  if (
    fullTextRegex !== undefined &&
    (regexMatchesNonEmpty(fullTextRegex, node.label) ||
      regexMatchesNonEmpty(fullTextRegex, node.value))
  ) {
    count++;
  }
  if (selector.identifier !== undefined && equalsCI(node.identifier, selector.identifier)) count++;
  if (selector.role !== undefined && equalsCI(node.role, selector.role)) count++;
  return count;
}

/**
 * The on-screen frame of a selector's best visible match — what a `tap`/`type`
 * action targets. An accessible container (e.g. a Touchable on iOS) aggregates
 * its descendants' labels, so a substring text selector matches the container
 * as well as the leaf carrying the text, and the container's centre can sit
 * over a different child entirely. Matches are therefore ranked: exact field
 * matches beat substring hits, then the smallest frame (mirroring
 * {@link nodeAtPoint}), with reading order as the final tiebreak.
 *
 * The universal selector (flow YAML's `any: true`) is the case ranking cannot
 * serve: with no field to be exact about, "smallest" degenerates to whatever
 * hairline spacer the scope contains. A field-less selector names a REGION, so
 * its matches are read the way conditions read a match set — first in reading
 * order — keeping an action's target the element an `assert` would quote.
 *
 * {@link compareBelowPick} rather than {@link firstInReadingOrder}: both order
 * by (y, x), but a bare reading order leaves an exact positional tie to adapter
 * emission order, and two frames with different extents are two different tap
 * centres, so the tie continues into "most specific" instead.
 */
export function selectorToFrame(root: DescribeNode, selector: Selector): DescribeFrame | undefined {
  const visible = findAll(root, selector).filter(isVisible);
  if (visible.length === 0) return undefined;
  if (!hasOwnConstraint(selector)) {
    let first: DescribeNode | undefined;
    for (const n of visible) {
      if (first === undefined || compareBelowPick(n.frame, first.frame) < 0) first = n;
    }
    return first?.frame;
  }
  const fullTextRegex = fullConsumptionRegex(selector);
  let best: DescribeNode | undefined;
  let bestExact = -1;
  for (const n of visible) {
    const exact = exactFieldCount(n, selector, fullTextRegex);
    if (best === undefined || exact !== bestExact) {
      if (exact > bestExact) {
        best = n;
        bestExact = exact;
      }
      continue;
    }
    const areaDelta = frameArea(n.frame) - frameArea(best.frame);
    if (
      areaDelta < 0 ||
      (areaDelta === 0 &&
        (n.frame.y < best.frame.y || (n.frame.y === best.frame.y && n.frame.x < best.frame.x)))
    ) {
      best = n;
    }
  }
  return best?.frame;
}

const GENERIC_ROLES = new Set([
  "axgroup",
  "group",
  "view",
  "other",
  "axother",
  "none",
  "viewgroup",
  "android.view.view",
  "android.view.viewgroup",
  // Android layout scaffolding, taken from the parser's own list so the two
  // cannot drift (`viewgroup`/`view` above are the overlap that already did).
  // The flow tree emits such a node only for an id, a label, focus, or the
  // scrollable flag, so a tap on dead space over an id-less scrollable
  // FrameLayout must keep its coordinates rather than become
  // `{ role: "FrameLayout" }`, which replays at the scroller's centre.
  ...Array.from(LAYOUT_CONTAINER_ROLES, (role) => role.toLowerCase()),
  // The iOS counterpart: a cell is a list's scaffolding, not an element, and
  // every row on the screen shares the role. A tap on a row's dead space must
  // keep its coordinates rather than become `{ role: "AXCell" }`, which replays
  // at whichever cell the ranking elects - the first row, not the tapped one.
  "axcell",
]);

/**
 * The most stable selector identifying a node, used by the recorder to turn a
 * tapped element into a `tap: { selector }` step. Prefers identifier, then
 * text, then a non-generic role. Null when the node has nothing stable to match
 * on — the caller then keeps coordinates.
 */
export function deriveSelector(node: DescribeNode): Selector | null {
  if (node.identifier && node.identifier.trim()) return { identifier: node.identifier };
  // Label OR value individually — never nodeText's joined form: matchNode
  // compares a text selector against label and value separately, so a joined
  // "Volume 50%" would match nothing, not even the node it came from. Label
  // first: a value like "50%" is the volatile part of a control. Icon-font
  // labels are invisible in YAML (see hasVisibleText), so a node carrying only
  // those falls through to role/coordinates.
  const text = [node.label, node.value].map((t) => t?.trim()).find((t) => t && hasVisibleText(t));
  if (text) return { text };
  if (node.role && !GENERIC_ROLES.has(node.role.toLowerCase())) return { role: node.role };
  return null;
}

/**
 * Fetch the describe tree for a device. The chromium CDP session is the only
 * service resolved here — iOS / Android describe resolve their own internally,
 * and Vega reads the on-device automation toolkit's page source.
 */
export async function fetchTree(
  registry: Registry,
  device: DeviceInfo,
  opts: { bundleId?: string } = {}
): Promise<DescribeTreeData> {
  if (device.platform === "ios") {
    return describeIos(registry, device, { bundleId: opts.bundleId });
  }
  if (device.platform === "android") {
    return describeAndroid(registry, device.id);
  }
  if (device.platform === "chromium") {
    const ref = chromiumCdpRef(device);
    const api = await registry.resolveService<ChromiumCdpApi>(ref.urn, ref.options);
    return describeChromium(api);
  }
  if (device.platform === "vega") {
    return describeVega(device.id);
  }
  throw new Error(`ui-tree matching is not supported on platform "${device.platform}"`);
}
