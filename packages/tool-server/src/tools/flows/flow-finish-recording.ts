import { z } from "zod";
import * as fs from "node:fs/promises";
import type { ToolDefinition } from "@argent/registry";
import {
  launchCoverage,
  requireRecordingSession,
  clearRecordingSession,
  withFlowFileLock,
  clientFileDirective,
  parseFlow,
  runsSteps,
  serializeFlow,
  selectorToYaml,
  LAUNCH_PLATFORMS,
  type FlowFile,
  type FlowRequires,
  type FlowStep,
  type FlowSavedTo,
  type FlowSelector,
  type RecordedStepWarning,
  type RecordingSession,
  type WhenPlatform,
} from "./flow-utils";
import { effectiveComposition } from "./flow-run";
import type { TextMatchMode } from "../../utils/ui-tree-match";

/**
 * The platforms these steps' launches already limit the flow to, or null when
 * they limit nothing. A platform is a candidate iff at least one launch is in
 * its scope and every launch there declares an id for it — stricter than the
 * validator, which ignores conditionally reached launches, so the hint can
 * never suggest a block the validator refuses over THESE steps: the run's
 * composed picture where {@link composedFlow} could read one, the root file
 * alone where it could not. Only a launch MAP ever narrows anything: the
 * recorder writes a bare app id, which serves all four platforms.
 *
 * The offer is coverage-literal, so it can name a platform the recording never
 * touched — a `native:` id serves vega, so a phone recording still offers vega —
 * because a RecordingSession carries no device or platform to narrow it with.
 *
 * Nothing is offered unless every excluded platform is already lost: either doomed
 * at a launch that certainly runs, or running no steps at all. A platform that is
 * neither passes today — a launch missing its id only behind a run-time guard
 * fails nothing on the runs that guard stays shut — and the block would silently
 * retire it.
 */
function launchPlatforms(steps: FlowStep[]): WhenPlatform[] | null {
  const named = LAUNCH_PLATFORMS.filter((p) => launchCoverage(steps, p) === "served");
  if (named.length === 0 || named.length === LAUNCH_PLATFORMS.length) return null;
  // "unknown" is exactly the excluded-but-not-doomed set: the "served" platforms
  // are the offered ones, and an "unserved" one already fails at its launch.
  const retires = LAUNCH_PLATFORMS.some(
    (p) => launchCoverage(steps, p) === "unknown" && runsSteps(steps, p)
  );
  return retires ? null : named;
}

/** The root file's own picture, or the one its leading `run:` chain composes. */
interface ComposedFlow {
  requires: FlowRequires | undefined;
  steps: FlowStep[];
}

/**
 * The picture a RUN of the finished flow is judged against: the block its
 * leading `run:` chain folds, and the steps that chain really executes — the
 * root's plus every fragment it enters. Judging the root file alone answers a
 * question the runner already answers differently, in both directions: a
 * fragment's block restricts a root that declares none, and a fragment's launch
 * narrows the platforms a root's own launch map does not.
 *
 * Falls back to the root file alone whenever this host cannot read that chain,
 * because a finish that throws loses the whole recording. In CLIENT mode
 * nothing may be read at all: `filePath` names a file on the CALLER's machine,
 * so a same-named path here would be a different file. The walk itself gives up
 * on a cycle, a depth limit or an unreadable hop, and it refuses a composition
 * no target could satisfy — which is the run's verdict to deliver, not this
 * tool's.
 */
async function composedFlow(
  flow: FlowFile,
  session: RecordingSession,
  flowName: string
): Promise<ComposedFlow> {
  if (session.persist !== "host") return { requires: flow.requires, steps: flow.steps };
  try {
    const composed = await effectiveComposition(flow, session.filePath, flowName);
    return { requires: composed.requires, steps: composed.steps ?? flow.steps };
  } catch {
    return { requires: flow.requires, steps: flow.steps };
  }
}

/**
 * The question to put to the user once a recording is done: should this flow be
 * restricted to some targets? Asked here, and only here, because this is the
 * moment the whole flow first exists — every earlier tool sees one step. A flow
 * with no block runs everywhere, which is right for most of them and wrong
 * silently for the rest, so the default is offered rather than assumed. Absent
 * once the RUN composes a block ({@link composedFlow}), declared here or folded
 * in from a leading `run:` fragment: the question has been answered.
 */
function requiresPrompt(composed: ComposedFlow): string | undefined {
  if (composed.requires) return undefined;
  const platforms = launchPlatforms(composed.steps);
  const hint = platforms
    ? ` Its launch step declares an app id only for ${platforms.join(", ")}, so ` +
      `\`requires: { platform: [${platforms.join(", ")}] }\` is the likely answer. Use it in ` +
      `place of the template's \`platform:\` line, and keep the \`runtimeKind:\` line only if the ` +
      `flow is also TV-specific.`
    : "";
  return (
    `This flow declares no \`requires:\` block, so it will run against any target — including ` +
    `ones it was never recorded on. Ask the user whether it should be restricted, and if so add ` +
    `the block to the YAML yourself (there is no tool for it):\n` +
    `  requires:\n` +
    `    platform: [ios, android]   # one platform or a list; ios covers a remote simulator (--device remote:<udid> runs only — auto-detection never lists one)\n` +
    `    runtimeKind: tv            # tv (Apple TV / Android TV / Fire TV), or mobile for everything else\n` +
    `Write only the lines that apply: each key is optional on its own, the block must declare at ` +
    `least one of them, and declaring both ANDs them. Rejected when the file is read: a repeated ` +
    `platform, an unknown key inside the block, a pair no target can present (chromium with tv, ` +
    `vega with mobile), a block admitting no platform that runs a step, a \`platform:\` list some ` +
    `unconditional launch declares no app id for, and a lone \`runtimeKind:\` no platform's ` +
    `launches serve. Leaving the block out is the right answer for a genuinely portable ` +
    `flow; restrict it when the scenario is platform-specific (a platform-only screen, an OS ` +
    `settings flow) or form-factor-specific (focus/remote navigation rather than touch).${hint}`
  );
}

// Spell selectors the way the flow FILE does (`id`, bare string for loose): the
// summary is read before hand-editing the YAML, so the spellings must agree.
//
// Key ORDER is normalised on top of that. This render is also the step ANCHOR
// ({@link stepAnchor}), which compares a selector built in memory — whose key
// order is the source object's — against one that came back through
// `parseSelector`, whose key order is the zod schema's. Two spellings of one
// selector would then render differently and drop every verdict in the
// recording. `deriveSelector` returns a single-field selector on every branch
// today, so sorting removes a dependency rather than fixes a live bug.
function selectorLabel(sel: FlowSelector): string {
  const yaml = selectorToYaml(sel);
  if (typeof yaml !== "object" || yaml === null) return JSON.stringify(yaml);
  const sorted = Object.fromEntries(
    Object.entries(yaml).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  );
  return JSON.stringify(sorted);
}

// One spelling for every step kind carrying a text condition (await/assert/when).
// The comparator is preserved, and JSON quoting keeps embedded quotes and
// control characters unambiguous.
function textConditionLabel(
  sel: FlowSelector,
  expectedText: string | undefined,
  textMatch: TextMatchMode | undefined
): string {
  const selector = selectorLabel(sel);
  const expected = expectedText ?? "";
  return textMatch === "matches"
    ? `text ${selector} matches /${expected}/`
    : textMatch === "equals"
      ? `text ${selector} == ${JSON.stringify(expected)}`
      : `text ${selector} contains ${JSON.stringify(expected)}`;
}

const zodSchema = z.object({
  name: z
    .string()
    .describe("Name of the flow being recorded — the one passed to flow-start-recording."),
  project_root: z
    .string()
    .describe(
      "Absolute path to the project root of the flow being recorded — the same value passed to flow-start-recording. Together with `name` it identifies which recording to finish."
    ),
});

/**
 * Fold each recorded step's cross-tree verdict into its own summary line.
 *
 * The probe raises the verdict on one step's `message`, but it answers a
 * POLISH-time question, and polish begins here. A warning raised at step 7 of a
 * 40-step recording has otherwise scrolled out of reach by the time it is
 * actionable, and no artifact carries it.
 *
 * The verdict gets its own ARRAY ELEMENT, not a newline inside the step's line:
 * this tool has no bespoke MCP renderer, so `JSON.stringify` would escape an
 * embedded newline and deliver the verdict inside one long string. The indent
 * and the `warning:` prefix keep it attached to the step above.
 *
 * {@link anchoredWarnings} decides which verdicts survive to be folded in.
 */
function attachStepWarnings(
  summary: string[],
  warnings: Map<number, RecordedStepWarning>
): string[] {
  if (warnings.size === 0) return summary;
  return summary.flatMap((line, i) => {
    const recorded = warnings.get(i + 1);
    return recorded ? [line, `   warning: ${recorded.warning}`] : [line];
  });
}

/**
 * What `message` says about the warnings the summary carries, by KIND — and
 * about the ones it does NOT carry.
 *
 * The two kinds are different news, and only one is about conversion. A wait
 * that came back `success: false` was never probed: it failed live, and at
 * replay it stops the run. Counting it as a conversion warning states the
 * opposite of the actionable fact.
 *
 * `discarded` is what the anchor checks threw away. Dropping is the right
 * answer, but reporting it as a pass is not: a recording where every wait
 * diverged would otherwise return the same payload as a clean one.
 */
function warningHeadline(warnings: Map<number, RecordedStepWarning>, discarded: number): string {
  const counts = { conversion: 0, wait: 0 };
  for (const { kind } of warnings.values()) counts[kind] += 1;
  const clauses: string[] = [];
  if (counts.conversion > 0) {
    clauses.push(
      `${counts.conversion} ${counts.conversion === 1 ? "step carries" : "steps carry"} a ` +
        `cross-tree warning about converting a recorded wait`
    );
  }
  if (counts.wait > 0) {
    clauses.push(
      `${counts.wait} ${counts.wait === 1 ? "step" : "steps"} recorded a wait that did not pass`
    );
  }
  const carried =
    clauses.length === 0
      ? ""
      : ` — ${clauses.join(", and ")}; read \`summary\` before converting or replaying`;
  if (discarded === 0) return carried;
  const one = discarded === 1;
  const drop =
    `${discarded} ${one ? "warning" : "warnings"} raised during this recording ${one ? "is" : "are"} ` +
    `NOT in \`summary\`: a hand edit to the .yaml moved the ${one ? "step it judged" : "steps they judged"}, ` +
    `so which step ${one ? "it belongs" : "they belong"} to is no longer knowable — re-record ` +
    `${one ? "that wait" : "those waits"} to see ${one ? "it" : "them"} again`;
  return carried === "" ? ` — ${drop}` : `${carried}. ${drop}`;
}

/**
 * The verdicts still anchored to the steps they judged.
 *
 * An anchor is a POSITION, and a mid-recording hand edit moves positions. A
 * verdict left on its old number would convict whichever step inherited it,
 * while the real risk reads clean. Two checks, because one edit can defeat
 * either alone:
 *
 * 1. The finished flow must still be the file the recorder saw. This catches an
 *    edit made after the last append. It compares step CONTENT, so an ordinary
 *    append that files no verdict does not read as an edit.
 * 2. Each verdict's own step must still occupy its number.
 *
 * A verdict that fails check 2 is dropped rather than re-anchored: which step
 * moved where is unknowable from here.
 *
 * An edit the recorder then appended OVER is invisible to both checks, because
 * that append re-read the edited file into `session.flow`. `appendStepToFlow`
 * settles that case while both views still exist — see `dropMovedWarnings` in
 * flow-utils.
 */
function anchoredWarnings(
  session: RecordingSession,
  steps: FlowStep[]
): Map<number, RecordedStepWarning> {
  const kept = new Map<number, RecordedStepWarning>();
  const recorded = session.flow.steps;
  if (recorded.length !== steps.length) return kept;
  if (!steps.every((step, i) => stepAnchor(step) === stepAnchor(recorded[i]))) return kept;
  for (const [n, verdict] of session.stepWarnings ?? []) {
    // `steps[n - 1]` is defined on every reachable path; the guard is a
    // fail-safe. `stepAnchor(undefined)` would throw inside the finish's
    // critical section and lose the whole recording rather than one warning.
    const step = steps[n - 1];
    if (step !== undefined && stepAnchor(step) === verdict.step) kept.set(n, verdict);
  }
  return kept;
}

export const flowFinishRecordingTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  {
    message: string;
    path: string;
    executionPrerequisite: string;
    steps: number;
    summary: string[];
    flowFile: string;
    savedTo: FlowSavedTo;
    /** Present only while the run composes no `requires:` block — see {@link requiresPrompt}. */
    requiresPrompt?: string;
  }
> = {
  id: "flow-finish-recording",
  interaction: {
    // Name the flow: other recordings stay live, so an unqualified message would
    // not identify which one.
    startedMsg: ({ params }) => `Finishing recording of flow ${params.name}`,
    // `params.name` equals the basename of `result.path` on every branch
    // (`assertSafeFlowName` admits no dots or separators), and matches the two
    // formatters either side.
    completedMsg: ({ params }) => `Saved recorded flow ${params.name}`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to finish recording of flow ${params.name}: ${failureSignal.error_code}`,
  },
  description: `Finish recording the flow named by \`name\` + \`project_root\`, leaving recordings under any other key untouched. Returns { message, path, executionPrerequisite, steps, summary, flowFile, savedTo, requiresPrompt? } - a summary of all recorded steps plus the final YAML. Use when you have added all desired steps and want to finalize the flow file. Fails if that flow has no recording in progress.
A warning flow-add-step raised on a recorded \`await-ui-element\` is repeated in \`summary\` as a \`warning:\` line of its own, right below the step it judges, and \`message\` counts them by kind. A warning is repeated only while the step it judges is still identifiable by its number: hand-editing the .yaml during the recording moves the steps, so those warnings are DROPPED rather than pinned on whichever step inherited the number, and \`message\` says how many were dropped. A step that carries a cross-tree warning was re-probed against the runner's tree: read it before converting that wait to \`await:\`/\`assert:\`, which is what the verdict is about and what this moment is for. A step that recorded a wait which did not pass was never probed at all, and its own warning names the CAUSE, because only one of them judges the condition: an unmet wait was read and found false, and it stops the run at replay; a wait whose tree source could not be read, or one that was cancelled, observed nothing and leaves the condition UNKNOWN rather than known-bad. Read those before replaying.
You can still edit the .yaml file directly afterwards to remove or reorder steps.
When the run composes no \`requires:\` block, the result carries a \`requiresPrompt\` — put that question to the user (should this flow be restricted to some platforms / to a TV?) and write the block into the YAML yourself if they say yes. This is the moment to ask: it is the first time the whole flow exists, and a flow with no block runs against every target.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    // Resolve, read and clear as ONE critical section: host mode's
    // `await fs.readFile` is a yield, and an append landing in it would be on
    // disk while the summary and step count — taken from the pre-append read —
    // say otherwise.
    const { filePath, flowFile, savedTo, flow, summary, headline, prompt } = await withFlowFileLock(
      params.project_root,
      params.name,
      async () => {
        const session = await requireRecordingSession(params.project_root, params.name);

        // Host mode re-reads so manual edits made during the recording reach the
        // summary; in client mode this host never has the file, so the in-memory
        // copy is the truth and travels back in the directive.
        const filePath = session.filePath;
        let flowFile: string;
        let savedTo: FlowSavedTo;
        if (session.persist === "client") {
          flowFile = serializeFlow(session.flow);
          savedTo = clientFileDirective(filePath, flowFile);
        } else {
          flowFile = await fs.readFile(filePath, "utf8");
          savedTo = filePath;
        }
        // Parse BEFORE clearing: nothing STOPS a mid-recording hand edit (the
        // recording tools only tell the agent to edit after the finish), so
        // parseFlow can throw on a botched one, and clearing first would
        // destroy the session — leaving no way to retry the finish after
        // repairing the file (flow-start-recording, the only tool that
        // re-establishes the key, truncates the take it would recover).
        const flow = parseFlow(flowFile);
        // Summarize before clearing for the same reason: it walks step bodies the
        // parser does not fully constrain, and nothing that can throw may run
        // after the session is destroyed. The one known thrower is guarded in
        // {@link renderToolArgs}; the order is what keeps the next one
        // recoverable.
        const anchored = anchoredWarnings(session, flow.steps);
        const summary = attachStepWarnings(summarizeSteps(flow), anchored);
        // Everything raised, less what survived. `discardedWarnings` counts
        // what the appends threw away; `stepWarnings` what the finish still
        // held.
        const discarded =
          (session.discardedWarnings ?? 0) + (session.stepWarnings?.size ?? 0) - anchored.size;
        const headline = warningHeadline(anchored, discarded);
        // Ahead of the clear for the same reason as the summary: it walks step
        // bodies, and nothing that can throw may run once the session is gone.
        const prompt = requiresPrompt(await composedFlow(flow, session, params.name));
        clearRecordingSession(session);
        return { filePath, flowFile, savedTo, flow, summary, headline, prompt };
      }
    );

    return {
      // Name the counts in `message` as well. A caller that reads only
      // `message` would otherwise polish blind.
      message: `Finished recording "${params.name}" flow (${flow.steps.length} steps)` + headline,
      path: filePath,
      executionPrerequisite: flow.executionPrerequisite,
      steps: flow.steps.length,
      summary,
      flowFile,
      savedTo,
      ...(prompt ? { requiresPrompt: prompt } : {}),
    };
  },
};

/**
 * A `tool:` step's `args` is the one step body the parser does not constrain, so
 * a cyclic YAML alias in a hand-edited file reaches here as a cyclic object and
 * `JSON.stringify` throws on it. Fall back to a marker, the way `parseFlow` does
 * for the same input class (`badEntry` in flow-utils), rather than failing an
 * otherwise fine summary on one unrenderable step.
 *
 * Interpolated rather than returning `JSON.stringify(args)` directly, because
 * `JSON.stringify(undefined)` is the VALUE `undefined`, not a string, and
 * TypeScript does not flag it (the overload is declared to return `string`). No
 * reachable input is undefined today on either path into {@link summarizeStep};
 * what this guards is the switch's `default:` arm, where a step kind added
 * without its own `case` is rendered as a `tool:` step with no `args` field.
 */
function renderToolArgs(args: unknown): string {
  try {
    return `${JSON.stringify(args)}`;
  } catch {
    return "[cyclic args]";
  }
}

/**
 * The pre-step sleep a replay performs, when the step carries one. Narrowed to
 * the one arm that has a `delayMs`; over the whole union it could only be read
 * through a cast, which would also stop the compiler checking it.
 *
 * A runtime check is still needed: `fromYamlStep` copies `delayMs` across
 * unvalidated and `validateFlow` does not check it, so a hand-edited non-number
 * survives a parse. It must mirror the RUNNER's check, not `typeof`: flow-run
 * gates on truthiness and hands the raw value to `setTimeout`, which coerces it.
 * A quoted `delayMs: "2000"` sleeps two real seconds; `delayMs: .nan` IS a
 * number and sleeps none — `typeof` was wrong in both directions.
 */
function delayLabel(step: Extract<FlowStep, { kind: "tool" }>): string {
  // The runner's own gate: a falsy `delayMs` is never slept.
  if (!step.delayMs) return "";
  const ms = Number(step.delayMs);
  // What `setTimeout` will actually wait: anything under 1ms — including a
  // non-numeric value, which coerces to NaN — and anything out of range floors
  // to an immediate tick, so there is no delay to describe.
  return Number.isFinite(ms) && ms >= 1 ? ` (after ${ms}ms)` : "";
}

/** One human-readable line per recorded step, in the flow file's own spellings. */
function summarizeSteps(flow: FlowFile): string[] {
  return flow.steps.map((step, i) => summarizeStep(step, i + 1));
}

/**
 * WHICH step this is, told apart from where it sits.
 *
 * The same renderer as the summary, on a fixed number, so the identity does not
 * move with the position.
 *
 * The anchor rests on {@link summarizeStep} being STABLE across a
 * serialize-then-parse round trip: two of the three comparisons put a raw
 * in-memory step against a parsed one. Every field it reads has to survive that
 * trip — including the selector, whose key order {@link selectorLabel} sorts
 * because the round trip does not preserve it.
 */
export function stepAnchor(step: FlowStep): string {
  return summarizeStep(step, 0);
}

/**
 * One recorded step, rendered the way the flow FILE spells it. Shared with the
 * recorder, which echoes just the line it appended.
 */
export function summarizeStep(step: FlowStep, n: number): string {
  switch (step.kind) {
    case "echo":
      return `${n}. echo: ${step.message}`;
    case "launch":
      return `${n}. launch: ${typeof step.app === "string" ? step.app : JSON.stringify(step.app)}`;
    case "run":
      return `${n}. run: ${step.flow}`;
    case "tap":
    case "long-press": {
      // `times` (tap) and `duration` (long-press) change what replays, so a
      // line that drops them misdescribes the file — and `tap` is recorder-built,
      // where this line is the author's only per-step view of what was appended.
      // Neither kind carries a `delayMs` (only `tool` steps do), so no
      // delayLabel here.
      //
      // Not applied file-wide: `type.submit` and `await.timeout` also change what
      // replays and still render nothing. Neither kind is recorder-built, so both
      // reach an author only through the finish `summary`, beside the `flowFile`
      // that spells them out.
      const target = step.selector ? selectorLabel(step.selector) : `(${step.x}, ${step.y})`;
      // `times: 1` is the default and never lands in the file (parseTapTimes
      // normalizes it to absent), so `×1` would describe a file that can't exist.
      const times =
        step.kind === "tap" && step.times !== undefined && step.times > 1 ? ` ×${step.times}` : "";
      const held =
        step.kind === "long-press" && step.duration !== undefined ? ` for ${step.duration}ms` : "";
      return `${n}. ${step.kind}: ${target}${times}${held}`;
    }
    case "type":
      return `${n}. type: ${selectorLabel(step.into)} ← "${step.text}"`;
    case "await":
    case "assert": {
      const tail =
        step.condition === "text"
          ? textConditionLabel(step.selector, step.expectedText, step.textMatch)
          : `${step.condition} ${selectorLabel(step.selector)}`;
      return `${n}. ${step.kind}: ${tail}`;
    }
    case "wait":
      return `${n}. wait: ${step.ms}ms`;
    case "when": {
      // Mirror the await/assert rendering above.
      const cond =
        step.condition.kind === "platform"
          ? `platform ${step.condition.platform}`
          : step.condition.condition === "text"
            ? textConditionLabel(
                step.condition.selector,
                step.condition.expectedText,
                step.condition.textMatch
              )
            : `${step.condition.condition} ${selectorLabel(step.condition.selector)}`;
      // Pluralize like flow-run's skip reason so the two surfaces agree.
      const count = step.steps.length;
      return `${n}. when: ${cond} (${count} step${count === 1 ? "" : "s"})`;
    }
    case "scroll-to":
      return `${n}. scroll-to: ${selectorLabel(step.target)} (${step.direction})`;
    case "pinch":
      return `${n}. pinch: scale ${step.scale}${step.selector ? ` on ${selectorLabel(step.selector)}` : ""}`;
    case "rotate":
      return `${n}. rotate: by ${step.by}°${step.selector ? ` on ${selectorLabel(step.selector)}` : ""}`;
    case "snapshot":
      return `${n}. snapshot: ${step.name}`;
    case "idle":
      return `${n}. await: screen idle`;
    case "tool":
    default:
      return `${n}. tool: ${step.name} ${renderToolArgs(step.args)}${delayLabel(step)}`;
  }
}
