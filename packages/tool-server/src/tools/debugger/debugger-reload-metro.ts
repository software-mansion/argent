import { z } from "zod";
import type { ToolDefinition } from "@radon-lite/registry";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
});

/**
 * Metro (React Native CLI) exposes a /reload endpoint that sends a reload command
 * to all connected apps over the packager connection (same as pressing "r" in
 * the Metro terminal). See react-native-community/cli#574.
 */
export const debuggerReloadMetroTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { reloaded: boolean; port: number }
> = {
  id: "debugger-reload-metro",
  description: `Ask the Metro server currently in use to reload all connected apps.
Calls Metro's HTTP /reload endpoint — equivalent to pressing "r" in the Metro terminal.
All simulators/devices connected to this Metro will reload their JS bundle. Use after code changes or to get a clean app state without restarting the app process.`,
  zodSchema,
  services: (params) => ({
    debugger: `JsRuntimeDebugger:${params.port}`,
  }),
  async execute(services, params) {
    const api = services.debugger as JsRuntimeDebuggerApi;
    const port = api.port;
    const res = await fetch(`http://127.0.0.1:${port}/reload`, {
      method: "POST",
    });
    if (!res.ok) {
      throw new Error(
        `Metro /reload failed: ${res.status} ${res.statusText}. Is Metro running and does it support /reload?`
      );
    }
    return { reloaded: true, port };
  },
};
