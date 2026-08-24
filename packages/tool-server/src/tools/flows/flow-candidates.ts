/**
 * Candidate ranking for a flow step whose selector did not resolve.
 *
 * "no visible element matched selector text=\"Checkout\"" tells an operator
 * what failed and nothing about what to do next. The repair is almost always a
 * one-token edit — a typo'd testID, a label that gained a space, the row that
 * scrolled out of its container — and the evidence for it is sitting in the
 * tree the runner already read. This module turns that tree into a ranked
 * "did you mean" list with a paste-able selector per row.
 *
 * Two rules keep the ranking honest:
 *
 * 1. **Score against the passes resolution ACTUALLY attempted.** The strict
 *    alternatives come from {@link flowSelectorAlternatives}, the same
 *    expansion the runner resolves through, so a bare-string `tap: submitBtn`
 *    is scored as an identifier AND as a text intent — exactly the two things
 *    it was looked up as. A second interpretation of the selector here would
 *    drift from matching the moment either side changed.
 * 2. **Reuse the match engine's own predicates.** `identifierMatches`,
 *    `equalsCI`, `includesCI`, `isVisible` and `deriveSelector` are imported,
 *    never reimplemented: ranking that disagreed with matching would suggest an
 *    element the fixed selector then fails to find, which is worse than no
 *    suggestion at all.
 *
 * Everything here is pure over `(DescribeNode, FlowSelector)` — no device, no
 * I/O, no throwing. A failure report is assembled on the failure path, so a
 * ranking that threw would replace a real diagnosis with a crash.
 */

import type { DescribeFrame, DescribeNode } from "../describe/contract";
import {
  deriveSelector,
  equalsCI,
  findAll,
  identifierMatches,
  includesCI,
  isVisible,
  selectorToFrame,
  uiTreeMatchInternals,
  SELECTOR_RELATIONS,
  type Selector,
  type SelectorRelation,
} from "../../utils/ui-tree-match";
import { editDistance, selectorToYaml, type FlowSelector } from "./flow-utils";
import { flowMatchAll, flowSelectorAlternatives } from "./flow-actions";
import {
  FLOW_FAILURE_CANDIDATE_LIMIT,
  flattenForReport,
  projectNode,
  type FlowFailureCandidate,
  type FlowFailureCandidateBasis,
} from "./flow-failure";

// ── Tuning ─────────────────────────────────────────────────────────────────

/**
 * Below this a row is noise. Calibrated against the table in {@link scoreText}:
 * it admits a near-miss from ~0.6 similarity up, and (inclusively) the weakest
 * useful signal a zero-area element can carry — a `text-contained-by` hit
 * halved by the invisibility penalty lands exactly here, and "the element you
 * named is on screen but has no frame" is precisely the row worth printing.
 */
const SCORE_THRESHOLD = 0.35;

/** A near-miss below this similarity is a different string, not a typo. */
const NEAR_MISS_MIN_SIM = 0.6;

/**
 * Needles shorter than this are skipped for near-miss scoring entirely: at two
 * characters every short label on screen is one edit away ("Ok" vs "On"), so
 * the ranking would fill with coincidences — and it is also the cheapest way to
 * keep the O(n·m) table off the hot path for the selectors least able to
 * benefit from it.
 */
const NEAR_MISS_MIN_NEEDLE = 3;

/**
 * Both sides of every {@link editDistance} call are truncated to this many
 * characters. The table is O(n·m) and one side is device-supplied text —
 * `subtreeText` on a flattened container is the whole screen's text and can be
 * kilobytes, which at a few thousand nodes per tree is the difference between
 * a few milliseconds and a hung report. Anything that differs past 128
 * characters is not a typo anyway.
 */
const EDIT_DISTANCE_MAX_CHARS = 128;

// ── Scoring ────────────────────────────────────────────────────────────────

interface Scored {
  score: number;
  basis: FlowFailureCandidateBasis;
}

/** Keep the stronger of two optional scores; the incumbent wins ties. */
function better(a: Scored | undefined, b: Scored | undefined): Scored | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return b.score > a.score ? b : a;
}

/**
 * `1 - editDistance / longest`, case-insensitively, over inputs truncated to
 * {@link EDIT_DISTANCE_MAX_CHARS}. Sliced BEFORE lowercasing so the cost bound
 * holds on the raw input rather than on a case-folded copy of a kilobyte
 * string.
 */
function similarity(needle: string, actual: string): number {
  const a = needle.slice(0, EDIT_DISTANCE_MAX_CHARS).toLowerCase();
  const b = actual.slice(0, EDIT_DISTANCE_MAX_CHARS).toLowerCase();
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 0;
  return 1 - editDistance(a, b) / longest;
}

/**
 * The spellings an identifier can plausibly be a typo OF. Android reports
 * `com.example.app:id/submit` while flows are written against the unqualified
 * `submit` (see {@link identifierMatches}), so scoring the qualified form alone
 * would rate every Android id a total mismatch on package prefix length.
 */
function identifierForms(identifier: string): string[] {
  const at = identifier.lastIndexOf(":id/");
  return at === -1 ? [identifier] : [identifier, identifier.slice(at + ":id/".length)];
}

function scoreIdentifier(node: DescribeNode, needle: string): Scored | undefined {
  // The engine's own predicate, so an exact hit here means exactly what an
  // exact hit means at match time (including the unqualified-name rule).
  if (identifierMatches(node.identifier, needle)) return { score: 1, basis: "identifier-exact" };
  const actual = node.identifier;
  if (actual === undefined || actual === "" || needle.length < NEAR_MISS_MIN_NEEDLE) {
    return undefined;
  }
  let sim = 0;
  for (const form of identifierForms(actual)) sim = Math.max(sim, similarity(needle, form));
  if (sim < NEAR_MISS_MIN_SIM) return undefined;
  // Weighted well above the text band: identifiers are authored, not rendered,
  // so a near-miss on one is a typo in the flow file with near-certainty —
  // which is the single most repairable failure there is.
  return { score: 0.55 + 0.35 * sim, basis: "identifier-near" };
}

/**
 * One text field against the needle, strongest signal first:
 *
 * | test                   | score              | basis               |
 * |------------------------|--------------------|---------------------|
 * | equals                 | 0.95               | `text-exact`        |
 * | field contains needle  | 0.80               | `text-contains`     |
 * | needle contains field  | 0.70               | `text-contained-by` |
 * | near-miss, sim ≥ 0.6   | `0.40 + 0.35·sim`  | `text-near`         |
 *
 * Ordered rather than max-of-all deliberately: each rung is strictly more
 * specific than the one below it, and stopping at the first hit is what keeps
 * the edit-distance table off the common path.
 */
function scoreTextField(field: string | undefined, needle: string): Scored | undefined {
  if (field === undefined || field === "") return undefined;
  if (equalsCI(field, needle)) return { score: 0.95, basis: "text-exact" };
  if (includesCI(field, needle)) return { score: 0.8, basis: "text-contains" };
  if (includesCI(needle, field)) return { score: 0.7, basis: "text-contained-by" };
  if (needle.length < NEAR_MISS_MIN_NEEDLE) return undefined;
  const sim = similarity(needle, field);
  return sim < NEAR_MISS_MIN_SIM ? undefined : { score: 0.4 + 0.35 * sim, basis: "text-near" };
}

/**
 * The three text fields a node can carry, scored INDIVIDUALLY — never against
 * `nodeText`'s join, for the exact reason `deriveSelector` documents: a text
 * selector is compared to `label` and to `value` separately by `matchNode`, so
 * scoring the joined `"Volume 50%"` as an exact hit would recommend a selector
 * that matches nothing, not even the node it was read from.
 *
 * `subtreeText` earns a field of its own because the flow adapters hoist
 * descendant text onto containers (see `flow-tree-flatten`): on a flattened
 * tree the element an author means by "Volume 50%" really is one node, and it
 * carries that string in `subtreeText` alone.
 */
function scoreText(node: DescribeNode, needle: string): Scored | undefined {
  let best: Scored | undefined;
  best = better(best, scoreTextField(node.label, needle));
  best = better(best, scoreTextField(node.value, needle));
  best = better(best, scoreTextField(node.subtreeText, needle));
  return best;
}

/**
 * A regex locator is tested against `subtreeText` here even though
 * `matchNodeWithRegex` deliberately restricts itself to the node's own
 * label/value. The engine's exclusion protects RANKING BETWEEN MATCHES — every
 * unshielded ancestor of a text leaf would match and dilute exact-beats-
 * substring. Nothing matched here (that is why a report is being written), and
 * on a flattened tree the hoisted text is the only place the string lives, so
 * excluding it would hide the very element the pattern was written for.
 */
function scoreRegex(node: DescribeNode, regex: RegExp): Scored | undefined {
  for (const field of [node.label, node.value, node.subtreeText]) {
    if (field !== undefined && field !== "" && regex.test(field)) {
      return { score: 0.9, basis: "text-regex" };
    }
  }
  return undefined;
}

/**
 * One strict alternative, with its regex compiled ONCE for the whole tree walk
 * — `new RegExp` per node is the difference between a linear pass and a
 * per-node compile on trees that run to thousands of nodes.
 */
interface RankPass {
  identifier?: string;
  text?: string;
  regex?: RegExp;
  role?: string;
}

function toPass(alt: Selector): RankPass {
  const pass: RankPass = {};
  if (alt.identifier !== undefined) pass.identifier = alt.identifier;
  if (alt.text !== undefined) pass.text = alt.text;
  if (alt.role !== undefined) pass.role = alt.role;
  if (alt.textMatches !== undefined) {
    // Patterns are validated at flow-parse time, so this cannot throw on a
    // parsed flow's behalf — but a hand-built selector reaching the report path
    // must degrade to "no regex signal", never take the whole ranking down.
    try {
      pass.regex = uiTreeMatchInternals.createRegExp(alt.textMatches);
    } catch {
      /* no regex signal from an uncompilable pattern */
    }
  }
  return pass;
}

/** Identity of a pass's own fields — two passes with the same one score alike. */
function passKey(pass: RankPass): string {
  return JSON.stringify([
    pass.identifier ?? null,
    pass.text ?? null,
    pass.regex?.source ?? null,
    pass.role ?? null,
  ]);
}

function dedupePasses(passes: RankPass[]): RankPass[] {
  const seen = new Set<string>();
  const out: RankPass[] = [];
  for (const pass of passes) {
    const key = passKey(pass);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pass);
  }
  return out;
}

/**
 * The node's best score under ONE pass. `role` is folded in here rather than
 * at node level because it belongs to the alternative: `+0.10` when it agrees,
 * `−0.15` when it does not (a `role: AXButton` selector pointing at a static
 * text is a weaker suggestion than the same text on a button).
 *
 * A pass carrying several own fields is an AND at match time but a MAX here:
 * the question ranking answers is "which element did you mean", and the
 * strongest single signal answers it — an identifier typo does not become less
 * diagnostic because the same selector also named a role.
 *
 * `role` is never a BASIS, only a modifier. A role-only selector that failed
 * matched no node's role at all, so scoring bare role hits would surface only
 * the zero-area nodes that belong in `actual.invisibleMatches`.
 */
function scorePass(node: DescribeNode, pass: RankPass): Scored | undefined {
  let best: Scored | undefined;
  if (pass.identifier !== undefined) best = better(best, scoreIdentifier(node, pass.identifier));
  if (pass.text !== undefined) best = better(best, scoreText(node, pass.text));
  if (pass.regex !== undefined) best = better(best, scoreRegex(node, pass.regex));
  if (best === undefined) return undefined;
  if (pass.role === undefined) return best;
  const delta = includesCI(node.role, pass.role) ? 0.1 : -0.15;
  return { score: best.score + delta, basis: best.basis };
}

// ── Suggested selector ─────────────────────────────────────────────────────

/** A candidate's proposed selector, before it has been checked against the tree. */
interface Suggestion {
  /** `deriveSelector`'s choice, kept so {@link resolvesToNode} can re-run it. */
  derived: Selector;
  /** The same selector spelled in flow YAML, scrubbed and JSON-compacted. */
  yaml: string;
}

/**
 * The paste-able selector for a candidate row: `deriveSelector`'s stable
 * identifier/text/role choice, spelled in flow YAML by `selectorToYaml` and
 * emitted compactly. JSON is a subset of YAML, so `{"id":"submit"}` pastes
 * straight into a `tap:` step and re-parses to the selector it was derived
 * from; a bare string stays a bare string.
 *
 * Pure over the node — NO tree walk. That is what lets every ranked entry be
 * spelled (which the dedupe needs) while only the rows actually offered pay
 * for {@link resolvesToNode}; see the note on the dedupe loop in
 * {@link rankCandidates}.
 *
 * `selectorToYaml` THROWS on selectors flow YAML cannot represent. A candidate
 * without a suggestion is still a useful row (it names the element, its frame
 * and its flags), so an unrepresentable selector omits the field rather than
 * failing the ranking.
 */
function suggestSelector(
  node: DescribeNode,
  scrub: (text: string) => string
): Suggestion | undefined {
  const derived = deriveSelector(node);
  if (derived === null) return undefined;
  try {
    // Masked like every other projection of this node. `deriveSelector` returns
    // the node's own identifier/label/value — the exact strings `projectNode`
    // scrubs — so without this the same candidate row carried a masked label
    // beside a suggestion quoting the credential in full, straight into the
    // model's context.
    const yaml = selectorToYaml(derived);
    return {
      derived,
      yaml:
        typeof yaml === "string"
          ? JSON.stringify(scrub(yaml))
          : JSON.stringify(scrubStrings(yaml, scrub)),
    };
  } catch {
    return undefined;
  }
}

/**
 * Whether the suggested selector RESOLVES BACK to the node it was derived
 * from. Ranking scores one field at a time, but `deriveSelector` picks its own
 * — a container scored 1.00 on its hoisted `subtreeText` ("Total $42.00")
 * derives `{ text: "Total" }` from its label, and that selector resolves to the
 * small caption elsewhere on screen, not to the row that was ranked. An LLM
 * pastes the suggestion and taps the wrong element, which is worse than
 * offering no suggestion at all. A visible node must be what `selectorToFrame`
 * lands on (the exact path a `tap` takes); an invisible one, which no gesture
 * can reach anyway, only has to be among the matches so an `exists`/`visible`
 * assertion still gets a usable spelling.
 *
 * "Only has to be among the matches" is not "may name something else", though.
 * Asking nothing more let a hidden duplicate sharing its label with a visible
 * element elsewhere produce a row describing the GHOST's rectangle beside a
 * selector that resolves to the other one — the retargeting this function
 * exists to prevent, reached through the branch that was meant to be the
 * lenient one. So the invisible branch also refuses a selector that lands
 * somewhere else; it just does not REQUIRE a landing, since a zero-area node
 * has no frame to land on.
 *
 * This is the O(nodes) half of a suggestion, so it is paid ONLY for the rows
 * the caller is going to emit.
 */
function resolvesToNode(tree: DescribeNode, node: DescribeNode, derived: Selector): boolean {
  const resolved = selectorToFrame(tree, derived);
  if (isVisible(node)) {
    return resolved !== undefined && sameFrame(resolved, node.frame);
  }
  if (!findAll(tree, derived).includes(node)) return false;
  return resolved === undefined || sameFrame(resolved, node.frame);
}

/** Mask every string inside a serializable selector, values not serialized text. */
function scrubStrings(value: unknown, scrub: (text: string) => string): unknown {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map((item) => scrubStrings(item, scrub));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) out[key] = scrubStrings(inner, scrub);
    return out;
  }
  return value;
}

/** Frame equality at the 3dp precision the wire rounds to. */
function sameFrame(a: DescribeFrame, b: DescribeFrame): boolean {
  return (
    Math.abs(a.x - b.x) < 5e-4 &&
    Math.abs(a.y - b.y) < 5e-4 &&
    Math.abs(a.width - b.width) < 5e-4 &&
    Math.abs(a.height - b.height) < 5e-4
  );
}

/**
 * Dedupe key: the suggestion plus the frame at the 3dp `projectNode` rounds to,
 * so the key names exactly what the wire row will say. A flattened tree routinely
 * carries a container and its text leaf at the same frame with the same label —
 * two rows proposing the identical selector for the identical rectangle is noise
 * that costs an operator a second look and buys nothing.
 */
function dedupeKey(selectorYaml: string | undefined, frame: DescribeFrame): string {
  return [
    selectorYaml ?? "",
    frame.x.toFixed(3),
    frame.y.toFixed(3),
    frame.width.toFixed(3),
    frame.height.toFixed(3),
  ].join("|");
}

// ── Ranking ────────────────────────────────────────────────────────────────

/**
 * How far past `limit` the emit loop may verify. Four rows considered per row
 * offered is enough to see past a cluster of same-rectangle rows whose
 * suggestions do not resolve, while keeping the work a constant multiple of
 * the output rather than a function of the tree.
 */
const VERIFY_ALLOWANCE = 4;

interface Ranked {
  node: DescribeNode;
  score: number;
  basis: FlowFailureCandidateBasis;
  note?: string;
}

/**
 * Rank every element in `tree` as a possible intent behind `selector`.
 *
 * Scores each node against EVERY strict alternative the runner would have
 * resolved through and keeps the max, then applies the node-level modifiers —
 * invisibility halves (a zero-area element cannot be what you saw, but it is
 * very often what you meant), and on a gesture step a `clickable` element is
 * marginally likelier while a `disabled` one is likelier to be the wrong
 * suggestion even when its text is right.
 *
 * Relational scopes are deliberately IGNORED while scoring: when a `within`
 * scope is itself the mistake, ranking only inside it would filter out the
 * very element the operator meant. {@link diagnoseScope} reports the broken
 * scope separately.
 *
 * @returns `candidates` capped at `opts.limit` (default
 * {@link FLOW_FAILURE_CANDIDATE_LIMIT}), and `total` — every distinct
 * (proposal, rectangle) above the threshold, BEFORE the cap, so a report can
 * say "5 of 23".
 *
 * `total` counts PROPOSED suggestions, not verified ones: knowing which
 * resolve back costs an O(nodes) walk each, and paying that for every ranked
 * row is the cost this module is built to avoid. Two rows proposing different
 * selectors for one rectangle therefore count twice even when neither
 * suggestion survives verification — the emitted rows collapse (see the loop
 * below), the count does not.
 */
export function rankCandidates(
  tree: DescribeNode,
  selector: FlowSelector,
  opts: { gesture?: boolean; scrub?: (text: string) => string; limit?: number } = {}
): { candidates: FlowFailureCandidate[]; total: number } {
  // Dedupe the passes BEFORE the tree walk. `flowSelectorAlternatives` expands
  // to 2^(bare-string scopes) selectors that differ ONLY in their scopes, and
  // `toPass` drops scopes by design — so a six-scope selector produced 32
  // byte-identical passes and scored every node 32 times. That is not a
  // micro-optimization: the walk is synchronous, so it cannot be preempted by
  // the capture's Promise.race budget, and on a large tree it blocked for
  // seconds while the failing step waited to be reported.
  const passes = dedupePasses(flowSelectorAlternatives(selector).map(toPass));
  // The elements the selector DID match are not candidates: "which element did
  // you mean instead" has no answer that is the element you already named.
  // They are reported as `actual.invisibleMatches` instead, and suggesting the
  // selector that just failed would burn a slot on a no-op repair.
  //
  // Guarded for the same reason `diagnoseScope` guards its identical call, and
  // the module header promises the same thing of the whole file: an
  // uncompilable `textMatches` throws out of the match engine, and a throw here
  // degrades a perfectly readable screen to `screen: read-failed`. `parseFlow`
  // validates every pattern, so this is a contract the file states rather than
  // a crash anyone has seen — which is exactly why it must not depend on the
  // parser staying the only way in.
  const matched = new Set(safeMatchAll(tree, selector) ?? []);
  const ranked: Ranked[] = [];

  for (const node of flattenForReport(tree)) {
    if (matched.has(node)) continue;
    let best: Scored | undefined;
    for (const pass of passes) best = better(best, scorePass(node, pass));
    if (best === undefined) continue;

    let score = best.score;
    const notes: string[] = [];
    // Applied in the order the modifiers are documented: the invisibility
    // penalty is multiplicative and lands on the base signal, the gesture
    // adjustments are additive on top of it.
    if (!isVisible(node)) {
      score *= 0.5;
      notes.push("zero-area frame");
    }
    if (opts.gesture === true) {
      if (node.clickable === true) score += 0.05;
      if (node.disabled === true) {
        score -= 0.1;
        notes.push("disabled");
      }
    }
    if (typeof node.scrollHidden === "number" && node.scrollHidden > 0) {
      notes.push("scrolled out of its container — add a scroll-to step");
    }
    score = Math.min(1, Math.max(0, score));
    if (score < SCORE_THRESHOLD) continue;
    ranked.push({
      node,
      score,
      basis: best.basis,
      ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
    });
  }

  // Score, then SMALLER frame, then reading order — `selectorToFrame`'s own
  // tie-break. A suggestion an operator pastes back must resolve to the element
  // the row described, and that resolution ranks by area then (y, x); ordering
  // candidates any other way would put a container above the leaf a fixed
  // selector actually lands on.
  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      a.node.frame.width * a.node.frame.height - b.node.frame.width * b.node.frame.height ||
      a.node.frame.y - b.node.frame.y ||
      a.node.frame.x - b.node.frame.x
  );

  // Deduped BEFORE counting: `total` is the number of distinct suggestions, so
  // "5 of 23" cannot be inflated by a container/leaf pair proposing one thing
  // twice. Sorted first, so the row kept per key is the highest-ranked one.
  //
  // Only the CHEAP half of a suggestion runs here. Resolving every ranked
  // entry back through the tree was O(ranked × nodes) of synchronous work for
  // rows that were then thrown away by the `limit` slice below: an 11 000-node
  // screen whose selector ranked every node spent ~4s inside this loop, could
  // not be preempted by the capture's `Promise.race` budget, and so blew the
  // 5s ceiling — losing the whole failure block on exactly the screens that
  // need one most.
  const scrub = opts.scrub ?? ((t) => t);
  const seen = new Set<string>();
  const distinct: Array<Ranked & { suggestion?: Suggestion }> = [];
  for (const entry of ranked) {
    const suggestion = suggestSelector(entry.node, scrub);
    const key = dedupeKey(suggestion?.yaml, entry.node.frame);
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push({ ...entry, ...(suggestion !== undefined ? { suggestion } : {}) });
  }

  const limit = Math.max(0, opts.limit ?? FLOW_FAILURE_CANDIDATE_LIMIT);
  const candidates: FlowFailureCandidate[] = [];
  // Rectangles already spoken for by an emitted row that carries NO usable
  // suggestion. Such a row says only "this element, this rectangle", so a
  // second one for the same rectangle repeats it — the noise `dedupeKey`
  // exists to remove, which it cannot see until the suggestion has been
  // verified.
  const bareFrames = new Set<string>();
  let verifications = 0;
  for (const entry of distinct) {
    if (candidates.length >= limit) break;
    // The O(nodes) verification, paid per row CONSIDERED for the output rather
    // than per row ranked. The allowance runs well past `limit` so a run of
    // unresolvable same-frame rows cannot crowd out the resolvable row behind
    // them, and stays a constant multiple of it so the cost is independent of
    // the tree size — the whole point of splitting the suggestion in two.
    let offer: string | undefined;
    if (entry.suggestion !== undefined && verifications < limit * VERIFY_ALLOWANCE) {
      verifications++;
      if (resolvesToNode(tree, entry.node, entry.suggestion.derived)) offer = entry.suggestion.yaml;
    }
    if (offer === undefined) {
      const key = dedupeKey(undefined, entry.node.frame);
      if (bareFrames.has(key)) continue;
      bareFrames.add(key);
    }
    candidates.push({
      node: projectNode(entry.node, opts.scrub),
      score: entry.score,
      basis: entry.basis,
      ...(offer !== undefined ? { selectorYaml: offer } : {}),
      ...(entry.note !== undefined ? { note: entry.note } : {}),
    });
  }
  return { candidates, total: distinct.length };
}

/**
 * {@link flowMatchAll}, or `undefined` when it THREW — the one call in this
 * module that can (a selector carrying an uncompilable `textMatches`), and it
 * appears twice.
 *
 * Undefined rather than an empty array because the two callers need to tell
 * "matched nothing" from "could not be probed" differently: ranking treats
 * both as "nothing to exclude", while {@link diagnoseScope} must NOT report an
 * unprobeable scope as one that resolved to nothing.
 */
function safeMatchAll(tree: DescribeNode, selector: FlowSelector): DescribeNode[] | undefined {
  try {
    return flowMatchAll(tree, selector);
  } catch {
    return undefined;
  }
}

/**
 * The first relational scope on `selector` that resolved to NOTHING, if any.
 *
 * This is the signal that turns a confusing report into an actionable one: when
 * `within: { id: profile-card }` names a container that is not on screen, the
 * target was never looked for anywhere, and a message about the target sends
 * the operator editing the one part of the selector that was correct.
 *
 * Scopes are probed with {@link flowMatchAll} — the same loose-aware resolution
 * the runner used — in the order {@link SELECTOR_RELATIONS} declares, which is
 * the order the engine applies them. Nested scopes need no recursion here: a
 * scope whose own scope is missing resolves to nothing itself, so the
 * OUTERMOST unresolved relation is reported, which is where an operator starts
 * reading anyway.
 */
export function diagnoseScope(
  tree: DescribeNode,
  selector: FlowSelector
): SelectorRelation | undefined {
  for (const relation of SELECTOR_RELATIONS) {
    const scope = selector[relation];
    if (scope === undefined) continue;
    // A scope that cannot be PROBED is not a scope that resolved to nothing:
    // reporting it as unresolved would send the operator to fix a scope that
    // may well be correct. Undiagnosed is the honest outcome there.
    const scoped = safeMatchAll(tree, scope);
    if (scoped !== undefined && scoped.length === 0) return relation;
  }
  return undefined;
}
