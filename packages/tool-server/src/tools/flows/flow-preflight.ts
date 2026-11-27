import * as path from "node:path";
import {
  FAILURE_CODES,
  getFailureSignal,
  MAX_RUN_DEPTH,
  type FailureCode,
} from "@argent/registry";
import {
  blockSteps,
  chromiumLaunchSpec,
  escapeInline,
  parseFlow,
  precedesLeadingLaunch,
  runTargetName,
  type FlowFile,
  type FlowStep,
  type Launch,
} from "./flow-utils";
import { resolveRunTarget, type ProjectAccess } from "./project-access";
import { typeScriptScriptRefusal } from "./flow-script-step";

/** A tool's JSON `inputSchema` by tool id, or undefined for a tool this tool-server lacks. */
export type ToolSchemaLookup = (tool: string) => Record<string, unknown> | undefined;

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
  label = "step"
): Generator<{ step: FlowStep; where: string }> {
  for (const [i, step] of steps.entries()) {
    const where = `${label} ${i + 1}${within}`;
    yield { step, where };
    const inner = blockSteps(step);
    if (inner) yield* walkSteps(inner, ` of the ${step.kind}: block at ${where}`);
  }
}

/** {@link walkSteps} over a file's `steps:`, then its `shutdown:`. */
export function* walkFlow(
  flow: FlowFile,
  within = ""
): Generator<{ step: FlowStep; where: string }> {
  yield* walkSteps(flow.steps, within);
  if (flow.shutdown) yield* walkSteps(flow.shutdown, within, "shutdown step");
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
  return (schemas(tool) as { properties?: Record<string, unknown> } | undefined)?.properties;
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
  code?: string;
  message: string;
}

/**
 * The e2e test in `text`, or the problem that keeps it from parsing, with its code.
 */
export function parseForCheck(text: string): { flow: FlowFile } | { problems: CheckProblem[] } {
  try {
    return { flow: parseFlow(text) };
  } catch (err) {
    const code = getFailureSignal(err)?.error_code;
    const message = err instanceof Error ? err.message : String(err);
    return { problems: [{ ...(code !== undefined && { code }), message }] };
  }
}

/**
 * The problems `e2e-execute` would refuse the e2e test for before it touches
 * a device, collected instead of thrown. `canonical` is the test's path where
 * `project` has it.
 */
export async function checkFlow(input: {
  flow: FlowFile;
  flowName: string;
  canonical: string;
  schemas: ToolSchemaLookup;
  project: ProjectAccess;
}): Promise<CheckProblem[]> {
  const { flow, flowName, canonical, schemas, project } = input;
  const refusals = [
    retiredArgRefusal(schemas, flow, flowName),
    await unrunnableScriptRefusal(flow, flowName),
    flow.executionPrerequisite
      ? await leadingLaunchRefusal(
          flow,
          [{ canonical, display: flowName }],
          { schemas, project },
          flowName,
          undefined
        )
      : undefined,
  ];
  return refusals.flatMap((refusal) =>
    refusal ? [{ code: refusal.code, message: refusal.message }] : []
  );
}
