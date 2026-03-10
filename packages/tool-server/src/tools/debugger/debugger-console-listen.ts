import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
});

export const debuggerConsoleListenTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { url: string }
> = {
  id: "debugger-console-listen",
  description: `Subscribe to real-time console logs from the React Native app runtime.
Returns a WebSocket URL that streams log entries as JSON messages.
On connect, all buffered logs are replayed, followed by live entries.
The app must be connected via debugger-connect first (auto-connects if needed).`,
  zodSchema,
  services: (params) => ({
    debugger: `JsRuntimeDebugger:${params.port}`,
  }),
  async execute(services) {
    const api = services.debugger as JsRuntimeDebuggerApi;
    return { url: api.consoleSocketUrl };
  },
};
