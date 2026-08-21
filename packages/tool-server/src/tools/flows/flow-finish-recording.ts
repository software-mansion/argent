import { z } from "zod";
import * as fs from "node:fs/promises";
import type { ToolDefinition } from "@argent/registry";
import {
  requireRecordingSession,
  clearRecordingSession,
  withFlowFileLock,
  clientFileDirective,
  parseFlow,
  serializeFlow,
  selectorToYaml,
  type FlowFile,
  type FlowStep,
  type FlowSavedTo,
  type FlowSelector,
  type RecordedStepWarning,
  type RecordingSession,
} from "./flow-utils";
import type { TextMatchMode } from "../../utils/ui-tree-match";

// Quote selectors in the step summary the way the flow FILE spells them
// (`id`, bare string for loose, no internal `loose` flag) — the summary is read
// before hand-editing the YAML, so the spellings must agree.
//
// Key ORDER is normalised on top of that, because this render is also the step
// ANCHOR ({@link stepAnchor}): an anchor compares a selector built in memory by
// the recorder against one that came back through `parseSelector`, whose key
// order is the zod schema's. Two spellings of one selector would then render
// differently and drop every verdict in the recording, with no hand edit
// involved. `deriveSelector` returns a single-field selector on every branch
// today, so sorting removes a dependency rather than fixes a live bug.
function selectorLabel(sel: FlowSelector): string {
  const yaml = selectorToYaml(sel);
  if (typeof yaml !== "object" || yaml === null) return JSON.stringify(yaml);
  const sorted = Object.fromEntries(
    Object.entries(yaml).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  );
  return JSON.stringify(sorted);
}

// Render a text condition for the summary, one spelling for every step kind
// that carries one (await/assert/when): the comparator is preserved — regex
// patterns as `matches /…/`, exact text as `== "…"`, substrings as
// `contains "…"` — and literals use JSON quoting so embedded quotes and
// control characters stay unambiguous.
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
 * The probe raises that verdict on one step's `message`, but what it answers is
 * a POLISH-time question, and polish begins here. Without this, a warning
 * raised at step 7 of a 40-step recording has scrolled out of reach by the time
 * it is actionable, and no artifact carries it.
 *
 * It gets its own ARRAY ELEMENT rather than a newline inside the step's text:
 * this tool has no bespoke MCP renderer, so its result reaches the agent
 * through `JSON.stringify(value, null, 2)`, which escapes an embedded newline.
 * One element per line is what that renderer prints on its own line; the indent
 * and `warning:` prefix keep it attached to the step above.
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
 * Every warning carried here is the cross-tree re-probe's verdict, so the
 * headline names that one question. A wait that came back `success: false` is
 * not among them: the recorder refuses the step, so there is no step to judge
 * and nothing to count.
 *
 * `discarded` is what {@link anchoredWarnings} and its append-time counterpart
 * threw away. Dropping is right — a verdict on the wrong step is worse than
 * none — but reporting it as a pass is not: without this clause a recording
 * where every wait diverged returns a payload identical to a clean one.
 */
function warningHeadline(warnings: Map<number, RecordedStepWarning>, discarded: number): string {
  const conversion = warnings.size;
  const clauses: string[] = [];
  if (conversion > 0) {
    clauses.push(
      `${conversion} ${conversion === 1 ? "step carries" : "steps carry"} a ` +
        `cross-tree warning about converting a recorded wait`
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
 * These anchors are POSITIONS, and a hand edit to the .yaml mid-recording moves
 * positions: host mode re-reads the file before each append, so a verdict left
 * on its old number would convict whichever step inherited it — worse than no
 * verdict at all. Two checks, because one edit can defeat either alone:
 *
 * 1. The finished flow must still be the file the RECORDER saw
 *    (`session.flow`, refreshed by `appendStepToFlow`). Comparing step CONTENT
 *    rather than an append count is what keeps an ordinary append — a
 *    `flow-add-echo` label, which files no verdict — from reading as an edit.
 * 2. Each verdict's own step must still occupy its number.
 *
 * A verdict that fails check 2 is dropped rather than re-anchored: which step
 * moved where is unknowable from here.
 *
 * An edit the recorder then appended OVER defeats both checks — that append
 * re-read the edited file into `session.flow`, so check 1 compares the edit
 * against itself. `appendStepToFlow` settles it at the one moment both views
 * still exist; see `dropMovedWarnings` in flow-utils.
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
    // fail-safe. Kept because `stepAnchor(undefined)` would throw inside the
    // finish's critical section, losing the whole recording over one warning.
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
  }
> = {
  id: "flow-finish-recording",
  interaction: {
    // Name the flow: other recordings stay live across this call, so an
    // unqualified "Finishing flow recording" would not identify which one.
    startedMsg: ({ params }) => `Finishing recording of flow ${params.name}`,
    // `params.name` rather than the basename of `result.path`: the two are the
    // same string on every branch — `assertSafeFlowName` admits no dots or
    // separators, so `getFlowPath` produces `<name>.yaml` and nothing else —
    // and this spelling matches the two formatters either side of it.
    completedMsg: ({ params }) => `Saved recorded flow ${params.name}`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to finish recording of flow ${params.name}: ${failureSignal.error_code}`,
  },
  description: `Finish recording the flow named by \`name\` + \`project_root\`, leaving recordings under any other key untouched. Returns { message, path, executionPrerequisite, steps, summary, flowFile, savedTo } - a summary of all recorded steps plus the final YAML. Use when you have added all desired steps and want to finalize the flow file. Fails if that flow has no recording in progress.
A warning flow-add-step raised on a recorded \`await-ui-element\` is repeated in \`summary\` as a \`warning:\` line of its own, right below the step it judges, and \`message\` counts them by kind. A warning is repeated only while the step it judges is still identifiable by its number: hand-editing the .yaml during the recording moves the steps, so those warnings are DROPPED rather than pinned on whichever step inherited the number, and \`message\` says how many were dropped. A step that carries a cross-tree warning was re-probed against the runner's tree: read it before converting that wait to \`await:\`/\`assert:\`, which is what the verdict is about and what this moment is for. A wait that did not pass is never among them — \`flow-add-step\` refuses to record one at all, naming the cause on the call itself — so every warning here is a question about converting, not about replaying.
You can still edit the .yaml file directly afterwards to remove or reorder steps.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    // Resolve, read and clear as ONE critical section under the flow-file lock.
    // Host mode's `await fs.readFile` is a yield, and an append that lands in it
    // would be on disk while the summary and step count reported here — taken
    // from the pre-append read — say otherwise.
    const { filePath, flowFile, savedTo, flow, summary, headline } = await withFlowFileLock(
      params.project_root,
      params.name,
      async () => {
        const session = await requireRecordingSession(params.project_root, params.name);

        // Host mode re-reads the file so manual edits made during the recording
        // survive into the summary; in client mode this host never has the file,
        // so the in-memory copy is the truth and travels back in the directive.
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
        // Parse BEFORE clearing. Both recording tools tell the agent to edit
        // the .yaml only AFTER the finish, but nothing STOPS a mid-recording
        // edit, so parseFlow can still throw here on a botched one. Clearing
        // first would destroy the session on the way out, and the agent could
        // not retry the finish after repairing the file (flow-start-recording,
        // the only tool that re-establishes the key, truncates the take).
        const flow = parseFlow(flowFile);
        // Render the summary before clearing too, for the same reason: it walks
        // step bodies the parser does not fully constrain, and nothing that can
        // throw may run after the session is destroyed. The one known thrower
        // there — `JSON.stringify` on a cyclic `args` anchor — is guarded in
        // {@link renderToolArgs}; keeping the order is what makes the next one
        // recoverable rather than fatal.
        const anchored = anchoredWarnings(session, flow.steps);
        const summary = attachStepWarnings(summarizeSteps(flow), anchored);
        // Everything raised, less what survived: `discardedWarnings` counts
        // what the appends threw away as they went, `stepWarnings` what was
        // still filed when the finish began.
        const discarded =
          (session.discardedWarnings ?? 0) + (session.stepWarnings?.size ?? 0) - anchored.size;
        const headline = warningHeadline(anchored, discarded);
        clearRecordingSession(session);
        return { filePath, flowFile, savedTo, flow, summary, headline };
      }
    );

    return {
      // Name the counts in `message` too: they are the reason to read
      // `summary`, and a caller that only reads `message` would polish blind.
      message: `Finished recording "${params.name}" flow (${flow.steps.length} steps)` + headline,
      path: filePath,
      executionPrerequisite: flow.executionPrerequisite,
      steps: flow.steps.length,
      summary,
      flowFile,
      savedTo,
    };
  },
};

/**
 * A `tool:` step's `args` is the one step body the parser does not constrain, so
 * a cyclic YAML alias in a hand-edited file reaches here as a cyclic object and
 * `JSON.stringify` throws on it. Fall back to a marker, the way `parseFlow`
 * already does for the same input class (see `badEntry` in flow-utils) — the
 * summary of a recording that is otherwise fine should not fail on one
 * unrenderable step.
 *
 * The body interpolates rather than returning `JSON.stringify(args)` directly,
 * because `JSON.stringify(undefined)` is the VALUE `undefined`, not a string,
 * and would leave through a `string`-typed signature uncaught (TypeScript does
 * not flag it — `JSON.stringify`'s overload is declared to return `string`).
 * No reachable input is undefined today, on either of the two paths into
 * {@link summarizeStep}: the finish comes through {@link summarizeSteps}, which
 * is only ever handed `parseFlow` output, where `fromYamlStep` normalises a
 * missing/`null` `args:` to `{}` on the way through; the recorder
 * (`flow-add-step`) hands over a step it built in memory, whose `args` is
 * `stripDeviceKeys(params.args ? JSON.parse(params.args) : {})` — a fresh
 * spread, so an object either way. It is the `default:` arm of that switch this
 * guards — a step kind added without its own `case` lands there and is rendered
 * as a `tool:` step, with no `args` field to read.
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
 * the one arm that has a `delayMs` — over the whole union the field could only
 * be read through a cast, which is also what would stop the compiler checking
 * it.
 *
 * A runtime check is still needed, because `fromYamlStep` copies `delayMs`
 * across unvalidated and `validateFlow` does not check it, so a hand-edited
 * non-number survives a parse. The check has to be the RUNNER's, though, not a
 * `typeof`: flow-run gates on truthiness and hands the raw value to
 * `setTimeout` (`if (step.delayMs && !(await sleepOrAbort(step.delayMs, …)))`),
 * which coerces it. A quoted `delayMs: "2000"` is not a number and sleeps two
 * real seconds; `delayMs: .nan` IS a number and sleeps none. Testing `typeof`
 * was therefore wrong in both directions — silent about a delay that happens,
 * and claiming `(after NaNms)` for one that does not.
 */
function delayLabel(step: Extract<FlowStep, { kind: "tool" }>): string {
  // The runner's own gate: a falsy `delayMs` (absent, 0, NaN) is never slept.
  if (!step.delayMs) return "";
  const ms = Number(step.delayMs);
  // What `setTimeout` will actually wait. It floors anything under 1ms — and
  // anything non-numeric, which coerces to NaN — to an immediate tick, so there
  // is no delay to describe; an out-of-range value is clamped the same way.
  return Number.isFinite(ms) && ms >= 1 ? ` (after ${ms}ms)` : "";
}

/** One human-readable line per recorded step, in the flow file's own spellings. */
function summarizeSteps(flow: FlowFile): string[] {
  return flow.steps.map((step, i) => summarizeStep(step, i + 1));
}

/**
 * WHICH step this is, told apart from where it sits: the summary's renderer on
 * a fixed number, so a step read back from the file renders exactly as the one
 * the recorder appended.
 *
 * Not because both sides are `parseFlow` output — `verdict.step` is rendered
 * from the RAW in-memory step, and in client mode so are `session.flow.steps`.
 * What holds the anchor up is that {@link summarizeStep} is STABLE across a
 * serialize-then-parse round trip for every recorder-built step: the numbers
 * `parseTapTimes` normalises, the `args` object `fromYamlStep` copies through,
 * and the selector — see {@link selectorLabel}, where key order is normalised
 * precisely because the round trip does not preserve it.
 */
export function stepAnchor(step: FlowStep): string {
  return summarizeStep(step, 0);
}

/**
 * One recorded step, rendered the way the flow FILE spells it. Shared with the
 * recorder, which echoes just the line it appended instead of the whole
 * growing file.
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
      // summary line that drops them misdescribes the file. `times` has a
      // second reason: `tap` is one of the kinds the recorder builds, and since
      // it stopped returning the YAML per step this line is the author's only
      // per-step view of what was appended. `long-press` has no recorder path,
      // so it only ever reaches an author through flow-finish-recording's
      // `summary`, which still returns `flowFile` beside it. Neither kind
      // carries a `delayMs` (only `tool` steps do), so no delayLabel here.
      //
      // That reasoning is NOT applied file-wide, and the arms below show it:
      // `type.submit` (whose `false` suppresses the Enter press) and
      // `await.timeout` also change what replays and still render nothing, as
      // they did before the recorder shared this renderer. Neither kind is
      // recorder-built, so both reach an author only through the finish
      // `summary` — beside the `flowFile` that spells them out. Rendering them
      // is a fair follow-up, not a gap this per-step view opened.
      const target = step.selector ? selectorLabel(step.selector) : `(${step.x}, ${step.y})`;
      // Only ×2..×10 is renderable: `times: 1` is the default and never lands in
      // the file (parseTapTimes normalizes it to absent), so rendering `×1` for
      // a stray in-memory `times: 1` would describe a file that can't exist.
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
      // Mirror the await/assert rendering above — selectorLabel spelling,
      // same comparator tail for text guards.
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
