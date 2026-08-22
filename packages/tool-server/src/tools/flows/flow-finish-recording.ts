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

// Spell selectors the way the flow FILE does (`id`, bare string for loose): the
// summary is read before hand-editing the YAML, so the spellings must agree.
function selectorLabel(sel: FlowSelector): string {
  return JSON.stringify(selectorToYaml(sel));
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
  description: `Finish recording the flow named by \`name\` + \`project_root\`, leaving recordings under any other key untouched. Returns { message, path, executionPrerequisite, steps, summary, flowFile, savedTo } - a summary of all recorded steps plus the final YAML. Use when you have added all desired steps and want to finalize the flow file. Fails if that flow has no recording in progress.
You can still edit the .yaml file directly afterwards to remove or reorder steps.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    // Resolve, read and clear as ONE critical section: host mode's
    // `await fs.readFile` is a yield, and an append landing in it would be on
    // disk while the summary and step count — taken from the pre-append read —
    // say otherwise.
    const { filePath, flowFile, savedTo, flow, summary } = await withFlowFileLock(
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
        // Parse BEFORE clearing: hand-editing the .yaml mid-recording is a
        // documented workflow, so parseFlow can throw on a botched edit, and
        // clearing first would destroy the session — leaving no way to retry the
        // finish after repairing the file (flow-start-recording, the only tool
        // that re-establishes the key, truncates the take it would recover).
        const flow = parseFlow(flowFile);
        // Summarize before clearing for the same reason: it walks step bodies the
        // parser does not fully constrain, and nothing that can throw may run
        // after the session is destroyed. The one known thrower is guarded in
        // {@link renderToolArgs}; the order is what keeps the next one
        // recoverable.
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
