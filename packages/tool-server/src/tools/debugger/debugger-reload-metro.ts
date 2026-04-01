import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";
import { DISABLE_LOGBOX_SCRIPT } from "../../utils/debugger/scripts/disable-logbox";

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
});

export const debuggerReloadMetroTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { reloaded: boolean; port: number; method: "cdp" | "http" }
> = {
  id: "debugger-reload-metro",
  description: `Refresh the connected app's JS bundle via Metro. Use when you need to apply code changes or reset app state without restarting the native process.
Accepts: port (default 8081, e.g. 8082 for alternate Metro instances).
Returns { reloaded, port, method } where method is "cdp" or "http".
Tries CDP Page.reload first (React Native 0.76+), then falls back to Metro's HTTP /reload endpoint.
Fails if neither CDP Page.reload nor the HTTP /reload endpoint is available.`,
  zodSchema,
  services: (params) => ({
    debugger: `JsRuntimeDebugger:${params.port}`,
  }),
  async execute(services, params) {
    const api = services.debugger as JsRuntimeDebuggerApi;
    const port = api.port;

    const disableLogBox = () =>
      new Promise<void>((resolve) => setTimeout(resolve, 2000)).then(() =>
        api.cdp.evaluate(DISABLE_LOGBOX_SCRIPT).catch(() => {})
      );

    // Primary: CDP Page.reload — works reliably with RN 0.76+ (Fusebox/Bridgeless).
    // Triggers a full JS execution context teardown and restart without touching the native shell.
    try {
      await api.cdp.send("Page.reload");
      disableLogBox();
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
    disableLogBox();
    return { reloaded: true, port, method: "http" };
  },
};
