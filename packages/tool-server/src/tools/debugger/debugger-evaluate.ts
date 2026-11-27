import { z } from "zod";
import {
  FAILURE_CODES,
  FailureError,
  getFailureSignal,
  type ToolDefinition,
} from "@argent/registry";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";
import {
  DEBUGGER_TOOL_CAPABILITY,
  debuggerServiceRef,
  isChromiumDebuggerTarget,
} from "./debugger-service-ref";
import { guardModuleLoadErrors } from "../../utils/debugger/scripts/guard-module-errors";
import { metroPortField } from "../../utils/debugger/metro-port";

const zodSchema = z.object({
  port: metroPortField,
  device_id: z
    .string()
    .describe(
      "Device id from `debugger-connect`<flag:macos-apps> (macOS: Mac app id)</flag:macos-apps>."
    ),
  expression: z.string().describe("JavaScript expression to evaluate."),
});

export const debuggerEvaluateTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { result: unknown; deviceName: string; appName: string; logicalDeviceId: string | undefined }
> = {
  id: "debugger-evaluate",
  description: `Evaluate JavaScript in the app runtime (Hermes on React Native/Vega<flag:macos-apps>/Mac apps</flag:macos-apps>; V8 on Chromium; awaits Promises).
Use when inspecting runtime state (e.g. localStorage/sessionStorage on Chromium) or calling app functions.
Returns \`{ result, deviceName, appName, logicalDeviceId }\` (JSON-serialized; cyclic objects fail). Fails if disconnected or the expression throws.`,
  zodSchema,
  searchHint:
    "javascript js eval expression runtime app state localstorage sessionstorage web storage",
  interaction: {
    startedMsg: () => "Running JavaScript in the app",
    completedMsg: () => "Ran JavaScript in the app",
    failedMsg: ({ failureSignal }) =>
      `Failed to run JavaScript in the app: ${failureSignal.error_code}`,
  },
  capability: DEBUGGER_TOOL_CAPABILITY,
  services: (params) => ({
    debugger: debuggerServiceRef(params),
  }),
  async execute(services, params) {
    const api = services.debugger as JsRuntimeDebuggerApi;
    let result: unknown;
    try {
      // Chromium has no Metro module loader, and a page's CSP may forbid eval.
      const expression = isChromiumDebuggerTarget(params.device_id)
        ? params.expression
        : guardModuleLoadErrors(params.expression);
      result = await api.cdp.evaluateAwaited(expression);
    } catch (err) {
      // The agent's expression throwing is not a tool malfunction, so re-code it
      // to keep it separable from genuine CDP faults in telemetry. getFailureSignal
      // is breadth-first, so this outer signal wins over the cause's.
      if (
        err instanceof Error &&
        getFailureSignal(err)?.error_code === FAILURE_CODES.DEBUGGER_CDP_RUNTIME_EXCEPTION
      ) {
        throw new FailureError(
          err.message,
          {
            error_code: FAILURE_CODES.DEBUGGER_EVALUATE_EXPRESSION_THREW,
            failure_stage: "debugger_evaluate_expression",
            failure_area: "tool_server",
            error_kind: "unknown",
          },
          { cause: err }
        );
      }
      throw err;
    }
    return {
      result,
      deviceName: api.deviceName,
      appName: api.appName,
      logicalDeviceId: api.logicalDeviceId,
    };
  },
};
