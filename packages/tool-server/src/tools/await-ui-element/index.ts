import { z } from "zod";
import type {
  DeviceInfo,
  Registry,
  ServiceRef,
  ToolCapability,
  ToolContext,
  ToolDefinition,
} from "@argent/registry";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { resolveDevice } from "../../utils/device-info";
import { isTvOsSimulator } from "../../utils/ios-devices";
import { isAndroidTv } from "../../utils/adb";
import { assertSupported } from "../../utils/capability";
import { ensureDeps } from "../../utils/check-deps";
import { pollDescribeTree } from "../../utils/poll-describe-tree";
import type { DescribeNode, DescribeTreeData } from "../describe/contract";
import { describeIos, iosRequires } from "../describe/platforms/ios";
import { describeAndroid, androidRequires } from "../describe/platforms/android";
import { describeChromium } from "../describe/platforms/chromium";
import { describeVega, vegaRequires } from "../describe/platforms/vega";
import {
  selectorSchema,
  nodeText,
  findAll,
  isVisible,
  firstInReadingOrder,
  evaluateCondition,
  confusableTextNote,
  confusableTextNoteIn,
  selectorMissNote,
  quoteScreenText,
} from "../../utils/ui-tree-match";

// Tool id. Exported so run-sequence can both allow this tool and recognise its
// result shape (it returns { success: false } instead of throwing on an unmet
// condition) without hard-coding the string in two places.
export const AWAIT_UI_ELEMENT_TOOL_ID = "await-ui-element";

// True when `result` is an unmet `await-ui-element` outcome — it reports a
// timed-out condition by returning { success: false } rather than throwing.
// The orchestrating tools (`run-sequence`, `flow-execute`) use this to STOP a
// sequence at a wait that never held, instead of running the next step (often a
// tap) blind against a screen that never settled. Shared here so the result
// shape lives in one place. Result is `unknown` because it crosses the registry
// boundary untyped.
export function isUnmetUiWaitResult(tool: string, result: unknown): boolean {
  return (
    tool === AWAIT_UI_ELEMENT_TOOL_ID &&
    typeof result === "object" &&
    result !== null &&
    (result as { success?: unknown }).success === false
  );
}

// Marker on the note of a `hidden` wait that passed WITHOUT the selector ever
// matching. Kept as a constant rather than re-matched from the prose so the
// recorder's refusal (flow-add-step) cannot drift from the message below.
export const VACUOUS_HIDDEN_MARKER = "the selector never matched any element";

/** The marker test alone, with no opinion about which tool produced `result`. */
function resultIsVacuousHidden(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const r = result as { success?: unknown; note?: unknown };
  return r.success === true && typeof r.note === "string" && r.note.includes(VACUOUS_HIDDEN_MARKER);
}

/** A `success: true` wait, of any condition — proof its selector was present. */
function resultSucceeded(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { success?: unknown }).success === true
  );
}

// The id/text a selector pins, lowercased. Mirrors flow-selector-evidence's
// `selectorIdentityTerms`; inlined here to keep this module free of the flows
// dependency (flow-selector-evidence imports AWAIT_UI_ELEMENT_TOOL_ID from
// here, so importing back would form a cycle). `role` is deliberately not
// identity — "some button existed earlier" says nothing about THIS element.
function selectorIdentity(selector: unknown): string[] {
  if (typeof selector !== "object" || selector === null) return [];
  const s = selector as { identifier?: unknown; text?: unknown };
  const terms: string[] = [];
  if (typeof s.identifier === "string" && s.identifier !== "") {
    terms.push(`id:${s.identifier.toLowerCase()}`);
  }
  if (typeof s.text === "string" && s.text !== "") terms.push(`text:${s.text.toLowerCase()}`);
  return terms;
}

/**
 * Every selector this result proves NOTHING about — the selectors of the
 * `hidden` waits inside it that passed without ever matching.
 *
 * Covers the wait called directly AND the ones nested in a `run-sequence`,
 * because the gate is only worth having if it cannot be stepped around:
 * wrapping the identical wait in a one-step sequence used to buy a
 * permanently-green check that the recorder refuses to write directly and the
 * runner marks with ⚠. Nested selectors are read from the REQUEST args by
 * index — a run-sequence step result carries its tool and result but not the
 * arguments it was called with.
 *
 * Evidence established EARLIER IN THE SAME SEQUENCE counts: a nested `hidden`
 * whose selector an earlier successful non-hidden wait proved present is
 * falsifiable — the sequence itself is the proof of visible→gone. Without this
 * a self-contained `[visible X, act, hidden X]` sequence would be condemned for
 * proving nothing when it plainly proves X left.
 */
export function vacuousHiddenSelectors(tool: string, result: unknown, args: unknown): unknown[] {
  const argRecord =
    typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  if (tool === AWAIT_UI_ELEMENT_TOOL_ID) {
    return resultIsVacuousHidden(result) ? [argRecord.selector] : [];
  }
  if (tool !== "run-sequence") return [];
  const steps = (result as { steps?: unknown })?.steps;
  const requested = argRecord.steps;
  if (!Array.isArray(steps) || !Array.isArray(requested)) return [];
  const out: unknown[] = [];
  const establishedInSequence = new Set<string>();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] as { tool?: unknown; result?: unknown } | null;
    if (step?.tool !== AWAIT_UI_ELEMENT_TOOL_ID) continue;
    const nestedArgs = (requested[i] as { args?: unknown } | undefined)?.args;
    const nested =
      typeof nestedArgs === "object" && nestedArgs !== null
        ? (nestedArgs as Record<string, unknown>)
        : undefined;
    const selector = nested?.selector;
    if (resultIsVacuousHidden(step.result)) {
      if (!selectorIdentity(selector).some((term) => establishedInSequence.has(term))) {
        out.push(selector);
      }
      continue;
    }
    // A non-hidden wait that genuinely succeeded proved its selector present,
    // so it can license a later nested `hidden` on the same selector.
    if (nested?.condition !== "hidden" && resultSucceeded(step.result)) {
      for (const term of selectorIdentity(selector)) establishedInSequence.add(term);
    }
  }
  return out;
}

// The `success: false` notes that are NOT a verdict on the condition. Named
// here and reused where the notes are built, so a reader can tell them apart
// from a genuine miss without re-typing the prose.
const WAIT_CANCELLED_NOTE = "wait was cancelled before the condition was met";
const TREE_FETCH_FAILED_NOTE_PREFIX = "last tree fetch failed: ";
const HIDDEN_UNREADABLE_NOTE =
  "could not confirm the element is hidden — the UI tree was empty or unreadable at timeout";

/**
 * WHY an unmet wait came back `success: false`. {@link isUnmetUiWaitResult}
 * answers "did this wait fail", which is all `run-sequence` and `flow-run` need
 * — they stop the run on every cause alike. A caller that NARRATES the failure
 * needs more, because only one of the three judges the condition:
 *
 * - `unmet` — the tree was read and the condition was false there.
 * - `unreadable` — the tree source never answered, or answered blind, so
 *   nothing was observed. The condition may be perfectly satisfiable.
 * - `cancelled` — the caller gave up before the deadline. Also no verdict.
 */
export type UnmetUiWaitCause = "unmet" | "unreadable" | "cancelled";

/**
 * The cause this wait recorded, or the closest its `note` can be read for.
 *
 * The cause is carried on the RESULT ({@link WaitResult.cause}), decided where
 * the evidence is: the loop knows which of its reads were trustworthy, which
 * the prose cannot say. On `visible`/`exists`/`text` a wholly blind window
 * produces prose byte-identical to a genuine miss, so three of the four
 * conditions have no distinguishable note at all.
 *
 * The note fallback stays for a result that crossed a boundary without the
 * field (an older tool-server, a hand-built fixture). It defaults to `unmet`,
 * the cause every caller acted on before this classification existed.
 */
export function unmetUiWaitCause(result: unknown): UnmetUiWaitCause {
  const carried = (result as { cause?: unknown } | null)?.cause;
  if (carried === "unmet" || carried === "unreadable" || carried === "cancelled") return carried;
  const note = (result as { note?: unknown } | null)?.note;
  if (typeof note !== "string") return "unmet";
  if (note === WAIT_CANCELLED_NOTE) return "cancelled";
  if (note.startsWith(TREE_FETCH_FAILED_NOTE_PREFIX) || note.startsWith(HIDDEN_UNREADABLE_NOTE)) {
    return "unreadable";
  }
  return "unmet";
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_POLL_INTERVAL_MS = 400;

const zodSchema = z
  .object({
    udid: z
      .string()
      .min(1)
      .describe("Target device id from `list-devices` (iOS UDID, Android serial, or Chromium id)."),
    condition: z
      .enum(["exists", "visible", "hidden", "text"])
      .describe(
        "What to wait for. `exists`: selector is anywhere in the tree. " +
          "`visible`: selector is present with a non-zero on-screen frame. `hidden`: selector is absent " +
          "or zero-area. `text`: the first visible match in reading order (topmost), falling back to the first match overall if none is visible, " +
          "contains (or, with textMatch `equals`, exactly matches) " +
          "expectedText — if a loose selector hits several elements, only that one is checked, so narrow it to target the intended element."
      ),
    selector: selectorSchema.describe("Element to match (text / identifier / role)."),
    expectedText: z
      .string()
      .min(1)
      .optional()
      .describe(
        "For condition `text`: the string the first visible matched element (topmost in reading order; the first match overall if none is visible) must contain (default) or equal — see `textMatch`. Case-insensitive."
      ),
    textMatch: z
      .enum(["contains", "equals"])
      .optional()
      .describe(
        "For condition `text`: how expectedText is compared. Both fold the text first, so a non-breaking space matches a plain one and an LTR bidi wrapper around left-to-right text is ignored. `contains` (default) is a case-insensitive substring, in which a leading or trailing space is significant and constrains the match; `equals` is a case-insensitive full-string match, trimmed at both ends."
      ),
    bundleId: z
      .string()
      .optional()
      .describe(
        "Optional iOS app bundle id, passed to the describe fallback (see `describe`). Ignored on Android / Chromium."
      ),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(120_000)
      .optional()
      .describe(
        `Max time to wait for the condition before giving up (default ${DEFAULT_TIMEOUT_MS}).`
      ),
    pollIntervalMs: z
      .number()
      .int()
      .min(50)
      .max(5000)
      .optional()
      .describe(`How often to re-check the tree (default ${DEFAULT_POLL_INTERVAL_MS}).`),
  })
  .refine((p) => p.condition !== "text" || p.expectedText !== undefined, {
    message: "condition `text` requires expectedText",
    path: ["expectedText"],
  });

type Params = z.infer<typeof zodSchema>;

const conditionDescription = {
  exists: "appear",
  visible: "become visible",
  hidden: "become hidden",
  text: "match expected text",
} as const;

const conditionCompleted = {
  exists: "UI element appeared",
  visible: "UI element became visible",
  hidden: "UI element became hidden",
  text: "UI element matched expected text",
} as const;

interface WaitResult {
  success: boolean;
  elapsed: number;
  note?: string;
  /**
   * WHY an unmet wait failed, for the callers that narrate it. Set on every
   * `success: false` return and never on a success. See
   * {@link UnmetUiWaitCause} and {@link timeoutCause}.
   */
  cause?: UnmetUiWaitCause;
}

/**
 * How far behind the loop's exit the last TRUSTED read may lie before "the
 * condition was false" stops being honest, as a multiple of the poll interval.
 * The same tolerance as `CONDITION_DARK_TAIL_TOLERANCE_MS` in the flow runner's
 * copy of this loop: one interval of sleep since the last clean read, plus one
 * interval of latency for the deadline poll to come back dark too. Longer means
 * consecutive reads went dark, and a verdict from the reads before the darkness
 * describes a screen nobody saw at the deadline.
 */
const DARK_TAIL_TOLERANCE_INTERVALS = 2;

/**
 * The same tolerance in absolute time, past which no poll interval buys more.
 *
 * `pollIntervalMs` is the CALLER's, up to 5000ms, so the multiple above alone
 * would let the tolerance reach 10s: a source that answered once and then went
 * silent would still come back `unmet`, the one cause that licenses an author
 * to rewrite the step. Past a couple of seconds "the trusted reads still
 * describe the deadline" stops being credible however sparsely the caller
 * polls.
 *
 * Set above the default interval's own tolerance (2 × 400ms), so nothing at or
 * below a 1000ms interval is affected — the routine deadline straddle still
 * reads as the blip it is.
 */
const DARK_TAIL_TOLERANCE_MAX_MS = 2000;

/**
 * How the loop's LAST fetch attempt ended, which is not a two-way question.
 *
 * - `trusted` — it settled, returned a tree, and the tree could be judged on.
 * - `untrusted` — it settled, and what came back cannot be judged: the fetch
 *   threw, or the tree was blind.
 * - `unsettled` — it never came back. The newest data is then the read BEFORE
 *   it, whose age is the only evidence there is.
 */
type FinalRead = "trusted" | "untrusted" | "unsettled";

/**
 * WHY a wait that reached its deadline came back `success: false`.
 *
 * Only `unmet` judges the condition, so it must be earned: some read must have
 * been trustworthy, and the reads must still describe the screen at the
 * deadline. Three tiers, mirroring `waitForCondition`'s post-timeout verdict in
 * flow-actions.ts:
 *
 * 1. No trusted read in the whole window — nothing ever evaluated the
 *    condition.
 * 2. Trusted reads existed but the window went dark at the end. `hidden` is
 *    held to a stricter bar, since there the element LEAVING is the transition
 *    being waited on and an unjudgeable final read leaves gone-ness
 *    unconfirmable. For the rest, a dark tail beyond
 *    {@link DARK_TAIL_TOLERANCE_INTERVALS} or
 *    {@link DARK_TAIL_TOLERANCE_MAX_MS}, whichever is shorter.
 * 3. A dark tail inside the tolerance — a last-poll blip, which must not turn a
 *    real miss into "nothing was ever compared".
 *
 * An `unsettled` final attempt takes the dark-tail measure on EVERY condition,
 * `hidden` included: that attempt is no evidence either way, and the loop makes
 * one on almost every timeout (the poll sleep is clamped to the deadline, so
 * the next iteration straddles it). Holding `hidden` to the strict bar there
 * would make every ordinary `hidden` timeout `unreadable`.
 */
function timeoutCause(
  condition: Params["condition"],
  lastTrustedReadAt: number | undefined,
  finalRead: FinalRead,
  pollIntervalMs: number
): UnmetUiWaitCause {
  if (lastTrustedReadAt === undefined) return "unreadable";
  if (finalRead === "trusted") return "unmet";
  if (finalRead === "untrusted" && condition === "hidden") return "unreadable";
  const darkTailMs = Date.now() - lastTrustedReadAt;
  const tolerance = Math.min(
    DARK_TAIL_TOLERANCE_INTERVALS * pollIntervalMs,
    DARK_TAIL_TOLERANCE_MAX_MS
  );
  return darkTailMs > tolerance ? "unreadable" : "unmet";
}

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
  vega: { vvd: true },
};

// ── Tree matching ────────────────────────────────────────────────────────
// The matching engine (matchNode, findAll, isVisible, firstInReadingOrder, …)
// lives in utils/ui-tree-match so the flow directives and recorder reuse the
// exact selector semantics. `evaluateMatches` is kept as a params-shaped wrapper
// for this tool and its tests.

export function evaluateMatches(params: Params, matches: DescribeNode[]): boolean {
  return evaluateCondition(params.condition, params.expectedText, matches, params.textMatch);
}

// A degraded / blind read: the tree came back EMPTY and that emptiness is not
// trustworthy evidence the element is gone, so we must not let `hidden` (the only
// condition that resolves true on an empty tree) resolve positively off it. Two
// ways an empty tree is untrustworthy:
//   - the adapter flagged it as unreliable: iOS AX down, native injection
//     pending, or a native hierarchy that could not be read at all (nothing
//     connected to auto-target, the service down, the query failing) →
//     `describeIos` returns an empty tree plus a hint / should_restart instead
//     of throwing. Android / Chromium never set these flags.
//   - the selector matched on an EARLIER poll (`everMatched`) yet the whole tree
//     is now empty. A genuinely-hidden element leaves the rest of the screen
//     behind; a wholly empty tree after we'd already read content is a transient
//     blank frame mid-navigation, not the element being hidden. This is the only
//     guard that fires on Android / Chromium, where an empty tree is otherwise
//     taken at face value — without it an `everMatched` `hidden` wait would
//     falsely resolve on a one-frame blink and release a gated tap against a
//     screen that only briefly went blank.
function isBlindRead(data: DescribeTreeData, everMatched: boolean): boolean {
  if (data.tree.children.length > 0) return false;
  return Boolean(data.hint || data.should_restart || everMatched);
}

// Fold an unreliable-read hint / restart prompt onto a timeout note so the agent
// learns the real cause (degraded AX, native injection pending) rather than a
// bare "no element matched".
function appendDiagnostics(base: string, lastData: DescribeTreeData | null): string {
  if (!lastData) return base;
  const extras: string[] = [];
  if (lastData.should_restart) {
    extras.push(
      "the foreground app may need a restart for native inspection — call restart-app and retry"
    );
  }
  if (lastData.hint) extras.push(lastData.hint);
  return extras.length === 0 ? base : `${base} (${extras.join("; ")})`;
}

function timeoutNote(
  params: Params,
  lastTree: DescribeNode | null,
  fetchError: string | undefined,
  lastData: DescribeTreeData | null
): string {
  if (fetchError) return `${TREE_FETCH_FAILED_NOTE_PREFIX}${fetchError}`;
  const matches = lastTree ? findAll(lastTree, params.selector) : [];
  // Explains which element on screen nearly matched the selector. The text is
  // the field that missed, so drop it and keep the other constraints. A
  // `visible` wait must not get a zero-area node. `hidden` never reaches this
  // note, because a selector that matches nothing satisfies `hidden`.
  const missNote = (): string => {
    if (lastTree === null || params.selector.text === undefined) return "";
    const candidates = findAll(lastTree, { ...params.selector, text: undefined });
    const eligible = params.condition === "visible" ? candidates.filter(isVisible) : candidates;
    const note = selectorMissNote(eligible, params.selector.text);
    return note === undefined ? "" : ` — ${note}`;
  };
  let base: string;
  switch (params.condition) {
    case "text": {
      // Visible-first, mirroring evaluateCondition — the note must quote the
      // same element the check read, or the two can contradict each other.
      const first = firstInReadingOrder(matches.filter(isVisible)) ?? firstInReadingOrder(matches);
      const wanted = params.textMatch === "equals" ? "equal" : "contain";
      if (!first) {
        base = `no element matched the selector before timeout${missNote()}`;
        break;
      }
      // The two quoted strings can look the same on screen and still compare
      // unequal. The note names the codepoints that differ.
      const shown = nodeText(first);
      // Use the comparator of the wait: `equals` asks about the whole string,
      // `contains` about a substring.
      const confusable =
        params.expectedText === undefined
          ? undefined
          : params.textMatch === "equals"
            ? confusableTextNote(shown, params.expectedText)
            : confusableTextNoteIn(shown, params.expectedText);
      // Quote both strings. An unbalanced U+202E reverses every character
      // after it, and the expectation is authored text too. See quoteScreenText.
      base =
        `element matched but its text was "${quoteScreenText(shown)}" ` +
        `(wanted to ${wanted} "${quoteScreenText(params.expectedText ?? "")}")` +
        (confusable ? ` — ${confusable}` : "");
      break;
    }
    case "hidden":
      base = matches.some(isVisible)
        ? "an element matching the selector was still visible at timeout"
        : HIDDEN_UNREADABLE_NOTE;
      break;
    case "visible":
      base =
        matches.length > 0
          ? "element(s) matched but none was visible (zero-area frame) before timeout"
          : `no element matched the selector before timeout${missNote()}`;
      break;
    default:
      base = `no element matched the selector before timeout${missNote()}`;
  }
  return appendDiagnostics(base, lastData);
}

// ── Tool ─────────────────────────────────────────────────────────────────

// `await-ui-element` is a factory (like `describe`) because the iOS / Android
// tree fetch resolves the AX / android-devtools services through the registry
// rather than through the tool's own services() declaration. Only the Chromium
// CDP session flows in as a normal service.
export function createAwaitUiElementTool(registry: Registry): ToolDefinition<Params, WaitResult> {
  async function fetchTree(
    device: DeviceInfo,
    params: Params,
    services: Record<string, unknown>,
    isTvOs: boolean,
    androidIsTv: boolean
  ): Promise<DescribeTreeData> {
    if (device.platform === "ios") {
      return describeIos(registry, device, { bundleId: params.bundleId }, { isTvOs });
    }
    if (device.platform === "android") {
      return describeAndroid(registry, device.id, undefined, androidIsTv);
    }
    if (device.platform === "vega") {
      return describeVega(device.id);
    }
    return describeChromium(services.chromium as ChromiumCdpApi);
  }

  return {
    id: AWAIT_UI_ELEMENT_TOOL_ID,
    interaction: {
      startedMsg: ({ params }) =>
        `Waiting for UI element to ${conditionDescription[params.condition]}`,
      completedMsg: ({ params }) => conditionCompleted[params.condition],
      failedMsg: ({ failureSignal }) =>
        `Failed while waiting for UI element: ${failureSignal.error_code}`,
    },
    description: `Block until a UI element reaches an expected state or a timeout elapses, so you don't have to poll screenshot/describe yourself.

Conditions:
  exists   — the selector matches an element anywhere in the tree.
  visible  — the selector matches an element with a non-zero on-screen frame.
  hidden   — the selector matches nothing, or only a zero-area element (e.g. a spinner that disappeared).
  text     — the first VISIBLE match in reading order (topmost, then leftmost; falling back to the first match
             overall if none is visible) contains expectedText (case-insensitive substring), or exactly matches
             it when textMatch is \`equals\`. A loose selector can match several elements; only that one is
             inspected, so if a different match is the one holding the text the wait still reports failure —
             narrow the selector to target it.

The selector is { text?, identifier?, role? }; every provided field must match. text and role match as
case-insensitive substrings of the element's label/value and role; identifier matches exactly (case-insensitive),
also accepting the unqualified Android resource-id name ('submit' matches 'com.example.app:id/submit').
text and role are compared on FOLDED text, so a non-breaking space matches a plain one and an LTR bidi wrapper
around left-to-right text is ignored — but characters that change the rendering are not folded (bidi controls
that reorder, a soft hyphen, emoji ZWJ/variation selectors), and a leading or trailing space is significant.
identifier is never folded: it is a machine key, so spell it exactly. A field of only invisible characters
matches nothing rather than everything, and so does a whitespace-only identifier — but a whitespace-only role
is a real constraint, and matches any role that holds a space.
It polls the same accessibility / DOM tree as \`describe\`
(iOS AXRuntime, Android uiautomator, Chromium CDP, Vega automation toolkit) every pollIntervalMs
(default ${DEFAULT_POLL_INTERVAL_MS}ms) until timeoutMs (default ${DEFAULT_TIMEOUT_MS}ms).

Returns { success: boolean, elapsed: number, note?, cause? } — success=false means the wait ended without the
condition holding, which is not always a verdict on the condition: \`cause\` says which it was — \`unmet\` (the tree
was read and the condition was false there), \`unreadable\` (no trustworthy read, so nothing was judged) or
\`cancelled\` — and \`note\` describes what was seen. Only \`unmet\` licenses rewriting the check. Use this after a
tap/navigation to wait for the next screen, or before tapping an element that appears asynchronously.`,
    alwaysLoad: true,
    searchHint:
      "wait await poll until visible hidden exists text appears disappears timeout element condition settle",
    longRunning: true,
    zodSchema,
    capability,
    services: (params): Record<string, ServiceRef> => {
      const device = resolveDevice(params.udid);
      if (device.platform === "chromium") {
        return { chromium: chromiumCdpRef(device) };
      }
      return {};
    },
    async execute(services, params, ctx?: ToolContext) {
      const signal = ctx?.signal;

      const device = resolveDevice(params.udid);
      assertSupported(AWAIT_UI_ELEMENT_TOOL_ID, capability, device);
      if (device.platform === "ios") await ensureDeps(iosRequires);
      else if (device.platform === "android") await ensureDeps(androidRequires);
      else if (device.platform === "vega") await ensureDeps(vegaRequires);

      // Resolve once, outside the poll loop — re-probing `xcrun` per fetch would
      // blow the per-fetch budget for a fake UDID that never caches. Same for
      // the Android TV probe: a serial that isn't listed is never cached, so
      // leaving it inside `describeAndroid` would spawn `adb devices` per poll.
      const isTvOs = device.platform === "ios" && (await isTvOsSimulator(device.id));
      const androidIsTv = device.platform === "android" && (await isAndroidTv(device.id));

      // Start the wait clock after setup so its fixed cost isn't charged against
      // timeoutMs (the deadline should bound polling, not device resolution).
      const start = Date.now();
      const cancelled = (): WaitResult => ({
        success: false,
        elapsed: Date.now() - start,
        note: WAIT_CANCELLED_NOTE,
        cause: "cancelled",
      });

      const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const pollIntervalMs = params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
      const selector = params.selector;

      // For `hidden`: did the selector ever match across polls? Distinguishes
      // "the element was there and disappeared" from "the selector never matched
      // at all" — otherwise a typo'd selector is an instant false-positive.
      let everMatched = false;
      // When the last read that could EVALUATE the condition landed. Still
      // undefined at the deadline means no read ever did.
      let lastTrustedReadAt: number | undefined;

      const poll = await pollDescribeTree<WaitResult>({
        fetchTree: () => fetchTree(device, params, services, isTvOs, androidIsTv),
        timeoutMs,
        pollIntervalMs,
        signal,
        onSample: (data, nowMs) => {
          const matches = findAll(data.tree, selector);
          if (matches.length > 0) everMatched = true;
          // Compute `blind` after `everMatched` so an empty tree that follows an
          // earlier match counts as a transient blank, not a confirmed read.
          const blind = isBlindRead(data, everMatched);
          if (!blind) lastTrustedReadAt = nowMs;
          if (!blind && evaluateMatches(params, matches)) {
            const result: WaitResult = { success: true, elapsed: Date.now() - start };
            if (params.condition === "hidden" && !everMatched) {
              result.note =
                `condition met immediately — ${VACUOUS_HIDDEN_MARKER}, ` +
                "so it may have already been hidden before the wait, or the selector is wrong";
            }
            return { done: true, result };
          }
          return { done: false };
        },
      });

      if (poll.aborted) return cancelled();
      if (poll.result) return poll.result;

      // The final read attempt: trusted only if it settled and returned
      // something the condition could be judged on. `lastError` alone cannot
      // say — the loop leaves it unset for an attempt it abandoned at the
      // deadline, so its absence does not mean the last read landed.
      const finalRead: FinalRead = !poll.lastAttemptSettled
        ? "unsettled"
        : poll.lastError === undefined &&
            poll.lastData !== null &&
            !isBlindRead(poll.lastData, everMatched)
          ? "trusted"
          : "untrusted";
      return {
        success: false,
        elapsed: Date.now() - start,
        note: timeoutNote(params, poll.lastData?.tree ?? null, poll.lastError, poll.lastData),
        cause: timeoutCause(params.condition, lastTrustedReadAt, finalRead, pollIntervalMs),
      };
    },
  };
}
