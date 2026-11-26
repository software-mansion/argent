import { z } from "zod";
import {
  getDescribeTapPoint,
  type DescribeFrame,
  type DescribeNode,
} from "../tools/describe/contract";

/**
 * Shared tree matching: `await-ui-element`, the flow directives (`tap`, `type`,
 * `assert`) and the recorder's reverse lookup all resolve selectors through it.
 *
 * Reading order — what `after` and `next` mean by "follows", the match a
 * `text` condition reads first, the pick of an `any: true` selector — is the
 * user's, and so is every tree's frame space: an iOS simulator's trees are
 * turned into the UI's upright space before they get here, also on a landscape
 * UI (`utils/ios-ui-orientation.ts`).
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

// Case-insensitive, with every run of whitespace read as one space: a label
// joined with a no-break space ("Hubert\u00A0Gancarczyk") prints as a plain
// space in `describe`, and a selector typed from that print must still match.
function foldText(text: string): string {
  return text.replace(/\s+/g, " ").toLowerCase();
}

function includesCI(haystack: string | undefined, needle: string): boolean {
  return Boolean(haystack) && foldText(haystack!).includes(foldText(needle));
}

function equalsCI(actual: string | undefined, expected: string): boolean {
  return foldText(actual ?? "") === foldText(expected);
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
export function frameWithin(inner: DescribeFrame, outer: DescribeFrame): boolean {
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
//
// `matchFieldValues` is for a `type` step's `into` only (see
// {@link resolveSelector}).
export function findAll(
  root: DescribeNode,
  selector: Selector,
  matchFieldValues = false
): DescribeNode[] {
  const all: DescribeNode[] = [];
  const collect = (node: DescribeNode): void => {
    all.push(node);
    for (const child of node.children) collect(child);
  };
  for (const child of root.children) collect(child);
  return resolveSelector(all, selector, matchFieldValues);
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
 * `matches` less each leaf with a borrowed label (an Android row that took the
 * text of its title and summary) that holds another match with a label of its
 * own: the title, not the row around it, is what a `text` check reads and what
 * `next`/`after` count from. A `within` scope keeps the row, since a row as a
 * scope is the point of it, and a tap already takes the smaller exact match.
 */
function preferOwnLabels(matches: DescribeNode[]): DescribeNode[] {
  if (!matches.some((n) => n.borrowedLabel === true)) return matches;
  return matches.filter(
    (n) =>
      n.borrowedLabel !== true ||
      !matches.some((m) => m.borrowedLabel !== true && frameWithin(m.frame, n.frame))
  );
}

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
  after: (matches, scope) => matches.filter(afterTester(preferOwnLabels(scope))),
  next: (matches, scope) => nearestAfter(matches, preferOwnLabels(scope)),
};

/**
 * Own-field matches from `all`, narrowed by every scope the selector carries.
 *
 * A text field that matches only by the text it holds (`typedValue`) is no
 * match: after typing "Paris", `tap: { text: Paris }` means the result that
 * shows it, not the field. The field still matches by its id, label or role.
 * `matchFieldValues` keeps such a match for the selector itself, never for its
 * scopes: a `type` step's `into` names the field it types into.
 */
function resolveSelector(
  all: DescribeNode[],
  selector: Selector,
  matchFieldValues = false
): DescribeNode[] {
  const regex = selectorTextRegex(selector);
  let matches = all.filter(
    (n) =>
      matchNodeWithRegex(n, selector, regex) &&
      (matchFieldValues ||
        n.typedValue !== true ||
        matchNodeWithRegex({ ...n, value: undefined }, selector, regex))
  );
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

// The nodes of the frontmost `layer` among `nodes`: a match in a Mac app's open
// menu or sheet is the one in front of a same-named control of the window.
function frontmost(nodes: DescribeNode[]): DescribeNode[] {
  let top = 0;
  for (const n of nodes) top = Math.max(top, n.layer ?? 0);
  return top === 0 ? nodes : nodes.filter((n) => n.layer === top);
}

// The element a reader "sees first": in the frontmost layer, smallest (y, then
// x), matching the order format-tree renders flat iOS leaves in.
export function firstInReadingOrder(matches: DescribeNode[]): DescribeNode | undefined {
  let best: DescribeNode | undefined;
  let bestFrame: DescribeFrame | undefined;
  for (const n of frontmost(matches)) {
    const f = n.frame;
    if (
      bestFrame === undefined ||
      f.y < bestFrame.y ||
      (f.y === bestFrame.y && f.x < bestFrame.x)
    ) {
      best = n;
      bestFrame = f;
    }
  }
  return best;
}

const MAC_TEXT_FIELD_ROLES: ReadonlySet<string> = new Set([
  "AXTextField",
  "AXTextArea",
  "AXComboBox",
]);

// The text a `text` check reads off a Mac app's text field: only its value, ""
// when it is empty, also when its placeholder is its label. Undefined for any
// other element, and for a password field, whose text argent never reads.
export function macFieldText(node: DescribeNode, macos: boolean): string | undefined {
  return macos && MAC_TEXT_FIELD_ROLES.has(node.role) && !node.password
    ? (node.value ?? "")
    : undefined;
}

const MAC_TEXT_ROLES: ReadonlySet<string> = new Set(["AXStaticText", "AXHeading", "AXLink"]);

// The match a `text` check reads: the first visible one in reading order (the
// first overall if none is visible), not a row with a borrowed label around
// another match (see `preferOwnLabels`). On a Mac app, not a text area around a
// matching text: a web editor's value is the text of the paragraphs inside it,
// so a selector for a paragraph's text reads that paragraph.
export function textCheckTarget(
  candidates: DescribeNode[],
  macos: boolean
): DescribeNode | undefined {
  const matches = preferOwnLabels(candidates);
  const read = macos
    ? matches.filter(
        (n) =>
          n.role !== "AXTextArea" ||
          !matches.some(
            (m) => isVisible(m) && MAC_TEXT_ROLES.has(m.role) && frameWithin(m.frame, n.frame)
          )
      )
    : matches;
  return firstInReadingOrder(read.filter(isVisible)) ?? firstInReadingOrder(read);
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
  textMatch: TextMatchMode = "contains",
  textFieldsShowText = false
): boolean {
  switch (condition) {
    case "exists":
      return matches.length > 0;
    case "visible":
      return matches.some(isVisible);
    case "hidden":
      return !matches.some(isVisible);
    case "text": {
      const first = textCheckTarget(matches, textFieldsShowText);
      if (first === undefined || expectedText === undefined) return false;
      const field = macFieldText(first, textFieldsShowText);
      if (field !== undefined) {
        return textMatch === "matches"
          ? uiTreeMatchInternals.createRegExp(expectedText).test(field)
          : textMatches(field, expectedText, textMatch);
      }
      // An element with no text at all reads as "", so `matches: '^$'` or a
      // negative lookahead can check an empty field. Selector matching still
      // skips empty text, or `.*` would select every unlabeled view. Not a
      // password field: the iOS tree drops a typed secret, so a filled one
      // reads "" there, and argent never reads a Mac app's password text.
      if (
        textMatch === "matches" &&
        first.password !== true &&
        !assertText(first) &&
        !nodeText(first) &&
        uiTreeMatchInternals.createRegExp(expectedText).test("")
      ) {
        return true;
      }
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

function frameArea(frame: DescribeFrame): number {
  return frame.width * frame.height;
}

/**
 * Reverse lookup for recording: the smallest visible node of the frontmost
 * layer whose frame contains the tapped point: the most specific element (a
 * button over its container). Skips the synthetic root.
 *
 * The on-screen keyboard lies over the app, so a point where the keyboard
 * draws (see {@link keyboardDrawsAt}) is a tap on the keyboard, also where an
 * app element behind it (a list row's icon under a key) is smaller than the
 * key: only the keyboard's own elements take part there, not the tall
 * containers of its window. In a gap between them nothing is hit.
 */
export function nodeAtPoint(
  root: DescribeNode,
  point: { x: number; y: number }
): DescribeNode | undefined {
  const hits: DescribeNode[] = [];
  const walk = (node: DescribeNode): void => {
    if (isVisible(node) && frameContains(node.frame, point.x, point.y)) hits.push(node);
    for (const child of node.children) walk(child);
  };
  for (const child of root.children) walk(child);
  const drawn = drawnKeyboard(root);
  const onKeyboard = drawsAt(drawn, point);
  let best: DescribeNode | undefined;
  for (const node of hits) {
    if (onKeyboard && !drawn.includes(node)) continue;
    const layerDelta = (node.layer ?? 0) - (best?.layer ?? 0);
    if (
      best === undefined ||
      layerDelta > 0 ||
      (layerDelta === 0 && frameArea(node.frame) < frameArea(best.frame))
    ) {
      best = node;
    }
  }
  return best;
}

/**
 * The elements the on-screen keyboard draws: its visible ones, other than one
 * whose frame holds every other. The input method's window on Android has
 * containers as tall as the window (`android:id/parentPanel`), which pass a
 * tap above the keys to the app. With gesture navigation, the window also
 * draws its own navigation bar below these containers, so the containers are
 * found by the other elements only. The navigation bar stays in the keyboard.
 */
function drawnKeyboard(root: DescribeNode): DescribeNode[] {
  const keyboard: DescribeNode[] = [];
  const walk = (node: DescribeNode): void => {
    if (node.keyboard === true && isVisible(node)) keyboard.push(node);
    for (const child of node.children) walk(child);
  };
  for (const child of root.children) walk(child);
  const span =
    boundingFrame(keyboard.filter((n) => !isImeNavigationBar(n)).map((n) => n.frame)) ??
    boundingFrame(keyboard.map((n) => n.frame));
  return span === undefined ? [] : keyboard.filter((n) => !frameWithin(span, n.frame));
}

/** An element of the navigation bar that the input method's window draws on Android. */
function isImeNavigationBar(node: DescribeNode): boolean {
  return node.identifier?.startsWith("android:id/input_method_nav") === true;
}

/**
 * Whether the keyboard whose elements are `drawn` draws at `point`. The
 * keyboard is docked at the bottom of the UI, and below its top edge it covers
 * the screen also between its elements: the gaps between the keys and the free
 * strip of the bottom row have no element of their own, and do not pass a
 * touch to the app either. So a point counts when it lies in the smallest
 * frame holding the elements, below the top of one of them in its column. A
 * tip that pops up above the keys covers its own column, not the strip beside
 * it. Frames are in the UI's upright space (see the module comment), where the
 * keyboard's top is up.
 */
function drawsAt(drawn: readonly DescribeNode[], point: { x: number; y: number }): boolean {
  const frames = drawn.map((n) => n.frame);
  const area = boundingFrame(frames);
  if (area === undefined) return false;
  return (
    frameContains(area, point.x, point.y) &&
    frames.some((f) => f.x <= point.x && point.x <= f.x + f.width && f.y <= point.y)
  );
}

/** Whether the on-screen keyboard draws at `point` (see {@link drawsAt}). */
export function keyboardDrawsAt(root: DescribeNode, point: { x: number; y: number }): boolean {
  return drawsAt(drawnKeyboard(root), point);
}

/**
 * Whether the on-screen keyboard covers an app element where an action touches
 * it, the centre of its frame: a tap there presses a key, not the element. An
 * element of the keyboard is never covered.
 */
export function underKeyboard(root: DescribeNode, node: DescribeNode): boolean {
  return node.keyboard !== true && keyboardDrawsAt(root, getDescribeTapPoint(node.frame));
}

/** The smallest frame holding every given frame; undefined for none. */
function boundingFrame(frames: readonly DescribeFrame[]): DescribeFrame | undefined {
  if (frames.length === 0) return undefined;
  let x1 = 1;
  let y1 = 1;
  let x2 = 0;
  let y2 = 0;
  for (const f of frames) {
    x1 = Math.min(x1, f.x);
    y1 = Math.min(y1, f.y);
    x2 = Math.max(x2, f.x + f.width);
    y2 = Math.max(y2, f.y + f.height);
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
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

/** A visible match of a selector, as the target ranking compares it. */
interface TargetCandidate {
  node: DescribeNode;
  /** How many of the selector's fields it matches exactly (see {@link exactFieldCount}). */
  exact: number;
}

/**
 * One rule of the target ranking: negative when `a` ranks before `b`, positive
 * after, 0 when this rule ties them and the next one decides. `byFields` is
 * false for the universal selector (see {@link selectorToNode}).
 */
type TieBreak = (a: TargetCandidate, b: TargetCandidate, byFields: boolean) => number;

/**
 * The tie-breaks that pick an action's target among a selector's visible
 * matches, in order: each one decides only between matches every earlier one
 * left tied.
 */
const TARGET_TIE_BREAKS: readonly TieBreak[] = [
  // A Mac app's front layer: a match in an open menu, sheet or alert beats a
  // same-named control behind it.
  (a, b) => (b.node.layer ?? 0) - (a.node.layer ?? 0),
  // An app element before a key of the on-screen keyboard, also when the key
  // matches more exactly: the app's "Done" button, not the return key "done",
  // and a row "Google", not the return key "go". A test selects a key by its id.
  (a, b) => Number(a.node.keyboard === true) - Number(b.node.keyboard === true),
  // The most fields matched exactly, not as a substring: the leaf carrying the
  // text beats the container whose aggregated label contains it.
  (a, b) => b.exact - a.exact,
  // The smallest frame: a labelled container and the leaf inside it match the
  // same text, and the leaf is the one meant. Not for a field-less selector,
  // where it would degenerate to a hairline spacer.
  (a, b, byFields) => (byFields ? frameArea(a.node.frame) - frameArea(b.node.frame) : 0),
  // Reading order. For a field-less selector, an exact positional tie goes on
  // to the most specific frame (two different extents are two different tap
  // centres), not to adapter emission order.
  (a, b, byFields) =>
    byFields
      ? a.node.frame.y - b.node.frame.y || a.node.frame.x - b.node.frame.x
      : compareBelowPick(a.node.frame, b.node.frame),
];

function compareTargets(a: TargetCandidate, b: TargetCandidate, byFields: boolean): number {
  for (const tieBreak of TARGET_TIE_BREAKS) {
    const order = tieBreak(a, b, byFields);
    if (order !== 0) return order;
  }
  return 0;
}

/**
 * A selector's best visible match — what a `tap`/`type` action targets —
 * ranked by {@link TARGET_TIE_BREAKS}; matches every rule ties go to the first
 * in tree order. An accessible container (e.g. a Touchable on iOS) aggregates
 * its descendants' labels, so a substring text selector matches the container
 * as well as the leaf carrying the text, and the container's centre can sit
 * over a different child entirely: hence exact before smallest (mirroring
 * {@link nodeAtPoint}) before reading order.
 *
 * The universal selector (flow YAML's `any: true`) is the case the field rules
 * cannot serve: with no field to be exact about, "smallest" degenerates to
 * whatever hairline spacer the scope contains. A field-less selector names a
 * REGION, so its matches are read the way conditions read a match set — first
 * in reading order — keeping an action's target the element an `assert` would
 * quote. It still takes an app element before a key of the on-screen keyboard:
 * a region that reaches under the keyboard names the app's elements there.
 *
 * `matchFieldValues` is as in {@link findAll}.
 */
export function selectorToNode(
  root: DescribeNode,
  selector: Selector,
  matchFieldValues = false
): DescribeNode | undefined {
  const byFields = hasOwnConstraint(selector);
  const fullTextRegex = fullConsumptionRegex(selector);
  let best: TargetCandidate | undefined;
  for (const node of findAll(root, selector, matchFieldValues)) {
    if (!isVisible(node)) continue;
    const candidate = {
      node,
      exact: byFields ? exactFieldCount(node, selector, fullTextRegex) : 0,
    };
    if (best === undefined || compareTargets(candidate, best, byFields) < 0) best = candidate;
  }
  return best?.node;
}

/** The frame of {@link selectorToNode}'s match. `matchFieldValues` is as in {@link findAll}. */
export function selectorToFrame(
  root: DescribeNode,
  selector: Selector,
  matchFieldValues = false
): DescribeFrame | undefined {
  return selectorToNode(root, selector, matchFieldValues)?.frame;
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
]);

/**
 * The most stable selector identifying a node, used by the recorder to turn a
 * tapped element into a `tap: { selector }` step. Prefers identifier, then
 * text, then a non-generic role. Null when the node has nothing stable to match
 * on — the caller then keeps coordinates.
 */
export function deriveSelector(node: DescribeNode): Selector | null {
  return ownSelectors(node)[0] ?? null;
}

// The own fields the recorder tries for a node, most stable first: an id,
// then visible text (whitespace folded, so the YAML holds plain spaces), then
// that text with a non-generic role (a slider labelled like its row title),
// then the role alone. Label OR value individually — never
// nodeText's joined form: matchNode compares a text selector against label
// and value separately, so a joined "Volume 50%" would match nothing, not
// even the node it came from. Label first: a value like "50%" is the volatile
// part of a control. Icon-font labels are invisible in YAML (see
// hasVisibleText), so a node carrying only those falls through to role. A
// toggle's "0"/"1" is its state and flips with the tap, a password's value is
// the secret, and a selector does not match a text field by the text it holds
// (see resolveSelector), so none of these values names the node.
function ownSelectors(node: DescribeNode): Selector[] {
  const out: Selector[] = [];
  if (node.identifier && node.identifier.trim()) out.push({ identifier: node.identifier });
  const skipValue =
    node.password === true ||
    node.typedValue === true ||
    (node.checked !== undefined && (node.value === "0" || node.value === "1"));
  const text = [node.label, skipValue ? undefined : node.value]
    .map((t) => t?.replace(/\s+/g, " ").trim())
    .find((t) => t && hasVisibleText(t));
  if (text) out.push({ text });
  if (node.role && !GENERIC_ROLES.has(node.role.toLowerCase())) {
    if (text) out.push({ text, role: node.role });
    out.push({ role: node.role });
  }
  return out;
}

/**
 * Does `selector` replay on the tapped node? The ranking replay uses
 * ({@link selectorToNode}) must pick the node on this screen: an app element
 * with a key's text, behind the keyboard under the tapped key, would win that
 * tie at replay. And every other visible match must sit over `point`: the
 * matches are one nested stack around the tapped element (a labelled container
 * and the leaf inside it rendering the same text), not the same label on
 * another row, which a slightly different screen at replay could rank first.
 * A key elsewhere does not count against an app element: the node matches its
 * own field exactly, and replay takes an app element before any key.
 */
function resolvesAt(
  root: DescribeNode,
  selector: Selector,
  node: DescribeNode,
  point: { x: number; y: number }
): boolean {
  if (selectorToNode(root, selector) !== node) return false;
  return findAll(root, selector).every(
    (n) =>
      !isVisible(n) ||
      frameContains(n.frame, point.x, point.y) ||
      (n.keyboard === true && node.keyboard !== true)
  );
}

// Roles of an editable text field on any platform: iOS AXTextField /
// AXSearchField / AXTextArea, Android EditText / TextField, Chromium input,
// textarea, textbox and searchbox.
const EDITABLE_ROLE = /text.?field|text.?area|textbox|search.?(field|box)|edittext|^input$/i;

// How many preceding elements the recorder tries as `next` anchors.
const MAX_ANCHORS = 12;

/**
 * The selector the recorder writes for a tapped node: the first of
 * {@link ownSelectors} that {@link resolvesAt} the tapped point on its own;
 * else that own selector scoped `within` the smallest labelled or identified
 * container holding the node; else `next` the nearest preceding element with
 * an id or label that is itself unique on screen. Null when no form resolves
 * to the tapped element — the caller then keeps coordinates.
 *
 * `after` is never emitted: with a unique anchor it keeps every candidate that
 * follows it, a superset of what `next` keeps, so it cannot single out what
 * `next` could not.
 *
 * Scopes are geometric, exactly as replay resolves them, and each candidate is
 * checked through the replay engine, so a selector returned here is one the
 * runner resolves to the tapped element on this screen.
 */
export function deriveUniqueSelector(
  root: DescribeNode,
  node: DescribeNode,
  point: { x: number; y: number }
): Selector | null {
  const own = ownSelectors(node);
  if (own.length === 0) return null;
  const unique = (s: Selector): boolean => resolvesAt(root, s, node, point);
  for (const s of own) if (unique(s)) return s;

  const others: DescribeNode[] = [];
  const collect = (n: DescribeNode): void => {
    if (n !== node && isVisible(n) && ownSelectors(n).length > 0) others.push(n);
    for (const child of n.children) collect(child);
  };
  for (const child of root.children) collect(child);
  // An anchor or container is named by its id or text, never by role alone,
  // and never by an editable field's value: that is what was typed into it.
  // Other values stay: a Chromium text element carries its text only as value.
  const nameOf = (n: DescribeNode): Selector | undefined =>
    ownSelectors(EDITABLE_ROLE.test(n.role) ? { ...n, value: undefined } : n).find(
      (s) => s.role === undefined
    );

  // Containers, tightest first; a container with the node's own frame is the
  // node again, not a scope.
  const containers = others
    .filter((c) => frameWithin(node.frame, c.frame) && !sameFrame(node.frame, c.frame))
    .sort((a, b) => frameArea(a.frame) - frameArea(b.frame));
  for (const c of containers) {
    const within = nameOf(c);
    if (!within) continue;
    for (const s of own) {
      const scoped = { ...s, within };
      if (unique(scoped)) return scoped;
    }
  }

  // Anchors: elements the node follows in reading order, nearest first, whose
  // own name resolves to exactly one place on screen. Labelled elements come
  // before id-only containers: a reader finds the anchor in `describe`, which
  // prints the first and not the second.
  const nf = node.frame;
  const unlabelled = (n: DescribeNode): number => (ownSelectors(n).some((s) => s.text) ? 0 : 1);
  const anchors = others
    .filter((a) => followKind(nf, a.frame) !== "no")
    .map((a) => ({ a, d: distance(nf, a.frame), u: unlabelled(a) }))
    .sort((p, q) => p.u - q.u || p.d - q.d)
    .slice(0, MAX_ANCHORS)
    .map(({ a }) => a);
  for (const a of anchors) {
    const next = nameOf(a);
    if (!next || !uniqueOnScreen(root, next, a)) continue;
    for (const s of own) {
      const scoped = { ...s, next };
      if (unique(scoped)) return scoped;
    }
  }
  return null;
}

function sameFrame(a: DescribeFrame, b: DescribeFrame): boolean {
  return (
    Math.abs(a.x - b.x) <= WITHIN_EPS &&
    Math.abs(a.y - b.y) <= WITHIN_EPS &&
    Math.abs(a.width - b.width) <= WITHIN_EPS &&
    Math.abs(a.height - b.height) <= WITHIN_EPS
  );
}

// Reading-order distance between two frames: rows apart first, then columns.
function distance(a: DescribeFrame, b: DescribeFrame): number {
  const dy = Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height));
  const dx = Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width));
  return dy * 4 + dx;
}

// Does `selector` match `node` and nothing else visible on screen?
function uniqueOnScreen(root: DescribeNode, selector: Selector, node: DescribeNode): boolean {
  const visible = findAll(root, selector).filter(isVisible);
  return visible.length === 1 && visible[0] === node;
}
