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
import { AWAIT_UI_ELEMENT_TOOL_ID } from "../await-ui-element";
import { probeWhenCondition } from "./flow-actions";
import { summarizeStep } from "./flow-finish-recording";
import { invokeSubTool } from "../../utils/sub-invoke";
import { resolveDevice } from "../../utils/device-info";
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
        const { stepCount, note } = await activeFlowState(session);
        return {
          message: `${hint} Nothing was executed and no step was recorded.${note ? ` ${note}` : ""}`,
          toolResult: undefined,
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
