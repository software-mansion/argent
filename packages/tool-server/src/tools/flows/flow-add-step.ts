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
import { AWAIT_UI_ELEMENT_TOOL_ID, isUnmetUiWaitResult } from "../await-ui-element";
import { probeWhenCondition, type DirectiveOutcome } from "./flow-actions";
import { summarizeStep } from "./flow-finish-recording";
import { invokeSubTool } from "../../utils/sub-invoke";
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
        'A flow-file directive name ("tap", "launch", "run", "type", "await", "assert", "echo", "wait", ' +
        '"long-press") is answered with guidance, and nothing runs or is recorded: most name the tool ' +
        'that records the directive, while "wait" and "long-press" have no recording tool at all and ' +
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

function fallbackSourceWarning(source: DescribeSource, platform: string): string | undefined {
  const expected = REPLAY_TREE_SOURCES[platform];
  if (!expected || source === expected) return undefined;
  return `selector captured from the fallback ${source} tree (${expected} unavailable) — replay resolves against the full hierarchy, which may not match it`;
}

// `resolveDevice` classifies by SHAPE (`classifyDevice` is a pure string test
// with no throw path and no total it can fail on), so there is nothing to
// guard: every string resolves, and a non-string never gets here in practice —
// `probeAgainstRunnerTree` returns before composing a warning without one.
function platformOf(udid: unknown): string | undefined {
  return typeof udid === "string" ? resolveDevice(udid).platform : undefined;
}

/**
 * The floor under both clause tables below. Nothing reaches it: they are
 * consulted only for a DETERMINATE verdict, which needs `fetchFlowTree` to have
 * answered — and it answers on exactly ios / android / chromium / vega, each of
 * which has its own arm. The one remaining classification, `ios-remote`, cannot
 * get this far either: `await-ui-element` declares no `appleRemote` capability,
 * so `assertSupported` throws while the step is still executing live and
 * flow-add-step never returns a warning at all.
 */
const UNSUPPORTED_PLATFORM = {
  divergence: "The recorder and the runner read different projections of the screen.",
  read: "No read-only tool is known to report the runner's projection on this platform — keep the step raw",
} as const;

/**
 * The clause naming how to read the tree the RUNNER resolves against — or, on
 * iOS, Android and Chromium, that no read-only tool does.
 *
 * Android's runner tree is the full accessibility hierarchy, and Android
 * `describe` returns the TRIMMED interactables tree the recorder already read.
 * Chromium's runner tree keeps only addressable nodes that are on screen, yet
 * `describe` returns the FULL DOM the recorder read — a superset that still
 * shows the very nodes the runner drops, including the off-viewport ones whose
 * frame it reports clamped to zero area. iOS is the same trap in the other
 * direction: the Apple-only
 * full-hierarchy readers see the raw UIView tree, which is a superset of what
 * `queryFullHierarchyTree` projects (it drops hidden, transparent,
 * scroll-clipped and unlabelled container views), AND they match `identifier` /
 * `label` / `className` EXACTLY — a recorded selector's `text` is a
 * case-insensitive SUBSTRING of a label or value and its `role` a substring of
 * a derived role name, neither of which those tools accept. So they report
 * elements the runner never sees and miss substring matches it does make.
 *
 * Naming any of those three would point the author at the wrong tree under the
 * banner of the runner's — the exact steer this warning exists to prevent.
 *
 * On iOS and Android the remedy is to fix the CONVERSION, never to re-record.
 * "Re-record with a selector a testID'd view carries" contradicts the workflow
 * the create-flow skill prescribes and this divergence usually comes out of: a
 * testID the trimmed tree hides can't be waited on live, so you gate on visible
 * text to get the step recorded and retarget the id at polish. Sending the
 * author back to the recorder asks for the very step the skill just explained
 * cannot be recorded, and lands them on the unmet-wait warning instead. The
 * full hierarchy has complete testID/resource-id coverage, so retargeting the
 * directive is both the fix and the thing that finishes that workflow.
 */
function runnerSideReadClause(udid: unknown): string {
  const platform = platformOf(udid);
  if (platform === "ios") {
    return (
      "No read-only tool reports the runner's projection on iOS — `native-find-views` and " +
      "`native-full-hierarchy` return the RAW view tree, matching `identifier`/`label`/" +
      "`className` exactly (neither takes a substring `text` or a `role`) and keeping the " +
      "hidden, transparent, scroll-clipped and unlabelled container views the runner drops — " +
      "so retarget the DIRECTIVE at an `id` the full hierarchy carries and prove it with " +
      "`flow-execute`, or keep the step raw"
    );
  }
  if (platform === "android") {
    return (
      "No read-only tool exposes the runner's full hierarchy on Android — `describe` returns the " +
      "trimmed tree the recorder read, not the runner's — so retarget the DIRECTIVE at a " +
      "`resource-id` the full hierarchy carries and prove it with `flow-execute`, or keep the " +
      "step raw"
    );
  }
  if (platform === "chromium") {
    // Every remedy here has to survive the two cases the divergence text now
    // admits, so none of them may assume the runner dropped the element:
    // `describe` can show a node the runner keeps under a different name (a
    // password field) and can omit one the runner has (past its 5000-node
    // walk). What always settles it is running the conversion.
    return (
      "No read-only tool exposes the runner's trimmed tree on Chromium — `describe` re-reads the " +
      "same DOM on a shorter walk, so it both lists nodes the runner drops and omits nodes the " +
      "runner keeps — so settle it by running the conversion: put the directive in a flow and " +
      "`flow-execute` it. A zero-height frame in `describe` means off-viewport, and the fix " +
      "there is a `scroll-to` before the check rather than a different selector; a password " +
      "field reaches the runner under the name `[password]`, so only an `id`/`role` selector " +
      "can match it"
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
 * The possibility every platform's story shares, and the one none of the tree
 * explanations can rule out: the probe reads the device a moment after the live
 * wait returned, so a screen that moved on in between produces this same
 * verdict with both trees in perfect agreement. Vega states it as its whole
 * story (there is no other cause there); the rest have to admit it, or an
 * author whose toast simply expired spends the next ten minutes rewriting a
 * selector that was never wrong.
 */
const SCREEN_MAY_HAVE_MOVED =
  " A screen that changed between the live wait and this re-probe reads the same way, so rule " +
  "that out first.";

/**
 * WHY the recorder's tree and the runner's tree can disagree — which is a
 * different story per platform, and stating the iOS one everywhere makes the
 * message false exactly where the author is trying to act on it.
 *
 * Each story names what the two projections do differently WITHOUT asserting
 * which side ended up missing the element: on Chromium both directions are
 * reachable, and a message that only ever describes the runner dropping
 * something sends an author to fix the wrong end.
 */
function treeDivergenceFor(udid: unknown): string {
  const platform = platformOf(udid);
  if (platform === "ios") {
    return (
      "The recorder reads the accessibility tree and the runner reads the full native view " +
      "hierarchy; they overlap but neither contains the other." +
      SCREEN_MAY_HAVE_MOVED
    );
  }
  if (platform === "chromium") {
    // Both halves of `projectChromiumNode`'s test, not just the first: it keeps
    // a node only when it is `onScreen && addressable`. Naming addressability
    // alone reads as a verdict on the SELECTOR, so an author whose element is
    // merely below the fold — the walker clamps an off-viewport frame to zero
    // area, and `describe` still lists it — goes hunting for an id it already
    // has.
    //
    // And the runner is not always the side that lost the element. Two
    // reachable cases where it is not:
    //   - a password field. `projectChromiumNode` KEEPS it and redacts its
    //     label to `[password]`, so the node reaches the runner (an `id`
    //     selector resolves it) while no `text`/label selector ever can. The
    //     old "an element with no id, label … never reaches the runner" story
    //     was false here in both halves, and its remedy — re-record with a
    //     text or label — is unreachable by construction.
    //   - a dense page. The agent-facing walk stops at DEFAULT_WALK_LIMITS
    //     (5000 nodes); FLOW_WALK_LIMITS raises it to 12000. Past 5000 it is
    //     the RECORDER's tree that is short, and `describe` cannot show the
    //     element at all — which also made "`describe` returns the full DOM the
    //     recorder read" false exactly when it mattered.
    return (
      "Both read the same DOM but project it differently, and either side can be the one " +
      "missing the element: the flow tree keeps only addressable nodes (id, label, value, " +
      "clickable or focused) whose frame the walker did not clamp to zero area for being " +
      "off-viewport, and it redacts a password field's name to `[password]` — while the " +
      "recorder's walk stops at 5000 nodes where the flow tree's goes to 12000, so on a dense " +
      "page it is the recorder that never saw the element." +
      SCREEN_MAY_HAVE_MOVED
    );
  }
  if (platform === "android") {
    return (
      "The recorder reads the trimmed accessibility tree and the runner reads the full " +
      "hierarchy including not-important views; each holds elements the other drops." +
      SCREEN_MAY_HAVE_MOVED
    );
  }
  if (platform === "vega") {
    // Vega is the one platform where the runner's tree cannot disagree on an
    // unchanged screen. `flow-vega-tree` re-shapes the very page source the
    // recorder read: `projectVegaNode` skips nothing and emits every node as a
    // leaf, so membership, frames and visibility are identical; the only edit
    // is a hoisted `subtreeText`, and `evaluateCondition` accepts a node's own
    // text as well as its hoisted text, so the hoist can only ever make a
    // `text` check MORE likely to hold. So "different projections of the
    // screen" would be plainly wrong here, and so would sending the author to
    // rewrite the selector.
    return (
      "Both read the same automation-toolkit page source, and the flow tree only re-shapes it — " +
      "it drops no element and its text hoist can only add matches — so on this platform a " +
      "disagreement means the SCREEN changed between the live wait and this re-probe, not that " +
      "the two trees differ."
    );
  }
  return UNSUPPORTED_PLATFORM.divergence;
}

/**
 * What an `await:` would still be waiting FOR, which is not the same event per
 * condition. "unless the element reaches that tree" is right for
 * `visible`/`exists` and backwards for `hidden`, where the wait passes when the
 * element LEAVES — so on the one condition whose whole point is absence, the
 * longer-timeout escape hatch was described as its own opposite.
 */
function awaitStillNeeds(condition: WaitCondition): string {
  if (condition === "hidden") return "the element LEAVES that tree";
  if (condition === "text") return "that element's text comes to match on that tree";
  return "the element reaches that tree";
}

/**
 * Which SPELLING of the conversion the verdict is about.
 *
 * The probe re-evaluates `args.selector` exactly as the recorded step carries
 * it — a strict selector, matched on its own fields. The directive grammar has
 * a second spelling that looks like the obvious conversion and is not the same
 * check: a bare string (`await: { visible: Continue }`) parses as a LOOSE
 * selector, which the runner resolves identifier-first and only falls back to
 * text (see `selectorAlternatives`). On a screen where some node's id equals
 * the recorded text — `<button id="Continue">Proceed</button>`, or an Android
 * `@+id/continue` under a "Continue" label — the two spellings resolve
 * DIFFERENT elements, so this verdict would be wrong in whichever direction
 * they disagree.
 *
 * Rather than predict both, say which one was judged. The strict map form is
 * also a mechanical copy of the recorded `selector:` map, and it is the same
 * doctrine the recorder already applies to a captured `tap:` — it emits
 * `tap: { text: General }`, never the bare string, because a bare string
 * re-parses as loose and routes through a fallback the recorder never checked.
 */
const SPELLING_CLAUSE =
  "Both of those are about the selector exactly as recorded, so convert it in the strict map " +
  "spelling (`{ text: … }` / `{ id: … }`, a straight copy of the step's `selector:`): a " +
  "bare-string conversion (`{ visible: Continue }`) re-parses as a LOOSE selector — " +
  "identifier first, text only as a fallback — which is a different check this probe never made.";

/**
 * `await-ui-element` reports a condition that never came true by returning
 * `{ success: false }` rather than throwing, so the recorder's success path
 * records the step regardless — the same shape `run-sequence` and `flow-run`
 * read through {@link isUnmetUiWaitResult} to STOP a run at a wait that never
 * held. The recorder can't stop anything (the tool already ran), but it must
 * not narrate the step as fine: at replay this is a step FAILURE that ends the
 * run there.
 *
 * The cross-tree probe is skipped on this path, and saying so matters. That
 * probe asks whether a check that PASSED would survive conversion to an
 * `await:`/`assert:` directive; this one did not pass, so its answer would be
 * about a premise that never held — and the divergence remedy it appends
 * ("re-record with a selector present in both trees") would blame a tree
 * mismatch for an element that is on neither tree.
 */
const UNMET_WAIT_WARNING =
  "recorded, but the wait itself never held — `await-ui-element` reports an unmet condition by " +
  "returning success:false instead of failing, so the step was written to the flow anyway. At " +
  "replay an unmet wait FAILS the step and stops the run there, so re-record it once the " +
  // "Delete it from the .yaml" is only unconditionally true in host mode,
  // where the recorder re-reads the file before each append. Against a remote
  // client the in-memory copy is authoritative and the next append writes the
  // step straight back — silently, since nothing reports the restore. The tool
  // description carries that caveat for mid-recording edits generally; a
  // warning that tells you to make one has to carry it too.
  "condition can actually hold, or delete the step from the .yaml — in host (local) mode, where " +
  "the recorder re-reads the file before each append; against a remote client the in-memory copy " +
  "is authoritative mid-recording, so delete it after `flow-finish-recording` instead. " +
  "The cross-tree re-probe was " +
  "skipped: it asks whether a check that PASSED would survive conversion to `await:`/`assert:`, " +
  "and this one did not pass";

function abortError(): Error {
  const err = new Error(
    "flow-add-step aborted while re-probing the recorded wait against the runner's tree"
  );
  err.name = "AbortError";
  return err;
}

/**
 * Hard ceiling on the whole re-probe. `probeWhenCondition` polls on the assert
 * grace window (`DEFAULT_ASSERT_TIMEOUT_MS`, 1s), but that budget bounds
 * only the LOOP: each `fetchFlowTree` inside it is awaited with no time bound
 * and the clock is checked between reads, then one more read fires
 * back-to-back after the deadline. A single read can take 10s on Chromium CDP,
 * and on Android it is the devtools `getHierarchy` RPC — bounded by
 * `LONG_RPC_TIMEOUT_MS`, 15s (NOT a `uiautomator dump`: `flow-android-tree`
 * refuses to degrade to that fallback and throws instead). So the nominal 1s
 * window really ceilings at whatever the slowest source takes, measured at 8.3s
 * against a throttled background renderer.
 *
 * The live `await-ui-element` doesn't have this problem because
 * `pollDescribeTree` races every fetch through `settleWithin`; the flow
 * runner's copy of the loop doesn't, and its callers (`await:`/`assert:`/
 * `when:`) run unattended where an overrun costs only time. The recorder is
 * interactive and this probe is a courtesy check on a step that ALREADY ran,
 * so bound it here rather than changing the shared loop: an overrun is
 * reported as indeterminate — "unknown", never "known-bad" — exactly like a
 * tree source that could not be read.
 *
 * The budget is the 1s grace plus enough slack for one in-flight read to land.
 */
const PROBE_BUDGET_MS = 4000;

/**
 * Length cap on the probe's own reason before it is quoted back to the agent —
 * applied ONLY to a determinate verdict's reason.
 *
 * `assertReason`'s `text` arm quotes the matched element's rendered content,
 * and on the flow tree that content is HOISTED — a container's text is every
 * descendant's, space-joined. So the reason for one failed `text` check can
 * carry an entire card, list section or log pane, and this warning is appended
 * to `message` on a tool whose result the agent reads in full. The reason has
 * to name enough of what it saw to be actionable, not reproduce the screen.
 *
 * An INDETERMINATE reason is a different kind of string and is quoted whole:
 * it is an environment error ("could not read the UI tree: …"), it carries no
 * screen content on any branch that produces it, and its TAIL is routinely the
 * recovery instruction — on a real iOS run against a non-injected app the cap
 * cut "…use screenshot to inspect visible Home/…" ten characters from the end.
 */
const MAX_PROBE_REASON_CHARS = 200;

/**
 * How much of the kept budget goes to the END of an over-long reason.
 *
 * Head-only truncation drops whatever the reason closes with, and
 * `waitForCondition` closes a determinate reason with the note recording that
 * its final poll went dark ("(the final poll could not read the UI tree: …)").
 * That note qualifies the verdict the whole warning is built on, so eliding the
 * MIDDLE keeps it while still refusing to reproduce the screen.
 */
const PROBE_REASON_TAIL_CHARS = 60;

function cappedReason(reason: string): string {
  if (reason.length <= MAX_PROBE_REASON_CHARS) return reason;
  const head = reason.slice(0, MAX_PROBE_REASON_CHARS - PROBE_REASON_TAIL_CHARS);
  const tail = reason.slice(reason.length - PROBE_REASON_TAIL_CHARS);
  const dropped = reason.length - MAX_PROBE_REASON_CHARS;
  return `${head}… (${dropped} more chars) …${tail}`;
}

/**
 * The recorder and the runner read DIFFERENT trees. `await-ui-element`
 * evaluates against the agent-facing describe tree — the AX hierarchy on
 * iOS/Android, the CDP DOM on Chromium, the toolkit page source on Vega; the
 * `await:`/`assert:` DIRECTIVE that polish converts this step into is evaluated
 * against `fetchFlowTree`'s. Which way the two diverge is per platform (see
 * {@link treeDivergenceFor}), but on none of them does one contain the other,
 * so a check can pass live and fail once converted — which makes "each step is
 * executed live so you verify it works" untrue exactly where it matters.
 *
 * Re-probe the same condition against the runner's tree and report the answer.
 * It is a WARNING, never a refusal: the step is recorded as a raw
 * `tool: await-ui-element`, and at replay that tool reads the SAME tree it just
 * passed against — so "it would fail every run" was false for the form actually
 * written. What the probe really tells the author is whether the conversion is
 * safe, which is a polish-time decision.
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
  // No try/catch: resolveDevice is a pure shape classifier. An id it maps to a
  // platform with no flow tree lands in `fetchFlowTree`'s not-supported throw
  // instead, which the probe already reports as indeterminate.
  const device = resolveDevice(args.udid);
  // Giving up on the probe has to STOP it, not just stop waiting for it.
  // `settleWithin` only abandons the promise: the poll loop it walked away from
  // is still awaiting a tree read, and when that read finally lands the loop
  // finds itself past its deadline and fires one more full read back-to-back
  // (`finalPoll`) — against a device the recorder has already returned from, so
  // the stall the ceiling was meant to remove just reappears under whichever
  // step runs next. Abort the loop the moment the ceiling decides, and its
  // per-iteration signal check ends it before that read.
  const giveUp = new AbortController();
  const probeSignal = ctx?.signal ? AbortSignal.any([ctx.signal, giveUp.signal]) : giveUp.signal;
  // Bounded by PROBE_BUDGET_MS: the loop's own deadline does not bound the
  // tree reads it awaits, and the recorder must not stall on one.
  const settled = await settleWithin(
    probeWhenCondition(
      // The signal rides on ActionEnv separately from `ctx`, so pass it too:
      // a cancelled flow-add-step must stop this probe rather than polling on.
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
  // Whichever way it settled, this call is done with the loop — and on the
  // timeout path the loop is the thing still holding the device.
  giveUp.abort();
  if (settled.type === "aborted") throw abortError();
  // A read that outran the budget, and a probe that threw outright, are both
  // "the runner's tree did not answer" — indeterminate, never a verdict.
  const outcome: DirectiveOutcome =
    settled.type === "value"
      ? settled.value
      : {
          ok: false,
          indeterminate: true,
          reason:
            settled.type === "timeout"
              ? `the runner's tree did not answer within ${PROBE_BUDGET_MS}ms`
              : `reading the runner's tree failed: ${settled.error}`,
        };
  if (outcome.ok) return {};
  if (outcome.aborted) throw abortError();
  if (outcome.indeterminate) {
    return {
      // Deliberately NOT joined with treeDivergenceFor/runnerSideReadClause.
      // Nothing was compared here — the runner's tree could not be read at all,
      // which is an environment failure. Appending the divergence explanation
      // would claim the two trees differ, and its remedy ("re-record with a
      // selector present in both") would send the author to rewrite a selector
      // that may be perfectly good.
      // "the tree `await-ui-element` reads", not "the accessibility tree": the
      // recorder's tree is the AX hierarchy only on iOS/Android. On Chromium it
      // is the CDP DOM and on Vega the automation toolkit's page source, so
      // naming the AX tree there describes a source neither side read.
      //
      // Quoted WHOLE, not through `cappedReason`: this reason is an environment
      // error, it never carries screen content, and its tail is routinely the
      // instruction for getting the tree source back (see
      // MAX_PROBE_REASON_CHARS).
      warning:
        `this check could not be re-verified against the tree the RUNNER reads ` +
        `(${outcome.reason ?? "no reason given"}), so it passed against the tree ` +
        `\`${AWAIT_UI_ELEMENT_TOOL_ID}\` ` +
        `reads and nothing else. Whether it would convert to \`await:\`/\`assert:\` is UNKNOWN, ` +
        `not known-bad — re-probe once that tree source is back before trusting the conversion`,
    };
  }
  // Determinate: the trees really were compared and really do disagree, so this
  // is the one warning that may explain the divergence and name how to read the
  // runner's side.
  return {
    warning:
      `recorded, but this condition does NOT hold against the tree the runner resolves ` +
      `directives against (${cappedReason(outcome.reason ?? "no match")}). As the raw ` +
      `\`tool: ${AWAIT_UI_ELEMENT_TOOL_ID}\` step it replays fine — it reads the same tree it ` +
      `just passed against — but an \`assert:\` conversion WILL fail (it reads that tree on ` +
      `the same short grace this probe just used), and an \`await:\` will too unless ` +
      // The remedy belongs to the platform clause, not here: "re-record with a
      // selector present in both trees" is right on iOS/Android/Chromium and
      // plainly wrong on Vega, where the two trees hold the same elements and a
      // disagreement means the screen moved, not that the selector is bad.
      `${awaitStillNeeds(condition as WaitCondition)} within its longer timeout. ` +
      SPELLING_CLAUSE +
      " " +
      `${treeDivergenceFor(args.udid)} ${runnerSideReadClause(args.udid)}`,
  };
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
 */
async function captureTapSelector(
  registry: Registry,
  udid: string,
  point: { x: number; y: number }
): Promise<{ selector?: Selector; warning?: string }> {
  try {
    const device = resolveDevice(udid);
    const { tree, source } = await fetchFlowTree(registry, device);
    const node = nodeAtPoint(tree, point);
    if (!node) return { warning: "no element found under the tap; kept coordinates (brittle)" };
    const selector = deriveSelector(node);
    if (!selector)
      return { warning: "tapped element has no stable text/id; kept coordinates (brittle)" };
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

/**
 * How far the recording has got — for responses that record no step but must
 * still say where the flow stands. Host mode re-reads the file (refreshing the
 * in-memory snapshot) so manual edits made mid-recording are honored; client
 * mode's in-memory copy is authoritative.
 *
 * Deliberately NOT the flow's YAML. Returning the whole growing file on every
 * call made the recorder the single largest consumer of a session's context,
 * and that pressure was observed removing checks from tests. The full file
 * comes back once, from `flow-finish-recording`.
 */
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

/**
 * The shared return for every path that answers with GUIDANCE and deliberately
 * runs nothing: `guidance`, then the invariant those paths all promise, then
 * the unchanged step count so the caller can see its take was left alone.
 *
 * A success rather than a throw — the caller asked a reasonable question and
 * got the answer — but a success that records no line, so `recorded` is absent.
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
  const { stepCount, note } = await activeFlowState(session);
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
   * commands the step-shaping switch handles are rewritten; everything else is
   * stored as a raw `tool:` step that the polish pass converts. Claiming a
   * rewrite that does not happen sends the author looking for a directive that
   * is not in the file.
   */
  rewritten: boolean;
  /**
   * For a CONDITIONALLY rewritten directive, the ARG-SHAPE condition, so the
   * hint does not promise a `${command}:` step the recorder then declines to
   * write (a `restart-app` with an extra arg, or a `run` target that is not a
   * resolvable sibling, is kept as a raw `tool:` step to convert during polish).
   * Omitted when no arg-shape condition applies (e.g. `tap`). Note the separate
   * `delayMs` opt-out (every rewrite also gates on `delayMs === undefined`) is
   * NOT expressed here; it is appended to all rewrite hints by
   * `directiveCommandHint`, so `tap` is not truly unconditional.
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
    // Three outcomes, not two: the blanket "otherwise the raw step is kept"
    // was true only of the `name` route. A non-sibling `flow_path` is REFUSED
    // before anything runs (a raw tool: step has no boundary to resolve a path
    // through at replay), and a remote recording keeps the raw step whatever
    // the target is, because `run:` composition is host-resolved.
    rewriteCondition:
      "when the target resolves as a sibling flow in this recording's folder — a `name` that " +
      "does not is kept as a raw `tool: flow-execute` step, and so is every target in a REMOTE " +
      "recording (`run:` composition is host-resolved, so the host cannot validate the client's " +
      "siblings); a `flow_path` that is not a sibling is refused outright and records nothing",
  },
  type: { tool: "keyboard", rewritten: false },
  await: { tool: AWAIT_UI_ELEMENT_TOOL_ID, rewritten: false },
  assert: { tool: AWAIT_UI_ELEMENT_TOOL_ID, rewritten: false },
  // `echo`, `wait` and `long-press` are deliberately absent — each needs an
  // answer this table cannot express, so `directiveCommandHint` handles them
  // directly: `echo` is recorded by a tool called on its OWN (routing it
  // through flow-add-step records a second, replay-breaking step), and neither
  // `wait` nor `long-press` has a recording tool at all.
};

/**
 * Recorder tools, which must never be `flow-add-step`'s `command`. Each one
 * mutates the recording itself, so running it as a nested step records the
 * action twice — once as the directive the inner tool wrote, once as a raw
 * `tool:` step that re-runs it at replay, when no recording is open.
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
 * `command`, as opposed to the tool itself running and failing.
 *
 * Keyed on the error's IDENTITY, not its message text: the registry throws a
 * raw `ToolNotFoundError` (carrying the missing `toolId`) for an unregistered
 * or flag-gated id, thrown BEFORE the invoke wrapper — while a tool that runs
 * and fails, or one whose OWN nested lookup misses, surfaces as a
 * `ToolExecutionError`. Matching `toolId === command` means a genuine "…not
 * found" *message* from a tool that actually ran (e.g. "element not found") is
 * never mistaken for the command itself being absent, and the guard no longer
 * depends on `directiveCommandHint`'s whitelist to stay correct if a tool is
 * ever registered under a directive name.
 */
function isToolNotFound(err: unknown, command: string): boolean {
  return err instanceof ToolNotFoundError && err.toolId === command;
}

function directiveCommandHint(command: string): string | undefined {
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
  // `Object.hasOwn`, not a bare index: `command` is caller-controlled, so a
  // value like `"constructor"` or `"toString"` would otherwise resolve to an
  // inherited prototype member and render a nonsense hint (`tool: undefined`).
  const hint = Object.hasOwn(DIRECTIVE_COMMAND_HINTS, command)
    ? DIRECTIVE_COMMAND_HINTS[command]
    : undefined;
  if (!hint) return undefined;
  return (
    `"${command}" is a flow directive, not a tool. Record it by calling \`${hint.tool}\` ` +
    `through flow-add-step` +
    (hint.rewritten
      ? // The `delayMs` clause is appended to EVERY rewrite hint, so it has to
        // be scoped to calls that are recorded at all: `run`'s own
        // rewriteCondition, printed two clauses earlier, says a non-sibling
        // `flow_path` is refused outright and records nothing — and it is,
        // whatever `delayMs` says, because `rewriteSiblingFlowPath` runs before
        // the invoke and throws. Promising a raw step there contradicts the
        // sentence beside it.
        ` — the recorder rewrites it into the \`${command}:\` step ${hint.rewriteCondition ?? "for you"}. ` +
        `Where the call is recorded at all, a \`delayMs\` on it opts out of the rewrite: the step is then ` +
        `kept in its raw \`tool: ${hint.tool}\` form (a replay delay has no directive form), so leave ` +
        `\`delayMs\` off if you want the \`${command}:\` step.`
      : `. It is stored as a raw \`tool: ${hint.tool}\` step; converting it to \`${command}:\` ` +
        `is part of the polish pass.`)
  );
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
  // Both spellings count as a name: `flow_name` is flow-execute's accepted
  // alias, so a call that pairs it with a flow_path is the same dual-source
  // misuse. Reading `name` alone would let the rewrite delete flow_path and
  // substitute that file's stem, running and permanently RECORDING a different
  // flow than the caller named — the recorded YAML is the artifact that gets
  // committed and replayed, and nothing in it would say the requested name was
  // discarded. Same fold, same precedence, as `resolveFlowName`.
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
  // Honor the `flow_name` alias that `flow-execute` now accepts, with the same
  // `name || flow_name` precedence `resolveFlowName` uses. A nested call that
  // named the flow via the alias runs fine at execution, so it must also be
  // captured as the portable `run: <name>` directive — reading `args.name`
  // alone would keep a raw, non-portable `tool: flow-execute` step AND print
  // the now-false "had no flow name" warning for a call that did name the flow.
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
     * The flow line just appended. Absent on the two paths that deliberately
     * record NOTHING and still SUCCEED — a recorder tool as `command`, and a
     * flow-directive name — where the tool answers with guidance and reports
     * the unchanged `stepCount` so the caller can see its take was left alone.
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
      // The guidance paths return SUCCESSFULLY and record nothing, so an
      // unconditional "Added …" line contradicts the result body it belongs to
      // ("Nothing was executed and no step was recorded") in the same log.
      // `recorded` is the discriminator: absent exactly when no line was
      // appended.
      completedMsg: ({ params, result }) =>
        result.recorded === undefined
          ? `Recorded no ${params.command} step in flow ${params.name}`
          : `Added ${params.command} step to flow ${params.name}`,
      failedMsg: ({ params, failureSignal }) =>
        `Failed to add ${params.command} step to flow ${params.name}: ${failureSignal.error_code}`,
    },
    description: `Execute a tool call and record it as a step in the flow named by \`name\` + \`project_root\` (the recording must already be open — see flow-start-recording). Use when recording a flow and you want to run and capture each action. A coordinate \`gesture-tap\` is recorded as a portable \`tap: { selector }\` step when the tapped element has stable text/identifier (otherwise coordinates are kept with a warning); a \`restart-app\` is recorded as a \`launch\` step (record one FIRST to make the flow a self-contained e2e flow; restart-app has no chromium support, so a chromium flow records as a fragment — add the \`launch: { chromium: <app path> }\` line to the YAML afterward, deleting the executionPrerequisite line if one was recorded: a flow that starts with a launch must not declare it).
A recorded \`await-ui-element\` is re-probed against the tree the RUNNER resolves \`await:\`/\`assert:\` directives against, which is NOT the tree the live call read; when the two disagree the step is still recorded and \`message\` carries a warning saying the conversion would fail. The probe judges the selector exactly as recorded, so write the conversion in the strict map spelling (\`{ visible: { text: Continue } }\`, copying the step's \`selector:\`) — the bare-string spelling (\`{ visible: Continue }\`) re-parses as a loose selector that resolves identifier-first and falls back to text, which is a different check. \`message\` also warns when the live wait never held — that tool reports an unmet condition by returning \`{ success: false }\` rather than failing, so the step is recorded and will stop the run at replay.
Returns { message, toolResult, stepCount, recorded, savedTo } - \`message\` is \`Step added to "<name>" flow\` plus any warning about what was recorded (read it; a warning never means the step was skipped); \`recorded\` is a one-line SUMMARY of the step just appended, numbered and in the flow file's own spellings (e.g. \`1. tap: {"id":"PLACARD"}\`), not the YAML that was written; \`stepCount\` is how many steps the flow now has, and the number \`recorded\` opens with. Read \`recorded\` to confirm WHAT was stored — a step is not always recorded as the tool call you made (see the tap and restart-app rewrites above). The flow's full YAML is deliberately NOT returned per step; read it back from \`flow-finish-recording\`. \`savedTo\` is where the YAML landed: a host path, or, against a remote client, the directive that has the client write it (the only field naming the destination in that mode). If it fails an error is returned and nothing is recorded. Two calls SUCCEED while recording nothing, and omit \`recorded\` to say so: a \`command\` naming a recording tool, and one naming a flow-file directive rather than a tool. Both answer with the call to make instead, run nothing at the device, and leave the take untouched — read \`recorded\`, not the status, to know whether a step was appended.
If a step was recorded by mistake, edit the .yaml to remove it. In host (local) mode the recorder re-reads the file before each append, so an edit made between steps is kept — but the append re-parses and re-validates the WHOLE file, so an edit that no longer parses makes the next step fail instead of being kept; repair the file and retry. Against a remote client, edit after \`flow-finish-recording\` because the in-memory copy is authoritative there and can overwrite a mid-recording edit.`,
    zodSchema,
    services: () => ({}),
    async execute(_services, params, ctx) {
      const session = await requireRecordingSession(params.project_root, params.name);

      // A recorder tool is not a step. Nesting one appends TWICE — the inner
      // tool writes its own directive and this call additionally records a
      // raw `tool: <recorder>` step, which then fails on every replay because
      // no recording is open then. It reports success either way, so nothing
      // signals the corruption; refuse before anything is written — and before
      // parsing `args`, so a malformed `args` payload cannot pre-empt this
      // guidance with a bare JSON error.
      // `Object.hasOwn`, not a bare index: a caller-supplied `command` equal to
      // an inherited member (`"__proto__"`, `"constructor"`, …) would otherwise
      // read truthy off the prototype chain and refuse the call with a garbage
      // message instead of falling through to the plain not-found path.
      const nested = Object.hasOwn(NESTED_RECORDER_TOOLS, params.command)
        ? NESTED_RECORDER_TOOLS[params.command]
        : undefined;
      if (nested) return recordNothing(session, nested);

      let args: Record<string, unknown>;
      try {
        args = params.args ? JSON.parse(params.args) : {};
      } catch (err) {
        // The directive hint normally fires from the sub-invoke catch below, so
        // a malformed `args` payload would pre-empt it with a bare JSON syntax
        // error — the same failure the recorder-tool guard is placed above this
        // parse to avoid. An author who wrote `command: "echo"` needs to hear
        // that echo is a directive, not that their payload is unparseable: the
        // payload was never going to run either way.
        //
        // Gated on the REGISTRY, not on the hint table alone, so the property
        // `isToolNotFound` protects holds here too — a tool one day registered
        // under a directive name reports its own error rather than a hint. Only
        // consulted on this path, where there is no invocation to ask.
        if (registry.getTool(params.command) === undefined) {
          const hint = directiveCommandHint(params.command);
          if (hint) return recordNothing(session, hint);
        }
        throw err;
      }

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

      let captured: { selector?: Selector; warning?: string } | undefined;
      if (isTap) {
        captured = await captureTapSelector(registry, args.udid as string, {
          x: args.x as number,
          y: args.y as number,
        });
      }

      let toolResult: unknown;
      try {
        toolResult = await invokeSubTool(registry, ctx, params.command, args);
      } catch (err) {
        // `command` names an MCP tool, but the vocabulary an author has in
        // mind while recording is the flow file's own directives — so
        // `command: "echo"` lands here as a bare "Tool not found", which says
        // nothing about what to do instead. Only rewrite a genuine not-found:
        // a tool that ran and failed must report its own error.
        const hint = isToolNotFound(err, params.command)
          ? directiveCommandHint(params.command)
          : undefined;
        if (!hint) throw err;
        return recordNothing(session, hint);
      }

      // A recorded wait that HELD against the tree await-ui-element reads gets
      // asked the tree the runner resolves DIRECTIVES against too, so the author learns
      // now — rather than after polish — whether the conversion is safe. One
      // that never held is a step failure at replay and is reported as such
      // instead (see {@link UNMET_WAIT_WARNING}).
      let crossTreeWarning: string | undefined;
      if (params.command === AWAIT_UI_ELEMENT_TOOL_ID) {
        if (isUnmetUiWaitResult(params.command, toolResult)) {
          crossTreeWarning = UNMET_WAIT_WARNING;
        } else {
          crossTreeWarning = (await probeAgainstRunnerTree(registry, ctx, args)).warning;
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
        // No stable selector — keep a coordinate tap, but still as a `tap:`
        // directive so every tap reads uniformly.
        step = { kind: "tap", x: args.x as number, y: args.y as number, ...tapTimes };
        warning = captured?.warning;
      } else if (isLaunch) {
        step = { kind: "launch", app: strippedArgs.bundleId as string };
      } else if (runTarget?.flow) {
        step = { kind: "run", flow: runTarget.flow };
      } else {
        warning = crossTreeWarning ?? runTarget?.warning;
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
