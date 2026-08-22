import { z } from "zod";
import {
  FAILURE_CODES,
  FailureError,
  getFailureSignal,
  type ToolDefinition,
} from "@argent/registry";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";
import { DEBUGGER_TOOL_CAPABILITY, debuggerServiceRef } from "./debugger-service-ref";

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port (ignored for Chromium)"),
  device_id: z
    .string()
    .describe(
      "Device id from list-devices — the SAME id you passed to debugger-connect (iOS simulator UDID, Android serial, Vega serial, or Chromium device id). On Metro the logicalDeviceId debugger-connect returns also resolves here for as long as that session lives, but prefer the stable list-devices id: once the session ends the alias goes with it, so the same logicalDeviceId then opens a SECOND debugger session for one device. On Chromium the two are one string, and a legacy inspector (Vega) reports no logicalDeviceId at all."
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
  description: `Execute arbitrary JavaScript in the app's JS runtime via CDP — Hermes on iOS / Android / Vega, V8 on Chromium.
Returns the evaluation result as a JSON-serializable value, along with deviceName, appName, and logicalDeviceId for context. Use when you need to read app state, call app functions, or test logic at runtime. The result is serialized by value, so cyclic objects (many RN runtime values — fiber nodes, navigation refs, global — are cyclic) fail with a serialization error rather than returning silently. Fails if the expression throws or the runtime is not connected.`,
  zodSchema,
  capability: DEBUGGER_TOOL_CAPABILITY,
  services: (params) => ({
    debugger: debuggerServiceRef(params),
  }),
  async execute(services, params) {
    const api = services.debugger as JsRuntimeDebuggerApi;
    let result: unknown;
    try {
      result = await api.cdp.evaluate(params.expression);
    } catch (err) {
      // The agent-supplied expression throwing is not a tool malfunction — the
      // evaluate round-trip worked. Re-code it so telemetry can separate
      // "agent's JS threw" from genuine CDP faults; the message (with the JS
      // stack the agent needs) is preserved verbatim. getFailureSignal is
      // breadth-first, so the outer signal wins over the inner one.
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
