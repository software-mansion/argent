import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  FAILURE_CODES,
  FailureError,
  ToolNotFoundError,
  type DeviceInfo,
  type Registry,
  type ToolDefinition,
} from "@argent/registry";
import {
  isInjectableBundleId,
  nativeDevtoolsRef,
  type NativeDevtoolsApi,
} from "../../blueprints/native-devtools";
import {
  chooseFrontmostConnectedApp,
  inspectConnectedNativeApps,
} from "../../utils/native-target-app";
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
  vacuousHiddenSelectors,
} from "../await-ui-element";
import { AWAIT_SCREEN_IDLE_TOOL_ID } from "../await-screen-idle";
import { selectorEstablishedInSteps, selectorIdentityTerms } from "./flow-selector-evidence";
import { runSequenceFailure } from "../run-sequence";
import { probeWhenCondition } from "./flow-actions";
import { NATIVE_READY_POLL_MS, NATIVE_READY_TIMEOUT_MS } from "./flow-run";
import { summarizeStep } from "./flow-finish-recording";
import { invokeSubTool } from "../../utils/sub-invoke";
import { settleWithin, sleepOrAbort } from "../../utils/timing";
import { resolveDevice } from "../../utils/device-info";
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
  command: z.string().describe('MCP tool name (e.g. "gesture-tap", "screenshot", "launch-app")'),
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

/**
 * Recording has no counterpart to replay's launch readiness gate
 * (`waitForNativeDevtools` in flow-run.ts): a live `restart-app` returns before
 * the injected dylib dials back, so a tap recorded right after it would read
 * the tree before the app has connected and silently keep coordinates. Ride
 * out that window: when the recording has a launch, poll that (most recent)
 * launch's exact bundle's synchronous connection bit (the same check replay
 * uses); otherwise poll until auto-targeting finds one connected, foreground-like
 * app. Stop when the budget lapses, then let the single tree read report
 * whatever is really there. The budget mirrors replay's NATIVE_READY_TIMEOUT_MS:
 * a cold start the replay gate would ride out, recording rides out too. When the
 * app was never Argent-launched this adds one budget's worth of latency before
 * the (accurate) capture warning; that beats silently downgrading a post-launch
 * tap.
 */
type CaptureReadiness = "ready" | "unavailable" | "timed-out" | "aborted";

// A third-party app started outside Argent can never connect during the active
// recording. Remember one exhausted/unavailable readiness probe per device and
// session so a 20-tap walkthrough does not pay the full budget 20 times. A
// successful tree read below or a successful app launch/restart clears the
// entry, allowing recovery when instrumentation becomes available later.
const captureReadinessMisses = new WeakMap<RecordingSession, Set<string>>();

function readinessMissesFor(session: RecordingSession): Set<string> {
  let misses = captureReadinessMisses.get(session);
  if (!misses) {
    misses = new Set<string>();
    captureReadinessMisses.set(session, misses);
  }
  return misses;
}

async function awaitIosDevtoolsTarget(
  registry: Registry,
  device: DeviceInfo,
  bundleId?: string,
  signal?: AbortSignal
): Promise<CaptureReadiness> {
  if (signal?.aborted) return "aborted";
  let api: NativeDevtoolsApi;
  try {
    const ndRef = nativeDevtoolsRef(device);
    api = await registry.resolveService<NativeDevtoolsApi>(ndRef.urn, ndRef.options);
  } catch {
    return signal?.aborted ? "aborted" : "unavailable";
  }
  const deadline = Date.now() + NATIVE_READY_TIMEOUT_MS;
  for (;;) {
    if (signal?.aborted) return "aborted";
    const remaining = deadline - Date.now();
    if (remaining <= 0) return "timed-out";

    if (bundleId) {
      try {
        if (api.isConnected(bundleId)) return "ready";
      } catch {
        // Treat a transient connection read as not-ready and keep polling.
      }
    } else {
      // Fragment auto-targeting must inspect app state, whose RPC can itself
      // wedge. Race it against the remaining budget so the advertised
      // 8-second gate stays a hard cap rather than 8 seconds between
      // potentially multi-second getAppState calls.
      const inspected = await settleWithin(inspectConnectedNativeApps(api), remaining, signal);
      if (inspected.type === "aborted") return "aborted";
      if (inspected.type === "timeout") return "timed-out";
      if (inspected.type === "value" && chooseFrontmostConnectedApp(inspected.value)) {
        return "ready";
      }
    }

    const delayMs = Math.min(NATIVE_READY_POLL_MS, deadline - Date.now());
    if (delayMs <= 0) return "timed-out";
    if (!(await sleepOrAbort(delayMs, signal))) return "aborted";
  }
}

/**
 * The most recent `launch` step recorded so far — the app the walkthrough is
 * currently driving, which is what the gate must wait on. Keying on the LEADING
 * launch instead misfires on a recording that relaunches a second app mid-flow
 * (`restart A` … `restart B` … tap): `restart-app B` never clears A's connection
 * bit, so polling A returns ready at once and B's own connect window is never
 * ridden out — exactly the downgrade this gate exists to prevent. Replay gates
 * each launch step on its own bundle for the same reason. Reduces to the leading
 * launch for the common single-launch flow.
 */
function mostRecentLaunch(session: RecordingSession): Extract<FlowStep, { kind: "launch" }> | null {
  for (let i = session.flow.steps.length - 1; i >= 0; i--) {
    const step = session.flow.steps[i];
    if (step.kind === "launch") return step;
  }
  return null;
}

function recordedLaunchApp(session: RecordingSession, platform: string): string | null {
  const launch = mostRecentLaunch(session);
  return launch ? appIdForPlatform(launch.app, platform) : null;
}

function invalidateReadinessMissAfterAppStart(
  session: RecordingSession,
  command: string,
  args: Record<string, unknown>,
  result: unknown
): void {
  const didStart =
    typeof result === "object" &&
    result !== null &&
    ((command === "restart-app" && (result as { restarted?: unknown }).restarted === true) ||
      (command === "launch-app" && (result as { launched?: unknown }).launched === true));
  if (!didStart) return;

  const misses = readinessMissesFor(session);
  // Both tools require a device id, but clearing all misses is the safe fallback
  // for older/custom registry adapters that omit it: a successful app start is
  // fresh evidence and another bounded probe is preferable to a stale miss.
  if (typeof args.udid === "string") misses.delete(args.udid);
  else misses.clear();
}

function platformOf(udid: unknown): string | undefined {
  try {
    if (typeof udid === "string") return resolveDevice(udid).platform;
  } catch {
    // Unresolvable device — callers fall back to platform-neutral wording.
  }
  return undefined;
}

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
 * The clause naming how to read the tree the RUNNER resolves against — or, on
 * Android and Chromium, that no read-only tool does. Android's runner tree is
 * the full accessibility hierarchy; the only full-hierarchy readers
 * (`native-find-views` / `native-full-hierarchy`) are Apple-only, and Android
 * `describe` returns the TRIMMED interactables tree the recorder already read.
 * Chromium's runner tree keeps only addressable nodes, yet `describe` returns
 * the FULL DOM the recorder read — a superset that still shows the very nodes
 * the runner drops. So naming `describe` on either platform would point the
 * author at the recorder's own tree under the banner of the runner's — the
 * exact wrong-tree steer this warning exists to prevent. iOS (and the remaining
 * platforms) have a reader that genuinely sees the runner's side.
 */
function runnerSideReadClause(udid: unknown): string {
  const platform = platformOf(udid);
  if (platform === "android") {
    return (
      "No read-only tool exposes the runner's full hierarchy on Android — `describe` returns the " +
      "trimmed tree the recorder read, not the runner's — so re-record with a selector an " +
      "interactable carries, or keep it raw"
    );
  }
  if (platform === "chromium") {
    return (
      "No read-only tool exposes the runner's trimmed tree on Chromium — `describe` returns the " +
      "full DOM the recorder read, including the non-addressable nodes the runner drops — so " +
      "re-record with a selector an addressable node carries (an id, label, text, or a " +
      "clickable/focused element), or keep it raw"
    );
  }
  return `${treeReaderFor(udid)} reads the runner's side`;
}

/**
 * WHY the recorder's tree and the runner's tree can disagree — which is a
 * different story per platform, and stating the iOS one everywhere makes the
 * message false exactly where the author is trying to act on it.
 */
function treeDivergenceFor(udid: unknown): string {
  const platform = platformOf(udid);
  if (platform === "ios" || platform === "ios-remote") {
    return (
      "The recorder reads the accessibility tree and the runner reads the full native view " +
      "hierarchy; they overlap but neither contains the other."
    );
  }
  if (platform === "chromium") {
    return (
      "Both read the same DOM, but the flow tree keeps only addressable nodes — an element with " +
      "no id, label, value, clickable or focused state never reaches the runner."
    );
  }
  if (platform === "android") {
    return (
      "The recorder reads the trimmed accessibility tree and the runner reads the full " +
      "hierarchy including not-important views; each holds elements the other drops."
    );
  }
  return "The recorder and the runner read different projections of the screen.";
}

function abortError(): Error {
  const err = new Error(
    "flow-add-step aborted while re-probing the recorded wait against the runner's tree"
  );
  err.name = "AbortError";
  return err;
}

/**
 * The recorder and the runner read DIFFERENT trees. `await-ui-element`
 * evaluates against the accessibility tree; the `await:`/`assert:` DIRECTIVE
 * that polish converts this step into is evaluated against the runner's tree.
 * They overlap but neither contains the other — an id present in one can be
 * absent from the other, and on iOS even the role vocabularies are disjoint.
 * So a check can pass live and fail once converted, which makes "each step is
 * executed live so you verify it works" untrue exactly where it matters.
 *
 * Re-probe the same condition against the runner's tree and report the answer.
 * It is a WARNING, never a refusal: the step is recorded as a raw
 * `tool: await-ui-element`, and at replay that tool reads the SAME
 * accessibility tree it just passed against — so "it would fail every run" was
 * false for the form actually written. What the probe really tells the author
 * is whether the conversion is safe, which is a polish-time decision, and the
 * blocking audit is where a flow is held to it.
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
  let device: DeviceInfo;
  try {
    device = resolveDevice(args.udid);
  } catch {
    return {}; // unresolvable device; the live result stands
  }
  const outcome = await probeWhenCondition(
    // The signal rides on ActionEnv separately from `ctx`, so pass it too:
    // a cancelled flow-add-step must stop this probe rather than polling on.
    { registry, ctx, device, signal: ctx?.signal },
    {
      condition: condition as WaitCondition,
      selector: selector as FlowSelector,
      expectedText: typeof args.expectedText === "string" ? args.expectedText : undefined,
      textMatch: args.textMatch as TextMatchMode | undefined,
    }
  );
  if (outcome.ok) return {};
  if (outcome.aborted) throw abortError();
  if (outcome.indeterminate) {
    return {
      // No trailing period: the caller joins this with ". " and a second one
      // renders as "..". And no claim that the two trees DIFFER — nothing was
      // compared. The runner's tree could not be read at all, which is an
      // environment failure; reporting it as a known divergence sends the
      // author to rewrite a selector that may be perfectly good.
      warning:
        `this check could not be re-verified against the tree the RUNNER reads ` +
        `(${outcome.reason}), so it passed against the accessibility tree only. Whether it ` +
        `would convert to \`await:\`/\`assert:\` is UNKNOWN, not known-bad — re-probe once that ` +
        `tree source is back before trusting the conversion`,
    };
  }
  return {
    warning:
      `recorded, but this condition does NOT hold against the tree the runner resolves ` +
      `directives against (${outcome.reason ?? "no match"}). As the raw ` +
      `\`tool: ${AWAIT_UI_ELEMENT_TOOL_ID}\` step it replays fine — it reads the same tree it ` +
      `just passed against — but an \`assert:\` conversion WILL fail (it reads that tree on ` +
      `the same short grace this probe just used), and an \`await:\` will too unless the ` +
      `element reaches that tree within its longer timeout. ` +
      `Either keep it raw deliberately, or re-record the wait with a selector present in both`,
  };
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
 */
async function captureTapSelector(
  registry: Registry,
  session: RecordingSession,
  udid: string,
  point: { x: number; y: number },
  signal?: AbortSignal
): Promise<{ selector?: Selector; warning?: string; ambiguous?: boolean; container?: boolean }> {
  try {
    const device = resolveDevice(udid);
    // iOS's tree source connects asynchronously after launch — absorb the
    // post-restart-app window replay's launch gate covers (see above). Apple
    // system apps can never connect, and an exhausted probe is cached for this
    // recording session so later taps do not each wait another full budget.
    if (device.platform === "ios") {
      const misses = readinessMissesFor(session);
      const launchApp = recordedLaunchApp(session, device.platform);
      if (!misses.has(device.id) && (!launchApp || isInjectableBundleId(launchApp))) {
        const readiness = await awaitIosDevtoolsTarget(
          registry,
          device,
          launchApp ?? undefined,
          signal
        );
        if (readiness === "aborted") throw abortError();
        if (readiness !== "ready") misses.add(device.id);
      }
    }
    if (signal?.aborted) throw abortError();
    const { tree, source } = await fetchFlowTree(registry, device);
    readinessMissesFor(session).delete(device.id);
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
    return { selector, warning: fallbackSourceWarning(source, device.platform) };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    return {
      warning: `selector capture failed (${err instanceof Error ? err.message : String(err)})`,
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
    rewriteCondition:
      "when the target resolves as a sibling flow in this recording's folder (otherwise the raw " +
      "`tool: flow-execute` step is kept)",
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
      ? ` — the recorder rewrites it into the \`${command}:\` step ${hint.rewriteCondition ?? "for you"}. ` +
        `A \`delayMs\` on the call opts out of the rewrite: it is then kept as a raw \`tool: ${hint.tool}\` ` +
        `step (a replay delay has no directive form), so leave \`delayMs\` off if you want the \`${command}:\` step.`
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
 * True when the flow being recorded has ALREADY established this selector
 * positively — acted on it, or proved it present — in an earlier step.
 *
 * This is what makes a later `hidden` check falsifiable. The wait tool itself
 * can only see its own poll window, so an element removed by the immediately
 * preceding action reads as "never matched" even though the flow proves it
 * existed two steps ago. Without this lookup the recorder would reject the
 * correct authoring order (prove visible -> act -> prove gone) and push authors
 * into adding absence checks by hand in YAML, which the skill forbids.
 */
function selectorEstablishedInFlow(session: RecordingSession, selector: unknown): boolean {
  return selectorEstablishedInSteps(session.flow.steps, selector);
}

function flowExecuteRecordBlock(
  result: unknown
): { reason: string; mayHaveMutated: boolean } | null {
  if (typeof result !== "object" || result === null) return null;
  const value = result as {
    ok?: unknown;
    notice?: unknown;
    executionPrerequisite?: unknown;
    passed?: unknown;
  };
  if (value.ok === false) {
    // Only warn about mutation when a prior composed step actually ran to
    // completion. A flow-execute that failed on its first step (passed: 0)
    // mutated nothing, so "restore the recorded prefix" would name a prefix
    // that does not exist. Unknown shape ⇒ assume mutation is possible.
    const mayHaveMutated = typeof value.passed === "number" ? value.passed > 0 : true;
    return { reason: "flow-execute returned ok: false", mayHaveMutated };
  }
  if (Object.prototype.hasOwnProperty.call(value, "notice")) {
    // The notice string only carries the generic handshake ("re-call with
    // prerequisiteAcknowledged"); name the actual prerequisite alongside it so
    // the author learns WHAT to satisfy without re-reading the returned result.
    const prereq =
      typeof value.executionPrerequisite === "string" && value.executionPrerequisite.length > 0
        ? ` (unmet prerequisite: ${value.executionPrerequisite})`
        : "";
    return {
      reason:
        typeof value.notice === "string"
          ? `flow-execute returned a prerequisite notice: ${value.notice}${prereq}`
          : `flow-execute returned a prerequisite notice without executing steps${prereq}`,
      mayHaveMutated: false,
    };
  }
  return null;
}

function partialMutationWarning(command: "flow-execute" | "run-sequence"): string {
  const stepKind = command === "flow-execute" ? "composed" : "nested";
  return (
    `Prior ${stepKind} steps may already have mutated device state. ` +
    "Restore the device to the state produced by the recorded prefix before adding another " +
    "step, or the remaining recording may not be reproducible."
  );
}

function runSequenceProgress(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const { completed, total } = result as { completed?: unknown; total?: unknown };
  return typeof completed === "number" && typeof total === "number"
    ? `${completed}/${total} nested steps completed`
    : null;
}

// Whether any nested step ran to completion before a run-sequence stopped or was
// cancelled. When nothing completed (`completed: 0` — the failure/abort landed on
// or before the first step), no prior state was mutated, so the mutation warning
// would name a recorded prefix that does not exist. Unknown shape ⇒ assume a
// mutation is possible (we cannot prove otherwise).
function nestedStepsRan(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return true;
  const completed = (result as { completed?: unknown }).completed;
  return typeof completed === "number" ? completed > 0 : true;
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
  // root (setActiveProjectRoot), so this refuses nothing that could have run.
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
     * The flow line just appended. Absent on the paths that deliberately record
     * NOTHING — an unrecognized `command`, or a rejected wait — where the tool
     * still reports the unchanged `stepCount` so the caller can see its take was
     * left alone. Required while every return appended a step; these returns are
     * what reopened it, and a placeholder would claim a line that is not there.
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
      completedMsg: ({ params }) => `Added ${params.command} step to flow ${params.name}`,
      failedMsg: ({ params, failureSignal }) =>
        `Failed to add ${params.command} step to flow ${params.name}: ${failureSignal.error_code}`,
    },
    description: `Execute a tool call and record it as a step in the flow named by \`name\` + \`project_root\` (the recording must already be open — see flow-start-recording). Use when recording a flow and you want to run and capture each action. A coordinate \`gesture-tap\` is recorded as a portable \`tap: { selector }\` step when the tapped element has stable text/identifier (otherwise coordinates are kept with a warning); a \`restart-app\` is recorded as a \`launch\` step (record one FIRST to make the flow a self-contained e2e flow; restart-app has no chromium support, so a chromium flow records as a fragment — add the \`launch: { chromium: <app path> }\` line to the YAML afterward, deleting the executionPrerequisite line if one was recorded: a flow that starts with a launch must not declare it).
Returns { message, toolResult, stepCount, recorded, savedTo } - \`recorded\` is the one line that was appended, and \`stepCount\` how many steps the flow now has. The flow's full YAML is deliberately NOT returned per step; read it back from \`flow-finish-recording\`. \`savedTo\` is where the YAML landed: a host path, or, against a remote client, the directive that has the client write it (the only field naming the destination in that mode). If it fails an error is returned and nothing is recorded.
If a step was recorded by mistake, edit the .yaml to remove it. In host (local) mode the recorder re-reads the file before each append, so an edit made between steps is kept. Against a remote client, edit after \`flow-finish-recording\` because the in-memory copy is authoritative there and can overwrite a mid-recording edit.`,
    zodSchema,
    services: () => ({}),
    async execute(_services, params, ctx) {
      const session = requireRecordingSession(params.project_root, params.name);

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
      if (nested) {
        const { stepCount, note } = await activeFlowState(session);
        return {
          message: `${nested} Nothing was executed and no step was recorded.${note ? ` ${note}` : ""}`,
          toolResult: undefined,
          stepCount,
          savedTo: session.filePath,
        };
      }

      const args: Record<string, unknown> = params.args ? JSON.parse(params.args) : {};

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
        captured = await captureTapSelector(
          registry,
          session,
          args.udid as string,
          {
            x: args.x as number,
            y: args.y as number,
          },
          ctx?.signal
        );
      }

      // A disconnect during the readiness poll must cancel the live action,
      // not merely stop polling and execute the tap anyway.
      if (ctx?.signal?.aborted) throw abortError();

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
        const { stepCount, note } = await activeFlowState(session);
        return {
          message: `${hint} Nothing was executed and no step was recorded.${note ? ` ${note}` : ""}`,
          toolResult: undefined,
          stepCount,
          savedTo: session.filePath,
        };
      }
      invalidateReadinessMissAfterAppStart(session, params.command, args, toolResult);

      // An `await-ui-element` whose condition never held reports
      // { success: false } instead of throwing — the same shape flow-run and
      // run-sequence special-case to stop a sequence. Without this gate the
      // wait would record as a passing step and bake a gate that fails every
      // replay. Hand the full result back, record nothing.
      if (isUnmetUiWaitResult(params.command, toolResult)) {
        const { stepCount, note } = await activeFlowState(session);
        const waitNote = (toolResult as { note?: unknown }).note;
        const cancelled = ctx?.signal?.aborted === true;
        return {
          message: cancelled
            ? `await-ui-element was cancelled — step NOT recorded${typeof waitNote === "string" ? `: ${waitNote}` : ""}.${note ? ` ${note}` : ""}`
            : "await-ui-element condition not met — step NOT recorded. Fix the wait (a longer " +
              `timeoutMs or a different selector) and re-run this flow-add-step call.${note ? ` ${note}` : ""}`,
          toolResult,
          stepCount,
          savedTo: session.filePath,
        };
      }

      // `await-screen-idle` reports "did not settle" as a SOFT `settled: false`
      // rather than a failure, so persisting it bakes a step that is green on
      // every replay whatever the screen does — the same unfalsifiable class
      // the `hidden` gate below exists to block. The skills already say never
      // to persist it; without this gate the recorder did it silently.
      if (params.command === AWAIT_SCREEN_IDLE_TOOL_ID) {
        const { stepCount, note } = await activeFlowState(session);
        const settled = (toolResult as { settled?: unknown }).settled;
        return {
          message:
            "`await-screen-idle` is a live diagnostic, not a gate — step NOT recorded. It " +
            "reports a screen that never settled as `settled: false` instead of failing, so a " +
            "recorded one passes on every replay no matter what the screen does" +
            (settled === false ? " — and it just reported `settled: false`" : "") +
            ". Record readiness as the element you actually need next (`await-ui-element`), or " +
            "add `await: { idle: true }` during polish, which FAILS when the screen never " +
            `settles.${note ? ` ${note}` : ""}`,
          toolResult,
          stepCount,
          savedTo: session.filePath,
        };
      }

      // A `hidden` wait that passed without the selector EVER matching is not
      // proof of dismissal — it is a check that cannot fail. Recorded, it
      // becomes a permanently-green gate: a typo'd selector, a renamed id, or
      // the wrong screen all satisfy it.
      //
      // "Ever matched" is scoped to the wait's own poll window, which is too
      // narrow on its own: the action that removes an element runs BEFORE the
      // check, so the normal authoring order (prove visible -> act -> prove
      // gone) always reaches here with everMatched false. The flow itself is
      // the wider evidence — if an earlier recorded step established this
      // selector, the check is falsifiable and is recorded.
      //
      // Read from `vacuousHiddenSelectors` rather than the wait's own args, so
      // a wait NESTED in a `run-sequence` is judged too. Refusing only the
      // direct call left the gate one wrapper away from being bypassed.
      const vacuousHidden = vacuousHiddenSelectors(params.command, toolResult, args).filter(
        // A selector this evidence model cannot name (role-only, a regex text
        // locator) is not something it may condemn either — the runner passes
        // it clean for the same reason, so refusing to record it would only
        // disagree with the runner. Mirror `hiddenCheckIsFalsifiable`.
        (selector) =>
          selectorIdentityTerms(selector).length > 0 &&
          !selectorEstablishedInFlow(session, selector)
      );
      if (vacuousHidden.length > 0) {
        const { stepCount, note } = await activeFlowState(session);
        const wrapped = params.command !== AWAIT_UI_ELEMENT_TOOL_ID;
        return {
          message:
            `the \`hidden\` condition was met without the selector ever matching, and no earlier ` +
            `step in this flow established it — step NOT recorded.${
              wrapped
                ? ` (Inside the \`${params.command}\` you passed; wrapping the wait does not make it provable, so the whole step is refused.)`
                : ""
            } This check cannot fail, so ` +
            "it would prove nothing on replay. Record a `visible` check for the same selector " +
            "while the element IS on screen first, then act, then record this one; the flow " +
            "then proves the element went away. If the element is never present at all, the " +
            `selector is wrong — find the real one with ${treeReaderFor(args.udid)}.${
              // A wrapped wait means the whole sequence ran first, so earlier
              // nested steps may already have changed device state — the same
              // hazard the run-sequence failure/cancel refusals warn about.
              wrapped ? ` ${partialMutationWarning("run-sequence")}` : ""
            }${note ? ` ${note}` : ""}`,
          toolResult,
          stepCount,
          savedTo: session.filePath,
        };
      }

      // The wait held against the accessibility tree. Ask the tree the runner
      // resolves DIRECTIVES against too, so the author learns now — rather than
      // after polish — whether the conversion is safe.
      let crossTreeWarning: string | undefined;
      if (params.command === AWAIT_UI_ELEMENT_TOOL_ID) {
        const probe = await probeAgainstRunnerTree(registry, ctx, args);
        crossTreeWarning = probe.warning
          ? `${probe.warning}. ${treeDivergenceFor(args.udid)} ${runnerSideReadClause(args.udid)}`
          : undefined;
      }

      const sequenceFailure = runSequenceFailure(params.command, toolResult);
      if (sequenceFailure) {
        const { stepCount, note } = await activeFlowState(session);
        const mutationWarning = nestedStepsRan(toolResult)
          ? ` ${partialMutationWarning("run-sequence")}`
          : "";
        return {
          message:
            `run-sequence stopped on a failed nested step: ${sequenceFailure} — step NOT recorded.` +
            `${mutationWarning}${note ? ` ${note}` : ""}`,
          toolResult,
          stepCount,
          savedTo: session.filePath,
        };
      }

      // run-sequence honours cancellation between nested steps by returning a
      // partial result rather than throwing. A post-invoke guard is therefore
      // required: otherwise that partial sequence would be recorded as if all
      // nested actions had run successfully.
      if (params.command === "run-sequence" && ctx?.signal?.aborted) {
        const { stepCount, note } = await activeFlowState(session);
        const progress = runSequenceProgress(toolResult);
        const mutationWarning = nestedStepsRan(toolResult)
          ? ` ${partialMutationWarning("run-sequence")}`
          : "";
        return {
          message:
            `run-sequence was cancelled${progress ? ` with ${progress}` : ""} — step NOT recorded.` +
            `${mutationWarning}${note ? ` ${note}` : ""}`,
          toolResult,
          stepCount,
          savedTo: session.filePath,
        };
      }

      if (params.command === RUN_TARGET_COMMAND) {
        const recordBlock = flowExecuteRecordBlock(toolResult);
        if (recordBlock) {
          const { stepCount, note } = await activeFlowState(session);
          const mutationWarning = recordBlock.mayHaveMutated
            ? ` ${partialMutationWarning("flow-execute")}`
            : "";
          return {
            message:
              `${recordBlock.reason} — step NOT recorded.${mutationWarning}` +
              `${note ? ` ${note}` : ""}`,
            toolResult,
            stepCount,
            savedTo: session.filePath,
          };
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
          crossTreeWarning ??
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
