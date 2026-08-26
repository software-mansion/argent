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
const TREE_FETCH_FAILED_NOTE_PREFIX = "last tree fetch failed: ";
const HIDDEN_UNREADABLE_NOTE =
  "could not confirm the element is hidden — the UI tree was empty or unreadable at timeout";

/**
 * WHY an unmet wait came back `success: false`. {@link isUnmetUiWaitResult}
 * answers "did this wait fail", which is all `run-sequence` and `flow-run`
 * need. A caller that NARRATES the failure needs more, because only one cause
 * judges the condition:
 *
 * - `unmet` — the tree was read and the condition was false there.
 * - `unreadable` — the tree source never answered, so nothing was observed.
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
 * deadline. Three tiers, mirroring `waitForCondition` in flow-actions.ts:
 *
 * 1. No trusted read at all — nothing ever evaluated the condition.
 * 2. Trusted reads, but the window went dark at the end. `hidden` is stricter,
 *    because there the element LEAVING is the transition being waited on.
 * 3. A dark tail inside the tolerance — a last-poll blip, which must not turn a
 *    real miss into "nothing was compared".
 *
 * An `unsettled` final attempt takes the dark-tail measure on every condition.
 * The loop makes one on almost every timeout, because the poll sleep is clamped
 * to the deadline and the next iteration straddles it. The age of the last
 * trusted read is what separates that straddle from a source that stopped
 * answering.
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

// The matching engine lives in utils/ui-tree-match so the flow directives and
// recorder reuse the exact selector semantics; `evaluateMatches` is a
// params-shaped wrapper for this tool and its tests.
export function evaluateMatches(params: Params, matches: DescribeNode[]): boolean {
  return evaluateCondition(params.condition, params.expectedText, matches, params.textMatch);
}

// An empty tree is not trustworthy evidence the element is gone, so `hidden` —
// the only condition that resolves true on one — must not resolve off it when
// the adapter flagged the read (`describeIos` returns an empty tree plus a hint /
// should_restart instead of throwing), or when the selector matched on an earlier
// poll and the tree has since gone blank mid-navigation.
function isBlindRead(data: DescribeTreeData, everMatched: boolean): boolean {
  if (data.tree.children.length > 0) return false;
  return Boolean(data.unreadable || data.hint || data.should_restart || everMatched);
}

// Floor on the per-poll accessibility read budget: bounded by the wait's
// remaining budget so a stalled app is caught within this call, never below
// this so a large tree is not mistaken for a stalled one.
const MIN_AX_READ_MS = 3000;

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
  lastData: DescribeTreeData | null
): string {
  if (fetchError) return `${TREE_FETCH_FAILED_NOTE_PREFIX}${fetchError}`;
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
  return appendDiagnostics(base, lastData);
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
    androidIsTv: boolean,
    remainingMs: number
  ): Promise<DescribeTreeData> {
    if (device.platform === "ios") {
      return describeIos(
        registry,
        device,
        { bundleId: params.bundleId },
        { isTvOs, axTimeoutMs: Math.max(remainingMs, MIN_AX_READ_MS) }
      );
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

      // Resolve once, outside the poll loop: an id that isn't listed is never
      // cached, so probing per fetch would re-run `simctl list` / `adb devices`
      // on every poll.
      const isTvOs = device.platform === "ios" && (await isTvOsSimulator(device.id));
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

      const deadline = start + timeoutMs;
      const poll = await pollDescribeTree<WaitResult>({
        fetchTree: () =>
          fetchTree(device, params, services, isTvOs, androidIsTv, deadline - Date.now()),
        timeoutMs,
        pollIntervalMs,
        signal,
        onSample: (data, nowMs) => {
          const matches = findAll(data.tree, selector);
          if (matches.length > 0) everMatched = true;
          const blind = isBlindRead(data, everMatched);
          if (!blind) lastTrustedReadAt = nowMs;
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
      return {
        success: false,
        elapsed: Date.now() - start,
        note: timeoutNote(params, poll.lastData?.tree ?? null, poll.lastError, poll.lastData),
        cause: timeoutCause(params.condition, lastTrustedReadAt, finalRead, pollIntervalMs),
      };
    },
  };
}
