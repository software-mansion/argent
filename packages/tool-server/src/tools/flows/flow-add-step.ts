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
  assertSessionStillLive,
  withRecordingLock,
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
import { nestedOrchestratorOutcome } from "./flow-nested-outcome";
import { probeWhenCondition, type DirectiveOutcome } from "./flow-actions";
import { stepAnchor, summarizeStep } from "./flow-finish-recording";
import { invokeSubTool, describeNestedParamError } from "../../utils/sub-invoke";
import { resolveDevice } from "../../utils/device-info";
import { settleWithin } from "../../utils/timing";
import { stripDeviceKeys } from "./flow-device";
import { fetchFlowTree } from "./flow-tree";
import type { DescribeFrame, DescribeNode, DescribeSource } from "../describe/contract";
import {
  nodeAtPoint,
  deriveSelector,
  selectorToFrame,
  frameContains,
  GENERIC_ROLES,
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
        '"echo", "wait", "long-press", "scroll-to", "snapshot", "when") is answered with guidance, ' +
        "and nothing runs or is recorded: most name the tool that records the directive, while " +
        '"wait", "long-press", "scroll-to", "snapshot" and "when" have no recording tool at all and ' +
        "are answered with what to do instead. A recording tool (flow-add-step, flow-add-echo, " +
        "flow-start-recording, flow-finish-recording) is refused the same way, each for its own " +
        "reason — nesting one would erase this flow at replay, end the take, or write the step twice."
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

// The full-hierarchy source replay gates on per platform (`treeSourceGate` in
// flow-run.ts). A capture from the fallback source was derived against a tree
// the replay will refuse to degrade to, so the selector deserves a caveat even
// when it derives cleanly. Chromium/Vega have a single source — no caveat.
const REPLAY_TREE_SOURCES: Record<string, DescribeSource> = {
  ios: "native-devtools",
  android: "android-devtools",
};

/**
 * The app this recording last started, from the `launch` step the recorder
 * captured for it — the session's stand-in for the runner's
 * {@link ActionEnv.launchedNativeApp}. Last rather than first: a recording that
 * relaunches mid-way is about the newer app from that point on, exactly as a
 * nested `launch:` retargets a run.
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

// `resolveDevice` classifies by shape and cannot throw, so no guard is needed.
function platformOf(udid: unknown): string | undefined {
  return typeof udid === "string" ? resolveDevice(udid).platform : undefined;
}

/**
 * Floor under both clause tables below. Nothing reaches it: they are consulted
 * only for a DETERMINATE verdict, which needs `fetchFlowTree` to have answered
 * — and it answers on exactly ios / android / chromium / vega, each of which
 * has its own arm.
 */
const UNSUPPORTED_PLATFORM = {
  divergence: "The recorder and the runner read different projections of the screen.",
  read: "No read-only tool is known to report the runner's projection on this platform — keep the step raw",
} as const;

/**
 * The read-only tool that reads the tree the RUNNER resolves against, for the
 * platforms where one exists. Android is deliberately routed elsewhere (see
 * {@link runnerSideReadClause}): no read-only tool exposes its runner tree, so
 * this helper is only ever called here for iOS / Chromium / Vega.
 *
 * `native-find-views` declares Apple capability only, so it is named for iOS
 * alone; iOS `describe` is the AX tree — the RECORDER's side — so it is NOT
 * listed here, where the point is to name the runner's reader.
 */
function treeReaderFor(udid: unknown): string {
  const platform = platformOf(udid);
  if (platform === "ios" || platform === "ios-remote") return "`native-find-views`";
  if (platform === "chromium") return "`describe` (this platform's DOM walker)";
  return "`describe`";
}

/**
 * The remedy half of the iOS/Android clause, which is not the same advice for
 * every condition.
 *
 * On `visible`/`exists`/`text` a determinate verdict means the runner's tree
 * does NOT have what the check wanted, so "retarget at an id the full hierarchy
 * carries" is right. On `hidden` it means the opposite: the verdict fires
 * because that tree still HAS the element, so the same advice makes the
 * directive match MORE surely. {@link awaitStillNeeds} draws the same
 * distinction one clause earlier.
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
 * How to read the tree the RUNNER resolves against — or, on iOS, Android and
 * Chromium, that no read-only tool does. Each arm says why its near miss is not
 * that tree, since naming one under the banner of the runner's is the exact
 * steer this warning exists to prevent.
 *
 * On iOS and Android the remedy is to fix the CONVERSION, never to re-record:
 * the create-flow workflow this divergence comes out of gates on visible text
 * precisely because the trimmed tree hides the id, so sending the author back
 * to the recorder asks for a step the skill just said cannot be recorded.
 *
 * On iOS the near miss is also SHALLOWER: `native-full-hierarchy` defaults to
 * `maxDepth: 8` where the runner's read asks for 100, so absent from it does
 * not mean absent from the runner's tree until the depth is raised.
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
    // No remedy here may assume the runner dropped the element: `describe` can
    // show a node the runner keeps under another name (a password field) and
    // omit one it has (past its 5000-node walk). Running the conversion settles it.
    const settle =
      "No read-only tool exposes the runner's trimmed tree on Chromium — `describe` re-reads the " +
      "same DOM on a shorter walk, so it both lists nodes the runner drops and omits nodes the " +
      "runner keeps — so settle it by running the conversion: put the directive in a flow and " +
      "`flow-execute` it. ";
    // Both chromium tips make the directive match MORE surely, which is right
    // only while the check wants the element THERE — the distinction the
    // iOS/Android arms draw in {@link retargetRemedy}.
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
      // Not "a zero-height frame": `normRect` clamps each edge on its own, so a
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
 * The cause no tree story can rule out: the probe reads the device a moment
 * after the live wait returned, so a screen that moved on in between gives this
 * same verdict with both trees in perfect agreement. Vega has no other cause;
 * the rest must still admit it, or an author whose toast merely expired
 * rewrites a selector that was never wrong.
 */
const SCREEN_MAY_HAVE_MOVED =
  " A screen that changed between the live wait and this re-probe reads the same way, so rule " +
  "that out first.";

/**
 * WHY the recorder's tree and the runner's tree can disagree — a different
 * story per platform. Each names what the two projections do differently
 * WITHOUT asserting which side lost the element: on Chromium both directions
 * are reachable, and a message that always blames the runner sends the author
 * to fix the wrong end.
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
    // Both halves of `projectChromiumNode`'s test: it keeps a node only when it
    // is `onScreen && addressable`. Naming addressability alone reads as a
    // verdict on the SELECTOR, so an author whose element is merely below the
    // fold goes hunting for an id it already has.
    //
    // The runner is also not always the side that lost the element. A password
    // field reaches it redacted to `[password]` — an `id` selector resolves it,
    // no text selector can — and past 5000 nodes it is the RECORDER's walk that
    // is short, where the flow tree's goes to 12000. Both are reachable, never
    // at once, and the CONDITION decides which: this probe runs only after the
    // live wait PASSED, so `visible`/`exists`/`text` rules out the recorder's
    // walk limit and `hidden` rules out the flow tree's drops.
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
    // Not "the runner reads a different dump": both sides call the same
    // `devtools.getHierarchy()` RPC. Only the host-side parser and node cap
    // differ, and an author told the two READ different things looks for a
    // second source that does not exist.
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
    // Vega is the one platform whose two trees cannot disagree on an unchanged
    // screen: `projectVegaNode` drops nothing, so membership, frames and
    // visibility are identical, and its hoisted `subtreeText` can only make a
    // `text` check MORE likely to hold. On `text` the two sides can still elect
    // different elements from identical nodes ({@link textTieClause}), so that
    // condition names both causes rather than the screen alone.
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
 * What an `await:` would still be waiting FOR — a different event per
 * condition. "the element reaches that tree" is right for `visible`/`exists`
 * and backwards for `hidden`, where the wait passes when the element LEAVES.
 */
function awaitStillNeeds(condition: WaitCondition): string {
  if (condition === "hidden") return "the element LEAVES that tree";
  // Not "that element's": on `text` the two sides can judge different elements
  // ({@link textTieClause}), the one cause a longer timeout cannot fix.
  if (condition === "text") return "the element THAT tree elects comes to match on it";
  return "the element reaches that tree";
}

/**
 * The cause neither tree story explains, on the one condition that can have it:
 * the selector matched several elements and the two sides elected different
 * ones. `exists`/`visible`/`hidden` quantify over every match, so match order
 * cannot change their answer; `text` reads exactly one — `firstInReadingOrder`
 * over the visible matches — and that helper breaks an EXACT (y, x) tie by
 * encounter order.
 *
 * Why the orders differ is per platform. On Android, Chromium and Vega the
 * recorder collects a nested tree pre-order and the runner emits it post-order,
 * so a container and a text child sharing a frame — routine in React Native —
 * elect differently. iOS has no container to list (both sides are flat), but
 * the two lists come from different sources, so the tie is still reachable.
 *
 * The verdict is right and every other explanation is wrong for it: both trees
 * hold both nodes, nothing moved, and the text the runner read is already
 * final. The one remedy that works — narrow the selector until it resolves a
 * single node — is the one the rest of the message never suggests.
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

/**
 * Which SPELLING of the conversion the verdict is about. The probe re-evaluates
 * `args.selector` exactly as the step carries it — a strict selector. The bare
 * string spelling (`await: { visible: Continue }`) parses as a LOOSE selector,
 * which the runner resolves identifier-first and only falls back to text, so on
 * a screen where some node's id equals the recorded text the two spellings
 * resolve DIFFERENT elements. Say which one was judged rather than predict
 * both. This is the doctrine the recorder already applies to a captured `tap:`.
 */
const SPELLING_CLAUSE =
  "Both of those are about the selector exactly as recorded, so convert it in the strict map " +
  "spelling (`{ text: … }` / `{ id: … }`, a straight copy of the step's `selector:`): a " +
  "bare-string conversion (`{ visible: Continue }`) re-parses as a LOOSE selector — " +
  "identifier first, text only as a fallback — which is a different check this probe never made.";

/**
 * `await-ui-element` reports an unmet condition with `{ success: false }`
 * rather than a throw, so the recorder's success path records the step anyway.
 * The recorder cannot stop anything (the tool already ran), but it must not
 * narrate the step as fine: at replay this is a step FAILURE that ends the run.
 *
 * The cross-tree probe is skipped here, and says so. That probe asks whether a
 * check that PASSED survives conversion to `await:`/`assert:`; this one did not
 * pass, so its divergence remedy would blame a tree mismatch for an element
 * that is on neither tree.
 */
const UNMET_WAIT_WARNING =
  "recorded, but the wait itself never held — `await-ui-element` reports an unmet condition by " +
  "returning success:false instead of failing, so the step was written to the flow anyway. At " +
  "replay an unmet wait FAILS the step and stops the run there, so re-record it once the " +
  // Delete AFTER the finish: against a remote client the in-memory copy is
  // authoritative and the next append writes the step straight back, and a
  // host-mode edit renumbers the steps the finish's verdicts are anchored to.
  "condition can actually hold, and delete the failed step after `flow-finish-recording` rather " +
  "than mid-recording: against a remote client the in-memory copy is authoritative and the next " +
  "append writes the step straight back, and in host mode the recorder re-reads the file before " +
  "each append, so an edit that renumbers the steps costs the finish the verdicts it would " +
  "otherwise carry. The cross-tree re-probe was " +
  "skipped: it asks whether a check that PASSED would survive conversion to `await:`/`assert:`, " +
  "and this one did not pass";

/**
 * The same `success: false` as {@link UNMET_WAIT_WARNING}, reached without a
 * trustworthy read to judge the condition on; {@link unmetUiWaitCause} tells
 * those causes apart from a genuine miss.
 *
 * Neither may reuse the unmet text, which asserts the wait never held and
 * prescribes re-recording. Nor may this one overclaim the other way: "nothing
 * was ever compared" is false of a window that only went dark at the end, and
 * the note carries a tree-source error only where a fetch actually threw.
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

/**
 * The indeterminate reason is quoted VERBATIM, and on iOS what it quotes was
 * written for a different caller: `queryFullHierarchyTree` auto-targets, so
 * with no injected app it throws the shared native-target error, whose recovery
 * ends "provide bundleId explicitly". `await-ui-element` does take one, which
 * makes that look actionable — so correct the quoted advice rather than honour
 * it, in the text below.
 */
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
 * A cancelled re-probe is reported, never thrown. The probe runs AFTER the wait
 * ran on the device, so a throw would discard the record of a step that already
 * happened — the doctrine {@link captureRunTarget} states for the same
 * position. It was also out of band: `AbortError` is special-cased nowhere, so
 * the caller saw REGISTRY_TOOL_EXECUTION_FAILED with `error_kind: "unknown"`,
 * where every other cancellation in the server reports in band.
 *
 * A cancelled probe compared nothing, so like an unreadable runner tree it is
 * UNKNOWN, never known-bad.
 */
const CANCELLED_PROBE_WARNING =
  "recorded, but the re-probe against the tree the RUNNER reads was cancelled before it " +
  "answered. The step itself ran and is written to the flow; only the verdict is missing, so " +
  "whether it would convert to `await:`/`assert:` is UNKNOWN, not known-bad — record the wait " +
  "again, uncancelled, before trusting the conversion";

/**
 * Hard ceiling on the whole re-probe. `probeWhenCondition` polls on the assert
 * grace window, but that bounds only the LOOP: each `fetchFlowTree` inside it
 * is awaited with no time bound, and one more read fires back-to-back after the
 * deadline. A single read can take 10s on Chromium CDP and up to
 * `LONG_RPC_TIMEOUT_MS` on Android, so the nominal 1s window really ceilings at
 * whatever the slowest source takes.
 *
 * The live `await-ui-element` races every fetch through `settleWithin`; the
 * flow runner's copy of the loop does not, and its callers run unattended where
 * an overrun costs only time. The recorder is interactive and this probe is a
 * courtesy check on a step that ALREADY ran, so bound it here rather than
 * change the shared loop. An overrun reports as indeterminate — unknown, never
 * known-bad.
 *
 * Budget the grace plus BOTH reads. A determinate "does NOT hold" costs two
 * full reads (the loop checks its deadline only after a completed read, then
 * fires `finalPoll`) where the clean case returns from the first, so anything
 * less gives the branch that carries the warning half the tolerance of the one
 * that does not. Android flow-tree reads measure 3.4-7.4s on a loaded host, so
 * no ceiling short of the RPC timeout makes a slow read impossible; the point
 * is to stop an ORDINARY slow read from costing the verdict.
 */
const PROBE_MAX_TREE_READ_MS = 2500;
const PROBE_ASSERT_GRACE_MS = 1000; // DEFAULT_ASSERT_TIMEOUT_MS, the loop's own window
const PROBE_BUDGET_MS = PROBE_ASSERT_GRACE_MS + 2 * PROBE_MAX_TREE_READ_MS;

/**
 * Length cap on the probe's own reason, applied ONLY to a determinate verdict.
 * `assertReason`'s `text` arm quotes the matched element's rendered content,
 * and on the flow tree that content is HOISTED — a container's text is every
 * descendant's — so one failed `text` check can carry a whole card, list
 * section or log pane. The reason must name enough to be actionable, not
 * reproduce the screen.
 *
 * An INDETERMINATE reason is quoted whole: it is an environment error, carries
 * no screen content, and its TAIL is routinely the recovery instruction.
 */
const MAX_PROBE_REASON_CHARS = 200;

/**
 * How much of the kept budget goes to the END of an over-long reason.
 * `waitForCondition` closes a determinate reason with the note that its final
 * poll went dark, which qualifies the verdict the whole warning is built on —
 * so elide the MIDDLE rather than drop the tail.
 */
const PROBE_REASON_TAIL_CHARS = 60;

function elisionMarker(dropped: number): string {
  return `… (${dropped} more chars) …`;
}

/**
 * {@link MAX_PROBE_REASON_CHARS} bounds what is EMITTED, not what is kept:
 * budgeting the kept content let the marker push a 201-char reason out at 218.
 * The marker's width depends on the count it reports, so size the head against
 * the WIDEST it can be — `dropped` never exceeds the reason's own length — and
 * the result fits in one pass, with no loop and no overshoot.
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
 * The recorder and the runner read DIFFERENT trees. `await-ui-element`
 * evaluates against the agent-facing describe tree; the `await:`/`assert:`
 * DIRECTIVE that polish converts this step into is evaluated against
 * `fetchFlowTree`'s. How they diverge is per platform (see
 * {@link treeDivergenceFor}), but on none of them does one contain the other,
 * so a check can pass live and fail once converted.
 *
 * Re-probe the same condition against the runner's tree and report the answer.
 * It is a WARNING, never a refusal: the step is recorded as a raw
 * `tool: await-ui-element`, which at replay reads the SAME tree it just passed
 * against. What the probe tells the author is whether the CONVERSION is safe.
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
  // No try/catch: `resolveDevice` is a pure shape classifier, and a platform
  // with no flow tree throws inside `fetchFlowTree`, reported as indeterminate.
  const device = resolveDevice(args.udid);
  // Giving up must STOP the probe, not just stop waiting for it: `settleWithin`
  // only abandons the promise, and the abandoned loop still fires one more full
  // read (`finalPoll`) against a device the recorder has already returned from.
  // Abort it the moment the ceiling decides, so its per-iteration signal check
  // ends it before that read.
  const giveUp = new AbortController();
  const probeSignal = ctx?.signal ? AbortSignal.any([ctx.signal, giveUp.signal]) : giveUp.signal;
  // Bounded by PROBE_BUDGET_MS: the loop's deadline does not bound its reads.
  const settled = await settleWithin(
    probeWhenCondition(
      // The signal rides on ActionEnv separately from `ctx`, so pass both.
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
  // Done with the loop either way; on the timeout path it still holds the device.
  giveUp.abort();
  // Every cancellation arrives HERE and {@link ABORTED_OUTCOME} never does:
  // `settleWithin` latches on `ctx.signal`, the only signal that can reach the
  // loop before `giveUp.abort()` above. So the value arm needs no aborted case.
  if (settled.type === "aborted") return { warning: CANCELLED_PROBE_WARNING };
  // A read that outran the budget and a probe that threw are both "the runner's
  // tree did not answer" — indeterminate, never a verdict. Not the same
  // diagnosis though: on a timeout the source ANSWERED, just too slowly, so the
  // reason must not describe it as absent (the recovery below turns on this).
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
      // Deliberately NOT joined with treeDivergenceFor/runnerSideReadClause:
      // nothing was compared, so claiming the two trees differ would send the
      // author to rewrite a selector that may be perfectly good.
      //
      // "the tree `await-ui-element` reads", not "the accessibility tree" —
      // that is the AX hierarchy only on iOS/Android.
      //
      // Quoted WHOLE, not through `cappedReason` — see MAX_PROBE_REASON_CHARS.
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
  // Determinate: the runner's tree was read and the condition did not hold on
  // it. That is NOT "the two trees disagree" — the same verdict comes back when
  // the screen simply moved on (see SCREEN_MAY_HAVE_MOVED; on Vega that is the
  // ONLY cause), and at replay the directive occupies the live wait's position,
  // not the moment after it where this probe looked. So the CONSEQUENCE stays
  // conditional on the cause the platform clause goes on to give: an absolute
  // "WILL fail" would decide the question that clause asks the author to rule
  // out. This is still the one warning that may explain a divergence.
  return {
    warning:
      `recorded, but this condition does NOT hold against the tree the runner resolves ` +
      `directives against (${cappedReason(outcome.reason ?? "no match")}). As the raw ` +
      `\`tool: ${AWAIT_UI_ELEMENT_TOOL_ID}\` step it replays fine — it reads the same tree it ` +
      `just passed against. What conversion costs you depends on WHY the two disagree: if the ` +
      `trees really do differ over this element, an \`assert:\` conversion fails the same way ` +
      `(it reads that tree on the same short grace this probe just used), and an \`await:\` ` +
      // The remedy belongs to the platform clause: "re-record with a selector
      // present in both trees" is wrong on Vega, where the trees hold the same
      // elements and a disagreement means the screen moved.
      `does too unless ${awaitStillNeeds(condition as WaitCondition)} within its longer ` +
      `timeout; if the SCREEN simply moved on since the live wait, this verdict is no evidence ` +
      `against either — at replay the directive runs where that wait ran, not a moment after ` +
      `it.` +
      // Ahead of the tree stories: when it applies it makes all of them
      // inapplicable, so an author who reads it last has already gone hunting.
      (condition === "text" ? textTieClause(args.udid) : "") +
      " " +
      SPELLING_CLAUSE +
      " " +
      `${treeDivergenceFor(args.udid, condition as WaitCondition)} ` +
      `${runnerSideReadClause(args.udid, condition as WaitCondition)}`,
  };
}

/**
 * `deriveSelector`'s last resort: the tapped node has no identifier and no
 * visible text, so the step replays on role alone. It holds only while that
 * element keeps winning `selectorToFrame`'s ranking. The re-resolve guard below
 * proves that for the recording screen, never for the screen replay meets, so
 * the warning says so instead of leaving it silent.
 *
 * The raised iOS depth cap makes this more common. An unlabeled icon that the
 * device used to truncate away, which left `nodeAtPoint` to pick its `testID`
 * container, is now present and is the smaller frame under the tap.
 */
function roleOnlySelectorWarning(selector: Selector): string | undefined {
  if (selector.role === undefined || selector.identifier !== undefined) return undefined;
  if (selector.text !== undefined || selector.textMatches !== undefined) return undefined;
  return (
    `selector ${describeSelector(selector)} matches by role alone (the tapped element has no id ` +
    `or visible text) — replay takes whichever element of that role ranks first, so re-record ` +
    `against a labelled element if that is not reliably this one`
  );
}

/**
 * A tap target has to be small enough that tapping its CENTRE reproduces the
 * tap. Frames are normalized to the viewport, so this is a share of the screen.
 *
 * The number is a judgement, and the two failures it sits between are both
 * real and both were observed. Too permissive and a container gets recorded:
 * a tap on blank space in a drawer resolved to the drawer's whole scroll area
 * (0.72 of the screen), and replay — which taps a selector's centre — hit the
 * "Chat" item and reported pass while navigating somewhere the walkthrough
 * never went. Too strict and ordinary widgets become unrecordable: a feed post
 * is half the screen and tapping it is a perfectly normal QA step.
 */
const MAX_TAP_TARGET_AREA = 0.6;

function isContainerSized(frame: DescribeFrame): boolean {
  return frame.width * frame.height > MAX_TAP_TARGET_AREA;
}

/**
 * A narrower form of a selector that resolved to the WRONG element — the tapped
 * node's own specific role added to the base. Returned best-first, or empty
 * when nothing narrower is available.
 *
 * A derived selector is the plainest thing that describes the tapped node, so
 * on a screen with repeats — a "Search" label shared by a field and a tab — it
 * is ambiguous rather than absent. Ambiguity is not the same failure as "this
 * element cannot be addressed", and it must not be answered with coordinates:
 * the runner resolves the narrower form.
 *
 * Only the node's OWN role is added, and only when it is specific (not
 * {@link GENERIC_ROLES}). The identifier is deliberately NOT narrowed on:
 * {@link deriveSelector} already makes any stable, non-positional id the BASE
 * selector, so when `base` carries no identifier the node has none left to
 * add — its id is either absent or POSITIONAL, and a positional id is exactly
 * what the recorder refuses. There is nothing an identifier branch here could
 * contribute that deriveSelector has not already used or refused.
 *
 * A `within` scope is deliberately NOT derived here either, even though it
 * would separate one feed row's button from another's: the flow tree is
 * flattened, so a container can only be found geometrically, and geometry is
 * z-order blind. With a modal open, the background screen's elements are still
 * the smallest nodes under the point and the FOREGROUND modal's container is a
 * perfectly good geometric ancestor — a tap on the composer's text input
 * recorded as a feed post "inside" the composer, which then failed on any
 * screen whose feed content differed. The scopes that survive are the ones an
 * author writes knowingly at polish, against a container they have chosen.
 */
function narrowedSelectors(node: DescribeNode, base: Selector): Selector[] {
  if (base.role !== undefined || !node.role || GENERIC_ROLES.has(node.role.toLowerCase())) {
    return [];
  }
  return [{ ...base, role: node.role }];
}

/**
 * Would replaying this selector reproduce the tap?
 *
 * Two things have to hold, and it is worth saying why it is not one.
 *
 * The frame must CONTAIN the tapped point — otherwise the selector matched
 * some other element and lost the ranking, so the step targets the wrong
 * control from the start.
 *
 * And the frame must be small enough to be a control rather than a container
 * (see {@link MAX_TAP_TARGET_AREA}), because replay taps its CENTRE, not the
 * point recorded here. A tap on blank space inside a drawer resolved to the
 * drawer's whole scroll area and replayed onto the "Chat" item, reporting
 * pass while navigating somewhere the walkthrough never went.
 *
 * What this deliberately does NOT do is require the centre to resolve back to
 * the same tree node. That test was tried and is wrong on a FLATTENED tree: a
 * control's own label is a SIBLING rect sitting on its centre, so a like
 * button, a search field, a full-width row and every grid cell were refused —
 * while replaying perfectly, because the touch is still inside the control.
 * Node identity cannot tell a label from an independent control; size can tell
 * a control from a container, which is the distinction that matters here.
 */
function replayReproducesTap(
  frame: DescribeFrame,
  point: { x: number; y: number }
): "ok" | "container" | "retargets" {
  if (isContainerSized(frame)) return "container";
  if (!frameContains(frame, point.x, point.y)) return "retargets";
  return "ok";
}

/**
 * For a recorded `gesture-tap`, look up the element under the tapped point and
 * record a portable `tap: { selector }` step instead of raw coordinates.
 * Returns the selector (possibly with a caveat warning), or a warning
 * describing why coordinates were kept.
 *
 * The lookup reads `fetchFlowTree` — the same tree source the runner resolves
 * selectors against at replay — NOT the agent-facing describe tree. The two
 * differ exactly where recording matters: on iOS the AX tree collapses an
 * `accessible` container into one leaf whose merged label exists on no single
 * view in the replay hierarchy, and on Android the interactables trim drops
 * the testID-only containers the replay tree keeps. A selector derived from
 * the describe tree could fail — or hit a different element — at replay while
 * recording reported success.
 *
 * The launched app the read is given plays the part it plays at replay (see
 * `ActionEnv`): with nothing connected it is the only id the iOS tree source
 * can measure, and the recorder is where that matters most — a recording
 * relaunches the app AFTER this tool-server bound its listener, so the first
 * tap reads during the connect window, whose measured messages say NOT to
 * restart the app. Without it the kept-coordinates warning quotes
 * auto-targeting's "Launch or restart the app first" instead.
 */
async function captureTapSelector(
  registry: Registry,
  session: RecordingSession,
  udid: string,
  point: { x: number; y: number }
): Promise<{ selector?: Selector; warning?: string; ambiguous?: boolean; container?: boolean }> {
  try {
    const device = resolveDevice(udid);
    const launched = recordedLaunchedApp(session, device.platform);
    const { tree, source } = await fetchFlowTree(registry, device, launched);
    const node = nodeAtPoint(tree, point);
    if (!node) return { warning: "no element found under the tap" };
    const selector = deriveSelector(node);
    if (!selector) return { warning: "tapped element has no stable text/id" };
    // Replay resolves through selectorToFrame, whose ranking (exact match →
    // smallest frame → reading order) is free to elect a DIFFERENT element
    // than the tapped one — e.g. the same label on an earlier row. Re-resolve
    // now and require the winning frame to cover the tapped point; otherwise
    // the recorded step would silently retarget, and coordinates are safer.
    const resolved = selectorToFrame(tree, selector);
    if (!resolved) {
      // Defensive: a selector derived from a visible node matches that node
      // under matchNode's semantics, so re-resolving the same tree should
      // always find something. Keep the guard (and an accurate message) in
      // case derivation and matching ever drift apart again.
      return {
        warning: `selector ${describeSelector(selector)} matches no element on this screen`,
      };
    }
    const verdict = replayReproducesTap(resolved, point);
    if (verdict === "container") {
      // The selector resolves to an element covering most of the screen — on
      // some trees a point on empty margin resolves to the screen root itself,
      // which is addressable and looks like a perfectly good `{ id: <screen> }`.
      // At this size the tree cannot tell a container from a genuinely
      // full-bleed control, and narrowing cannot help: the problem is the
      // element, not the selector. Kept coordinates either way — for a real
      // container a centre-tap replay would fire elsewhere, and for a full-bleed
      // control a coordinate replays as well as a selector would.
      return {
        container: true,
        warning:
          `the tap landed on ${describeSelector(selector)}, which covers most of the screen — ` +
          `at that size a container is indistinguishable from a control, and replay taps a ` +
          `selector's CENTRE, so if it is a container a step recorded with it would fire ` +
          `somewhere else entirely`,
      };
    }
    if (verdict === "retargets") {
      // The selector matches the tapped element AND something else, and ranks
      // the other one first. Narrow it before giving up — the runner resolves
      // either narrower form, so answering ambiguity with coordinates would
      // throw away a perfectly good target.
      for (const candidate of narrowedSelectors(node, selector)) {
        const frame = selectorToFrame(tree, candidate);
        if (frame && replayReproducesTap(frame, point) === "ok") {
          return { selector: candidate, warning: fallbackSourceWarning(source, device.platform) };
        }
      }
      return {
        ambiguous: true,
        warning:
          `selector ${describeSelector(selector)} also matches another element on this screen, ` +
          `and ranks it first — narrowing by the tapped element's own role did not single it out`,
      };
    }
    const warnings = [
      roleOnlySelectorWarning(selector),
      fallbackSourceWarning(source, device.platform),
    ].filter((w) => w !== undefined);
    return { selector, ...(warnings.length > 0 ? { warning: warnings.join("; ") } : {}) };
  } catch (err) {
    return {
      warning: `selector capture failed (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

/**
 * How far the recording has got — for responses that record no step but must
 * still say where the flow stands. Host mode re-reads the file so mid-recording
 * edits are honored; client mode's in-memory copy is authoritative.
 *
 * Deliberately NOT the flow's YAML: returning the whole growing file per call
 * made the recorder the largest consumer of a session's context. The full file
 * comes back once, from `flow-finish-recording`.
 *
 * The liveness check comes first, as on the append path. The caller resolved
 * its session BEFORE a tool that can run for minutes, so the recording can be
 * finished, restarted or evicted by now. Without the check, the read below
 * reports another take's step count as this one's.
 *
 * The check and the read hold the flow lock, as {@link appendStepToFlow} does.
 * The check is synchronous and the read is not, and `flow-start-recording`
 * truncates the file under that same lock. A restart between the two would make
 * this report the SUPERSEDED take's count as a success.
 *
 * `ranOnDevice` says whether the refused call already ran, which decides what
 * the liveness error tells the author to undo.
 */
async function activeFlowState(
  session: RecordingSession,
  ranOnDevice: boolean
): Promise<{ stepCount: number; note?: string }> {
  return withRecordingLock(session, async () => {
    assertSessionStillLive(session, ranOnDevice);
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
  });
}

/**
 * The shared return for every path that answers with GUIDANCE and runs nothing:
 * the guidance, the invariant those paths promise, and the unchanged step count
 * so the caller can see its take was left alone. A success rather than a throw,
 * but one that records no line — so `recorded` is absent.
 */
async function recordNothing(
  session: RecordingSession,
  guidance: string
): Promise<{
  message: string;
  toolResult: undefined;
  stepCount: number;
  savedTo: FlowSavedTo;
}> {
  const { stepCount, note } = await activeFlowState(session, false);
  return {
    message: `${guidance} Nothing was executed and no step was recorded.${note ? ` ${note}` : ""}`,
    toolResult: undefined,
    stepCount,
    savedTo: session.filePath,
  };
}

/**
 * `command` names an MCP tool, but the names an author has in mind while
 * recording are the flow file's own directives — so `command: "echo"` reaches
 * here and the registry answers "Tool not found", which says nothing about
 * what to do instead. Name the tool that records that directive.
 */
interface DirectiveHint {
  /** The tool to call instead. */
  tool: string;
  /**
   * Whether the recorder REWRITES that tool call into this directive. Only the
   * commands the step-shaping switch handles are; the rest are stored as raw
   * `tool:` steps for the polish pass to convert. Claiming a rewrite that does
   * not happen sends the author looking for a directive that is not there.
   */
  rewritten: boolean;
  /**
   * The ARG-SHAPE condition on a conditionally rewritten directive, so the hint
   * does not promise a `${command}:` step the recorder then declines to write.
   * Omitted when no arg-shape condition applies (e.g. `tap`). The separate
   * `delayMs` opt-out is appended to every rewrite hint by
   * `directiveCommandHint`, so it is not expressed here.
   */
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
    // Three outcomes, not two: a non-sibling `flow_path` is REFUSED before
    // anything runs, and a remote recording keeps the raw step whatever the
    // target is, because `run:` composition is host-resolved.
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
  // Every parser directive is either here, answered directly by
  // `directiveCommandHint` below, or listed in {@link UNHINTED_DIRECTIVE_KEYS}.
  // `echo`, `wait`, `long-press`, `scroll-to`, `snapshot` and `when` need an
  // answer this table cannot express: `echo` is recorded by a tool called on
  // its OWN, and the other five have no recording tool at all.
};

/**
 * Recorder tools, which must never be `flow-add-step`'s `command`. Each mutates
 * the recording rather than the device, and this call would also append a raw
 * `tool: <recorder>` step that re-runs that mutation at replay, when no
 * recording is open. The damage differs per entry, so each carries its own text.
 */
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
 * Whether the invocation failed because the registry has no tool named
 * `command`, as opposed to the tool running and failing.
 *
 * Keyed on the error's IDENTITY, not its message text: the registry throws a
 * raw `ToolNotFoundError` before the invoke wrapper, while a tool that runs and
 * fails — or whose OWN nested lookup misses — surfaces as a
 * `ToolExecutionError`. Matching `toolId === command` keeps a genuine "not
 * found" message from a tool that ran (e.g. "element not found") from reading
 * as the command itself being absent.
 */
function isToolNotFound(err: unknown, command: string): boolean {
  return err instanceof ToolNotFoundError && err.toolId === command;
}

/**
 * Directive keys this feature deliberately does NOT answer, with the reason.
 * `flow-record-cross-tree.test.ts` holds it against the parser's vocabulary, so
 * a directive added later is either answered or listed here on purpose.
 */
export const UNHINTED_DIRECTIVE_KEYS: readonly string[] = [
  // A real `rotate` tool is registered (device orientation, not the `rotate:`
  // gesture), so the ToolNotFoundError this hangs off never fires.
  "rotate",
  // The raw escape hatch: `command` already IS the tool name a `tool:` step
  // wants.
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
  // `Object.hasOwn`, not a bare index: a caller-controlled `"constructor"` or
  // `"toString"` would otherwise render a nonsense hint (`tool: undefined`).
  const hint = Object.hasOwn(DIRECTIVE_COMMAND_HINTS, command)
    ? DIRECTIVE_COMMAND_HINTS[command]
    : undefined;
  if (!hint) return undefined;
  return (
    `"${command}" is a flow directive, not a tool. Record it by calling \`${hint.tool}\` ` +
    `through flow-add-step` +
    (hint.rewritten
      ? // The `delayMs` clause is appended to EVERY rewrite hint, so scope it
        // to calls that are recorded at all: `run` refuses a non-sibling
        // `flow_path` outright, whatever `delayMs` says, because
        // `rewriteSiblingFlowPath` runs before the invoke and throws.
        ` — the recorder rewrites it into the \`${command}:\` step ${hint.rewriteCondition ?? "for you"}. ` +
        `Where the call is recorded at all, a \`delayMs\` on it opts out of the rewrite: the step is then ` +
        `kept in its raw \`tool: ${hint.tool}\` form (a replay delay has no directive form), so leave ` +
        `\`delayMs\` off if you want the \`${command}:\` step.`
      : `. It is stored as a raw \`tool: ${hint.tool}\` step; converting it to \`${command}:\` ` +
        `is part of the polish pass.`)
  );
}

/**
 * What to do about a tap whose selector could not be captured, now that the
 * raw point has been kept.
 *
 * Three different failures, and they call for different responses: an element
 * nothing can address, one that several things address equally, and one that
 * covers most of the screen. Saying "no selector could be derived" for the
 * second sends the author to re-discover a selector they already have; saying
 * "an element with no id or label" for the third is simply false — the warning
 * names the container's own id. The advice rides on the recorded step's warning
 * because that is the only moment it is read while the screen is still there to
 * retarget against — a coordinate step replays fine today and breaks on the
 * first layout change, which is why the skills treat this warning as a stop
 * rather than a note.
 */
function coordinateRemedy(
  captured: { ambiguous?: boolean; container?: boolean },
  udid: unknown
): string {
  if (captured.ambiguous) {
    return (
      `Disambiguate it: give the intended element its own testID, or tap a target whose id is ` +
      `unique on this screen. At polish, a hand-written \`within\`/\`after\`/\`next\` scope can ` +
      `also single out the element this point hit.`
    );
  }
  if (captured.container) {
    return (
      `Find the specific control under the point with ${treeReaderFor(udid)} and tap ITS centre — ` +
      `the smallest element that is genuinely the target, not the full-screen container it sits in.`
    );
  }
  return (
    `Find the real target with ${treeReaderFor(udid)} and tap its centre. If the element ` +
    `genuinely has no id or label, that is usually worth fixing in the app.`
  );
}

function rawCoordinateWarning(
  command: string,
  args: Record<string, unknown>,
  delayMs: number | undefined
): string | undefined {
  if (command === "gesture-tap" && delayMs !== undefined) {
    return (
      "gesture-tap was kept as a raw coordinate tool step because flow-add-step delayMs prevents " +
      "selector capture; remove delayMs, add a separate wait step before the tap if the pre-action " +
      "delay is necessary, then record the tap again"
    );
  }
  if (command === "restart-app" && delayMs !== undefined) {
    return (
      "restart-app was kept as a raw tool step because flow-add-step delayMs prevents the launch rewrite; " +
      "remove delayMs so restart-app records as the leading launch, then record a post-launch " +
      "await-ui-element readiness gate"
    );
  }
  if (command === "gesture-custom") {
    return (
      "gesture-custom was recorded with raw coordinates because it has no selector-capture rewrite; " +
      "if it contains a tap, record that tap individually with gesture-tap so selector capture can run"
    );
  }
  if (
    command === "run-sequence" &&
    Array.isArray(args.steps) &&
    args.steps.some(
      (step) =>
        typeof step === "object" &&
        step !== null &&
        (step as { tool?: unknown }).tool === "gesture-tap"
    )
  ) {
    return (
      "run-sequence contains coordinate taps and was recorded as one opaque raw step; record taps " +
      "individually so each can become a tap selector"
    );
  }
  return undefined;
}

/**
 * Whether this step must be refused rather than recorded, and why.
 *
 * `flow-execute` and `run-sequence` report a failed, cancelled or never-run
 * nested run in their RESULT, not by throwing. If the recorder does not read
 * that result, a composition that failed everything becomes a step that passed.
 *
 * The verdict comes from {@link nestedOrchestratorOutcome}, the reader the
 * RUNNER scores a nested step with. A step the recorder refuses is a step the
 * runner would not have passed, so one reader keeps the two in agreement.
 *
 * `undefined` means the nested run finished cleanly. A cancel in the trailing
 * delay after the last declared step is clean: that step ran in full.
 */
function nestedRecordRefusal(
  command: string,
  result: unknown,
  aborted: boolean
): { reason: string; mayHaveMutated: boolean } | null {
  const outcome = nestedOrchestratorOutcome(command, result);
  if (!outcome) return null;
  // Read the signal before the verdict, the order the runner uses.
  // `run-sequence` has no abort field: a nested tool that is cancelled returns
  // unmet or throws, and either becomes an ordinary error entry. A
  // verdict-first read would file the author's own cancel as a failed nested
  // step. `skip` is the reader's own abort branch, so it speaks for itself.
  //
  // `attempted` is the third condition, because a cancel can only affect an
  // outcome the run got far enough to have. A `flow-execute` prerequisite
  // notice reached no step, so the wrapper would report a cancel of something
  // that never started.
  const attempted = nestedStepAttempted(result);
  const reason =
    aborted && attempted && outcome.status !== "skip"
      ? `${command} was cancelled (${outcome.reason})`
      : outcome.reason;
  return { reason, mayHaveMutated: attempted };
}

/**
 * The advice asks for a CHECK, not a restore.
 *
 * The result cannot show whether an attempted step moved the device (see
 * {@link nestedStepAttempted}), so this fires on read-only nested runs too. A
 * composed flow of only `assert`s reaches a step and trips it. "Restore the
 * device" would invite a relaunch, and a relaunch shows the start screen, not
 * the state the recorded prefix leaves.
 */
function partialMutationWarning(command: "flow-execute" | "run-sequence"): string {
  const stepKind = command === "flow-execute" ? "composed" : "nested";
  return (
    `Prior ${stepKind} steps may already have changed the device — a step can act and then fail, ` +
    "so the result cannot rule it out. Check the device against the state the recorded prefix " +
    "leaves it in before adding the next step, and put it back by hand if it has moved; " +
    "relaunching the app does NOT reproduce that prefix."
  );
}

/**
 * Whether the nested run ATTEMPTED a step. This is the trigger for the warning
 * that the device may no longer be where the recorded prefix leaves it.
 *
 * Not "did a step succeed". A step often acts and THEN fails. A `scroll-to`
 * scrolls to the end of the list before it reports a miss. A `keyboard` types
 * part of its text before it throws. Both leave `passed` and `completed` at 0
 * while the screen moved. The result settles only whether a step was reached.
 *
 * A false warning is safe, because the message says "may" and asks for a check.
 * Silence leaves the author recording against a screen the prefix cannot reach.
 */
function nestedStepAttempted(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return true;
  const steps = (result as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) {
    // Only `flow-execute`'s prerequisite notice has no step list, because it
    // ran nothing. Any other unknown shape must assume that a step ran.
    return !Object.prototype.hasOwnProperty.call(result, "notice");
  }
  // The flow runner reports one entry per DECLARED step and marks the ones it
  // never reached `skip`. A step CUT SHORT by a cancel is a skip too, and that
  // one can have acted. A `launch` becomes cancellable only after `restart-app`
  // relaunched the app. The runner marks those `reached`.
  //
  // `run-sequence` appends one entry per step it got to, so its entries are
  // attempts. The exceptions carry `dispatched: false`: an unlisted tool, one
  // the platform does not support, or args the registry refuses. A sequence
  // rejected on its FIRST step touched nothing, and a warning there would
  // contradict "after 0 of N steps" in the same message.
  return steps.some((s) => {
    if (typeof s !== "object" || s === null) return true;
    const entry = s as { status?: unknown; reached?: unknown; dispatched?: unknown };
    if (entry.status === "skip") return entry.reached === true;
    return entry.dispatched !== false;
  });
}

// Replaying a fragment to set up state during recording is done by running it
// through `flow-execute`. Recorded verbatim that becomes a brittle
// `tool: flow-execute` step (baked-in project_root + device, no portability).
// Instead, capture it as a `run: <name>.yaml` composition directive —
// mirroring the gesture-tap → tap rewrite.
const RUN_TARGET_COMMAND = "flow-execute";

/**
 * Rewrite a nested `flow-execute` target from `flow_path` to the equivalent
 * `name`, in place — or reject the call before anything runs.
 *
 * `flow-add-step` forwards the nested call's arguments as opaque JSON, so a
 * `flow_path` inside them never crosses flow-execute's file-input boundary and
 * `resolveFlowSource` would reject it outright. A sibling of the recording is
 * the one target with a boundary-verified equivalent: the same file the
 * `name` + `project_root` pair already resolves to, in a directory
 * flow-start-recording established through its own boundary. Every other
 * flow_path is refused here — it could not replay as a recorded step either,
 * since a raw `tool:` step has no boundary to resolve a path through.
 */
async function rewriteSiblingFlowPath(
  session: RecordingSession | null,
  args: Record<string, unknown>
): Promise<void> {
  const flowPath = args.flow_path;
  // A call naming both sources — or neither — is flow-execute's schema to judge.
  // Both spellings count as a name: `flow_name` is flow-execute's alias, so
  // pairing it with a flow_path is the same dual-source misuse. Reading `name`
  // alone would let the rewrite delete flow_path and RECORD a different flow
  // than the caller named. Same fold and precedence as `resolveFlowName`.
  if (typeof flowPath !== "string" || args.name !== undefined || args.flow_name !== undefined)
    return;

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
  // results, which collapse ".." lexically, but the kernel resolves a
  // symlinked directory component first — "<flowsDir>/link/../<stem>.yaml"
  // can open a file outside flowsDir yet pass every check, so the rewrite
  // would silently run the flows-dir <stem> instead of the file the path
  // opens. Same constraint as flow_path_dotdot in flow-run.ts.
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
  // is actually missing is the filename stem, named by assertSafeFlowName below.
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
  // basename leaves a suffix in place when stripping it would leave nothing,
  // and strips only an exact-case one — so both ".yaml" and ".YAML" would
  // otherwise be reported as a flow *named* that, not as a missing stem.
  const stem = bareExtension ? "" : path.basename(flowPath, ".yaml");
  assertSafeFlowName(stem);
  // Only sound while `name` under the caller's project_root names this very
  // file — otherwise the rewrite would silently run a different flow. The root
  // must be absolute before that comparison means anything: path.resolve
  // anchors a relative root at the tool SERVER's cwd, which bears no relation
  // to the calling agent's, so a relative root would pass or fail by accident
  // of where the server was started. flow-execute itself demands an absolute
  // root (`assertValidProjectRoot`, called by `resolveFlowSource` before either
  // of its branches), so this refuses nothing that could have run.
  const projectRoot = args.project_root;
  if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) {
    throw invalid(
      `project_root must be an absolute path (got ${typeof projectRoot === "string" ? `"${projectRoot}"` : "none"}) — a relative root would be resolved against the tool server's cwd, not the calling agent's`
    );
  }
  if (path.resolve(flowsDirFor(projectRoot), `${stem}.yaml`) !== path.resolve(flowPath)) {
    throw invalid(`project_root "${projectRoot}" does not resolve "${stem}" to it`);
  }

  // Every check above compared the SUPPLIED spelling lexically; nothing has
  // consulted the directory. On a case-insensitive filesystem (APFS, NTFS)
  // the nested flow-execute would happily open a sibling really named
  // "sibling.yaml" for "Sibling.yaml", and the rewrite below would bake the
  // phantom spelling into the recorded YAML as `run: Sibling` — the recording
  // is the one output that is committed and replayed elsewhere, so the step
  // replays green here and fails on every case-sensitive checkout (Linux CI).
  // Require the supplied basename to appear in the flows dir byte-for-byte.
  // This dir is the recording's own host-persisted one — the recording file
  // itself lives in it — so an unreadable listing is far less plausible than
  // in the flow-run/CLI twins, but classifyOnDiskSpelling's readdir failure
  // skips the check all the same rather than refusing a file the exact-named
  // contract may well be honoring. Both verdicts refuse here: unlike a bare
  // `name`, this path names a file the caller says exists, so a listing
  // lacking it entirely is the same phantom spelling, just with no neighbour
  // to name.
  const suppliedBase = path.basename(flowPath);
  const spelling = await classifyOnDiskSpelling(flowsDir, suppliedBase);
  if (spelling.state !== "listed") {
    // Hint the real spelling only when this same ladder would accept it (a
    // stem-case slip like Sibling.yaml); an invalid real name (sibling.YAML)
    // needs a rename, and pointing at a flow_path the extension arm will
    // refuse helps no one.
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
 * `run: <name>.yaml` directive — a sibling-relative path the runner resolves
 * against the canonical containing flow file's directory. Returns the path
 * to compose, or a warning explaining why the raw `flow-execute` step was
 * kept.
 *
 * The `run:` directive itself is not sibling-scoped: it composes any
 * relative YAML path — fragment or e2e, cross-directory included, e.g.
 * `run: ../shared/login.yaml` — resolved by the runner against the containing
 * file's canonical directory, with no path fence (host-resolved composition,
 * design §12; see `execRunStep` in flow-run.ts). The RECORDER deliberately emits
 * only the sibling subset: `<name>.yaml` beside the recording's REAL file is
 * the one target shape it can validate here and identity-check against the
 * file the live sub-invoke executed; a cross-directory composition is
 * authored by editing the flow YAML directly, not recorded. The anchor is
 * the realpath'd containing-file dir because the runner's is (scopeFlowDir
 * in flow-run.ts), so a recording made through a symlink validates its
 * sibling in the canonical directory, not beside the symlink's spelling. An
 * e2e target's `launch` simply runs inline. So we keep the raw step only
 * when the target can't be resolved as a sibling, the sibling is not the
 * same file the live sub-invoke executed (the recorded step must name the
 * flow that actually ran), or the recording is remote (the host can't read
 * the client's sibling files to validate). A `flow_path` target reaches here
 * as its sibling `name` or not at all — see {@link rewriteSiblingFlowPath}.
 *
 * "Resolved as a sibling" is the same two-part identity {@link
 * rewriteSiblingFlowPath} demands of a flow_path, asked of the name route: the
 * call's own `project_root` must resolve `name` to the very file `run:` will
 * resolve beside the recording's real file — compared canonically, since those
 * two anchors reach it by different spellings — and that directory must list
 * `<name>.yaml` byte-for-byte. Every refusal keeps the raw step rather than
 * throwing — unlike the rewrite, this runs AFTER the nested flow ran on the
 * device, so a throw would discard the record of a step that already happened.
 * The raw `tool: flow-execute` step it keeps still replays the flow that
 * actually ran, carrying the caller's own project_root.
 */
async function captureRunTarget(
  session: RecordingSession,
  args: Record<string, unknown>
): Promise<{ flow?: string; warning?: string }> {
  // Honor `flow-execute`'s `flow_name` alias, with `resolveFlowName`'s
  // `name || flow_name` precedence. A call that used the alias runs fine, so it
  // must also capture as the portable `run: <name>` directive — reading
  // `args.name` alone would keep a raw step AND print a false "no flow name".
  const named = args.name || args.flow_name;
  const name = typeof named === "string" ? named : undefined;
  if (name === undefined || name === "") {
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
    // (scopeFlowDir in flow-run.ts). When the recording is itself a symlink,
    // a sibling beside the symlink's spelling would validate here yet fail at
    // replay, so the anchor must match the runner's. A realpath failure lands
    // in the catch below — raw step plus warning, which is the right recorder
    // semantics: an anchor we cannot canonicalize is one we cannot promise
    // will replay.
    const realFlowPath = await fs.realpath(session.filePath);
    const flowsDir = path.dirname(realFlowPath);
    const fragPath = path.join(flowsDir, `${name}.yaml`);

    // The live invoke resolved `name` under the CALL's project_root; a recorded
    // `run:` resolves it beside the recording. Those are the same file only
    // while that root's flows dir is this one — a nested call naming another
    // project's `<name>.yaml` runs that copy live and would record a step
    // running this one: same name, different flow, both green, nothing said.
    // The comparison itself is below, once the sibling has been read; what
    // this guard settles is that the root can be compared at all — it must be
    // absolute, since path.resolve anchors a relative root at the tool
    // SERVER's cwd, which bears no relation to the calling agent's.
    // flow-execute's schema requires project_root and its resolver demands an
    // absolute one, so any call that got past the live invoke above has one;
    // the guard covers direct execute() callers, which bypass that schema.
    const projectRoot = args.project_root;
    if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) {
      return {
        warning:
          `kept the raw flow-execute step — project_root must be an absolute path ` +
          `(got ${typeof projectRoot === "string" ? `"${projectRoot}"` : "none"}) to confirm ` +
          `"${name}" names the recording's own sibling`,
      };
    }

    // Nothing above consulted the directory, and a composed `run:` name is not
    // just a lookup — it is written into the recorded YAML, the one output that
    // gets committed and replayed elsewhere. On a case-insensitive filesystem
    // (APFS, NTFS) `name: "Frag"` opens a sibling really named "frag.yaml", and
    // the read below would too, baking `run: Frag` into a flow no
    // case-sensitive checkout (Linux CI) can resolve. flow-execute's own name
    // gate refuses that spelling one layer down — against this very directory,
    // since the identity check below forces the two to coincide — but it skips on a
    // listing that momentarily refused to be read (EMFILE under load), and the
    // recorder forwards these args opaquely: it does not take the spelling of a
    // reference it commits on the word of the tool it dispatched. Same gate the
    // flow_path arm applies to its basename, on the route that reaches the same
    // file by name. Only a case-folded verdict keeps the raw step: a name
    // matching nothing at all is an ordinary missing sibling, which the read
    // below reports far better than a casing complaint could.
    const spelling = await classifyOnDiskSpelling(flowsDir, `${name}.yaml`);
    if (spelling.state === "case_folded") {
      // Hint a name only when one can reach the file: an on-disk .YAML is
      // addressable by no name at all (this route always builds "<name>.yaml"),
      // and the flow_path arm refuses it too — so that fork asks for the rename
      // it really needs.
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
    // runner's own canonicalization on both sides (canonicalFlowPath in
    // flow-run.ts realpaths before reading). An executed path that cannot be
    // canonicalized (e.g. ENOENT) means nothing verifiable ran from the flows
    // dir, and the raw step is then the honest record: it replays via name +
    // project_root, i.e. the file that actually ran.
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
    /**
     * The flow line just appended, and the discriminator for "was anything
     * recorded at all". Every path that records NOTHING still returns normally
     * with the unchanged `stepCount`, so the caller can see its take was left
     * alone. Those paths are:
     *
     * - a `command` that names a recorder tool, or a flow-file directive
     *   instead of a tool. Both answer with the call to make.
     * - a nested `flow-execute` that failed, was cancelled, or returned a
     *   prerequisite notice.
     * - a nested `run-sequence` that stopped on a failed step or was cancelled
     *   part-way.
     *
     * The list is NOT split by whether the call reached the device, because
     * some refusals provably ran nothing. `message` carries that half. See
     * {@link partialMutationWarning}.
     *
     * Required while every return appended a step; these returns are what
     * reopened it, and a placeholder would claim a line that is not there. Also
     * the discriminator the completion message reads, so the log line does not
     * announce a step the body says was never recorded.
     */
    recorded?: string;
    savedTo: FlowSavedTo;
  }
> {
  return {
    id: "flow-add-step",
    interaction: {
      // Name the flow: recordings are concurrent, so several of these lines can
      // interleave in one log and "the recorded flow" would not identify which.
      startedMsg: ({ params }) => `Adding ${params.command} step to flow ${params.name}`,
      // Several returns are success-SHAPED and record nothing: a refused
      // directive command, or a nested orchestrator that failed or was
      // cancelled. An "Added …" line for those makes the event log contradict
      // the message in the same result. An agent reads that log to reconstruct
      // what a take contains. `recorded` is absent exactly when no line was
      // appended.
      completedMsg: ({ params, result }) =>
        result.recorded === undefined
          ? `Did NOT add ${params.command} step to flow ${params.name} (see the returned message)`
          : `Added ${params.command} step to flow ${params.name}`,
      failedMsg: ({ params, failureSignal }) =>
        `Failed to add ${params.command} step to flow ${params.name}: ${failureSignal.error_code}`,
    },
    description: `Execute a tool call and record it as a step in the flow named by \`name\` + \`project_root\` (the recording must already be open — see flow-start-recording). Use when recording a flow and you want to run and capture each action. A coordinate \`gesture-tap\` is recorded as a portable \`tap: { selector }\` step when the tapped element has stable text/identifier (otherwise coordinates are kept with a warning); a \`restart-app\` is recorded as a \`launch\` step (record one FIRST to make the flow a self-contained e2e flow; restart-app has no chromium support, so a chromium flow records as a fragment — add the \`launch: { chromium: <app path> }\` line to the YAML afterward, deleting the executionPrerequisite line if one was recorded: a flow that starts with a launch must not declare it).
A recorded \`await-ui-element\` that PASSED is re-probed against the tree the RUNNER resolves \`await:\`/\`assert:\` directives against, which is NOT the tree the live call read; a wait that came back \`{ success: false }\` is not probed at all, and its warning says so; when the condition does not hold there the step is still recorded and \`message\` carries a warning to read before converting — whether the conversion actually breaks depends on WHY the two disagree, since a screen that moved on between the live wait and the re-probe reads the same way. If that tree could not be read at all, the warning says so instead: the conversion is UNKNOWN, not known-bad. The probe judges the selector exactly as recorded, so write the conversion in the strict map spelling (\`{ visible: { text: Continue } }\`, copying the step's \`selector:\`) — the bare-string spelling (\`{ visible: Continue }\`) re-parses as a loose selector that resolves identifier-first and falls back to text, which is a different check. \`message\` also warns when the live wait itself came back \`{ success: false }\` — that tool reports a failed wait by returning rather than throwing, so the step is recorded either way. That warning names the cause, because only one of them judges the condition: a genuine miss will stop the run at replay, while a wait whose tree source was unreadable, or one that was cancelled, observed nothing and leaves the condition UNKNOWN.
Returns { message, toolResult, stepCount, recorded, savedTo } on success — \`message\` is \`Step added to "<name>" flow\` plus any warning about what was recorded (read it; a warning never means the step was skipped). If it fails an error is returned and nothing is recorded. Two calls record NOTHING and answer with guidance instead: a \`command\` naming a recording tool, and one naming a flow-file directive rather than a tool. Both answer with what to do instead — usually the call to make (the tool that records that directive, or the recording tool called directly), but \`wait\`, \`long-press\`, \`scroll-to\`, \`snapshot\` and \`when\` have no recording tool, so those name no call and say what to record or add by hand in its place. Either way nothing runs at the device, both omit \`recorded\`, and the take is left untouched — read \`recorded\`, not the status, to know whether a step was appended.
A NORMAL return can also mean "not recorded": \`recorded\` is the discriminator - it is absent, and \`message\` says "step NOT recorded", whenever the call ran but its outcome must not become a step. That covers a nested \`flow-execute\` that failed, was cancelled, or returned a prerequisite notice instead of running, and a nested \`run-sequence\` that stopped on a failed nested step or was cancelled part-way. Read \`message\` before assuming the step landed. Whether anything ran is what \`message\` says, not something to infer from which case it was: it warns that the device may have moved whenever a nested step was reached, and stays silent when the refusal provably reached none (a prerequisite notice, a sequence rejected before its first step could be dispatched, a cancel that landed before it). On the warning, CHECK the device against the state your recorded prefix leaves it in before adding the next step - do not relaunch the app to "reset", which lands on the start screen instead and makes the rest of the recording unreproducible.
If a step was recorded by mistake, remove it from the .yaml after \`flow-finish-recording\` rather than during the recording: against a remote client the in-memory copy is authoritative and every write serializes it over your edit, and in host mode a mid-recording edit renumbers the steps, which costs the finish the cross-tree verdicts anchored to them.`,
    // The recorded tool RUNS here, so this call is as long as whatever it
    // wraps — and the three it most often wraps all declare this. Without it
    // the MCP adapter capped the POST at 30s and retried the identical body
    // four more times, each retry re-running the action and appending another
    // step. The server also keeps its idle timer warm on this flag (see http.ts).
    longRunning: true,
    zodSchema,
    services: () => ({}),
    async execute(_services, params, ctx) {
      const session = await requireRecordingSession(params.project_root, params.name);

      // A recorder tool is not a step: running one mutates the recording, and
      // this call would also record a raw `tool: <recorder>` step that re-runs
      // that mutation at replay, when no recording is open. Refuse before
      // anything is written — and before parsing `args`, so a malformed payload
      // cannot pre-empt this guidance with a bare JSON error.
      // `Object.hasOwn`, not a bare index: an inherited member (`"__proto__"`,
      // `"constructor"`, …) would otherwise read truthy off the prototype chain.
      const nested = Object.hasOwn(NESTED_RECORDER_TOOLS, params.command)
        ? NESTED_RECORDER_TOOLS[params.command]
        : undefined;
      if (nested) return recordNothing(session, nested);

      let args: Record<string, unknown>;
      try {
        args = params.args ? JSON.parse(params.args) : {};
      } catch (err) {
        // The hint normally fires from the sub-invoke catch below, so a
        // malformed `args` payload would pre-empt it with a bare JSON syntax
        // error. An author who wrote `command: "echo"` needs to hear that echo
        // is a directive; the payload was never going to run either way.
        //
        // Gated on the REGISTRY, not the hint table alone, so the property
        // `isToolNotFound` protects holds here too.
        if (registry.getTool(params.command) === undefined) {
          const hint = directiveCommandHint(params.command);
          if (hint) return recordNothing(session, hint);
        }
        throw err;
      }

      // Snapshot before the rewrite below mutates `args` in place, so a schema
      // miss can be re-rendered against the keys the AUTHOR wrote. Shallow is
      // enough: `rewriteSiblingFlowPath` only deletes and adds top-level keys.
      const authoredArgs = { ...args };

      // A nested flow-execute must never carry a raw flow_path into the live
      // invoke — it has no boundary metadata there and would be rejected.
      if (params.command === RUN_TARGET_COMMAND) await rewriteSiblingFlowPath(session, args);

      // Selector capture must read the tree BEFORE the tap runs: a navigating
      // tap (e.g. a list row that opens a detail screen) replaces the screen, so
      // the tapped element is gone by the time the tap returns. Resolve the
      // element under the point against the pre-tap tree, then execute.
      const isTap =
        params.command === "gesture-tap" &&
        params.delayMs === undefined &&
        typeof args.udid === "string" &&
        typeof args.x === "number" &&
        typeof args.y === "number";

      let captured:
        | { selector?: Selector; warning?: string; ambiguous?: boolean; container?: boolean }
        | undefined;
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
        // An author's recording vocabulary is the flow file's directives, so
        // `command: "echo"` lands here as a bare "Tool not found". Only rewrite
        // a genuine not-found: a tool that ran and failed reports its own error.
        const hint = isToolNotFound(err, params.command)
          ? directiveCommandHint(params.command)
          : undefined;
        if (hint) return recordNothing(session, hint);

        // This dispatcher rewrites the args it forwards, so it must not read
        // the rewrite back to the caller: `rewriteSiblingFlowPath` swaps a
        // sibling `flow_path` for the equivalent `name`, and the registry can
        // only describe what it was handed. Re-render against the snapshot;
        // every other command passes its args through, where this is the same
        // sentence.
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

      // A wait that HELD is asked the runner's tree too, so the author learns
      // now — not after polish — whether the conversion is safe. One that came
      // back success:false is reported by CAUSE instead: a genuine miss fails
      // the step at replay ({@link UNMET_WAIT_WARNING}), while an unreadable
      // tree source or a cancellation observed nothing
      // ({@link UNREADABLE_WAIT_WARNING}).
      //
      // The two are filed under different kinds because only the probe's answer
      // is about converting the step, and `flow-finish-recording` headlines
      // them separately.
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

      const refusal = nestedRecordRefusal(
        params.command,
        toolResult,
        ctx?.signal?.aborted === true
      );
      if (refusal) {
        // The mutation warning below reads the same predicate, for the same
        // reason. A refusal that provably ran nothing must not tell a
        // superseded author their step "already ran on the device".
        const { stepCount, note } = await activeFlowState(session, refusal.mayHaveMutated);
        const mutationWarning = refusal.mayHaveMutated
          ? ` ${partialMutationWarning(
              params.command === RUN_TARGET_COMMAND ? "flow-execute" : "run-sequence"
            )}`
          : "";
        return {
          message: `${refusal.reason} — step NOT recorded.${mutationWarning}${note ? ` ${note}` : ""}`,
          toolResult,
          stepCount,
          savedTo: session.filePath,
        };
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
      // rewritten — it foregrounds without terminating, a different semantic.
      const strippedArgs = stripDeviceKeys(args);
      const isLaunch =
        params.command === "restart-app" &&
        params.delayMs === undefined &&
        typeof strippedArgs.bundleId === "string" &&
        Object.keys(strippedArgs).length === 1;

      // A multi-tap (`clickCount: 2` = double-tap) must survive the rewrite as
      // `times`, or replay would silently fire a single tap for a recorded
      // double. Bounds match the tool's clickCount; 1 is the default (absent).
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
        // No stable selector — keep a coordinate tap (still as a `tap:`
        // directive so every tap reads uniformly), but recording the point is
        // not an endorsement of it: say what failed AND what to do instead,
        // since this warning is the whole of the author's signal that the flow
        // just took on a step that survives only until the layout moves.
        step = { kind: "tap", x: args.x as number, y: args.y as number, ...tapTimes };
        warning = captured?.warning
          ? `${captured.warning}; kept coordinates, which replay at a fixed point and break on ` +
            `any layout change. ${coordinateRemedy(captured, args.udid)} Keep the point only for ` +
            `a genuinely unaddressable target (a canvas, a map, an unlabeled image), preceded by ` +
            `an echo naming what it is.`
          : undefined;
      } else if (isLaunch) {
        step = { kind: "launch", app: strippedArgs.bundleId as string };
      } else if (runTarget?.flow) {
        step = { kind: "run", flow: runTarget.flow };
      } else {
        warning =
          waitWarning?.warning ??
          runTarget?.warning ??
          rawCoordinateWarning(params.command, args, params.delayMs);
        // The step ran live with the full args (incl. the device id), but the
        // recorded form drops the device id so the flow stays portable — the
        // runner injects whatever device it resolves at replay.
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
      // ONLY this warning is carried, deliberately. The finish summary already
      // answers the other two by RENDERING what was written — a
      // `captureTapSelector` refusal reads as `N. tap: (x, y)`, a
      // `captureRunTarget` refusal as `N. tool: flow-execute {…}` — whereas a
      // step that will break on conversion renders exactly like one that will
      // not. {@link fallbackSourceWarning} is neither carried nor legible; that
      // is a known gap, not this branch's subject.
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
        // Host mode: a path. Client mode: the directive that carries the YAML
        // to the client, which IS the persistence mechanism there — the one
        // place the full file still has to travel per step.
        savedTo,
      };
    },
  };
}
