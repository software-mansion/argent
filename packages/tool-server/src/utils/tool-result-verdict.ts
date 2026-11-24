import { canonicalToolId } from "@argent/registry";
import { unmetUiWaitCause } from "../tools/await-ui-element";
import { isDebuggerNotConnectedResult } from "../tools/debugger/not-connected";
import { isUnlandedKeyboardTextResult } from "../tools/keyboard";
import { nestedOrchestratorOutcome } from "../tools/flows/flow-nested-outcome";
import { isNativeDevtoolsBlockResult } from "../blueprints/native-devtools";
import { AWAIT_UI_ELEMENT_TOOL_ID, isUnmetWaitResult, type UnmetWaitCause } from "./wait-result";

/**
 * Why a wait of `tool` came back `success: false`. `await-ui-element` can read
 * it off the note of a result without the field; the other wait tools always
 * carry `cause`.
 */
export function unmetWaitCause(tool: string, result: unknown): UnmetWaitCause {
  if (tool === AWAIT_UI_ELEMENT_TOOL_ID) return unmetUiWaitCause(result);
  const carried = (result as { cause?: unknown } | null)?.cause;
  return carried === "unreadable" || carried === "cancelled" ? carried : "unmet";
}

/** Why a wait of `tool` came back `success: false`, as a step's reason. */
export function unmetWaitReason(tool: string, result: unknown): string {
  const { note } = result as { note?: string };
  const cause = unmetWaitCause(tool, result);
  // Only an `unmet` wait judged the condition; the other causes observed nothing.
  const what = cause === "unmet" ? "condition not met" : `condition not judged (${cause})`;
  return `${tool} ${what}${note ? `: ${note}` : ""}`;
}

export interface ToolResultVerdict {
  status: "fail" | "error" | "skip";
  reason: string;
}

/**
 * The failure a tool reports in a result it returns rather than throws: an
 * unmet wait (`await-ui-element`, `await-network-request`), a `keyboard`
 * read-back that found the text did not land, an `e2e-execute` or
 * `run-sequence` that did not pass, a debugger tool with no connection, a
 * native-devtools precheck that stopped the tool before its work, a recording
 * tool that recorded nothing.
 * `undefined` for any other result.
 *
 * The e2e runner scores a `tool:` step by it. A direct call is judged by
 * {@link directCallFailure}.
 */
export function toolResultVerdict(tool: string, result: unknown): ToolResultVerdict | undefined {
  if (isUnmetWaitResult(tool, result)) {
    return { status: "fail", reason: unmetWaitReason(tool, result) };
  }
  if (isUnlandedKeyboardTextResult(tool, result)) {
    return {
      status: "fail",
      reason: `typed text did not land${result.note ? `: ${result.note}` : ""}`,
    };
  }
  const nested = nestedOrchestratorOutcome(tool, result);
  if (nested) return nested;
  if (isDebuggerNotConnectedResult(tool, result)) {
    // `detail` is the only place the underlying error lives: device_mismatch's
    // guidance points at the logicalDeviceId "listed in the detail message".
    return {
      status: "fail",
      reason: `debugger not connected (${result.reason}): ${result.detail} — ${result.guidance}`,
    };
  }
  if (isNativeDevtoolsBlockResult(tool, result)) {
    return { status: "fail", reason: `${tool} did not run (${result.status}): ${result.message}` };
  }
  return isRecord(result) ? unrecordedStepVerdict(canonicalToolId(tool), result) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * A recording tool that recorded nothing: an `e2e-add-script` whose script did
 * not pass, or an `e2e-add-step` that answered with guidance (only an appended
 * step carries `recorded`).
 */
function unrecordedStepVerdict(
  tool: string,
  result: Record<string, unknown>
): ToolResultVerdict | undefined {
  const message = String(result.message);
  if (tool === "e2e-add-script") {
    const { status, reason } = result;
    if (status !== "fail" && status !== "error") return undefined;
    return { status, reason: `${message}${typeof reason === "string" ? ` (${reason})` : ""}` };
  }
  if (tool === "e2e-add-step" && !("recorded" in result))
    return { status: "error", reason: message };
  return undefined;
}

/**
 * Tools whose result is a status report, so `not_connected` or `init_failed`
 * is their answer rather than a failure. An e2e step that runs one asserts the
 * state, so the runner still fails it.
 */
const STATUS_TOOLS: ReadonlySet<string> = new Set(["debugger-status", "native-devtools-status"]);

/**
 * The reason a direct call of `tool` failed though it returned, for the HTTP
 * `failure` field. Also a `debugger-inspect-element` `{ error }`, a
 * `debugger-component-tree` `Error: ...` and a `native-profiler-analyze`
 * `analysis_failed`, which the e2e runner and recorder take as a step's result.
 */
export function directCallFailure(tool: string, result: unknown): string | undefined {
  if (STATUS_TOOLS.has(tool)) return undefined;
  if (tool === "debugger-inspect-element" && isRecord(result) && typeof result.error === "string") {
    return `debugger-inspect-element failed: ${result.error}`;
  }
  // A tree always starts with its `[device: ...]` line.
  if (tool === "debugger-component-tree" && typeof result === "string") {
    return result.startsWith("Error: ")
      ? `debugger-component-tree failed: ${result.slice("Error: ".length)}`
      : undefined;
  }
  if (tool === "native-profiler-analyze" && isRecord(result)) {
    if (result.status !== "analysis_failed") return undefined;
    const errors = isRecord(result.exportErrors) ? Object.entries(result.exportErrors) : [];
    const detail = errors.map(([name, error]) => `${name}: ${String(error)}`).join("; ");
    return `native-profiler-analyze could not analyze the whole trace${detail ? ` (${detail})` : ""}`;
  }
  return toolResultVerdict(tool, result)?.reason;
}
