import { z } from "zod";
import type { ToolDefinition } from "@radon-lite/registry";
import type { MetroDebuggerApi } from "../blueprints/metro-debugger";

const zodSchema = z.object({
  port: z.number().default(8081).describe("Metro server port"),
});

export const metroConsoleListenTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { url: string }
> = {
  id: "metro-console-listen",
  description: `Subscribe to real-time console logs from the React Native app runtime.
Returns a WebSocket URL that streams log entries as JSON messages.
On connect, all buffered logs are replayed, followed by live entries.
The app must be connected via metro-connect first (auto-connects if needed).`,
  zodSchema,
  services: (params) => ({
    metroDebugger: `MetroDebugger:${params.port}`,
  }),
  async execute(services) {
    const api = services.metroDebugger as MetroDebuggerApi;
    return { url: api.consoleSocketUrl };
  },
};
