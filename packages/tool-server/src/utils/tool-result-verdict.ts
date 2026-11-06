import { isUnmetUiWaitResult } from "../tools/await-ui-element";
import { isDebuggerNotConnectedResult } from "../tools/debugger/not-connected";
import { nestedOrchestratorOutcome } from "../tools/flows/flow-nested-outcome";
import { isNativeDevtoolsBlockResult } from "../blueprints/native-devtools";

export interface ToolResultVerdict {
  status: "fail" | "error" | "skip";
  reason: string;
}

/**
 * The failure a tool reports in a result it returns rather than throws: an
 * unmet `await-ui-element`, an `e2e-execute` or `run-sequence` that did not
 * pass, a debugger tool with no connection, a native-devtools precheck that
 * stopped the tool before its work. `undefined` for any other result.
 *
 * The e2e runner scores a `tool:` step by it, and the tool-server sends its
 * reason beside the result so `argent run` exits non-zero on it.
 */
export function toolResultVerdict(tool: string, result: unknown): ToolResultVerdict | undefined {
  if (isUnmetUiWaitResult(tool, result)) {
    const note = (result as { note?: string }).note;
    return {
      status: "fail",
      reason: `await-ui-element condition not met${note ? `: ${note}` : ""}`,
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
  return undefined;
}
