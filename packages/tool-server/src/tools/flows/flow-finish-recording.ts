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
} from "./flow-utils";
import type { TextMatchMode } from "../../utils/ui-tree-match";

// Quote selectors in the step summary the way the flow FILE spells them
// (`id`, bare string for loose, no internal `loose` flag) — the summary is what
// gets read before hand-editing the YAML, so the spellings must agree.
function selectorLabel(sel: FlowSelector): string {
  return JSON.stringify(selectorToYaml(sel));
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
You can still edit the .yaml file directly afterwards to remove or reorder steps.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    // Resolve, read and clear as ONE critical section under the flow-file lock.
    // Host mode's `await fs.readFile` is a yield, and an append that lands in it
    // would be on disk while the summary and step count reported here — taken
    // from the pre-append read — say otherwise.
    const { filePath, flowFile, savedTo, flow, summary } = await withFlowFileLock(
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
        // Parse BEFORE clearing. Hand-editing the .yaml mid-recording is a
        // documented workflow, so parseFlow can legitimately throw here on a
        // botched edit — and clearing first would destroy the session on the
        // way out, leaving the agent unable to retry the finish after repairing
        // the file (the only tool that re-establishes the key,
        // flow-start-recording, truncates the take it would be recovering).
        const flow = parseFlow(flowFile);
        // Render the summary before clearing too, for the same reason: it walks
        // step bodies the parser does not fully constrain, and nothing that can
        // throw may run after the session is destroyed. The one known thrower
        // there — `JSON.stringify` on a cyclic `args` anchor — is guarded in
        // {@link renderToolArgs}; keeping the order is what makes the next one
        // recoverable rather than fatal.
        const summary = summarizeSteps(flow);
        clearRecordingSession(session);
        return { filePath, flowFile, savedTo, flow, summary };
      }
    );

    return {
      message: `Finished recording "${params.name}" flow (${flow.steps.length} steps)`,
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

/** The pre-step sleep a replay performs, when the step carries one. */
function delayLabel(step: FlowStep): string {
  const delayMs = (step as { delayMs?: number }).delayMs;
  return typeof delayMs === "number" ? ` (after ${delayMs}ms)` : "";
}

/** One human-readable line per recorded step, in the flow file's own spellings. */
function summarizeSteps(flow: FlowFile): string[] {
  return flow.steps.map((step, i) => summarizeStep(step, i + 1));
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
      // summary line that drops them misdescribes the file, and since the
      // recorder stopped returning the YAML per step this line is the author's
      // only per-step view of what was appended. Neither kind carries a
      // `delayMs` (only `tool` steps do), so no delayLabel here.
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
    case "tool":
    default:
      return `${n}. tool: ${step.name} ${renderToolArgs(step.args)}${delayLabel(step)}`;
  }
}
