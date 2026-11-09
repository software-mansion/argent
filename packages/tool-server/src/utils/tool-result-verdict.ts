import { canonicalToolId } from "@argent/registry";
import { isUnmetUiWaitResult, unmetUiWaitCause } from "../tools/await-ui-element";
import { isDebuggerNotConnectedResult } from "../tools/debugger/not-connected";
import { nestedOrchestratorOutcome } from "../tools/flows/flow-nested-outcome";
import { isNativeDevtoolsBlockResult } from "../blueprints/native-devtools";

/** Why an `await-ui-element` came back `success: false`. */
export function unmetWaitReason(result: unknown): string {
  const note = (result as { note?: unknown }).note;
  const cause = unmetUiWaitCause(result);
  // Only an `unmet` wait judged the condition; the other causes observed nothing.
  const what = cause === "unmet" ? "condition not met" : `condition not judged (${cause})`;
  return `await-ui-element ${what}${typeof note === "string" && note ? `: ${note}` : ""}`;
}

export interface ToolResultVerdict {
  status: "fail" | "error" | "skip";
  reason: string;
}

/**
 * The failure a tool reports in a result it returns rather than throws: an
 * unmet `await-ui-element`, an `e2e-execute` or `run-sequence` that did not
 * pass, a debugger tool with no connection, a native-devtools precheck that
 * stopped the tool before its work, a recording tool that recorded nothing, a
 * `debugger-inspect-element` error. `undefined` for any other result.
 *
 * The e2e runner scores a `tool:` step by it. A direct call is judged by
 * {@link directCallFailure}.
 */
export function toolResultVerdict(tool: string, result: unknown): ToolResultVerdict | undefined {
  if (isUnmetUiWaitResult(tool, result)) return { status: "fail", reason: unmetWaitReason(result) };
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
  return typeof result === "object" && result !== null
    ? (unrecordedStepVerdict(canonicalToolId(tool), result as Record<string, unknown>) ??
        inspectErrorVerdict(tool, result as Record<string, unknown>))
    : undefined;
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
  if (typeof result.message !== "string") return undefined;
  if (tool === "e2e-add-script") {
    const { status, reason } = result;
    if (status !== "fail" && status !== "error" && status !== "skip") return undefined;
    return {
      status,
      reason: `${result.message}${typeof reason === "string" && reason ? ` (${reason})` : ""}`,
    };
  }
  if (tool === "e2e-add-step" && !("recorded" in result)) {
    return { status: "error", reason: result.message };
  }
  return undefined;
}

function inspectErrorVerdict(
  tool: string,
  result: Record<string, unknown>
): ToolResultVerdict | undefined {
  if (tool !== "debugger-inspect-element" || typeof result.error !== "string") return undefined;
  return { status: "fail", reason: `debugger-inspect-element failed: ${result.error}` };
}

/**
 * Tools whose result is a status report, so `not_connected` or `init_failed`
 * is their answer rather than a failure. An e2e step that runs one asserts the
 * state, so the runner still fails it.
 */
const STATUS_TOOLS: ReadonlySet<string> = new Set(["debugger-status", "native-devtools-status"]);

/** The reason a direct call of `tool` failed though it returned, for the HTTP `failure` field. */
export function directCallFailure(tool: string, result: unknown): string | undefined {
  return STATUS_TOOLS.has(tool) ? undefined : toolResultVerdict(tool, result)?.reason;
}
