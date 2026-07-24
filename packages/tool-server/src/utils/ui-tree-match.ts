import { z } from "zod";
import type { DeviceInfo, Registry } from "@argent/registry";
import type { DescribeFrame, DescribeNode, DescribeTreeData } from "../tools/describe/contract";
import { describeIos } from "../tools/describe/platforms/ios";
import { describeAndroid } from "../tools/describe/platforms/android";
import { describeChromium } from "../tools/describe/platforms/chromium";
import { describeVega } from "../tools/describe/platforms/vega";
import { chromiumCdpRef, type ChromiumCdpApi } from "../blueprints/chromium-cdp";

/**
 * Shared accessibility/DOM-tree matching, extracted from `await-ui-element` so
 * the flow directives (`tap`, `type`, `assert`) and the recorder's reverse
 * lookup consume the same selector semantics the wait engine uses.
 */

// A selector locates a node in the tree returned by `describe`. Every provided
// field must match (logical AND). `text` and `role` match as case-insensitive
// substrings so callers don't need the exact label; `identifier` matches
// exactly (or as the unqualified name of an Android resource-id) — see
// `identifierMatches`.
/**
 * Strict validation for the fields shared by every selector representation.
 * Kept separate from the non-empty selector refinement so flow-only selector
 * forms can replace `text` with another validated text constraint while still
 * reusing the canonical identifier/role validation.
 */
/**
 * True when `text` contains at least one visibly-rendered, font-independent
 * character. Icon fonts expose their glyphs as Private Use Area code points
 * (a tab-bar icon's label can be U+E163 — an icon, not text) and zero-width /
 * format characters render as nothing: a text constraint made only of those
 * displays as EMPTY in flow YAML, is meaningless outside the app's private
 * font, and at replay matches an element no reader of the flow can predict.
 * Strips Cf (format: zero-width space/joiners, BOM), Co (private use) and
 * Cc (controls), then whitespace; visible = anything left.
 */
export function hasVisibleText(text: string): boolean {
  return text.replace(/[\p{Cf}\p{Co}\p{Cc}]/gu, "").trim().length > 0;
}

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
   * YAML): a JS regular expression tested — unanchored and case-sensitive,
   * the same doctrine as the `text` condition's `matches` — against the
   * node's OWN label/value, deliberately not the hoisted `subtreeText`:
   * subtree matching would make every unshielded ancestor of a text leaf
   * match too, degrading the exact-beats-substring ranking actions rely on.
   * Aggregate checks stay the `text` condition's job (`{ in, matches }`).
   * A type-level extension, not a schema field, so the `await-ui-element`
   * tool surface doesn't grow (the same boundary `TextMatchMode.matches`
   * draws below).
   */
  textMatches?: string;
  /**
   * Flow-only container scope (`{ text: "Delete", within: { id: "card" } }` in
   * flow YAML): the node must additionally sit INSIDE a distinct element
   * matching this selector — its frame contained in the container's frame
   * (small tolerance for sub-pixel overhang). Deliberately geometric, not
   * tree-ancestry: every flow adapter flattens its platform tree into leaves
   * under one synthetic root (see `flow-tree-flatten`), so ancestry does not
   * survive to replay — and visual containment is what "the button inside the
   * card" means to a flow author anyway (the same frame-based reading of
   * "within" the scroll-to directive's container anchor uses). Scopes chain
   * outward (`a within b within c` reads "a inside b inside c", each
   * container's frame inside the next). Resolved by {@link findAll}, which
   * sees the whole tree; {@link matchNode} is a single-node predicate and
   * evaluates own fields only. A type-level extension, not a schema field,
   * for the same reason as `textMatches`.
   */
  within?: Selector;
};

export type WaitCondition = "exists" | "visible" | "hidden" | "text";

// How a `text` condition compares the located element's text to the expected
// string: `contains` (default) is a case-insensitive substring; `equals` is a
// case-insensitive full-string match (so "1" no longer satisfies "10"). Both
// are offered so a caller can assert "shows this somewhere" or "shows exactly
// this" interchangeably. `matches` treats the expected string as a JS regular
// expression tested unanchored against the text (the `contains` analog —
// anchor with ^…$ for the `equals` analog) for dynamic content that neither
// literal mode can pin (counters, prices, dates). Unlike the literal modes it
// is CASE-SENSITIVE — a regex carries its semantics in the pattern, and
// forcing `i` would betray `\d{2}`-style precision. Flow directives only; the
// await-ui-element tool's schema deliberately stays contains/equals.
export type TextMatchMode = "contains" | "equals" | "matches";

// ── Tree matching ──────────────────────────────────────────────────────────

export function nodeText(node: DescribeNode): string {
  return [node.label, node.value].filter(Boolean).join(" ");
}

// Text used to evaluate a `text` condition (and quoted in its failure
// messages). Prefers `subtreeText` — the text hoisted from descendants by the
// flow adapters — so a `text` check against a testID container reads the text
// it visibly wraps (e.g. a counter whose number is a child node), not the
// container's own (empty) label. Falls back to the node's own text when no
// descendant text was hoisted (every non-flow tree, and any leaf that already
// carries its own text). `evaluateCondition` additionally accepts a match on
// the node's own text — hoisting is additive, see the comment there. Selector
// matching stays on `nodeText` so `tap`/`{ text }` targeting is unaffected.
export function assertText(node: DescribeNode): string {
  return node.subtreeText ?? nodeText(node);
}

export function includesCI(haystack: string | undefined, needle: string): boolean {
  return Boolean(haystack) && haystack!.toLowerCase().includes(needle.toLowerCase());
}

export function equalsCI(actual: string | undefined, expected: string): boolean {
  return (actual ?? "").toLowerCase() === expected.toLowerCase();
}

/**
 * Identifier matching: case-insensitive EXACT match, or the unqualified name of
 * an Android resource-id — `submit` matches `com.example.app:id/submit` — so a
 * caller never needs the package prefix. Deliberately NOT a substring test: an
 * identifier names one element, and substring matching lets a short needle
 * capture an unrelated id (`save` must not match `autosave-banner`), which is
 * how a loose flow selector's identifier-first pass could hijack a tap.
 */
export function identifierMatches(actual: string | undefined, needle: string): boolean {
  if (!actual) return false;
  return equalsCI(actual, needle) || actual.toLowerCase().endsWith(`:id/${needle.toLowerCase()}`);
}

/** @internal A narrow seam for verifying regex compilation lifetime in tests. */
export const uiTreeMatchInternals = {
  createRegExp(pattern: string): RegExp {
    return new RegExp(pattern);
  },
};

// Empty/absent text is not a regex haystack, matching includesCI's semantics.
// Keeping that rule here prevents selector, assertion, and ranking paths from
// drifting apart when they reuse a compiled expression.
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
  // The pattern was validated at flow parse time, so construction here cannot
  // throw on a flow's behalf.
  if (mode === "matches") {
    return regexMatchesNonEmpty(uiTreeMatchInternals.createRegExp(expected), actual);
  }
  return mode === "equals" ? equalsCI(actual, expected) : includesCI(actual, expected);
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
 * Single-node predicate over the selector's OWN fields (text/regex/identifier/
 * role). Ancestor scoping (`within`) needs the tree and is resolved by
 * {@link findAll}; a `within` on the selector is ignored here by design.
 */
export function matchNode(node: DescribeNode, selector: Selector): boolean {
  return matchNodeWithRegex(node, selector, selectorTextRegex(selector));
}

// `within` containment tolerance (normalized units): a hair of overhang — a
// border, a shadow, sub-pixel rounding — must not disqualify an element that
// visually sits in its container. Matches the magnitude of the flow runner's
// edge tolerance (EDGE_EPS in flow-actions).
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

// Resolving a `within` scope asks "does this candidate sit inside SOME distinct
// container?" for every candidate against every container. The naive form scans
// the whole container set per candidate — O(candidates × containers) — which a
// broad container selector (`within: { role: <common role> }`, a form the
// nested slot explicitly allows) drives quadratic on the flattened flow tree
// (bounded per platform — 12k nodes on Android/Chromium, depth-capped on iOS),
// and findAll re-runs on every settle/poll. Above a small container count, index
// the containers in a coarse uniform grid so a candidate only tests the
// containers registered in its own top-left cell. The realistic container shapes
// — scattered role matches, a list of stacked rows, a grid of cards — each land
// only a handful of containers per cell, dropping the scan to near-linear. Only
// a `within` selector ever builds this; an unscoped findAll never reaches it.
// (The one input the grid can't prune is many mutually-overlapping containers
// crammed into one cell — it degrades gracefully back to the naive scan there,
// never worse, since the exact check still short-circuits on the first hit.)
const CONTAINMENT_GRID_N = 16; // cells per axis over the normalized [0,1]² frame
const CONTAINMENT_GRID_MIN = 32; // fewer containers than this: a direct scan wins

// The grid column/row a normalized coordinate falls in, clamped to [0, N): a
// frame can sit a hair off-screen (negative, or ≥ 1), and every such point must
// still map to a real cell.
function gridCell(coord: number): number {
  const c = Math.floor(coord * CONTAINMENT_GRID_N);
  return c < 0 ? 0 : c >= CONTAINMENT_GRID_N ? CONTAINMENT_GRID_N - 1 : c;
}

/**
 * Build a predicate `inside(node)` — true when the node's frame sits inside a
 * DISTINCT container in `containers` (the {@link frameWithin} containment a
 * `within` scope needs). Below {@link CONTAINMENT_GRID_MIN} it scans directly;
 * larger sets are indexed in a coarse grid keyed by top-left cell.
 *
 * A container is registered in every cell its frame covers, PADDED by
 * {@link WITHIN_EPS}: a candidate may overhang a container edge by up to the
 * tolerance, so its top-left corner can land one cell before the container's
 * unpadded coverage — the pad guarantees the corner still hits a registered
 * cell. The grid therefore only PRUNES; the exact `frameWithin` check on the
 * bucket decides, so the padding never admits a false containment.
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

// Every node matching the selector in the tree, EXCLUDING `root` itself — the
// synthetic full-screen container describe puts at the head of the tree. See the
// long-form rationale in await-ui-element: matching the root would let a broad
// role selector satisfy `visible`/`exists` on any screen. The exclusion covers
// `within` containers too: the synthetic root wraps every screen, so letting it
// satisfy a scope would make `within` vacuous for broad container selectors.
//
// A `within` scope is resolved GEOMETRICALLY — the candidate's frame contained
// in a matching container's frame — never by tree ancestry: the flow adapters
// flatten every platform tree into leaves under one synthetic root (see
// `flow-tree-flatten`), so parent/child structure does not survive to replay,
// while frames do. The container must be a DISTINCT node (an element never
// scopes itself, so `a within a` needs two nested elements), and a chain
// resolves outermost-first: each level keeps only the containers that
// themselves sit inside a distinct container of the level above.
export function findAll(root: DescribeNode, selector: Selector): DescribeNode[] {
  const all: DescribeNode[] = [];
  const collect = (node: DescribeNode): void => {
    all.push(node);
    for (const child of node.children) collect(child);
  };
  for (const child of root.children) collect(child);

  const matchesOf = (sel: Selector): DescribeNode[] => {
    const regex = selectorTextRegex(sel);
    return all.filter((n) => matchNodeWithRegex(n, sel, regex));
  };

  // Flatten the `within` chain, outermost scope first: for
  // `{ text: "a", within: { id: "b", within: { text: "c" } } }` — "a inside b
  // inside c" — c's containers are resolved first, then b's are filtered to
  // the ones sitting inside them.
  const chain: Selector[] = [];
  for (let s = selector.within; s !== undefined; s = s.within) chain.unshift(s);
  let containers: DescribeNode[] | undefined;
  for (const level of chain) {
    const levelMatches = matchesOf(level);
    const outer = containers;
    if (outer === undefined) {
      containers = levelMatches;
    } else {
      const inside = containmentTester(outer);
      containers = levelMatches.filter(inside);
    }
  }

  const own = matchesOf(selector);
  if (containers === undefined) return own;
  const inside = containmentTester(containers);
  return own.filter(inside);
}

// describe prunes off-screen / zero-size nodes, so a non-zero frame area is a
// cheap, reliable proxy for "visible".
export function isVisible(node: DescribeNode): boolean {
  return node.frame.width > 0 && node.frame.height > 0;
}

// The element a reader "sees first": smallest (y, then x), matching how
// format-tree renders iOS leaves in reading order. Returns undefined for [].
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

// Evaluate a wait/assert condition over ALL elements matching a selector.
// `visible` holds if ANY match is on-screen; `hidden` only if NONE is; `text`
// inspects the first VISIBLE match in reading order (falling back to the first
// overall if none is visible) — so a stale zero-area node can't shadow the
// element the check was meant to read, and the check agrees with the failure
// messages (flow assertReason, await-ui-element's timeout note), which quote
// the same visible-first node.
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
      // Hoisted subtree text is ADDITIVE evidence, never a replacement: a
      // check the element's own label/value satisfies on a plain describe
      // tree (`equals: "Save"` on a container labelled "Save" that wraps a
      // "Saved successfully" child) must not start failing because the flow
      // adapters stamped a compound `subtreeText` ("Save Saved successfully")
      // onto the node — so the expected text may match either.
      return (
        textMatches(assertText(first), expectedText, textMatch) ||
        textMatches(nodeText(first), expectedText, textMatch)
      );
    }
    default:
      return false;
  }
}

// ── Settle detection ────────────────────────────────────────────────────────

/**
 * A stable fingerprint of the tree's visible structure — every node's role,
 * rounded frame, and text/identifier. Two consecutive identical fingerprints
 * mean the UI has settled (a scroll's momentum has stopped, an animation has
 * finished): the flow runner uses this to wait out a fling before reading or
 * tapping, so a tap can't land mid-deceleration (where a scroll view would
 * swallow it to halt the scroll) and a resolved frame can't be stale by the time
 * we act on it. Frames are rounded to 1e-3 so sub-pixel jitter does not read as
 * motion.
 *
 * The optional `include` predicate restricts the fingerprint to a subset of
 * nodes (children of an excluded node are still walked) — e.g. the flow
 * runner's end-of-scroll check fingerprints only the scrolled region (the
 * `within` container, or the scroll containers under the gesture anchor) so an
 * animating node outside that region can't keep the fingerprint changing and
 * mask the end of the scroll.
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

// ── Reverse lookup & selector → frame ──────────────────────────────────────

export function frameContains(frame: DescribeFrame, x: number, y: number): boolean {
  return x >= frame.x && x <= frame.x + frame.width && y >= frame.y && y <= frame.y + frame.height;
}

function frameArea(frame: DescribeFrame): number {
  return frame.width * frame.height;
}

/**
 * Reverse lookup for recording: the smallest visible node whose frame contains
 * the tapped point. "Smallest" picks the most specific element (a button over
 * its container). Skips the synthetic root. Returns undefined if nothing
 * sensible is under the point.
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

// Does the regex consume the WHOLE non-empty string? The regex analog of an exact
// text match, for ranking: `^Order #\d+$`-style full hits on a leaf must beat
// a container whose aggregated label merely contains the same text. Wrapping
// in `^(?:…)$` is safe for any valid pattern (non-capturing, so backreference
// numbering is unchanged; inner `^`/`$` stay valid).
function fullConsumptionRegex(selector: Selector): RegExp | undefined {
  return selector.textMatches === undefined
    ? undefined
    : uiTreeMatchInternals.createRegExp(`^(?:${selector.textMatches})$`);
}

// How many of the selector's provided fields this node matches exactly
// (case-insensitive equality; full-string consumption for a regex) rather
// than merely as a substring / partial hit.
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
 * Resolve a selector to the on-screen frame of its best visible match — the
 * element a `tap`/`type` action should target. An accessible container (e.g. a
 * Touchable on iOS) aggregates its descendants' labels, so a substring text
 * selector matches the container as well as the leaf that actually carries the
 * text — and the container's centre can sit over a different nested child
 * entirely. Matches are therefore ranked: exact field matches beat substring
 * hits, then the smallest frame wins (the most specific element, mirroring
 * nodeAtPoint's reverse lookup), with reading order as the final tiebreak.
 * Returns undefined when no visible element matches.
 */
export function selectorToFrame(root: DescribeNode, selector: Selector): DescribeFrame | undefined {
  const visible = findAll(root, selector).filter(isVisible);
  if (visible.length === 0) return undefined;
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

/**
 * Derive the most stable selector that identifies a node, used by the recorder
 * to turn a tapped element into a `tap: { selector }` step. Prefers identifier,
 * then text; falls back to a specific (non-generic) role. Returns null when the
 * node has nothing stable to match on — the caller then keeps coordinates.
 */
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

export function deriveSelector(node: DescribeNode): Selector | null {
  if (node.identifier && node.identifier.trim()) return { identifier: node.identifier };
  // Derive text from label OR value individually — never nodeText's joined
  // form: matchNode compares a text selector against label and value
  // separately, so a joined "Volume 50%" would match nothing, not even the
  // node it was derived from. Label first — a value like "50%" is the
  // volatile part of a control, the label is the stabler replay anchor.
  // Only visibly-rendered text counts as stable: icon-font labels are Private
  // Use Area glyphs that serialize to invisible YAML (see hasVisibleText), so
  // a node carrying only those falls through to role/coordinates.
  const text = [node.label, node.value].map((t) => t?.trim()).find((t) => t && hasVisibleText(t));
  if (text) return { text };
  if (node.role && !GENERIC_ROLES.has(node.role.toLowerCase())) return { role: node.role };
  return null;
}

// ── Tree fetch ─────────────────────────────────────────────────────────────

/**
 * Fetch the describe tree for a device, resolving services through the registry
 * (the chromium CDP session is the only one that flows in as a service). iOS /
 * Android describe resolve their own services internally; Vega reads the
 * on-device automation toolkit's page source (`describeVega`).
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
