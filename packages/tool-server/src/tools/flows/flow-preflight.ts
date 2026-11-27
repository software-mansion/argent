import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  canonicalFlowPath,
  canonicalToolArgs,
  canonicalToolId,
  classifyOnDiskSpelling,
  describeParamIssues,
  FAILURE_CODES,
  getFailureSignal,
  MAX_RUN_DEPTH,
  nestedFlowTarget,
  pickE2eFile,
  ToolParamAliasError,
  type FailureCode,
  type NestedFlowTarget,
  type ToolDefinition,
} from "@argent/registry";
import {
  blockSteps,
  chromiumLaunchSpec,
  escapeInline,
  flowNameCasingError,
  flowPathCasingError,
  hostFileArgumentStat,
  intoStep,
  parseFlow,
  parseFlowCollecting,
  precedesLeadingLaunch,
  runTargetName,
  type FlowFile,
  type FlowStep,
  type Launch,
  type StepLevel,
} from "./flow-utils";
import {
  resolveRunTarget,
  resolveSavedTest,
  type ProjectAccess,
  type ResolvedFlowFile,
} from "./project-access";
import { locateScript, typeScriptScriptRefusal } from "./flow-script-step";
import { DEVICE_BIND_KEYS, DEVICE_BIND_LIST_KEYS } from "./flow-device-keys";

/** The input schemas of a tool a `tool:` step can call. */
type CallableTool = Pick<ToolDefinition, "inputSchema" | "zodSchema">;

/** A tool's input schemas by tool id, or undefined for a tool this tool-server lacks. */
export type ToolSchemaLookup = (tool: string) => CallableTool | undefined;

interface LeadingLaunchEnv {
  schemas: ToolSchemaLookup;
  project: ProjectAccess;
}

/**
 * Yield every parsed step, recursing into a block directive's children through
 * {@link blockSteps}: this is the sole feeder of
 * `assertUploadSelfContained`, so a block absent from the recursion would
 * carry an uploaded flow's nested `run:`, `script:` or `snapshot` past the
 * preflight.
 *
 * Each step arrives with its AUTHORED position - its place in the file as
 * written, every entry counted, `echo` included. A pre-run refusal has no report
 * line to point at, so the file is the one thing its reader can count against;
 * the CLI and MCP renderers number differently again, and already disagree with
 * each other. {@link retiredArgReason} says which counting its number uses.
 *
 * A `run:` target is deliberately not followed: the fragment resolves at run
 * time, so reading it here would duplicate that lookup.
 * `execRunStep` repeats the pass where the fragment loads.
 */
export function* walkSteps(
  steps: FlowStep[],
  within = "",
  levels: StepLevel[] = [],
  label = "step"
): Generator<{ step: FlowStep; where: string; at: StepLevel[] }> {
  for (const [i, step] of steps.entries()) {
    const where = `${label} ${i + 1}${within}`;
    const at = [...levels, { step: i + 1 }];
    yield { step, where, at };
    const inner = blockSteps(step);
    if (inner) {
      yield* walkSteps(
        inner,
        ` of the ${step.kind}: block at ${where}`,
        intoStep(at, { [step.kind]: true })
      );
    }
  }
}

/** {@link walkSteps} over a file's `steps:`, then its `shutdown:`. */
export function* walkFlow(
  flow: FlowFile,
  within = ""
): Generator<{ step: FlowStep; where: string }> {
  yield* walkSteps(flow.steps, within);
  if (flow.shutdown) yield* walkSteps(flow.shutdown, within, [], "shutdown step");
}

/** A retired key reaching a tool through a `tool:` step, with the guidance that tool declares. */
interface RetiredArgUse {
  where: string;
  tool: string;
  key: string;
  guidance: string;
}

/**
 * The guidance a schema property carries if - and only if - it is a RETIRED
 * field, else undefined (an empty string is retired with no guidance).
 *
 * A retired field is declared `z.never().optional()`, which serializes to a
 * `not: {}` with no `type`. Matched by SHAPE and never by field name, so a key
 * retired on any tool later is refused with no edit here - the same test
 * `isRetiredField` applies on the CLI's flag paths.
 */
function retiredKeyGuidance(prop: unknown): string | undefined {
  const schema = prop as { not?: Record<string, unknown>; description?: string } | undefined;
  if (!schema?.not || Object.keys(schema.not).length > 0) return undefined;
  // Minus the "Retired: " label - every caller already says retired.
  return (schema.description ?? "").replace(/^Retired:\s*/, "");
}

/** The schema properties a registered tool declares, or undefined for a tool this registry lacks. */
function toolArgProps(
  schemas: ToolSchemaLookup,
  tool: string
): Record<string, unknown> | undefined {
  return schemas(tool)?.inputSchema?.properties as Record<string, unknown> | undefined;
}

/** The first retired key in one invocation's args, against the properties its tool declares. */
function retiredArgIn(
  props: Record<string, unknown>,
  tool: string,
  args: Record<string, unknown>,
  where: string
): RetiredArgUse | undefined {
  for (const key of Object.keys(args)) {
    const guidance = retiredKeyGuidance(props[key]);
    if (guidance !== undefined) return { where, tool, key, guidance };
  }
  return undefined;
}

/**
 * The tool invocations a `tool:` step's args carry inline, each with the
 * position naming it. Matched by SHAPE - a `{ tool, args }` entry, in an arg's
 * array (run-sequence's `steps`) or as an arg itself - never by the carrying
 * tool's name.
 *
 * Only under a key the carrying tool DECLARES: a non-strict schema strips an
 * undeclared key before execute, so the invocation it looks like is never made
 * and refusing the flow over it would refuse a call that never happens.
 *
 * One level only: those args are forwarded verbatim to the named tool, and no
 * tool that batches others allows a batching tool among them.
 */
function* nestedInvocations(
  props: Record<string, unknown>,
  args: Record<string, unknown>
): Generator<{ tool: string; args: Record<string, unknown>; at: string }> {
  for (const [key, value] of Object.entries(args)) {
    if (!Object.hasOwn(props, key)) continue;
    const entries = Array.isArray(value) ? value : [value];
    for (const [i, entry] of entries.entries()) {
      const call = entry as { tool?: unknown; args?: unknown } | null | undefined;
      if (typeof call?.tool !== "string") continue;
      if (typeof call.args !== "object" || call.args === null || Array.isArray(call.args)) continue;
      yield {
        tool: call.tool,
        args: call.args as Record<string, unknown>,
        at: Array.isArray(value) ? `step ${i + 1}` : `\`${key}\``,
      };
    }
  }
}

/**
 * The first retired key a raw `tool:` step in these steps passes - in its own
 * args, or in an invocation those args carry inline (a recorded run-sequence
 * batch).
 *
 * The typed directives refuse a retired spelling at parse time (`swipe.settle`),
 * but a recorded `tool:` step carries its args opaquely - the parser knows no
 * tool schemas - so the same key reached `registry.invokeTool` and failed only
 * there, with every earlier step already run against the device. Callers use
 * this to move that refusal to load time.
 *
 * An unknown tool is skipped: that step already fails on its own, with a better
 * message than a missing schema could produce here.
 */
function findRetiredToolArg(schemas: ToolSchemaLookup, flow: FlowFile): RetiredArgUse | undefined {
  for (const { step, where } of walkFlow(flow)) {
    if (step.kind !== "tool") continue;
    const props = toolArgProps(schemas, step.name);
    if (!props) continue;
    const direct = retiredArgIn(props, step.name, step.args, where);
    if (direct) return direct;
    for (const call of nestedInvocations(props, step.args)) {
      const nestedProps = toolArgProps(schemas, call.tool);
      if (!nestedProps) continue;
      // Spelled like walkSteps' block position, so both nestings read alike:
      // "step 1 of the run-sequence step at step 2".
      const hit = retiredArgIn(
        nestedProps,
        call.tool,
        call.args,
        `${call.at} of the ${step.name} step at ${where}`
      );
      if (hit) return hit;
    }
  }
  return undefined;
}

/**
 * The refusal text for {@link findRetiredToolArg}'s hit, shared by both callers.
 * The position carries its counting rule, since "step 2" alone is ambiguous: the
 * CLI renderers would call that same step step 1 (see {@link walkSteps}).
 * Qualified once at the end of `use.where`, not once per nesting level.
 */
function retiredArgReason(use: RetiredArgUse): string {
  return `${use.where} as written (echo included) passes ${use.tool}'s retired \`${use.key}\` key${use.guidance ? `: ${use.guidance}` : ""}`;
}

/**
 * The refusal for the first `script:` step in these steps that this host cannot
 * run, or undefined: a TypeScript file, on a Node.js that does not run
 * TypeScript (see `typeScriptScriptRefusal`).
 *
 * Nothing a step does changes that answer, so it is asked before any of them
 * runs, a `when:` block's included. Left to the step, the refusal lands after
 * earlier steps have seeded data and driven the device, and a step under a
 * `when:` guard passes or errors by the branch the device happens to take.
 */
async function findUnrunnableScript(flow: FlowFile): Promise<string | undefined> {
  for (const { step } of walkFlow(flow)) {
    if (step.kind !== "script") continue;
    const refusal = await typeScriptScriptRefusal(step.path);
    if (refusal !== undefined) return refusal;
  }
  return undefined;
}

/**
 * Why a loaded `run:` fragment is refused before any of its steps runs, or
 * undefined: the root flow's load-time gates, applied to the fragment at the
 * only moment its steps exist. One function for both callers:
 * `execRunStep`, which charges the refusal to the `run:` step, and
 * {@link scanLeadingLaunch}, which must not follow a launch into a fragment
 * the executor refuses.
 */
export async function fragmentLoadRefusal(
  schemas: ToolSchemaLookup,
  fragment: FlowFile,
  target: string
): Promise<string | undefined> {
  const retiredArg = findRetiredToolArg(schemas, fragment);
  const shown = escapeInline(target);
  if (retiredArg) return `fragment "${shown}" ${retiredArgReason(retiredArg)}`;
  const unrunnableScript = await findUnrunnableScript(fragment);
  return unrunnableScript ? `fragment "${shown}" cannot run. ${unrunnableScript}` : undefined;
}

/**
 * One `run:` chain entry: the cycle guard compares canonical (realpath'd)
 * paths; error messages render the human-readable display names.
 */
export interface RunStackEntry {
  canonical: string;
  display: string;
}

/**
 * `runDisplayName` against a root name rather than a scope, so
 * {@link scanLeadingLaunch} — which walks the same chain before any scope
 * exists — attributes a hop exactly as the executor will.
 */
export function runDisplayFor(target: string, rootDisplay: string): string {
  const stem = runTargetName(target);
  if (stem !== rootDisplay) return stem;
  // Parse guarantees the target ends in lowercase ".yaml", so slicing the
  // extension off never truncates a real path segment.
  const spelled = target.slice(0, -".yaml".length);
  return spelled === stem ? `./${stem}` : escapeInline(spelled);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Why a run is refused. `cycleAt` is the stack index a cycle closes on, and
 * `tooDeep` marks a stack past {@link MAX_RUN_DEPTH}.
 */
export interface RunRefusal {
  refusal: string;
  cycleAt?: number;
  tooDeep?: true;
}

/**
 * A `run:` target resolved against the top of `stack` and passed through
 * `execRunStep`'s guards (cycle, depth, on-disk casing), or the reason that
 * fails the `run:` step. `display` names the fragment in reports.
 */
export async function guardRunHop(
  project: ProjectAccess,
  stack: RunStackEntry[],
  rootDisplay: string,
  target: string
): Promise<RunRefusal | { hop: ResolvedFlowFile; display: string }> {
  // Reasons quote the target escaped. A YAML error stays raw (its code frame
  // is multi-line); a file system error quotes the path, so it is escaped.
  const shown = escapeInline(target);
  const display = runDisplayFor(target, rootDisplay);

  // One resolution through the project seam: on this host, or in the files
  // the client sent with an uploaded flow (a member carries its text, which
  // `read` in {@link loadRunHop} hands over). A target the client did not send fails this
  // step with the reason.
  let hop: ResolvedFlowFile;
  try {
    hop = await resolveRunTarget(project, path.dirname(stack[stack.length - 1]!.canonical), target);
  } catch (err) {
    return { refusal: `could not load fragment "${shown}": ${escapeInline(errMsg(err))}` };
  }
  const { canonical, spelling } = hop;

  // The cycle guard deliberately runs before the depth guard. A loop that
  // happens to close on the MAX_RUN_DEPTH-th hop is still a loop, and reporting
  // it as "max run depth exceeded" would send the author looking for excessive
  // nesting instead of the repeated reference — and would drop the chain, the
  // one piece of output that identifies the offending edge. The depth guard
  // immediately below still stops the recursion.
  const cycleAt = stack.findIndex((entry) => entry.canonical === canonical);
  if (cycleAt !== -1) {
    return {
      refusal: `cyclic e2e test reference: ${[...stack.map((entry) => entry.display), display].join(" → ")}`,
      cycleAt,
    };
  }

  if (stack.length >= MAX_RUN_DEPTH) {
    return { refusal: "max run depth exceeded", tooDeep: true };
  }

  // The canonical path above resolves the spelling by the FILESYSTEM's rules,
  // and a case-insensitive one (APFS, NTFS) opens a file really named
  // "frag.yaml" for `run: Frag.yaml`. Every expanded step is then attributed to
  // a fragment no directory entry carries, and the identical tree fails with
  // ENOENT on a case-sensitive volume (Linux CI). Only a case-folded verdict
  // refuses: a basename matching nothing at all is an ordinary missing fragment,
  // which the read's own ENOENT reports far better, and an unreadable listing
  // vouches for nothing so it must refuse nothing.
  const suppliedBase = path.posix.basename(target);
  if (spelling.state === "case_folded") {
    // Quote a replacement target only when parseRunTarget would accept one —
    // `addressable` tests the same FLOW_FILE_NAME_PATTERN that gate applies —
    // keeping the target's own directory prefix so the hint is a line the author
    // can paste. An on-disk ".YAML" is reachable by no run: target at all, so
    // that fork asks for the rename it really needs.
    const recovery = spelling.addressable
      ? `reference it as "${escapeInline(target.slice(0, target.length - suppliedBase.length))}${spelling.actual}"`
      : `rename "${spelling.actual}" to "${suppliedBase}" to compose it — e2e test files must be ` +
        `lowercase .yaml`;
    return {
      refusal:
        `mis-cased fragment reference "${shown}": no directory entry is named "${suppliedBase}" ` +
        `(this filesystem matched it case-insensitively to "${spelling.actual}"), so the fragment ` +
        `name keying its step reports is one nothing on disk carries and a case-sensitive ` +
        `checkout could not find the file at all — ${recovery}`,
    };
  }
  return { hop, display };
}

/**
 * The fragment a {@link guardRunHop} hop names, read and parsed, or the reason
 * that fails the `run:` step.
 */
export async function loadRunHop(
  hop: ResolvedFlowFile,
  target: string
): Promise<{ refusal: string } | { fragment: FlowFile }> {
  const read = await readRunHop(hop, target);
  if ("refusal" in read) return read;
  try {
    return { fragment: parseFlow(read.text) };
  } catch (err) {
    return { refusal: fragmentParseRefusal(target, err) };
  }
}

function fragmentParseRefusal(target: string, err: unknown): string {
  return `could not load fragment "${escapeInline(target)}": ${errMsg(err)}`;
}

/** The text of the fragment a {@link guardRunHop} hop names, or the reason it cannot be read. */
async function readRunHop(
  hop: ResolvedFlowFile,
  target: string
): Promise<{ refusal: string } | { text: string }> {
  const shown = escapeInline(target);
  // There is deliberately NO path fence on the host read. A `run:` target is
  // reachable exactly when the tool-server user can read it, the same reach the
  // front door already grants: an operator can point e2e_test_path at any YAML on
  // the host, so restricting composition below that only breaks documented
  // layouts — a fragment shared sideways (`../shared/login.yaml`), and a flows
  // dir symlinked to a tree kept outside the project. The one route that
  // carries untrusted content, an uploaded flow, never reads from this host:
  // assertUploadSelfContained refuses its `run:` steps unless the client sent
  // their fragments, and then the resolution above is a lookup of what the
  // client resolved on its own disk, fenced to the roots the client chose: the
  // project, its .argent/flows, the root flow's directory, and the project of a
  // flow saved under .argent/flows. Over a link each layout above works alone,
  // but a sideways fragment of a flows dir symlinked outside the project lands
  // under none of those roots, so the client refuses it and the run stops
  // before step 1.
  //
  // A missing file reports the same ENOENT shape on both sides, so a reason
  // reads the same whichever machine lacked the fragment.
  let text: string | null;
  try {
    text = await hop.read();
  } catch (err) {
    return { refusal: `could not load fragment "${shown}": ${escapeInline(errMsg(err))}` };
  }
  if (text === null) {
    return {
      refusal: `could not load fragment "${shown}": ENOENT: no such file or directory, open '${escapeInline(hop.canonical)}'`,
    };
  }
  return { text };
}

/**
 * `e2e-execute`'s refusal of a nested run of `root` inside the runs `enclosing`
 * it: a cycle, or a run stack past {@link MAX_RUN_DEPTH}.
 */
export function nestedRunRefusal(
  enclosing: readonly RunStackEntry[],
  root: RunStackEntry
): RunRefusal | undefined {
  const cycleAt = enclosing.findIndex((entry) => entry.canonical === root.canonical);
  if (cycleAt !== -1) {
    return {
      refusal: `cyclic e2e test reference: ${[...enclosing, root].map((entry) => entry.display).join(" → ")}`,
      cycleAt,
    };
  }
  if (enclosing.length >= MAX_RUN_DEPTH)
    return { refusal: "max run depth exceeded", tooDeep: true };
  return undefined;
}

/** {@link scanLeadingLaunch}'s "keep scanning the parent" outcome. */
const NO_EXECUTABLE_STEP = "no-executable-step";

/**
 * The launch the RUN begins with, following a leading `run:` — a fragment whose
 * first step composes a standalone flow starts with that flow's launch, and the runner
 * has to know that before step 1 to boot a chromium app for it (and to refuse a
 * prerequisite that launch would invalidate). `flow` names the flow whose first
 * step IS the launch, so a rejection can point at the right file. Null when the
 * run doesn't begin with a launch, or when the chain can't be read (a broken
 * `run:` target is reported by `execRunStep` when it executes).
 */
export async function leadingLaunch(
  flow: FlowFile,
  stack: RunStackEntry[],
  env: LeadingLaunchEnv
): Promise<{ app: Launch; flow: string } | null> {
  // The root of this run is the top of the seed; the entries below it are
  // the runs that enclose it.
  const found = await scanLeadingLaunch(flow, stack, stack.at(-1)!.display, env);
  return found === NO_EXECUTABLE_STEP ? null : found;
}

/**
 * {@link leadingLaunch}'s recursion, plus the third outcome it needs internally:
 * {@link NO_EXECUTABLE_STEP} — this flow, and everything its leading `run:`s
 * pulled in, contribute no executable step. That is not a reason to give up on
 * the run: `execRunStep` inlines such a fragment and carries straight on
 * to the *parent's* next step, so the scan resumes there too. Abandoning the
 * whole scan instead would make `[run: <echo-only frag>, run: <e2e>]` look
 * launch-free while the run really does launch first thing — the chromium hoist
 * would skip and the prerequisite guard would wave through a run that destroys
 * the state it just asked the caller to establish.
 *
 * The walk below IS the executor's, run ahead of time: it takes the same
 * `runStack` (seeded with the enclosing runs and the root flow) and the same
 * `rootDisplay` the hops are named against, and resolves each hop through the same
 * {@link ProjectAccess.resolveFlowFile} `execRunStep` uses, then applies
 * the same cycle, depth, and on-disk-casing guards and the same load-time
 * gates ({@link fragmentLoadRefusal}). A chain the executor refuses never
 * reaches its launch, so any hop it would error on stays `null` (give up)
 * here, never transparent. Anything unreadable is `null` too — a fragment the
 * client did not send included: the executor reports that when it executes
 * the step.
 */
async function scanLeadingLaunch(
  flow: FlowFile,
  stack: RunStackEntry[],
  rootDisplay: string,
  env: LeadingLaunchEnv
): Promise<{ app: Launch; flow: string } | typeof NO_EXECUTABLE_STEP | null> {
  const top = stack[stack.length - 1]!;
  for (const step of flow.steps) {
    if (precedesLeadingLaunch(step)) continue;
    if (step.kind === "launch") return { app: step.app, flow: top.display };
    if (step.kind !== "run") return null;
    let nested: FlowFile;
    let canonical: string;
    try {
      const hop = await resolveRunTarget(env.project, path.dirname(top.canonical), step.flow);
      canonical = hop.canonical;
      if (stack.some((entry) => entry.canonical === canonical)) return null;
      if (stack.length >= MAX_RUN_DEPTH) return null;
      if (hop.spelling.state === "case_folded") return null;
      const text = await hop.read();
      if (text === null) return null;
      nested = parseFlow(text);
    } catch {
      return null;
    }
    if ((await fragmentLoadRefusal(env.schemas, nested, step.flow)) !== undefined) return null;
    const inner = await scanLeadingLaunch(
      nested,
      [...stack, { canonical, display: runDisplayFor(step.flow, rootDisplay) }],
      rootDisplay,
      env
    );
    if (inner !== NO_EXECUTABLE_STEP) return inner;
  }
  return NO_EXECUTABLE_STEP;
}

/** A root e2e test refused at load time: the failure code and text `e2e-execute` throws. */
export interface PreflightRefusal {
  code: FailureCode;
  message: string;
}

/** The {@link findRetiredToolArg} refusal of the root e2e test `flowName`. */
export function retiredArgRefusal(
  schemas: ToolSchemaLookup,
  flow: FlowFile,
  flowName: string
): PreflightRefusal | undefined {
  const use = findRetiredToolArg(schemas, flow);
  if (!use) return undefined;
  return {
    code: FAILURE_CODES.FLOW_FILE_INVALID,
    message: `E2E test "${flowName}" ${retiredArgReason(use)}`,
  };
}

/** The {@link findUnrunnableScript} refusal of the root e2e test `flowName`. */
export async function unrunnableScriptRefusal(
  flow: FlowFile,
  flowName: string
): Promise<PreflightRefusal | undefined> {
  const reason = await findUnrunnableScript(flow);
  if (!reason) return undefined;
  return {
    code: FAILURE_CODES.FLOW_SCRIPT_TYPESCRIPT_UNSUPPORTED,
    message: `E2E test "${flowName}" was not run. ${reason}`,
  };
}

/**
 * Does this leading launch declare a chromium target — i.e. would the
 * {@link pinnedToChromium} exemption be any use to the caller staring at the
 * refusal? Pinned to an instance, a launch naming no chromium app doesn't
 * attach, it errors ({@link noChromiumAppReason}), so an ios/android/vega-only
 * launch must not advertise the pin. A multi-platform map counts: pinning is
 * what picks chromium out of it (only the *boot* hoist demands an unambiguous
 * one). A bare string names no platform and is the native bundle-id shape, so it
 * counts under `--platform chromium` alone.
 */
function chromiumPinnable(app: Launch, platform: string | undefined): boolean {
  if (typeof app === "string") return platform === "chromium";
  return chromiumLaunchSpec(app) !== null;
}

/**
 * The refusal of a root e2e test `flowName` that declares `executionPrerequisite`
 * while its leading `run:` chain reaches a launch ({@link leadingLaunch}).
 * `platform` is the run's `--platform`.
 */
export async function leadingLaunchRefusal(
  flow: FlowFile,
  seed: RunStackEntry[],
  env: LeadingLaunchEnv,
  flowName: string,
  platform: string | undefined
): Promise<PreflightRefusal | undefined> {
  const leading = await leadingLaunch(flow, seed, env);
  if (!leading) return undefined;
  // Offer the pin only where it is a real way out (see
  // chromiumPinnable): the guard also fires for unpinned runs of every
  // platform and for pinned native ones, and sending the caller of an
  // android flow after a chromium id would only misdirect.
  const pinRemedy = chromiumPinnable(leading.app, platform)
    ? ` Or pin the run to a chromium instance you have already brought to that state (--device chromium-cdp-<port>), where the leading launch only attaches.`
    : "";
  return {
    code: FAILURE_CODES.FLOW_E2E_HAS_PREREQUISITE,
    message: `An e2e test whose leading run: chain reaches a launch step must not declare executionPrerequisite — it launches its own app and controls its start state. Drop the leading launch in "${leading.flow}" to make it a fragment, or drop executionPrerequisite from "${flowName}".${pinRemedy}`,
  };
}

/** One problem `e2e-check` reports; `code` is the failure code `e2e-execute` would give. */
export interface CheckProblem {
  at?: StepLevel[];
  code?: string;
  message: string;
}

const BOUND_KEYS: readonly string[] = [...DEVICE_BIND_KEYS, ...DEVICE_BIND_LIST_KEYS];

/**
 * Why `registry.invokeTool` would refuse a `tool:` step's args, with its text,
 * after the runner binds the device keys. A retired key is left to
 * {@link findRetiredToolArg}.
 */
function toolArgsRefusal(
  tool: string,
  def: CallableTool,
  stepArgs: Record<string, unknown>
): string | undefined {
  const toolId = canonicalToolId(tool);
  let args: Record<string, unknown>;
  try {
    args = { ...canonicalToolArgs(toolId, stepArgs) };
  } catch (err) {
    if (!(err instanceof ToolParamAliasError)) throw err;
    return `Invalid params for tool "${toolId}": ${err.message}`;
  }
  const props = (def.inputSchema?.properties ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(args)) {
    const bound =
      (DEVICE_BIND_KEYS as readonly string[]).includes(key) ||
      ((DEVICE_BIND_LIST_KEYS as readonly string[]).includes(key) && !Object.hasOwn(props, key));
    if (bound || retiredKeyGuidance(props[key]) !== undefined) delete args[key];
  }
  const parsed = def.zodSchema?.safeParse(args);
  if (!parsed || parsed.success) return undefined;
  const issues = parsed.error.issues.filter((issue) => !BOUND_KEYS.includes(String(issue.path[0])));
  if (issues.length === 0) return undefined;
  return `Invalid params for tool "${toolId}": ${describeParamIssues({ issues }, args)}`;
}

/**
 * Why one step fails when it runs, for what can be told without a device: a
 * tool this tool-server does not offer, args its tool refuses, or a missing
 * script file. `flowDir` is the directory of the file the step is in.
 */
async function stepProblem(
  walk: CheckWalk,
  step: FlowStep,
  flowDir: string
): Promise<string | undefined> {
  if (step.kind === "script") {
    const located = await locateScript(flowDir, step.path);
    return "refused" in located ? located.refused.reason : undefined;
  }
  if (step.kind !== "tool") return undefined;
  const def = walk.schemas(step.name);
  return def ? toolArgsRefusal(step.name, def, step.args) : `Tool "${step.name}" not found`;
}

/** What one {@link checkFlow} call shares across the files it follows. */
interface CheckWalk {
  schemas: ToolSchemaLookup;
  project: ProjectAccess;
  /** The deepest stack length each `<reach>:<canonical path>` was walked at. */
  reached: Map<string, number>;
  problems: CheckProblem[];
}

function report(
  walk: Pick<CheckWalk, "problems">,
  at: StepLevel[] | undefined,
  message: string,
  code?: string
): void {
  walk.problems.push({
    ...(at !== undefined && { at }),
    ...(code !== undefined && { code }),
    message,
  });
}

/**
 * The flow in `text`, or undefined after reporting each bad step under
 * `prefix` (unless `quiet`), with its code when `withCode`. A file error
 * throws.
 */
function parseReported(
  walk: Pick<CheckWalk, "problems">,
  text: string,
  {
    prefix,
    quiet = false,
    withCode = false,
  }: { prefix: StepLevel[]; quiet?: boolean; withCode?: boolean }
): FlowFile | undefined {
  const parsed = parseFlowCollecting(text);
  if ("flow" in parsed) return parsed.flow;
  if (quiet) return undefined;
  for (const { at, error } of parsed.stepErrors) {
    const code = withCode ? getFailureSignal(error)?.error_code : undefined;
    report(walk, [...prefix, ...at], errMsg(error), code);
  }
  return undefined;
}

/**
 * Whether to walk a file reached this way at stack length `depth`: always the
 * first time, and again when deeper, where its own `run:` chains can pass
 * {@link MAX_RUN_DEPTH}.
 */
function reach(
  walk: CheckWalk,
  kind: "test" | "fragment",
  canonical: string,
  depth: number
): "first" | "deeper" | undefined {
  const key = `${kind}:${canonical}`;
  const deepest = walk.reached.get(key);
  if (deepest !== undefined && depth <= deepest) return undefined;
  walk.reached.set(key, depth);
  return deepest === undefined ? "first" : "deeper";
}

/**
 * The stack index of the file a walk revisits deeper (`floor`), or undefined
 * on a first walk, for its child reached as `visit`.
 */
function childFloor(
  floor: number | undefined,
  visit: "first" | "deeper",
  stack: RunStackEntry[]
): number | undefined {
  return visit === "first" ? undefined : (floor ?? stack.length);
}

/**
 * Whether a refusal is new in a walk that revisits the file at stack index
 * `floor`: only a run past the depth limit, or a cycle closing below it.
 */
function isNewRefusal(floor: number | undefined, refusal: RunRefusal): boolean {
  return (
    floor === undefined ||
    refusal.tooDeep === true ||
    (refusal.cycleAt !== undefined && refusal.cycleAt < floor)
  );
}

/**
 * The checks `e2e-execute` runs on the test it is called for, then the files
 * its steps reach. A nested test's problems go on the step `edge.at` that runs
 * it, without a code: there they fail only that step. A revisit (`floor` set)
 * only follows the references.
 */
async function checkTest(
  walk: CheckWalk,
  flow: FlowFile,
  flowName: string,
  stack: RunStackEntry[],
  edge?: { at: StepLevel[]; prefix: StepLevel[] },
  floor?: number
): Promise<void> {
  if (floor !== undefined) {
    return followReferences(walk, flow.steps, stack, flowName, edge?.prefix ?? [], floor);
  }
  const refusals = [
    retiredArgRefusal(walk.schemas, flow, flowName),
    await unrunnableScriptRefusal(flow, flowName),
    flow.executionPrerequisite
      ? await leadingLaunchRefusal(
          flow,
          stack,
          { schemas: walk.schemas, project: walk.project },
          flowName,
          undefined
        )
      : undefined,
  ];
  for (const refusal of refusals) {
    if (refusal) report(walk, edge?.at, refusal.message, edge ? undefined : refusal.code);
  }
  await followReferences(walk, flow.steps, stack, flowName, edge?.prefix ?? [], undefined);
}

/**
 * Follow every `run:` and nested `tool: e2e-execute` step in `steps`, `when:`
 * blocks included. A first walk (`floor` unset) also checks each step.
 */
async function followReferences(
  walk: CheckWalk,
  steps: FlowStep[],
  stack: RunStackEntry[],
  rootDisplay: string,
  prefix: StepLevel[],
  floor: number | undefined
): Promise<void> {
  const flowDir = path.dirname(stack[stack.length - 1]!.canonical);
  for (const { step, at } of walkSteps(steps, "", prefix)) {
    if (floor === undefined) {
      const problem = await stepProblem(walk, step, flowDir);
      if (problem !== undefined) report(walk, at, problem);
    }
    if (step.kind === "run") {
      await followRun(walk, step.flow, stack, rootDisplay, at, floor);
    } else if (step.kind === "tool" && canonicalToolId(step.name) === "e2e-execute") {
      const target = nestedFlowTarget(step.args);
      if (target) await followNested(walk, step.name, target, stack, at, floor);
    }
  }
}

/** A `run:` fragment gets the checks `execRunStep` makes when it loads one. */
async function followRun(
  walk: CheckWalk,
  target: string,
  stack: RunStackEntry[],
  rootDisplay: string,
  at: StepLevel[],
  floor: number | undefined
): Promise<void> {
  const guarded = await guardRunHop(walk.project, stack, rootDisplay, target);
  if ("refusal" in guarded) {
    if (isNewRefusal(floor, guarded)) report(walk, at, guarded.refusal);
    return;
  }
  const { hop, display } = guarded;
  const visit = reach(walk, "fragment", hop.canonical, stack.length + 1);
  if (visit === undefined) return;
  const inner = childFloor(floor, visit, stack);
  const read = await readRunHop(hop, target);
  if ("refusal" in read) {
    if (inner === undefined) report(walk, at, read.refusal);
    return;
  }
  const prefix = intoStep(at, { run: target });
  let fragment: FlowFile | undefined;
  try {
    fragment = parseReported(walk, read.text, { prefix, quiet: inner !== undefined });
  } catch (err) {
    if (inner === undefined) report(walk, at, fragmentParseRefusal(target, err));
    return;
  }
  if (fragment === undefined) return;
  if (inner === undefined) {
    const refusal = await fragmentLoadRefusal(walk.schemas, fragment, target);
    if (refusal !== undefined) report(walk, at, refusal);
  }
  await followReferences(
    walk,
    fragment.steps,
    [...stack, { canonical: hop.canonical, display }],
    rootDisplay,
    prefix,
    inner
  );
}

/** A nested test gets the checks `e2e-execute` makes on this host for the call the step makes. */
async function followNested(
  walk: CheckWalk,
  toolName: string,
  target: NestedFlowTarget,
  stack: RunStackEntry[],
  at: StepLevel[],
  floor: number | undefined
): Promise<void> {
  const nested = await readNestedTest(walk.project, target, toolName);
  if ("refusal" in nested) {
    if (floor === undefined) report(walk, at, nested.refusal);
    return;
  }
  const entry: RunStackEntry = { canonical: nested.canonical, display: nested.flowName };
  const nesting = nestedRunRefusal(stack, entry);
  if (nesting !== undefined) {
    if (isNewRefusal(floor, nesting)) report(walk, at, nesting.refusal);
    return;
  }
  const visit = reach(walk, "test", nested.canonical, stack.length + 1);
  if (visit === undefined) return;
  const inner = childFloor(floor, visit, stack);
  const prefix = intoStep(at, { e2e: target.kind === "name" ? target.name : target.path });
  let flow: FlowFile | undefined;
  try {
    flow = parseReported(walk, nested.text, { prefix, quiet: inner !== undefined });
  } catch (err) {
    if (inner === undefined) report(walk, at, errMsg(err));
    return;
  }
  if (flow === undefined) return;
  await checkTest(walk, flow, nested.flowName, [...stack, entry], { at, prefix }, inner);
}

/**
 * The test a nested `tool: e2e-execute` step names, found and read as
 * `e2e-execute` finds and reads it, or the reason it fails.
 */
async function readNestedTest(
  project: ProjectAccess,
  target: NestedFlowTarget,
  toolName: string
): Promise<{ refusal: string } | { canonical: string; flowName: string; text: string }> {
  // An upload names a nested test only by name: assertUploadSelfContained refuses the rest.
  if (project.mode === "client" && target.kind === "name") {
    try {
      const hop = await resolveSavedTest(project, target.paths);
      if (hop.spelling.state === "case_folded") {
        return { refusal: flowNameCasingError(target.name, hop.spelling).message };
      }
      const text = await hop.read();
      if (text === null) {
        return { refusal: `ENOENT: no such file or directory, open '${hop.canonical}'` };
      }
      return { canonical: hop.canonical, flowName: target.name, text };
    } catch (err) {
      return { refusal: errMsg(err) };
    }
  }
  let filePath: string;
  let flowName: string;
  if (target.kind === "name") {
    flowName = target.name;
    const picked = await pickE2eFile(target.paths);
    filePath = picked.path;
    const dirs = picked.exists
      ? [path.dirname(filePath)]
      : target.paths.map((candidate) => path.dirname(candidate));
    for (const dir of dirs) {
      const spelling = await classifyOnDiskSpelling(dir, `${flowName}.yaml`);
      if (spelling.state === "case_folded") {
        return { refusal: flowNameCasingError(flowName, spelling).message };
      }
    }
  } else {
    filePath = target.path;
    const stat = await hostFileArgumentStat(toolName, "e2e_test_path", filePath);
    if ("refusal" in stat) return stat;
    const spelling = await classifyOnDiskSpelling(path.dirname(filePath), path.basename(filePath));
    if (spelling.state !== "listed") {
      return { refusal: flowPathCasingError(filePath, spelling).message };
    }
    flowName = path.basename(filePath, ".yaml");
  }
  const canonical = await canonicalFlowPath(filePath);
  try {
    return { canonical, flowName, text: await fs.readFile(canonical, "utf8") };
  } catch (err) {
    return { refusal: errMsg(err) };
  }
}

/**
 * The e2e test in `text`, or the problems that keep it from parsing, each
 * with its code: one for a file error, else one for each step that does not parse.
 */
export function parseForCheck(text: string): { flow: FlowFile } | { problems: CheckProblem[] } {
  const parsing: { problems: CheckProblem[] } = { problems: [] };
  try {
    const flow = parseReported(parsing, text, { prefix: [], withCode: true });
    if (flow !== undefined) return { flow };
  } catch (err) {
    report(parsing, undefined, errMsg(err), getFailureSignal(err)?.error_code);
  }
  return parsing;
}

/**
 * The problems `e2e-execute` would refuse the e2e test for before it touches
 * a device, and those of the `run:` fragments and nested tests its steps
 * reach, collected instead of thrown, plus the steps that would fail (see
 * {@link stepProblem}). `canonical` is the test's path where `project` has it.
 */
export async function checkFlow(input: {
  flow: FlowFile;
  flowName: string;
  canonical: string;
  schemas: ToolSchemaLookup;
  project: ProjectAccess;
}): Promise<CheckProblem[]> {
  const { flow, flowName, canonical, schemas, project } = input;
  const walk: CheckWalk = { schemas, project, reached: new Map(), problems: [] };
  reach(walk, "test", canonical, 1);
  await checkTest(walk, flow, flowName, [{ canonical, display: flowName }]);
  return walk.problems;
}
