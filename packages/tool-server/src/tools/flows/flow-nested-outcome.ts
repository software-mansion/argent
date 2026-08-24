import type { StepStatus } from "./flow-run";
import { KEYBOARD_TOOL_ID, resultNote } from "./flow-actions";

/**
 * Reading the verdict of a nested orchestrator step.
 *
 * Two registered tools run other tools and report what happened in their
 * result rather than by throwing: `flow-execute` and `run-sequence`. The flow
 * runner dispatches both through the generic `tool` step, which — apart from one
 * `await-ui-element` special case — treats any non-throwing result as a pass. So
 * a composed flow that failed every step, or a sequence that stopped on its
 * first tool, was reported as a green pass by the run that contained it (#606).
 *
 * These are deliberately two named, tool-scoped branches rather than a general
 * "a result with `ok: false` fails the step" rule. There is no such contract in
 * this codebase to generalise: the only other soft-verdict tool spells it
 * `success` (`await-ui-element`), `run-sequence` spells it neither way, and the
 * generic `tool` step dispatches tools whose results are typed `unknown` or
 * `Record<string, unknown>` — several of them carrying app-derived payloads. A
 * blanket rule would silently bind all of those, and every tool added later, to
 * "a key called `ok` decides my flow's verdict". `isUnmetUiWaitResult` set the
 * precedent for naming the tool instead.
 *
 * Everything here narrows defensively: results cross the registry boundary as
 * `unknown`, and a shape this does not recognise must fall through to the
 * runner's existing behaviour rather than guess at a verdict.
 */

const FLOW_EXECUTE_TOOL_ID = "flow-execute";
const RUN_SEQUENCE_TOOL_ID = "run-sequence";

export interface NestedOutcome {
  status: StepStatus;
  reason: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The first step in a nested flow report that did not pass, rendered for a human. */
function firstFailingStep(steps: unknown): string | undefined {
  if (!Array.isArray(steps)) return undefined;
  for (const entry of steps) {
    if (!isRecord(entry)) continue;
    if (entry.status !== "fail" && entry.status !== "error") continue;
    // Prefer the tool id; fall back to the step kind. Both are checked for being
    // strings rather than coerced — this report crossed the registry boundary as
    // `unknown`, and an object here would render as "[object Object]".
    const what =
      typeof entry.tool === "string"
        ? entry.tool
        : typeof entry.kind === "string"
          ? entry.kind
          : "step";
    const why = typeof entry.reason === "string" ? entry.reason : "no reason given";
    return `${what}: ${why}`;
  }
  return undefined;
}

function count(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

/**
 * The weak-pass note a `run-sequence` step buried in its per-step results.
 *
 * `run-sequence` is a first-class flow tool step, `keyboard` is one of its
 * allowed tools, and `argent-device-interact` prescribes this spelling for a
 * clear that types: `{ clear: true, text }`, then `{ key: "enter" }`. The note
 * that says the clear took a weaker path then lands at
 * `result.steps[i].result.note`, where the runner's own top-level read cannot
 * see it and no CLI renders it — so the step reported a clean green over a clear
 * nothing verified.
 *
 * Only `keyboard` steps are read, for the reason KEYBOARD_TOOL_ID gives: a
 * `note` on any other tool describes a healthy call.
 *
 * A sequence may hold more than one clear, so every note is kept. Each is a
 * finished sentence, so joining them needs no separator beyond the space.
 *
 * Narrows defensively throughout: this report crossed the registry boundary as
 * `unknown`, and a shape not recognised here must leave the step exactly as the
 * runner would have reported it.
 */
function nestedWeakPassNote(result: unknown): string | undefined {
  if (!isRecord(result) || !Array.isArray(result.steps)) return undefined;
  const notes: string[] = [];
  for (const entry of result.steps) {
    if (!isRecord(entry) || entry.tool !== KEYBOARD_TOOL_ID) continue;
    const note = resultNote(entry.result);
    if (note !== undefined) notes.push(note);
  }
  return notes.length > 0 ? notes.join(" ") : undefined;
}

/**
 * The weak-pass warnings a nested `flow-execute` reported one level down.
 *
 * `flow-execute` keeps its sub-run's step reports inside `result`, and a green
 * sub-run has no outcome of its own — so a composed flow whose clear took a
 * weaker path passed with the warning sitting where nothing reads it: the CLI's
 * `StepReport` has no `result` field, and the runner counts only top-level
 * `warning`s. `flow-add-step` records a raw `tool: flow-execute` step on four
 * branches, so this is a spelling flows really carry.
 *
 * Every `warning` is taken, not just a `keyboard` note, and that is the whole
 * difference from {@link nestedWeakPassNote}: a nested report has already been
 * through the sub-run's own `execLeafStep`, so its `warning` field means one
 * thing — this step passed in a way that weakens it as proof — where a `note`
 * means whatever the tool that wrote it meant. It composes to any depth for the
 * same reason: a `flow-execute` inside the sub-flow carries its own children's
 * warnings up by this route before this one reads it.
 *
 * Repeats are dropped. A flow that clears five fields the same weak way has one
 * thing to say about it, and five copies of the sentence is a warning nobody
 * finishes reading.
 */
export function nestedFlowWarnings(result: unknown): string | undefined {
  if (!isRecord(result) || !Array.isArray(result.steps)) return undefined;
  const warnings: string[] = [];
  for (const entry of result.steps) {
    if (!isRecord(entry)) continue;
    const warning = entry.warning;
    if (typeof warning !== "string" || warning.length === 0) continue;
    if (!warnings.includes(warning)) warnings.push(warning);
  }
  return warnings.length > 0 ? warnings.join(" ") : undefined;
}

/**
 * The warning a passing `tool:` step owes its own report, whatever level the
 * weakness was buried at.
 *
 * One place for the enumeration, because the docblocks that describe it — on
 * both `StepReport.warning`s and in the `flow-execute` tool description — name
 * the routes, and a route added here without them is a claim that stopped being
 * true. Three tools answer: `keyboard` for its own note, and the two nested
 * orchestrators for the reports they hold.
 */
export function toolStepWarning(tool: string, result: unknown): string | undefined {
  if (tool === KEYBOARD_TOOL_ID) return resultNote(result);
  if (tool === RUN_SEQUENCE_TOOL_ID) return nestedWeakPassNote(result);
  if (tool === FLOW_EXECUTE_TOOL_ID) return nestedFlowWarnings(result);
  return undefined;
}

/** A nested `flow-execute` result: a run report, or a prerequisite notice. */
function flowExecuteOutcome(result: Record<string, unknown>): NestedOutcome | undefined {
  const flow = typeof result.flow === "string" ? result.flow : "the composed flow";

  // A notice means the sub-flow ran NOTHING. Reported as an error rather than a
  // failure: nothing was asserted, so "the app misbehaved" would be untrue —
  // the step was never runnable as written, which is the class the runner
  // already labels error (an unreadable fragment, a cyclic reference).
  if (!("steps" in result) && typeof result.notice === "string") {
    const prerequisite =
      typeof result.executionPrerequisite === "string" && result.executionPrerequisite
        ? `: ${result.executionPrerequisite}`
        : "";
    return {
      status: "error",
      reason:
        `flow "${flow}" did not run — its execution prerequisite was not acknowledged${prerequisite}. ` +
        `Add prerequisiteAcknowledged: true to the step's args, or compose with run: instead.`,
    };
  }

  // A cancelled run is a skip, never a failure — the same rule the runner
  // applies to its own steps when the signal fires mid-flight.
  if (result.aborted === true) {
    return { status: "skip", reason: `flow "${flow}" was aborted` };
  }

  if (result.ok === false) {
    const detail = firstFailingStep(result.steps);
    return {
      status: "fail",
      reason:
        `flow "${flow}" failed: ${count(result.passed)} passed, ${count(result.failed)} failed, ` +
        `${count(result.errored)} errored${detail ? ` (${detail})` : ""}`,
    };
  }

  return undefined;
}

/**
 * A nested `run-sequence` result.
 *
 * `run-sequence` has no verdict field at all. Every one of its failure paths —
 * a disallowed tool, an unsupported operation, an unmet `await-ui-element`, a
 * tool that threw — pushes an `error` entry, breaks the loop, and returns
 * normally. So a sequence that stopped on its first of eight steps returned a
 * perfectly ordinary result, and the flow step reported a pass.
 */
function runSequenceOutcome(result: Record<string, unknown>): NestedOutcome | undefined {
  const steps = result.steps;
  if (!Array.isArray(steps)) return undefined;

  const failed = steps.find((s) => isRecord(s) && typeof s.error === "string");
  if (failed && isRecord(failed)) {
    const tool = typeof failed.tool === "string" ? failed.tool : "step";
    return {
      status: "fail",
      reason:
        `run-sequence stopped at ${tool} after ${count(result.completed)} of ` +
        `${count(result.total)} steps: ${String(failed.error)}`,
    };
  }

  // No error entry but the sequence stopped short: its only other exit is the
  // abort check. Cancellation is a skip, matching the flow-execute branch.
  const total = count(result.total);
  if (total > 0 && steps.length < total) {
    return {
      status: "skip",
      reason: `run-sequence was aborted after ${count(result.completed)} of ${total} steps`,
    };
  }

  return undefined;
}

/**
 * Every nested orchestrator with the reader for its result shape. One list, so
 * a caller asking only WHETHER a tool runs a nested flow — the flow runner
 * spends its tree-outage verdict on one — cannot drift from this dispatch.
 */
const NESTED_ORCHESTRATORS = new Map<
  string,
  (result: Record<string, unknown>) => NestedOutcome | undefined
>([
  [FLOW_EXECUTE_TOOL_ID, flowExecuteOutcome],
  [RUN_SEQUENCE_TOOL_ID, runSequenceOutcome],
]);

/** Whether a `tool:` step runs other tools through a run of its own. */
export function isNestedOrchestratorTool(tool: string): boolean {
  return NESTED_ORCHESTRATORS.has(tool);
}

/**
 * Classify a nested orchestrator's result, or `undefined` when this is not one
 * of them, when it succeeded, or when the shape is not recognised — in every
 * one of which cases the runner's existing handling is correct.
 */
export function nestedOrchestratorOutcome(
  tool: string,
  result: unknown
): NestedOutcome | undefined {
  if (!isRecord(result)) return undefined;
  return NESTED_ORCHESTRATORS.get(tool)?.(result);
}
