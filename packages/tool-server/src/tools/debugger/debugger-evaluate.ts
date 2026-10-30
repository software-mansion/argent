import { z } from "zod";
import {
  FAILURE_CODES,
  FailureError,
  getFailureSignal,
  type ToolDefinition,
} from "@argent/registry";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";
import { DEBUGGER_TOOL_CAPABILITY, debuggerServiceRef } from "./debugger-service-ref";
import { metroPortField } from "../../utils/debugger/metro-port";

const zodSchema = z.object({
  port: metroPortField,
  device_id: z
    .string()
    .describe(
      "Device id from list-devices: the SAME id you passed to debugger-connect (iOS simulator UDID, Android serial, Vega serial, or Chromium device id). The logicalDeviceId debugger-connect returns also resolves here, but prefer the stable list-devices id."
    ),
  expression: z.string().describe("JavaScript expression to evaluate in the app runtime"),
});

export const debuggerEvaluateTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { result: unknown; deviceName: string; appName: string; logicalDeviceId: string | undefined }
> = {
  id: "debugger-evaluate",
  interaction: {
    startedMsg: () => "Running JavaScript in the app",
    completedMsg: () => "Ran JavaScript in the app",
    failedMsg: ({ failureSignal }) =>
      `Failed to run JavaScript in the app: ${failureSignal.error_code}`,
  },
  description: `Execute arbitrary JavaScript in the app's JS runtime via CDP: Hermes on iOS / Android / Vega, V8 on Chromium.
Returns the evaluation result as a JSON-serializable value, along with deviceName, appName, and logicalDeviceId for context. A returned Promise is awaited and its resolved value returned, e.g. \`fetch(url).then(r => r.status)\`; a rejection fails the call like a throw, and a Promise still pending after 10 s fails with DEBUGGER_CDP_REQUEST_TIMEOUT although the expression has already run, so do not re-run it for its side effects. On React Native 0.76 and older with Hermes, a Promise comes back unsettled (its internals); store the result on a global in a \`then\` callback and read it with a second call. To run something for its side effect without waiting, evaluate \`void (expr)\`. Use when you need to read app state, call app functions, or test logic at runtime. The result is serialized by value, so cyclic objects (many RN runtime values, such as fiber nodes, navigation refs and global, are cyclic) fail with a serialization error rather than returning silently. Fails if the expression throws or the runtime is not connected.`,
  zodSchema,
  capability: DEBUGGER_TOOL_CAPABILITY,
  services: (params) => ({
    debugger: debuggerServiceRef(params),
  }),
  async execute(services, params) {
    const api = services.debugger as JsRuntimeDebuggerApi;
    let result: unknown;
    try {
      result = await api.cdp.evaluateAwaited(params.expression);
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
