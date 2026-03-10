import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
});

export const debuggerReloadMetroTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { reloaded: boolean; port: number; method: "cdp" | "http" }
> = {
  id: "debugger-reload-metro",
  description: `Ask the Metro server currently in use to reload the connected app's JS bundle.
Equivalent to pressing "r" in the Metro terminal. Use after code changes or to get a clean app state without restarting the native process.
Tries the CDP Page.reload method first (works with React Native 0.76+ Fusebox/Bridgeless), then falls back to Metro's HTTP /reload endpoint for older setups.`,
  zodSchema,
  services: (params) => ({
    debugger: `JsRuntimeDebugger:${params.port}`,
  }),
  async execute(services, params) {
    const api = services.debugger as JsRuntimeDebuggerApi;
    const port = api.port;

    // Primary: CDP Page.reload — works reliably with RN 0.76+ (Fusebox/Bridgeless).
    // Triggers a full JS execution context teardown and restart without touching the native shell.
    try {
      await api.cdp.send("Page.reload");
      return { reloaded: true, port, method: "cdp" };
    } catch {
      // Fall through to HTTP fallback
    }

    // Fallback: Metro's HTTP /reload endpoint (RN CLI classic, older Expo setups).
    // Not always present — Expo SDK 52+ / RN 0.76+ may not expose it.
    const res = await fetch(`http://127.0.0.1:${port}/reload`, {
      method: "POST",
    });
    if (!res.ok) {
      throw new Error(
        `Failed to reload: CDP Page.reload unsupported and Metro HTTP /reload returned ${res.status} ${res.statusText}.`
      );
    }
    return { reloaded: true, port, method: "http" };
  },
};
