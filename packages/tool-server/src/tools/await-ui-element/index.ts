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
import {
  MIN_POLL_INTERVAL_MS,
  pollDescribeTree,
  TREE_FETCH_FAILED_NOTE_PREFIX,
} from "../../utils/poll-describe-tree";
import type { DescribeNode, DescribeTreeData } from "../describe/contract";
import { isBlindRead } from "../describe/blind-read";
import { describeIos, iosRequires } from "../describe/platforms/ios";
import { describeIosDevice } from "../describe/platforms/ios-device";
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
} from "../../utils/ui-tree-match";

// Exported so run-sequence can allowlist this tool without repeating the string.
export const AWAIT_UI_ELEMENT_TOOL_ID = "await-ui-element";

// True when `result` is a timed-out `await-ui-element`: an unmet condition is
// reported as { success: false } rather than thrown. `run-sequence` and
// `flow-execute` use this to stop a sequence instead of running the next step
// against a screen that never settled. `unknown` because the result crosses the
// registry boundary untyped.
export function isUnmetUiWaitResult(tool: string, result: unknown): boolean {
  return (
    tool === AWAIT_UI_ELEMENT_TOOL_ID &&
    typeof result === "object" &&
    result !== null &&
    (result as { success?: unknown }).success === false
  );
}

// The `success: false` notes that are NOT a verdict on the condition. Named
// here, and used below where the notes are built.
const WAIT_CANCELLED_NOTE = "wait was cancelled before the condition was met";
const HIDDEN_UNREADABLE_NOTE =
  "could not confirm the element is hidden — the UI tree was empty or unreadable at timeout";

/**
 * WHY an unmet wait came back `success: false`. {@link isUnmetUiWaitResult}
 * answers "did this wait fail", which is all `run-sequence` and `flow-run`
 * need. A caller that NARRATES the failure needs more, because only one cause
 * judges the condition:
 *
 * - `unmet` — the tree was read and the condition was false there.
 * - `unreadable` — no read that speaks for the screen at the deadline. The
 *   source never answered, or it went dark at the end, or the last good read
 *   lies further behind the deadline than a poll excuses (a wide `pollIntervalMs`
 *   does that on a source that never failed, when its last read still lands more
 *   than ~2s before the deadline). Anything judged was judged too early to stand
 *   for the deadline.
 * - `cancelled` — the caller gave up before the deadline. Also no verdict.
 */
export type UnmetUiWaitCause = "unmet" | "unreadable" | "cancelled";

/**
 * The cause this wait recorded, or the closest its `note` can be read for.
 *
 * The loop decides the cause and carries it on the result, because only the
 * loop knows which reads were trustworthy. The note cannot say: a wholly blind
 * window produces prose identical to a genuine miss on three of the four
 * conditions.
 *
 * The note fallback is for a result that crossed a boundary without the field —
 * an older tool-server, or a hand-built fixture.
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
        "For condition `text`: how expectedText is compared. `contains` (default) is a case-insensitive substring; `equals` is a case-insensitive full-string match."
      ),
    bundleId: z
      .string()
      .optional()
      .describe(
        "Optional iOS app bundle id, passed to the describe fallback (see `describe`). Ignored on Android / Chromium, " +
          "and on physical iOS."
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
      .min(MIN_POLL_INTERVAL_MS)
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

// A timed-out wait returns `success: false` rather than throwing, so the
// completion line — not `failedMsg` — is what the user reads for it. Every
// shape `cause` distinguishes needs its own, or the distinction stops at the
// JSON.
const conditionUnmet = {
  exists: "UI element never appeared",
  visible: "UI element never became visible",
  hidden: "UI element never became hidden",
  text: "UI element never matched expected text",
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
 * One interval of sleep, plus one interval of latency for the deadline poll to
 * also come back dark. The flow runner's copy of this loop uses the same
 * tolerance as `CONDITION_DARK_TAIL_TOLERANCE_MS`.
 */
const DARK_TAIL_TOLERANCE_INTERVALS = 2;

/**
 * The same tolerance in absolute time. `pollIntervalMs` is the caller's, up to
 * 5000ms, so the multiple alone would reach 10s — and a source that answered
 * once and then went silent would still come back `unmet`. Past a couple of
 * seconds the trusted reads no longer credibly describe the deadline, however
 * sparsely the caller polls.
 *
 * Set above the default interval's own tolerance (2 x 400ms), so the routine
 * deadline straddle still reads as the blip it is.
 */
const DARK_TAIL_TOLERANCE_MAX_MS = 2000;

/**
 * How far the last trusted read may lie behind the loop's exit and still be
 * taken to describe it. The caller's own interval sets it, because the interval
 * is the blindness the caller already accepted between looks.
 */
function darkTailToleranceMs(pollIntervalMs: number): number {
  return Math.min(DARK_TAIL_TOLERANCE_INTERVALS * pollIntervalMs, DARK_TAIL_TOLERANCE_MAX_MS);
}

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
 * Only `unmet` judges the condition, so it has to be earned: some read must
 * have been trustworthy, and the reads must still describe the screen at the
 * deadline. Three tiers, following `waitForCondition` in flow-actions.ts — which
 * reaches its own final read by polling once PAST the deadline, where this loop
 * stops on it, so only here can a trusted final read be a whole poll old:
 *
 * 1. No trusted read at all — nothing ever evaluated the condition.
 * 2. Trusted reads, but they no longer describe the deadline: the window went
 *    dark at the end, or the last one lies further behind the exit than a poll
 *    can explain. `hidden` is stricter about a dark final read, because there
 *    the element LEAVING is the transition being waited on.
 * 3. A gap inside the tolerance — a last-poll blip or the routine sleep before
 *    the exit, which must not turn a real miss into "nothing was compared".
 *
 * The age of the last trusted read is measured on every condition, INCLUDING a
 * final attempt that came back with a good tree: the loop stops on the deadline
 * rather than reading across it, so with a coarse `pollIntervalMs` that tree can
 * be a whole interval old. `unmet` licenses a caller to rewrite or drop the
 * check (see the flow-authoring guidance), which a verdict that stale has not
 * earned.
 *
 * `endedAt` is passed rather than read here so the note beside this verdict
 * quotes the same gap it was decided on.
 */
function timeoutCause(
  condition: Params["condition"],
  lastTrustedReadAt: number | undefined,
  finalRead: FinalRead,
  pollIntervalMs: number,
  endedAt: number
): UnmetUiWaitCause {
  if (lastTrustedReadAt === undefined) return "unreadable";
  if (finalRead === "untrusted" && condition === "hidden") return "unreadable";
  const darkTailMs = endedAt - lastTrustedReadAt;
  return darkTailMs > darkTailToleranceMs(pollIntervalMs) ? "unreadable" : "unmet";
}

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
  vega: { vvd: true },
};

// The matching engine lives in utils/ui-tree-match so the flow directives and
// recorder reuse the exact selector semantics; `evaluateMatches` is a
// params-shaped wrapper for this tool and its tests.
export function evaluateMatches(params: Params, matches: DescribeNode[]): boolean {
  return evaluateCondition(params.condition, params.expectedText, matches, params.textMatch);
}

// Fold the read's hint / restart prompt into the timeout note so the agent sees
// the real cause rather than a bare "no element matched".
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
  lastData: DescribeTreeData | null,
  samples: number,
  budget: {
    timeoutMs: number;
    pollIntervalMs: number;
    lastAttemptSettled: boolean;
    slowestFetchMs: number;
    /** Fetches that errored across the wait, monotonic (a later success does not
     * clear it). A single sample with this above zero is a mostly-blind window,
     * not a schedule too tight for a second read. */
    failedFetches: number;
    /** Empty/degraded reads since the last one that could judge the condition. A
     * stale verdict with this above zero is a source that went dark, not a poll
     * interval too wide: the reads looked and saw nothing. */
    trailingBlindReads: number;
    /** Gap from the last trusted read to the exit, when it is what made the
     * verdict `unreadable`. */
    staleReadMs?: number;
  }
): string {
  // `fetchError` is sticky: the loop clears it on a successful fetch but leaves
  // it standing when the deadline abandons a later one, so it names the LAST
  // fetch only when that fetch settled. Where it did not, `samples` says whether
  // anything was read at all — and either way the failure itself is carried, not
  // dropped for being out of position.
  if (budget.lastAttemptSettled && fetchError !== undefined) {
    return `${TREE_FETCH_FAILED_NOTE_PREFIX}${fetchError}`;
  }
  if (!budget.lastAttemptSettled && samples === 0) {
    const earlier = fetchError === undefined ? "" : ` An earlier read failed: ${fetchError}.`;
    return (
      `reading the tree did not finish within the ${budget.timeoutMs}ms budget, so no tree was ever ` +
      `read and nothing judged the selector.${earlier} Raise timeoutMs if the tree is merely large, ` +
      `or repair the source if it has stopped answering altogether.`
    );
  }
  // Trees were read; the diagnosis below is the useful thing to report, so what
  // undermines it gets appended rather than replacing it. At most one caveat,
  // most blind first:
  //
  // - one sample, which can be the read taken before the element appeared. Name
  //   the knob that applies, failures first: a window where earlier fetches
  //   FAILED was mostly blind, and its single read may also read as STALE — but
  //   the staleness is downstream of the blindness, so "restore the source" is
  //   the remedy, not "poll more often". Only where nothing failed does a single
  //   stale read mean the interval left it too far behind the deadline (say how
  //   far, or the caveat contradicts the cause). Otherwise lowering the sleep
  //   helps only when the sleep is what ran out, not when the deadline cut a
  //   fetch off, and not when the fetches ate over half the budget between them
  //   (a second sample needs the slowest one's length again plus the shortest
  //   sleep the schema takes — a bound on reads THIS size, not a promise the
  //   next costs as much, so the remedy is offered rather than ruled out).
  // - samples enough to compare, but the last one lies too far behind the
  //   deadline to speak for it. Without this the note is word-for-word a
  //   determinate miss, while `cause` says `unreadable`.
  let readCaveat = "";
  if (samples < 2) {
    if (budget.failedFetches > 0) {
      // The window was mostly blind: the failures took the other samples, not the
      // schedule, so restoring the source is the remedy even where the one read
      // that landed is also stale.
      readCaveat =
        ` (only one tree read returned a tree — ${budget.failedFetches} earlier ` +
        `${budget.failedFetches === 1 ? "read" : "reads"} failed — so this rests on that single sample from ` +
        `a mostly-blind window; restore the tree source and re-run)`;
    } else if (budget.staleReadMs !== undefined) {
      // The single read is what made the verdict `unreadable`: it is old. Say so,
      // rather than blaming a schedule that had nothing to do with it.
      readCaveat =
        ` (the one tree read landed ${budget.staleReadMs}ms before the deadline and nothing looked at the ` +
        `screen after it, so this rests on a single, stale sample; lower pollIntervalMs ` +
        `(${budget.pollIntervalMs}ms))`;
    } else if (
      budget.lastAttemptSettled &&
      2 * budget.slowestFetchMs + MIN_POLL_INTERVAL_MS <= budget.timeoutMs
    ) {
      readCaveat =
        ` (the ${budget.timeoutMs}ms budget left room for only one tree read — the slowest fetch took ` +
        `${budget.slowestFetchMs}ms, and pollIntervalMs (${budget.pollIntervalMs}ms) leaves no room for a ` +
        `second — so this rests on that single sample; lower pollIntervalMs or raise timeoutMs)`;
    } else {
      readCaveat =
        ` (only one tree read completed within the ${budget.timeoutMs}ms budget, so this rests on that ` +
        `single sample — raise timeoutMs, or lower pollIntervalMs if reads that slow are the exception)`;
    }
  } else if (budget.staleReadMs !== undefined) {
    readCaveat =
      budget.trailingBlindReads > 0
        ? // The tail WAS read; the source went dark. So the stale verdict is for
          // want of a source, not of polling — the line await-screen-idle draws
          // with its trailing-blank-reads arm.
          ` (the last ${budget.trailingBlindReads} tree ${budget.trailingBlindReads === 1 ? "read" : "reads"} ` +
          `came back empty, so the source went dark and the newest read that could judge the selector is ` +
          `${budget.staleReadMs}ms behind the deadline; restore the tree source and re-run)`
        : ` (the last tree read landed ${budget.staleReadMs}ms before the deadline and nothing looked at the ` +
          `screen after it, so this describes the screen then, not at the deadline; lower pollIntervalMs ` +
          `(${budget.pollIntervalMs}ms))`;
  }
  // A fetch that failed before the deadline abandoned the final one: the window
  // was part blind, which is half of why it looks the way it does below.
  const droppedError = fetchError !== undefined ? ` (a tree read also failed: ${fetchError})` : "";
  const matches = lastTree ? findAll(lastTree, params.selector) : [];
  let base: string;
  switch (params.condition) {
    case "text": {
      // Visible-first, mirroring evaluateCondition, so the note quotes the
      // element the check read.
      const first = firstInReadingOrder(matches.filter(isVisible)) ?? firstInReadingOrder(matches);
      const wanted = params.textMatch === "equals" ? "equal" : "contain";
      base = first
        ? `element matched but its text was "${nodeText(first)}" (wanted to ${wanted} "${params.expectedText}")`
        : "no element matched the selector before timeout";
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
          : "no element matched the selector before timeout";
      break;
    default:
      base = "no element matched the selector before timeout";
  }
  return appendDiagnostics(base + readCaveat + droppedError, lastData);
}

// A factory (like `describe`) because the iOS / Android tree fetch resolves the
// AX / android-devtools services through the registry rather than through the
// tool's own services() declaration. Only the Chromium CDP session flows in as a
// normal service.
export function createAwaitUiElementTool(registry: Registry): ToolDefinition<Params, WaitResult> {
  async function fetchTree(
    device: DeviceInfo,
    params: Params,
    services: Record<string, unknown>,
    isTvOs: boolean,
    androidIsTv: boolean
  ): Promise<DescribeTreeData> {
    if (device.platform === "ios") {
      // Physical devices poll the same XCUITest runner snapshot as describe.
      if (device.kind === "device") {
        return describeIosDevice(registry, device);
      }
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
      completedMsg: ({ params, result }) =>
        result.success
          ? conditionCompleted[params.condition]
          : result.cause === "cancelled"
            ? "Wait for the UI element cancelled"
            : result.cause === "unreadable"
              ? `Could not judge whether the UI element would ${conditionDescription[params.condition]}`
              : conditionUnmet[params.condition],
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
It polls the same accessibility / DOM tree as \`describe\`
(iOS simulator AXRuntime, physical-iOS runner snapshot, Android uiautomator, Chromium CDP,
Vega automation toolkit) every pollIntervalMs
(default ${DEFAULT_POLL_INTERVAL_MS}ms) until timeoutMs (default ${DEFAULT_TIMEOUT_MS}ms).

Returns { success: boolean, elapsed: number, note?, cause? } — success=false means the wait ended without the
condition holding, which is not always a verdict on the condition: \`cause\` says which it was — \`unmet\` (the tree
was read and the condition was false there), \`unreadable\` (no read that can speak for the screen at the deadline:
the source never answered, went dark at the end, or the last good read is too far behind it — the note names the
knob, pollIntervalMs when the polling was sparse and timeoutMs when the reads were slow) or
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

      // Resolve tvOS / Android-TV once. Physical devices skip the tvOS probe. They are never tvOS simulators.
      const isTvOs =
        device.platform === "ios" && device.kind !== "device" && (await isTvOsSimulator(device.id));
      const androidIsTv = device.platform === "android" && (await isAndroidTv(device.id));

      // Clock starts after setup so its fixed cost isn't charged to timeoutMs.
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

      // Whether the selector ever matched, so a `hidden` wait that resolves on
      // the first poll can report it may have had nothing to wait for.
      let everMatched = false;
      // When the last read that could EVALUATE the condition landed. Still
      // undefined at the deadline means no read ever did.
      let lastTrustedReadAt: number | undefined;
      // Blind reads (empty tree / degraded AX) since the last trusted one. A
      // stale verdict with these above zero is a source that went dark, not a
      // poll interval too wide — the reads DID look, they just saw nothing.
      let trailingBlindReads = 0;

      const poll = await pollDescribeTree<WaitResult>({
        fetchTree: () => fetchTree(device, params, services, isTvOs, androidIsTv),
        timeoutMs,
        pollIntervalMs,
        signal,
        onSample: (data, nowMs) => {
          const matches = findAll(data.tree, selector);
          if (matches.length > 0) everMatched = true;
          const blind = isBlindRead(data, everMatched);
          if (blind) {
            trailingBlindReads += 1;
          } else {
            lastTrustedReadAt = nowMs;
            trailingBlindReads = 0;
          }
          if (!blind && evaluateMatches(params, matches)) {
            const result: WaitResult = { success: true, elapsed: Date.now() - start };
            if (params.condition === "hidden" && !everMatched) {
              result.note =
                "condition met immediately — the selector never matched any element, " +
                "so it may have already been hidden before the wait, or the selector is wrong";
            }
            return { done: true, result };
          }
          return { done: false };
        },
      });

      if (poll.aborted) return cancelled();
      if (poll.result) return poll.result;

      // The final attempt is trusted only if it settled and came back with a
      // tree the condition could be judged on. `lastError` alone cannot say:
      // the loop leaves it unset for an attempt it abandoned at the deadline,
      // so that the note can still be built from an older tree.
      const finalRead: FinalRead = !poll.lastAttemptSettled
        ? "unsettled"
        : poll.lastError === undefined &&
            poll.lastData !== null &&
            !isBlindRead(poll.lastData, everMatched)
          ? "trusted"
          : "untrusted";
      const endedAt = Date.now();
      const cause = timeoutCause(
        params.condition,
        lastTrustedReadAt,
        finalRead,
        pollIntervalMs,
        endedAt
      );
      const darkTailMs = lastTrustedReadAt === undefined ? undefined : endedAt - lastTrustedReadAt;
      return {
        success: false,
        elapsed: endedAt - start,
        note: timeoutNote(
          params,
          poll.lastData?.tree ?? null,
          poll.lastError,
          poll.lastData,
          poll.samples,
          {
            timeoutMs,
            pollIntervalMs,
            lastAttemptSettled: poll.lastAttemptSettled,
            slowestFetchMs: poll.slowestFetchMs,
            failedFetches: poll.failedFetches,
            trailingBlindReads,
            staleReadMs:
              darkTailMs !== undefined && darkTailMs > darkTailToleranceMs(pollIntervalMs)
                ? darkTailMs
                : undefined,
          }
        ),
        cause,
      };
    },
  };
}
