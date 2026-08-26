import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  FAILURE_CODES,
  FailureError,
  ToolNotFoundError,
  type Registry,
  type ToolDefinition,
} from "@argent/registry";
import {
  requireRecordingSession,
  appendStepToFlow,
  appIdForPlatform,
  parseFlow,
  assertSafeFlowName,
  classifyOnDiskSpelling,
  describeSelector,
  flowsDirFor,
  type FlowSavedTo,
  type FlowSelector,
  type FlowStep,
  type RecordingSession,
} from "./flow-utils";
import {
  AWAIT_UI_ELEMENT_TOOL_ID,
  isUnmetUiWaitResult,
  unmetUiWaitCause,
  type UnmetUiWaitCause,
} from "../await-ui-element";
import { probeWhenCondition, type DirectiveOutcome } from "./flow-actions";
import { stepAnchor, summarizeStep } from "./flow-finish-recording";
import { invokeSubTool, describeNestedParamError } from "../../utils/sub-invoke";
import { resolveDevice } from "../../utils/device-info";
import { settleWithin } from "../../utils/timing";
import { stripDeviceKeys } from "./flow-device";
import { fetchFlowTree } from "./flow-tree";
import type { DescribeSource } from "../describe/contract";
import {
  nodeAtPoint,
  deriveSelector,
  selectorToFrame,
  frameContains,
  type Selector,
  type TextMatchMode,
  type WaitCondition,
} from "../../utils/ui-tree-match";

const zodSchema = z.object({
  name: z
    .string()
    .describe("Name of the flow being recorded — the one passed to flow-start-recording."),
  project_root: z
    .string()
    .describe(
      "Absolute path to the project root of the flow being recorded — the same value passed to flow-start-recording. Together with `name` it identifies which recording this step belongs to."
    ),
  command: z
    .string()
    .describe(
      'MCP tool name (e.g. "gesture-tap", "screenshot", "launch-app") — a TOOL, not a flow directive. ' +
        'A flow-file directive name ("tap", "launch", "run", "type", "await", "assert", "pinch", ' +
        '"echo", "wait", "long-press", "scroll-to", "snapshot", "when", "repeat") is answered with ' +
        "guidance, and nothing runs or is recorded: most name the tool that records the directive, " +
        'while "wait", "long-press", "scroll-to", "snapshot", "when" and "repeat" have no recording ' +
        "tool at all and are answered with what to do instead. A recording tool (flow-add-step, " +
        "flow-add-echo, flow-start-recording, flow-finish-recording) is refused the same way, " +
        "each for its own reason — nesting one would erase this flow at replay, end the take, or " +
        "write the step twice."
    ),
  args: z
    .string()
    .optional()
    .describe(
      'Tool arguments as a JSON string, e.g. \'{"udid": "ABC", "x": 0.5, "y": 0.3}\'. Omit for tools with no arguments.'
    ),
  delayMs: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Milliseconds to sleep before executing this step during replay."),
});

// Replay gates on the platform's full-hierarchy source (`treeSourceGate` in
// flow-run.ts) and refuses to degrade to the fallback tree, so a selector
// derived from the fallback deserves a caveat even when it derives cleanly.
// Chromium/Vega have a single source — no caveat.
const REPLAY_TREE_SOURCES: Record<string, DescribeSource> = {
  ios: "native-devtools",
  android: "android-devtools",
};

/**
 * The app this recording last started, from the recorder's `launch` steps — the
 * session's stand-in for the runner's {@link FlowTreeTarget.bundleId}. Last
 * rather than first: a mid-recording relaunch retargets what follows, exactly as
 * a nested `launch:` retargets a run.
 */
function recordedLaunchedApp(session: RecordingSession, platform: string): string | undefined {
  for (let i = session.flow.steps.length - 1; i >= 0; i--) {
    const step = session.flow.steps[i];
    if (step.kind === "launch") return appIdForPlatform(step.app, platform) ?? undefined;
  }
  return undefined;
}

function fallbackSourceWarning(source: DescribeSource, platform: string): string | undefined {
  const expected = REPLAY_TREE_SOURCES[platform];
  if (!expected || source === expected) return undefined;
  return `selector captured from the fallback ${source} tree (${expected} unavailable) — replay resolves against the full hierarchy, which may not match it`;
}

// `resolveDevice` classifies the id by shape and never throws, so no guard.
function platformOf(udid: unknown): string | undefined {
  return typeof udid === "string" ? resolveDevice(udid).platform : undefined;
}

/**
 * Fallback for a platform the clauses below do not name. Unreachable today: a
 * determinate verdict needs `fetchFlowTree`, which answers only on ios,
 * android, chromium and vega.
 */
const UNSUPPORTED_PLATFORM = {
  divergence: "The recorder and the runner read different projections of the screen.",
  read: "No read-only tool is known to report the runner's projection on this platform — keep the step raw",
} as const;

/**
 * The remedy half of the iOS/Android clause. The advice inverts on `hidden`:
 * there the verdict means the runner's tree still HAS the element, so a more
 * reliable selector only makes the directive match more surely.
 */
function retargetRemedy(idKind: string, condition: WaitCondition): string {
  if (condition === "hidden") {
    return (
      `but this verdict says that tree still HAS the element, so retargeting at ${idKind} it ` +
      "definitely carries is the wrong direction — either narrow the selector until it matches " +
      "only what you expect to leave, or gate on something that does leave, and prove it with " +
      "`flow-execute`; or keep the step raw"
    );
  }
  return (
    `so retarget the DIRECTIVE at ${idKind} the full hierarchy carries and prove it with ` +
    "`flow-execute`, or keep the step raw"
  );
}

/**
 * How to read the tree the runner resolves against — or, on iOS, Android and
 * Chromium, that no read-only tool reports it. `describe` and the native
 * readers each show a different projection, so naming one of them would point
 * the author at the wrong tree.
 */
function runnerSideReadClause(udid: unknown, condition: WaitCondition): string {
  const platform = platformOf(udid);
  if (platform === "ios") {
    return (
      "No read-only tool reports the runner's projection on iOS — `native-find-views` and " +
      "`native-full-hierarchy` return the RAW view tree, keeping the hidden, transparent, " +
      "scroll-clipped and unlabelled container views the runner drops, and neither answers the " +
      "question a selector asks: `native-find-views` matches `identifier`/`label`/`className` " +
      "EXACTLY and takes no substring `text` or `role`, and `native-full-hierarchy` takes no " +
      "matcher at all — it dumps the tree for you to read — " +
      retargetRemedy("an `id`", condition)
    );
  }
  if (platform === "android") {
    return (
      "No read-only tool exposes the runner's full hierarchy on Android — `describe` returns the " +
      "trimmed tree the recorder read, not the runner's — " +
      retargetRemedy("a `resource-id`", condition)
    );
  }
  if (platform === "chromium") {
    const settle =
      "No read-only tool exposes the runner's trimmed tree on Chromium — `describe` re-reads the " +
      "same DOM on a shorter walk, so it both lists nodes the runner drops and omits nodes the " +
      "runner keeps — so settle it by running the conversion: put the directive in a flow and " +
      "`flow-execute` it. ";
    if (condition === "hidden") {
      return (
        settle +
        "This verdict says that tree still HAS the element, so the usual chromium tips are the " +
        "wrong direction here: a `scroll-to` before the check, or a switch to an `id`/`role` " +
        "selector, only makes the directive match more surely. Absence from `describe` is not " +
        "the element having left, either — on a dense page the recorder's walk stops at 5000 " +
        "nodes where the runner's goes to 12000. Narrow the selector until it matches only what " +
        "you expect to leave, or gate on something that does leave; or keep the step raw"
      );
    }
    return (
      settle +
      // Name both axes: `normRect` clamps each edge on its own, so a
      // horizontally scrolled node comes back zero-WIDTH at a normal height.
      "A zero-area frame in `describe` means off-viewport — zero height for a node above or " +
      "below the viewport, zero width for one left or right of it, since the walker clamps " +
      "each edge on its own — and the fix there is a `scroll-to` before the check rather than " +
      "a different selector; a password field reaches the runner under the name `[password]`, " +
      "so only an `id`/`role` selector can match it"
    );
  }
  if (platform === "vega") {
    return (
      "`describe` reads the same source the runner does, so re-run the wait rather than " +
      "re-recording the selector"
    );
  }
  return UNSUPPORTED_PLATFORM.read;
}

/**
 * The cause no tree story can rule out. The probe reads the device just after
 * the live wait, so a screen that moved on gives this same verdict with both
 * trees in agreement. On Vega it is the only cause.
 */
const SCREEN_MAY_HAVE_MOVED =
  " A screen that changed between the live wait and this re-probe reads the same way, so rule " +
  "that out first.";

/**
 * WHY the two trees can disagree. The story differs per platform, and it must
 * not name the side that lost the element: on Chromium either side can.
 */
function treeDivergenceFor(udid: unknown, condition: WaitCondition): string {
  const platform = platformOf(udid);
  if (platform === "ios") {
    return (
      "The recorder reads the accessibility tree and the runner reads the full native view " +
      "hierarchy; they overlap but neither contains the other." +
      SCREEN_MAY_HAVE_MOVED
    );
  }
  if (platform === "chromium") {
    // `projectChromiumNode` keeps a node only when it is `onScreen &&
    // addressable`. The condition says which side lost the element, because the
    // probe runs only after the live wait passed.
    if (condition === "hidden") {
      return (
        "Both read the same DOM but project it differently, and here it is the RECORDER that " +
        "never saw the element: the live wait passed on absence, and this verdict says the " +
        "runner's tree holds it — so nothing the flow tree DROPS can be the cause. What is " +
        "left is the recorder's own limit: its walk stops at 5000 nodes where the flow tree's " +
        "goes to 12000, so on a dense page the element is past the end of what it read." +
        SCREEN_MAY_HAVE_MOVED
      );
    }
    return (
      "Both read the same DOM but project it differently, and here it is the RUNNER's side to " +
      "check: the live wait passed, so the recorder's tree did hold a matching element and its " +
      "5000-node walk limit is not what went wrong. The flow tree keeps only addressable nodes " +
      "(id, label, value, clickable or focused) whose frame the walker did not clamp to zero " +
      "area for being off-viewport, and it redacts a password field's name to `[password]`." +
      SCREEN_MAY_HAVE_MOVED
    );
  }
  if (platform === "android") {
    // Both sides call the same `getHierarchy` RPC. An author told the two READ
    // different things looks for a second source that does not exist.
    return (
      "Both read the same `getHierarchy` dump from the android-devtools helper; this host then " +
      "parses it two ways. `describe`'s interactables trim collapses a `testID`-only container " +
      "into a passthrough and drops the node carrying the id, while borrowing a descendant's " +
      "text into an unlabelled clickable's own label — where the flow adapter keeps every view " +
      "with a `resource-id` or a label, and asks for 12000 nodes against the helper's 5000 " +
      "default. So each holds elements the other drops." +
      SCREEN_MAY_HAVE_MOVED
    );
  }
  if (platform === "vega") {
    // `projectVegaNode` skips nothing, so the two trees cannot disagree on an
    // unchanged screen. On `text` they can still elect different elements,
    // because they walk the nodes in opposite order — see {@link textTieClause}.
    const cause =
      condition === "text"
        ? "disagreement means either the SCREEN changed between the live wait and this re-probe " +
          "or the two sides elected different elements, as above — not that the two trees differ."
        : "disagreement means the SCREEN changed between the live wait and this re-probe, not " +
          "that the two trees differ.";
    return (
      "Both read the same automation-toolkit page source, and the flow tree only re-shapes it — " +
      "it drops no element and its text hoist can only add matches — so on this platform a " +
      cause
    );
  }
  return UNSUPPORTED_PLATFORM.divergence;
}

/**
 * What an `await:` would still wait FOR. The wording inverts on `hidden`: there
 * the wait passes when the element LEAVES.
 */
function awaitStillNeeds(condition: WaitCondition): string {
  if (condition === "hidden") return "the element LEAVES that tree";
  // Not "that element": on `text` the two sides can elect different elements.
  if (condition === "text") return "the element THAT tree elects comes to match on it";
  return "the element reaches that tree";
}

/**
 * The cause no tree story explains, and the one only `text` can have: the
 * selector matched several elements and the two sides elected different ones.
 *
 * `exists`/`visible`/`hidden` quantify over every match, so the order the
 * matches arrive in cannot change their answer. `text` reads one — the first
 * visible match in reading order — and an exact frame tie goes to whichever
 * node its own tree listed first.
 *
 */
function textTieClause(udid: unknown): string {
  const order =
    platformOf(udid) === "ios"
      ? "and the two are flat lists built from different sources — the accessibility element " +
        "order and the view-hierarchy walk — so neither order follows from the other"
      : "and the recorder's lists a container before its children where the runner's lists " +
        "children before their container";
  return (
    " Check FIRST whether the selector matches more than one element, because a `text` check " +
    "reads only one of them — the first visible match in reading order — and the two sides can " +
    "elect DIFFERENT ones from the very same nodes: an exact frame tie is settled by which node " +
    `its tree listed first, ${order}. The reason above quotes whichever element the RUNNER ` +
    "elected, so compare it against the one you meant. If that is what happened, both trees hold " +
    "both elements and neither the tree differences nor a changed screen below explains " +
    "anything — narrow the selector until it resolves a single node, and note that a longer " +
    "`await:` timeout cannot help, since the text it read is already final."
  );
}

// The probe judges `args.selector` as a STRICT selector, so the warning has to
// name that spelling: a bare string parses as a loose selector instead.
const SPELLING_CLAUSE =
  "Both of those are about the selector exactly as recorded, so convert it in the strict map " +
  "spelling (`{ text: … }` / `{ id: … }`, a straight copy of the step's `selector:`): a " +
  "bare-string conversion (`{ visible: Continue }`) re-parses as a LOOSE selector — " +
  "identifier first, text only as a fallback — which is a different check this probe never made.";

/**
 * `await-ui-element` reports an unmet condition by returning
 * `{ success: false }` rather than throwing, so the recorder writes the step
 * anyway. At replay the same step FAILS and stops the run, so the message must
 * not read as fine.
 */
const UNMET_WAIT_WARNING =
  "recorded, but the wait itself never held — `await-ui-element` reports an unmet condition by " +
  "returning success:false instead of failing, so the step was written to the flow anyway. At " +
  "replay an unmet wait FAILS the step and stops the run there, so re-record it once the " +
  "condition can actually hold, and delete the failed step after `flow-finish-recording` rather " +
  "than mid-recording: against a remote client the in-memory copy is authoritative and the next " +
  "append writes the step straight back, and in host mode the recorder re-reads the file before " +
  "each append, so an edit that renumbers the steps costs the finish the verdicts it would " +
  "otherwise carry. The cross-tree re-probe was " +
  "skipped: it asks whether a check that PASSED would survive conversion to `await:`/`assert:`, " +
  "and this one did not pass";

/**
 * The same `success: false`, reached without a trustworthy read of the tree —
 * see {@link unmetUiWaitCause}. It must not reuse the unmet text, which asserts
 * that the wait never held: nothing judged the condition here, so the step may
 * be perfectly good.
 */
const UNREADABLE_WAIT_WARNING =
  "recorded, but this wait reached its deadline without a trustworthy read of the UI tree, so " +
  "the condition was never judged — `await-ui-element` returns success:false for that too, and " +
  "the step was written to the flow anyway. Either no read in the window could be trusted, or " +
  "the reads went dark before the end and what they saw no longer describes it. Whether the " +
  "condition holds is UNKNOWN, not known-bad: `toolResult.note` names the tree-source error " +
  "where a fetch threw, and describes what was seen where the tree was merely empty or " +
  "degraded. Get that source back and re-record the step to find out. Do not delete the step on " +
  "this warning alone. The cross-tree re-probe was skipped: it asks whether a check that PASSED " +
  "would survive conversion to `await:`/`assert:`, and this one never got an answer";

const CANCELLED_WAIT_WARNING =
  "recorded, but this wait was cancelled before its deadline, so the condition was never settled " +
  "— `await-ui-element` reports a cancelled wait as success:false, and the step was written to " +
  "the flow anyway. Whether it holds is UNKNOWN, not known-bad: re-record the step to find out. " +
  "The cross-tree re-probe was skipped for the same reason";

function unmetWaitWarningFor(cause: UnmetUiWaitCause): string {
  if (cause === "unreadable") return UNREADABLE_WAIT_WARNING;
  if (cause === "cancelled") return CANCELLED_WAIT_WARNING;
  return UNMET_WAIT_WARNING;
}

// The indeterminate reason is quoted verbatim, and on iOS it can end "provide
// bundleId explicitly" — advice written for the native tools. Correct it rather
// than honour it.
function indeterminateReasonCaveat(udid: unknown): string {
  if (platformOf(udid) !== "ios") return "";
  return (
    ". That reason may tell you to pass `bundleId` — it is quoted from the shared native-target " +
    "error, and it does not apply here: the probe predicts an `await:`/`assert:` directive, and " +
    "no directive takes a bundleId, so neither this probe nor the runner accepts one (the " +
    "`bundleId` on this step reached the live wait only). What the runner's iOS tree needs is an " +
    "app with argent's instrumentation loaded — relaunch it with `launch-app` or a flow `launch:` " +
    "step. An app that cannot load it at all, such as a `com.apple.*` system app, can never be " +
    "probed or converted: keep the check as a raw `tool:` step"
  );
}

/**
 * A cancelled re-probe is reported, never thrown. A throw would discard the
 * record of a step that already ran on the device, and it would arrive out of
 * band: every other cancellation in the server is reported in the result.
 */
const CANCELLED_PROBE_WARNING =
  "recorded, but the re-probe against the tree the RUNNER reads was cancelled before it " +
  "answered. The step itself ran and is written to the flow; only the verdict is missing, so " +
  "whether it would convert to `await:`/`assert:` is UNKNOWN, not known-bad — record the wait " +
  "again, uncancelled, before trusting the conversion";

/**
 * Hard ceiling on the whole re-probe. `probeWhenCondition` polls on the assert
 * grace window, but that bounds the LOOP only: each tree read inside it is
 * awaited with no time bound, and one read can take seconds. The recorder is
 * interactive, so bound it here rather than in the shared loop.
 *
 * Sized for the expensive branch. A determinate "does NOT hold" costs two full
 * reads, because the loop fires one more after its deadline; the clean case
 * returns from the first read that satisfies the condition. An overrun is
 * reported as indeterminate — unknown, never known-bad.
 */
const PROBE_MAX_TREE_READ_MS = 2500;
const PROBE_ASSERT_GRACE_MS = 1000; // DEFAULT_ASSERT_TIMEOUT_MS, the loop's own window
const PROBE_BUDGET_MS = PROBE_ASSERT_GRACE_MS + 2 * PROBE_MAX_TREE_READ_MS;

/**
 * Length cap on a DETERMINATE reason before it is quoted back. That reason
 * quotes the matched element's text, and the flow tree hoists text from every
 * descendant, so one failed `text` check can carry a whole card.
 *
 * An indeterminate reason is quoted whole: it is an environment error, it
 * carries no screen content, and its tail is the recovery instruction.
 */
const MAX_PROBE_REASON_CHARS = 200;

/**
 * How much of the cap goes to the END. `waitForCondition` closes a determinate
 * reason with the note that its final poll went dark. That note qualifies the
 * verdict, so elide the middle rather than the tail.
 */
const PROBE_REASON_TAIL_CHARS = 60;

function elisionMarker(dropped: number): string {
  return `… (${dropped} more chars) …`;
}

/**
 * {@link MAX_PROBE_REASON_CHARS} bounds what is EMITTED, not what is kept.
 * Sizing the head against the widest the marker can be fits the result in one
 * pass. Budgeting the kept text instead let a 201-character reason come out at
 * 218, announcing "(1 more chars)".
 */
function cappedReason(reason: string): string {
  if (reason.length <= MAX_PROBE_REASON_CHARS) return reason;
  const widestMarker = elisionMarker(reason.length).length;
  const tailChars = Math.max(
    0,
    Math.min(PROBE_REASON_TAIL_CHARS, MAX_PROBE_REASON_CHARS - widestMarker)
  );
  const headChars = Math.max(0, MAX_PROBE_REASON_CHARS - widestMarker - tailChars);
  const dropped = reason.length - headChars - tailChars;
  return `${reason.slice(0, headChars)}${elisionMarker(dropped)}${reason.slice(reason.length - tailChars)}`;
}

/**
 * The recorder and the runner read DIFFERENT trees. `await-ui-element` reads the
 * agent-facing describe tree; the `await:`/`assert:` directive that polish
 * converts this step into reads `fetchFlowTree`'s. Neither tree contains the
 * other, so a check can pass live and fail once converted.
 *
 * So re-probe the same condition against the runner's tree and report the
 * answer. It warns; it never refuses. The step is recorded as a raw
 * `tool: await-ui-element`, and at replay that tool reads the same tree it just
 * passed against — so the verdict is about the CONVERSION, not this step.
 */
async function probeAgainstRunnerTree(
  registry: Registry,
  ctx: Parameters<typeof invokeSubTool>[1],
  args: Record<string, unknown>
): Promise<{ warning?: string }> {
  const selector = args.selector;
  const condition = args.condition;
  if (typeof condition !== "string" || selector === null || typeof selector !== "object") {
    return {};
  }
  if (typeof args.udid !== "string") return {}; // nothing to probe against
  // No try/catch: an id with no flow tree throws inside `fetchFlowTree`, which
  // the probe already reports as indeterminate.
  const device = resolveDevice(args.udid);
  // Giving up must STOP the loop, not just stop waiting for it. `settleWithin`
  // abandons the promise, but the loop keeps its tree read and then fires one
  // more — against a device the recorder has already returned from.
  const giveUp = new AbortController();
  const probeSignal = ctx?.signal ? AbortSignal.any([ctx.signal, giveUp.signal]) : giveUp.signal;
  // Bounded by PROBE_BUDGET_MS: the loop's deadline does not bound its reads.
  const settled = await settleWithin(
    probeWhenCondition(
      // The loop reads the signal off ActionEnv, so pass it there as well.
      { registry, ctx, device, signal: probeSignal },
      {
        condition: condition as WaitCondition,
        selector: selector as FlowSelector,
        expectedText: typeof args.expectedText === "string" ? args.expectedText : undefined,
        textMatch: args.textMatch as TextMatchMode | undefined,
      }
    ),
    PROBE_BUDGET_MS,
    ctx?.signal
  );
  // Done with the loop either way; on the timeout path it still holds the
  // device.
  giveUp.abort();
  // Every cancellation arrives here rather than as an aborted outcome:
  // `settleWithin` latches on `ctx.signal`, and `giveUp` aborts only after the
  // await above.
  if (settled.type === "aborted") return { warning: CANCELLED_PROBE_WARNING };
  // A read that outran the budget and a probe that threw are both "the runner's
  // tree did not answer". They need different words, though: on a timeout the
  // source answered, only too slowly, so the reason must not call it absent.
  const timedOut = settled.type === "timeout";
  const outcome: DirectiveOutcome =
    settled.type === "value"
      ? settled.value
      : {
          ok: false,
          indeterminate: true,
          reason: timedOut
            ? `the runner's tree was still being read ${PROBE_BUDGET_MS}ms in, which is longer ` +
              `than the recorder waits — the source is slow, not down`
            : `reading the runner's tree failed: ${settled.error}`,
        };
  if (outcome.ok) return {};
  if (outcome.indeterminate) {
    return {
      // Deliberately NOT joined with treeDivergenceFor/runnerSideReadClause.
      // Nothing was compared, so claiming the two trees differ would send the
      // author to rewrite a selector that may be perfectly good.
      //
      // The reason is quoted whole rather than through `cappedReason`; see
      // {@link MAX_PROBE_REASON_CHARS}.
      warning:
        `this check could not be re-verified against the tree the RUNNER reads ` +
        `(${outcome.reason ?? "no reason given"}), so it passed against the tree ` +
        `\`${AWAIT_UI_ELEMENT_TOOL_ID}\` ` +
        `reads and nothing else. Whether it would convert to \`await:\`/\`assert:\` is UNKNOWN, ` +
        `not known-bad — ` +
        // A timeout and an outage need different next moves: "once that tree
        // source is back" is nonsense for a source that never left.
        (timedOut
          ? `re-record this step when the device is quieter, or settle the conversion directly by ` +
            `putting the directive in a flow and running \`flow-execute\`, which has no such ` +
            `ceiling`
          : `re-probe once that tree source is back before trusting the conversion` +
            indeterminateReasonCaveat(args.udid)),
    };
  }
  // Determinate: the runner's tree was read, and the condition did not hold on
  // it. That is not the same as "the two trees disagree" — the same verdict
  // comes back when the screen simply moved on (see SCREEN_MAY_HAVE_MOVED), and
  // at replay the directive runs where the live wait ran, not a moment later.
  // So keep the CONSEQUENCE conditional on the cause the platform clause gives.
  return {
    warning:
      `recorded, but this condition does NOT hold against the tree the runner resolves ` +
      `directives against (${cappedReason(outcome.reason ?? "no match")}). As the raw ` +
      `\`tool: ${AWAIT_UI_ELEMENT_TOOL_ID}\` step it replays fine — it reads the same tree it ` +
      `just passed against. What conversion costs you depends on WHY the two disagree: if the ` +
      `trees really do differ over this element, an \`assert:\` conversion fails the same way ` +
      `(it reads that tree on the same short grace this probe just used), and an \`await:\` ` +
      `does too unless ${awaitStillNeeds(condition as WaitCondition)} within its longer ` +
      `timeout; if the SCREEN simply moved on since the live wait, this verdict is no evidence ` +
      `against either — at replay the directive runs where that wait ran, not a moment after ` +
      `it.` +
      // Ahead of the tree stories: when it applies it makes all of them
      // inapplicable.
      (condition === "text" ? textTieClause(args.udid) : "") +
      " " +
      SPELLING_CLAUSE +
      " " +
      `${treeDivergenceFor(args.udid, condition as WaitCondition)} ` +
      `${runnerSideReadClause(args.udid, condition as WaitCondition)}`,
  };
}

/**
 * For a recorded `gesture-tap`, look up the element under the tapped point and
 * record a portable `tap: { selector }` step instead of raw coordinates.
 * Returns the selector (possibly with a caveat warning), or a warning
 * describing why coordinates were kept.
 *
 * Reads `fetchFlowTree`, the tree the runner resolves selectors against at
 * replay — NOT the agent-facing describe tree, which collapses an iOS
 * `accessible` container into one merged-label leaf that exists on no single
 * view in the replay hierarchy, and trims Android's testID-only containers the
 * replay tree keeps. A describe-derived selector could fail — or hit a
 * different element — at replay while recording reported success.
 *
 * The launched app is passed — unpinned, unlike replay, since recording has no
 * run state vouching for the foreground app — because a recording relaunches
 * the app AFTER this tool-server bound its listener: the first tap reads during
 * the connect window, where that id is the only one the iOS tree source can
 * measure, and it yields a measured reason instead of auto-targeting's "Launch
 * or restart the app first".
 */
async function captureTapSelector(
  registry: Registry,
  session: RecordingSession,
  udid: string,
  point: { x: number; y: number }
): Promise<{ selector?: Selector; warning?: string }> {
  try {
    const device = resolveDevice(udid);
    const launched = recordedLaunchedApp(session, device.platform);
    const { tree, source } = await fetchFlowTree(
      registry,
      device,
      launched ? { bundleId: launched, pinned: false, probeAnswered: false } : undefined
    );
    const node = nodeAtPoint(tree, point);
    if (!node) return { warning: "no element found under the tap; kept coordinates (brittle)" };
    const selector = deriveSelector(node);
    if (!selector)
      return { warning: "tapped element has no stable text/id; kept coordinates (brittle)" };
    // Replay resolves through selectorToFrame, whose ranking (exact match →
    // smallest frame → reading order) is free to elect a DIFFERENT element than
    // the tapped one — e.g. the same label on an earlier row. Require the
    // winning frame to cover the tapped point, or the recorded step would
    // silently retarget and coordinates are safer.
    const resolved = selectorToFrame(tree, selector);
    if (!resolved) {
      // Defensive: a selector derived from a visible node matches that node
      // under matchNode's semantics, so this should be unreachable. Kept in
      // case derivation and matching drift apart again.
      return {
        warning: `selector ${describeSelector(selector)} matches no element on this screen; kept coordinates (brittle)`,
      };
    }
    if (!frameContains(resolved, point.x, point.y)) {
      return {
        warning: `selector ${describeSelector(selector)} resolves to a different element on this screen; kept coordinates (brittle)`,
      };
    }
    return { selector, warning: fallbackSourceWarning(source, device.platform) };
  } catch (err) {
    return {
      warning: `selector capture failed (${err instanceof Error ? err.message : String(err)}); kept coordinates`,
    };
  }
}

async function activeFlowState(
  session: RecordingSession
): Promise<{ stepCount: number; note?: string }> {
  if (session.persist === "host") {
    try {
      session.flow = parseFlow(await fs.readFile(session.filePath, "utf8"));
    } catch (err) {
      return {
        stepCount: session.flow.steps.length,
        note:
          `The persisted flow could not be read and parsed (${err instanceof Error ? err.message : String(err)}); ` +
          `the step count is from the last valid in-memory snapshot.`,
      };
    }
  }
  return { stepCount: session.flow.steps.length };
}

async function recordNothing(
  session: RecordingSession,
  guidance: string
): Promise<{
  message: string;
  toolResult: undefined;
  stepCount: number;
  savedTo: FlowSavedTo;
}> {
  const { stepCount, note } = await activeFlowState(session);
  return {
    message: `${guidance} Nothing was executed and no step was recorded.${note ? ` ${note}` : ""}`,
    toolResult: undefined,
    stepCount,
    savedTo: session.filePath,
  };
}

interface DirectiveHint {
  tool: string;
  rewritten: boolean;
  rewriteCondition?: string;
}

const DIRECTIVE_COMMAND_HINTS: Record<string, DirectiveHint> = {
  tap: { tool: "gesture-tap", rewritten: true },
  launch: {
    tool: "restart-app",
    rewritten: true,
    rewriteCondition:
      "when it carries only the bundle id (a call with an extra arg, e.g. an Android `activity`, " +
      "is kept as a raw `tool: restart-app` step to convert during polish)",
  },
  run: {
    tool: "flow-execute",
    rewritten: true,
    rewriteCondition:
      "when the target resolves as a sibling flow in this recording's folder — a `name` that " +
      "does not is kept as a raw `tool: flow-execute` step, and so is every target in a REMOTE " +
      "recording (`run:` composition is host-resolved, so the host cannot validate the client's " +
      "siblings); a `flow_path` that is not a sibling is refused outright and records nothing",
  },
  type: { tool: "keyboard", rewritten: false },
  await: { tool: AWAIT_UI_ELEMENT_TOOL_ID, rewritten: false },
  assert: { tool: AWAIT_UI_ELEMENT_TOOL_ID, rewritten: false },
  pinch: { tool: "gesture-pinch", rewritten: false },
};

const NESTED_RECORDER_TOOLS: Record<string, string> = {
  "flow-add-echo":
    "`flow-add-echo` records a step itself, so it must be called DIRECTLY, not through " +
    "flow-add-step — nesting it would write the echo AND a `tool: flow-add-echo` step that " +
    "fails on every replay.",
  "flow-add-step":
    "flow-add-step cannot record itself. Pass the MCP tool you want to execute as `command`.",
  "flow-start-recording":
    "`flow-start-recording` truncates the flow it names. Recording it as a step would erase " +
    "this flow at replay; call it directly when you want to start a recording.",
  "flow-finish-recording":
    "`flow-finish-recording` ends the recording, so it cannot also be a step in it. Call it " +
    "directly when the walkthrough is complete.",
};

/**
 * Keyed on the error's identity and its `toolId`, so a tool that ran and
 * reported its own "not found" is not read as the command being absent.
 */
function isToolNotFound(err: unknown, command: string): boolean {
  return err instanceof ToolNotFoundError && err.toolId === command;
}

/**
 * Directive keys with no hint, and why. `flow-record-cross-tree.test.ts` holds
 * this against the parser's vocabulary, so a directive added later is either
 * answered or listed here.
 */
export const UNHINTED_DIRECTIVE_KEYS: readonly string[] = [
  // A real `rotate` tool is registered, so the not-found path never fires.
  "rotate",
  // `command` already is the tool name a `tool:` step wants.
  "tool",
];

export function directiveCommandHint(command: string): string | undefined {
  if (command === "echo") {
    return (
      `"echo" is a flow directive, not a tool. Call \`flow-add-echo\` DIRECTLY — not through ` +
      `flow-add-step, which would run it as a nested tool AND record a \`tool: flow-add-echo\` ` +
      `step that fails on every replay.`
    );
  }
  if (command === "wait") {
    return (
      `"wait" is a flow directive, not a tool, and there is no tool that records one — a fixed ` +
      `sleep is not a readiness signal. Record the thing you are actually waiting for with ` +
      `\`${AWAIT_UI_ELEMENT_TOOL_ID}\` instead.`
    );
  }
  if (command === "long-press") {
    return (
      `"long-press" is a flow directive, not a tool, and no tool records one — there is no ` +
      `gesture-long-press. Record the rest of the path, then add the \`long-press:\` step by ` +
      `hand during polish and prove it with the replay.`
    );
  }
  if (command === "scroll-to") {
    return (
      `"scroll-to" is a flow directive, not a tool, and no tool records one — it SEARCHES, ` +
      `scrolling until the target is visible, which no single recorded gesture reproduces. ` +
      `Record the movement with \`gesture-swipe\` (\`gesture-scroll\` on chromium) if the path ` +
      `needs it, then add the \`scroll-to:\` step by hand during polish and prove it with the ` +
      `replay.`
    );
  }
  if (command === "snapshot") {
    return (
      `"snapshot" is a flow directive, not a tool, and no tool records one — it compares the ` +
      `screen against a stored baseline, which \`screenshot-diff\` does not manage. Add the ` +
      `\`snapshot:\` step by hand during polish, then adopt its baseline with a run that sets ` +
      `updateBaselines, and review the PNG before committing it.`
    );
  }
  if (command === "when") {
    return (
      `"when" is a flow directive, not a tool, and no tool records one — it GUARDS the steps ` +
      `nested under it, so there is no action of its own to run. Record those steps, then wrap ` +
      `them in the \`when:\` block by hand during polish and prove both branches with the replay.`
    );
  }
  if (command === "repeat") {
    return (
      `"repeat" is a flow directive, not a tool, and no tool records one — it BOUNDS the steps ` +
      `nested under it, so there is no action of its own to run. Record one pass of those steps, ` +
      `then wrap them in the \`repeat:\` block by hand during polish and prove the bound with the ` +
      `replay.`
    );
  }
  // `Object.hasOwn`, not a bare index: `"constructor"` would hit the prototype
  // and render a hint with `tool: undefined`.
  const hint = Object.hasOwn(DIRECTIVE_COMMAND_HINTS, command)
    ? DIRECTIVE_COMMAND_HINTS[command]
    : undefined;
  if (!hint) return undefined;
  return (
    `"${command}" is a flow directive, not a tool. Record it by calling \`${hint.tool}\` ` +
    `through flow-add-step` +
    (hint.rewritten
      ? ` — the recorder rewrites it into the \`${command}:\` step ${hint.rewriteCondition ?? "for you"}. ` +
        `Where the call is recorded at all, a \`delayMs\` on it opts out of the rewrite: the step is then ` +
        `kept in its raw \`tool: ${hint.tool}\` form (a replay delay has no directive form), so leave ` +
        `\`delayMs\` off if you want the \`${command}:\` step.`
      : `. It is stored as a raw \`tool: ${hint.tool}\` step; converting it to \`${command}:\` ` +
        `is part of the polish pass.`)
  );
}

// A fragment replayed mid-recording through `flow-execute` would record
// verbatim as a brittle `tool: flow-execute` step (baked-in project_root, no
// portability). Capture it as a `run: <name>.yaml` composition directive
// instead — mirroring the gesture-tap → tap rewrite.
const RUN_TARGET_COMMAND = "flow-execute";

/**
 * Rewrite a nested `flow-execute` target from `flow_path` to the equivalent
 * `name`, in place — or reject the call before anything runs.
 *
 * `flow-add-step` forwards the nested call's arguments as opaque JSON, so a
 * `flow_path` inside them never crosses flow-execute's file-input boundary and
 * `resolveFlowSource` would reject it outright. A sibling of the recording is
 * the one target with a boundary-verified equivalent: the same file the `name` +
 * `project_root` pair already resolves to, in a directory flow-start-recording
 * established through its own boundary. Every other flow_path is refused here —
 * a raw `tool:` step has no boundary to resolve a path through at replay either.
 */
async function rewriteSiblingFlowPath(
  session: RecordingSession | null,
  args: Record<string, unknown>
): Promise<void> {
  const flowPath = args.flow_path;
  // A call naming both sources — or neither — is flow-execute's schema to judge.
  if (typeof flowPath !== "string" || args.name !== undefined) return;

  const invalid = (detail: string): FailureError =>
    new FailureError(
      `Cannot record a flow-execute of flow_path "${flowPath}": ${detail}. flow_path carries no ` +
        `file-input resolution through flow-add-step's opaque args — pass name + project_root ` +
        `for a flow saved beside the recording, or add a \`run: <relative path>.yaml\` step to ` +
        `the flow YAML by hand for a cross-directory target.`,
      {
        error_code: FAILURE_CODES.FLOW_FILE_INVALID,
        failure_stage: "flow_add_step_flow_path",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );

  if (!session || session.persist !== "host") {
    throw invalid(
      "the recording is not persisted on this host, so its siblings cannot be resolved here"
    );
  }
  // Reject ".." segments: the sibling checks below compare path.resolve
  // results, which collapse ".." lexically, but the kernel resolves a symlinked
  // directory component first — "<flowsDir>/link/../<stem>.yaml" can open a file
  // outside flowsDir yet pass every check, so the rewrite would run the flows-dir
  // <stem> instead. Same constraint as flow_path_dotdot in flow-run.ts.
  if (flowPath.split(/[\\/]+/).includes("..")) {
    throw invalid(
      'flow paths must not contain ".." segments — sibling identity is decided lexically ' +
        "from this path, and a symlinked directory component would make the rewrite run a " +
        "different file than the path opens"
    );
  }
  const ext = path.extname(flowPath);
  // path.extname reads a basename that is only the extension as an
  // extensionless dotfile, so ext is "" for ".yaml" (and ".YAML") and the arms
  // below would blame the extension of a path that visibly ends in .yaml. What
  // is missing is the stem, which assertSafeFlowName reports below.
  const bareExtension = path.basename(flowPath).toLowerCase() === ".yaml";
  if (!bareExtension && ext !== ".yaml") {
    // On case-insensitive filesystems the path looks valid to the user, so name the real problem.
    throw invalid(
      ext.toLowerCase() === ".yaml"
        ? `flow files must use the lowercase .yaml extension, not "${ext}"`
        : "flow files must use the .yaml extension"
    );
  }
  // The recording's own dir, not getFlowsDir(): only a sibling of the flow
  // being recorded composes as `run:`.
  const flowsDir = path.dirname(session.filePath);
  if (path.resolve(path.dirname(flowPath)) !== path.resolve(flowsDir)) {
    throw invalid(
      `it is not in the recording's flow directory ("${flowsDir}"), and a raw tool: step has ` +
        `no boundary to resolve a path through at replay`
    );
  }
  // basename leaves a suffix in place when stripping it would leave nothing, and
  // strips only an exact-case one — so ".yaml" and ".YAML" would otherwise be
  // reported as a flow *named* that, not as a missing stem.
  const stem = bareExtension ? "" : path.basename(flowPath, ".yaml");
  assertSafeFlowName(stem);
  // Only sound while `name` under the caller's project_root names this very
  // file — otherwise the rewrite would silently run a different flow. The root
  // must be absolute for that comparison to mean anything: path.resolve anchors
  // a relative root at the tool SERVER's cwd, which bears no relation to the
  // calling agent's. flow-execute itself demands an absolute root
  // (`assertValidProjectRoot`, called by `resolveFlowSource` before either of
  // its branches), so this refuses nothing that could have run.
  const projectRoot = args.project_root;
  if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) {
    throw invalid(
      `project_root must be an absolute path (got ${typeof projectRoot === "string" ? `"${projectRoot}"` : "none"}) — a relative root would be resolved against the tool server's cwd, not the calling agent's`
    );
  }
  if (path.resolve(flowsDirFor(projectRoot), `${stem}.yaml`) !== path.resolve(flowPath)) {
    throw invalid(`project_root "${projectRoot}" does not resolve "${stem}" to it`);
  }

  // Every check above compared the SUPPLIED spelling lexically. On a
  // case-insensitive filesystem (APFS, NTFS) the nested flow-execute would open
  // a sibling really named "sibling.yaml" for "Sibling.yaml", and the rewrite
  // would bake `run: Sibling` into the recorded YAML — the one output that is
  // committed and replayed elsewhere, so it replays green here and fails on
  // every case-sensitive checkout (Linux CI). Require the supplied basename to
  // appear in the flows dir byte-for-byte; an unreadable listing still skips the
  // check (classifyOnDiskSpelling). Both other verdicts refuse: unlike a bare
  // `name`, this path names a file the caller says exists, so a listing lacking
  // it entirely is the same phantom spelling with no neighbour to name.
  const suppliedBase = path.basename(flowPath);
  const spelling = await classifyOnDiskSpelling(flowsDir, suppliedBase);
  if (spelling.state !== "listed") {
    // Hint the real spelling only when this same ladder would accept it (a
    // stem-case slip like Sibling.yaml); an invalid real name (sibling.YAML)
    // needs a rename, not a flow_path the extension arm will refuse.
    const recovery =
      spelling.state === "absent"
        ? `pass the basename exactly as it appears on disk`
        : spelling.addressable
          ? `pass flow_path with the on-disk basename "${spelling.actual}"`
          : `rename "${spelling.actual}" to "${suppliedBase}" to record it — flow files must be lowercase .yaml`;
    throw invalid(
      `the file must be named as it appears on disk — no directory entry is named ` +
        `"${suppliedBase}"` +
        (spelling.state === "case_folded"
          ? ` (this filesystem matched it case-insensitively to "${spelling.actual}")`
          : "") +
        `, so the recorded run: step would name a flow no case-sensitive checkout can find — ` +
        recovery
    );
  }

  delete args.flow_path;
  args.name = stem;
}

/**
 * For a recorded `flow-execute` call, decide whether to record it as a
 * `run: <name>.yaml` directive. Returns the path to compose, or a warning
 * explaining why the raw `flow-execute` step was kept.
 *
 * The `run:` directive itself is not sibling-scoped: it composes any relative
 * YAML path, cross-directory included (`run: ../shared/login.yaml`), against
 * the containing file's canonical directory with no path fence (`execRunStep`
 * in flow-run.ts). The RECORDER deliberately emits only the sibling subset:
 * `<name>.yaml` beside the recording's REAL file is the one target shape it can
 * validate here and identity-check against the file the live sub-invoke
 * executed; a cross-directory composition is authored by editing the YAML. The
 * anchor is the realpath'd containing-file dir because the runner's is
 * (scopeFlowDir in flow-run.ts), so a recording made through a symlink
 * validates its sibling in the canonical directory. So the raw step is kept
 * only when the target can't be resolved as a sibling, the sibling is not the
 * file the live sub-invoke executed, or the recording is remote (the host can't
 * read the client's sibling files). A `flow_path` target reaches here as its
 * sibling `name` or not at all — see {@link rewriteSiblingFlowPath}.
 *
 * "Resolved as a sibling" is the same two-part identity {@link
 * rewriteSiblingFlowPath} demands of a flow_path, asked of the name route: the
 * call's own `project_root` must resolve `name` to the very file `run:` will
 * resolve beside the recording's real file — compared canonically, since those
 * two anchors reach it by different spellings — and that directory must list
 * `<name>.yaml` byte-for-byte. Every refusal keeps the raw step rather than
 * throwing: unlike the rewrite, this runs AFTER the nested flow ran on the
 * device, so a throw would discard the record of a step that already happened.
 * The raw step still replays the flow that actually ran, carrying the caller's
 * own project_root.
 */
async function captureRunTarget(
  session: RecordingSession,
  args: Record<string, unknown>
): Promise<{ flow?: string; warning?: string }> {
  const name = typeof args.name === "string" ? args.name : undefined;
  if (name === undefined) {
    return { warning: "flow-execute call had no flow name; kept the raw step" };
  }
  if (session.persist !== "host") {
    return {
      warning: `kept the raw flow-execute step — run: composition is host-resolved, so a remote recording can't reference "${name}" portably`,
    };
  }
  try {
    assertSafeFlowName(name);
    // Resolve against THIS recording's own flows dir, not the project root the
    // nested flow-execute ran under: `run:` composes siblings of the flow being
    // recorded, which is not necessarily the project that nested call ran in —
    // and against the recording's REAL file, because the runner resolves the
    // recorded `run:` against the canonical containing-file directory
    // (scopeFlowDir in flow-run.ts). When the recording is itself a symlink, a
    // sibling beside the symlink's spelling would validate here yet fail at
    // replay. A realpath failure lands in the catch below — an anchor we cannot
    // canonicalize is one we cannot promise will replay.
    const realFlowPath = await fs.realpath(session.filePath);
    const flowsDir = path.dirname(realFlowPath);
    const fragPath = path.join(flowsDir, `${name}.yaml`);

    // The live invoke resolved `name` under the CALL's project_root; a recorded
    // `run:` resolves it beside the recording. Those are the same file only
    // while that root's flows dir is this one — a nested call naming another
    // project's `<name>.yaml` runs that copy live and would record a step
    // running this one: same name, different flow, both green, nothing said.
    // The comparison is below, once the sibling has been read; this guard only
    // settles that the root can be compared at all — path.resolve anchors a
    // relative root at the tool SERVER's cwd, which bears no relation to the
    // calling agent's. flow-execute's resolver demands an absolute root, so any
    // call that got past the live invoke has one; this covers direct execute()
    // callers, which bypass that schema.
    const projectRoot = args.project_root;
    if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) {
      return {
        warning:
          `kept the raw flow-execute step — project_root must be an absolute path ` +
          `(got ${typeof projectRoot === "string" ? `"${projectRoot}"` : "none"}) to confirm ` +
          `"${name}" names the recording's own sibling`,
      };
    }

    // A composed `run:` name is written into the recorded YAML, the one output
    // that gets committed and replayed elsewhere. On a case-insensitive
    // filesystem (APFS, NTFS) `name: "Frag"` opens a sibling really named
    // "frag.yaml", and the read below would too, baking `run: Frag` into a flow
    // no case-sensitive checkout (Linux CI) can resolve. flow-execute's own name
    // gate refuses that spelling one layer down — against this very directory,
    // since the identity check below forces the two to coincide — but it skips
    // on a listing that momentarily refused to be read (EMFILE under load), and
    // the recorder does not take the spelling of a reference it commits on the
    // word of the tool it dispatched. Only a case-folded verdict keeps the raw
    // step: a name matching nothing at all is an ordinary missing sibling, which
    // the read below reports far better than a casing complaint could.
    const spelling = await classifyOnDiskSpelling(flowsDir, `${name}.yaml`);
    if (spelling.state === "case_folded") {
      // Hint a name only when one can reach the file: an on-disk .YAML is
      // addressable by no name at all (this route always builds "<name>.yaml"),
      // so that fork asks for the rename it really needs.
      const recovery = spelling.addressable
        ? `re-run it as name "${path.basename(spelling.actual, ".yaml")}" to record it`
        : `rename "${spelling.actual}" to "${name}.yaml" to record it — flow files must be ` +
          `lowercase .yaml`;
      return {
        warning:
          `kept the raw flow-execute step — no sibling is named "${name}.yaml" (this filesystem ` +
          `matched it case-insensitively to "${spelling.actual}"), so a run: ${name} step would ` +
          `name a flow no case-sensitive checkout can find — ${recovery}`,
      };
    }

    // Parsing validates the sibling exists and is a well-formed flow; a failure
    // falls through to keeping the raw step.
    parseFlow(await fs.readFile(fragPath, "utf8"));
    // The sibling validated above is the file the runner will replay — but the
    // live sub-invoke that just ran resolved `name` through getFlowPath, the
    // as-written flows dir under the caller's project_root. When the recording
    // is a symlink out of the flows dir the two anchors can name different
    // files, so require them to canonicalize to the same one, matching the
    // runner's own canonicalization (canonicalFlowPath in flow-run.ts realpaths
    // before reading). An executed path that cannot be canonicalized (e.g.
    // ENOENT) means nothing verifiable ran from the flows dir, and the raw step
    // is then the honest record: it replays via name + project_root.
    let executedPath: string | undefined;
    try {
      executedPath = await fs.realpath(path.join(flowsDirFor(projectRoot), `${name}.yaml`));
    } catch {
      executedPath = undefined;
    }
    if (executedPath === undefined) {
      return {
        warning: `kept the raw flow-execute step — could not verify which file the live flow-execute ran ("${name}" has no canonical file in project_root's flows dir to compare the sibling against)`,
      };
    }
    if (executedPath !== (await fs.realpath(fragPath))) {
      return {
        warning:
          `kept the raw flow-execute step — project_root "${projectRoot}" resolves "${name}" to ` +
          `"${executedPath}", not the recording's sibling "${fragPath}", so "${name}.yaml" beside ` +
          `the recording's real file is not the file the live flow-execute ran and a run: ${name} ` +
          `step would replay a different flow than the one that just ran`,
      };
    }
    return { flow: `${name}.yaml` };
  } catch (err) {
    return {
      warning: `could not resolve "${name}" as a sibling fragment (${err instanceof Error ? err.message : String(err)}); kept the raw flow-execute step`,
    };
  }
}

export function createFlowAddStepTool(registry: Registry): ToolDefinition<
  z.infer<typeof zodSchema>,
  {
    message: string;
    toolResult: unknown;
    stepCount: number;
    recorded?: string;
    savedTo: FlowSavedTo;
  }
> {
  return {
    id: "flow-add-step",
    interaction: {
      // Name the flow: recordings are concurrent, so several of these lines can
      // interleave in one log and "the recorded flow" would not say which.
      startedMsg: ({ params }) => `Adding ${params.command} step to flow ${params.name}`,
      completedMsg: ({ params, result }) =>
        result.recorded === undefined
          ? `Recorded no ${params.command} step in flow ${params.name}`
          : `Added ${params.command} step to flow ${params.name}`,
      failedMsg: ({ params, failureSignal }) =>
        `Failed to add ${params.command} step to flow ${params.name}: ${failureSignal.error_code}`,
    },
    description: `Execute a tool call and record it as a step in the flow named by \`name\` + \`project_root\` (the recording must already be open — see flow-start-recording). Use when recording a flow and you want to run and capture each action. A coordinate \`gesture-tap\` is recorded as a portable \`tap: { selector }\` step when the tapped element has stable text/identifier (otherwise coordinates are kept with a warning); a \`restart-app\` is recorded as a \`launch\` step (record one FIRST to make the flow a self-contained e2e flow; restart-app has no chromium support, so a chromium flow records as a fragment — add the \`launch: { chromium: <app path> }\` line to the YAML afterward, deleting the executionPrerequisite line if one was recorded: a flow that starts with a launch must not declare it).
A recorded \`await-ui-element\` that PASSED is re-probed against the tree the RUNNER resolves \`await:\`/\`assert:\` directives against, which is NOT the tree the live call read; a wait that came back \`{ success: false }\` is not probed at all, and its warning says so; when the condition does not hold there the step is still recorded and \`message\` carries a warning to read before converting — whether the conversion actually breaks depends on WHY the two disagree, since a screen that moved on between the live wait and the re-probe reads the same way. If that tree could not be read at all, the warning says so instead: the conversion is UNKNOWN, not known-bad. The probe judges the selector exactly as recorded, so write the conversion in the strict map spelling (\`{ visible: { text: Continue } }\`, copying the step's \`selector:\`) — the bare-string spelling (\`{ visible: Continue }\`) re-parses as a loose selector that resolves identifier-first and falls back to text, which is a different check. \`message\` also warns when the live wait itself came back \`{ success: false }\` — that tool reports a failed wait by returning rather than throwing, so the step is recorded either way. That warning names the cause, because only one of them judges the condition: a genuine miss will stop the run at replay, while a wait whose tree source was unreadable, or one that was cancelled, observed nothing and leaves the condition UNKNOWN.
Returns { message, toolResult, stepCount, recorded, savedTo } on success — \`message\` is \`Step added to "<name>" flow\` plus any warning about what was recorded (read it; a warning never means the step was skipped). If it fails an error is returned and nothing is recorded. Two calls SUCCEED while recording nothing, and omit \`recorded\` to say so: a \`command\` naming a recording tool, and one naming a flow-file directive rather than a tool. Both answer with what to do instead — usually the call to make (the tool that records that directive, or the recording tool called directly), but \`wait\`, \`long-press\`, \`scroll-to\`, \`snapshot\`, \`when\` and \`repeat\` have no recording tool, so those name no call and say what to record or add by hand in its place. Either way nothing runs at the device and the take is left untouched — read \`recorded\`, not the status, to know whether a step was appended.
If a step was recorded by mistake, remove it from the .yaml after \`flow-finish-recording\` rather than during the recording: against a remote client the in-memory copy is authoritative and every write serializes it over your edit, and in host mode a mid-recording edit renumbers the steps, which costs the finish the cross-tree verdicts anchored to them.`,
    // The recorded tool RUNS here, so this call lasts as long as whatever it
    // wraps, and the three it most often wraps declare this too. Without it the
    // MCP adapter capped the POST at 30s and retried the identical body four
    // more times — and every retry re-runs the action and appends another step,
    // because an aborted request still appends its first.
    longRunning: true,
    zodSchema,
    services: () => ({}),
    async execute(_services, params, ctx) {
      const session = await requireRecordingSession(params.project_root, params.name);

      // Before parsing `args`, so a malformed payload cannot pre-empt this
      // guidance with a bare JSON error. `Object.hasOwn`, not a bare index: an
      // inherited member would read truthy off the prototype chain.
      const nested = Object.hasOwn(NESTED_RECORDER_TOOLS, params.command)
        ? NESTED_RECORDER_TOOLS[params.command]
        : undefined;
      if (nested) return recordNothing(session, nested);

      let args: Record<string, unknown>;
      try {
        args = params.args ? JSON.parse(params.args) : {};
      } catch (err) {
        // The hint normally fires from the sub-invoke catch below, which a
        // malformed payload never reaches. Gated on the registry, not the hint
        // table alone, so a real tool of that name still reports its own error.
        if (registry.getTool(params.command) === undefined) {
          const hint = directiveCommandHint(params.command);
          if (hint) return recordNothing(session, hint);
        }
        throw err;
      }

      // Snapshot before the rewrite below mutates `args` in place, so a schema
      // miss can be re-rendered against the keys the author wrote. Shallow is
      // enough: `rewriteSiblingFlowPath` only deletes and adds top-level keys.
      const authoredArgs = { ...args };

      // A nested flow-execute must never carry a raw flow_path into the live
      // invoke — it has no boundary metadata there and would be rejected.
      if (params.command === RUN_TARGET_COMMAND) await rewriteSiblingFlowPath(session, args);

      // Selector capture must read the tree BEFORE the tap runs: a navigating
      // tap (e.g. a list row that opens a detail screen) replaces the screen, so
      // the tapped element is gone by the time the tap returns.
      const isTap =
        params.command === "gesture-tap" &&
        params.delayMs === undefined &&
        typeof args.udid === "string" &&
        typeof args.x === "number" &&
        typeof args.y === "number";

      let captured: { selector?: Selector; warning?: string } | undefined;
      if (isTap) {
        captured = await captureTapSelector(registry, session, args.udid as string, {
          x: args.x as number,
          y: args.y as number,
        });
      }

      let toolResult: unknown;
      try {
        toolResult = await invokeSubTool(registry, ctx, params.command, args);
      } catch (err) {
        const hint = isToolNotFound(err, params.command)
          ? directiveCommandHint(params.command)
          : undefined;
        if (hint) return recordNothing(session, hint);

        const reframed = describeNestedParamError(
          registry,
          err,
          params.command,
          args,
          authoredArgs
        );
        if (reframed === undefined) throw err;
        throw new FailureError(reframed, {
          error_code: FAILURE_CODES.TOOL_INPUT_INVALID,
          failure_stage: "flow_add_step_nested_params",
          failure_area: "tool_server",
          error_kind: "validation",
        });
      }

      // A wait that HELD is asked the runner's tree as well, so the author
      // learns now — rather than after polish — whether the conversion is safe.
      // One that came back success:false is reported by CAUSE instead: only a
      // genuine miss fails the step at replay (see {@link UNMET_WAIT_WARNING});
      // an unreadable tree or a cancellation observed nothing (see
      // {@link UNREADABLE_WAIT_WARNING}).
      //
      // The two are filed under different kinds because only the probe's answer
      // is about converting the step, and the finish counts them separately.
      let waitWarning: { warning: string; kind: "conversion" | "wait" } | undefined;
      if (params.command === AWAIT_UI_ELEMENT_TOOL_ID) {
        if (isUnmetUiWaitResult(params.command, toolResult)) {
          waitWarning = {
            warning: unmetWaitWarningFor(unmetUiWaitCause(toolResult)),
            kind: "wait",
          };
        } else {
          const probed = (await probeAgainstRunnerTree(registry, ctx, args)).warning;
          if (probed) waitWarning = { warning: probed, kind: "conversion" };
        }
      }

      // Running a fragment via flow-execute mid-recording is recorded as a
      // `run:` composition directive rather than a raw, non-portable tool call.
      const runTarget =
        params.command === RUN_TARGET_COMMAND && params.delayMs === undefined
          ? await captureRunTarget(session, args)
          : undefined;

      // A recorded `restart-app` is captured as the portable `launch` directive
      // (same terminate-and-relaunch semantics, plus the runner's post-launch
      // settle and readiness gate at replay). Recorded first, it makes the flow
      // an e2e flow. Only the plain bundleId form maps; extra args (e.g. an
      // Android `activity`) keep the raw tool step. `launch-app` is NOT
      // rewritten — it foregrounds without terminating.
      const strippedArgs = stripDeviceKeys(args);
      const isLaunch =
        params.command === "restart-app" &&
        params.delayMs === undefined &&
        typeof strippedArgs.bundleId === "string" &&
        Object.keys(strippedArgs).length === 1;

      // A multi-tap (`clickCount: 2` = double-tap) must survive the rewrite as
      // `times`, or replay would fire a single tap for a recorded double.
      // Bounds match the tool's clickCount; 1 is the default (absent).
      const cc = args.clickCount;
      const tapTimes =
        isTap && typeof cc === "number" && Number.isInteger(cc) && cc >= 2 && cc <= 10
          ? { times: cc }
          : {};

      let step: FlowStep;
      let warning: string | undefined;
      if (captured?.selector) {
        step = { kind: "tap", selector: captured.selector, ...tapTimes };
        warning = captured.warning;
      } else if (isTap) {
        // No stable selector — keep a coordinate tap, but still as a `tap:`
        // directive so every tap reads uniformly.
        step = { kind: "tap", x: args.x as number, y: args.y as number, ...tapTimes };
        warning = captured?.warning;
      } else if (isLaunch) {
        step = { kind: "launch", app: strippedArgs.bundleId as string };
      } else if (runTarget?.flow) {
        step = { kind: "run", flow: runTarget.flow };
      } else {
        warning = waitWarning?.warning ?? runTarget?.warning;
        // The step ran live with the full args (incl. the device id), but the
        // recorded form drops it so the flow stays portable — the runner injects
        // whatever device it resolves at replay.
        step = {
          kind: "tool",
          name: params.command,
          args: strippedArgs,
          delayMs: params.delayMs,
        };
      }

      const { savedTo, stepCount } = await appendStepToFlow(session, step);

      // Keep the probe's verdict for `flow-finish-recording`. It answers a
      // polish-time question, and polish starts after the recording closes — by
      // which point this `message` is many tool results back. Filed under the
      // step's number and carrying the step itself, so a hand edit cannot pass
      // the verdict to whatever inherits that number (see
      // {@link RecordedStepWarning}).
      //
      // Only this warning is carried. The finish summary already shows the
      // other two by rendering what was written: kept coordinates read as
      // `N. tap: (x, y)`, and a kept raw step reads as `N. tool: flow-execute`.
      // A step that breaks on conversion renders like one that does not.
      if (waitWarning) {
        (session.stepWarnings ??= new Map()).set(stepCount, {
          ...waitWarning,
          step: stepAnchor(step),
        });
      }

      return {
        message: `Step added to "${params.name}" flow${warning ? ` — ${warning}` : ""}`,
        toolResult,
        stepCount,
        recorded: summarizeStep(step, stepCount),
        savedTo,
      };
    },
  };
}
