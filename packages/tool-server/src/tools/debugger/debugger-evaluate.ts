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
      "Device id used with debugger-connect<flag:macos-apps>. For macOS, use the Mac app id</flag:macos-apps>."
    ),
  expression: z.string().describe("JavaScript expression to evaluate in the app runtime"),
});

export const debuggerEvaluateTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { result: unknown; deviceName: string; appName: string; logicalDeviceId: string | undefined }
> = {
  id: "debugger-evaluate",
  description: `Run JavaScript in the app's runtime. React Native uses Hermes, including on Vega<flag:macos-apps> and Mac apps</flag:macos-apps>. Chromium uses V8.
Returns the result serialized by value as JSON, with deviceName, appName, and logicalDeviceId. A returned Promise is awaited and its resolved value returned. Use when you need to read app state, including localStorage and sessionStorage on Chromium, call app functions, or test logic at runtime. Cyclic objects, which many RN runtime values are (fiber nodes, navigation refs, global), fail with a serialization error. Fails if the expression throws or the runtime is not connected. On React Native, a module that fails to load while the expression runs (e.g. a lazy react-native export whose native module the app lacks) fails the call with that module's error instead of opening the app's red box.`,
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
