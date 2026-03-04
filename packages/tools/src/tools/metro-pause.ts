import { z } from "zod";
import type { ToolDefinition } from "@radon-lite/registry";
import type { MetroDebuggerApi } from "../blueprints/metro-debugger";

interface CallFrameInfo {
  functionName: string;
  sourceFile: string | null;
  sourceLine: number | null;
  sourceColumn: number | null;
  bundleLine: number;
  bundleColumn: number;
  scriptId: string;
}

const zodSchema = z.object({
  port: z.number().default(8081).describe("Metro server port"),
});

export const metroPauseTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { paused: boolean; reason?: string; topFrames?: CallFrameInfo[] }
> = {
  id: "metro-pause",
  description: `Pause JavaScript execution in the React Native app. The app UI will freeze until resumed.
Returns the pause reason and top call frames with source-mapped locations.`,
  zodSchema,
  services: (params) => ({
    metroDebugger: `MetroDebugger:${params.port}`,
  }),
  async execute(services) {
    const api = services.metroDebugger as MetroDebuggerApi;

    const pausedPromise = new Promise<Record<string, unknown> | null>(
      (resolve) => {
        const timeout = setTimeout(() => resolve(null), 5000);
        const handler = (params: Record<string, unknown>) => {
          clearTimeout(timeout);
          api.cdp.events.off("paused", handler);
          resolve(params);
        };
        api.cdp.events.on("paused", handler);
      }
    );

    await api.cdp.send("Debugger.pause");

    const pausedParams = await pausedPromise;
    if (!pausedParams) {
      return { paused: true };
    }

    const callFrames = (pausedParams.callFrames ?? []) as Array<{
      functionName: string;
      location: { scriptId: string; lineNumber: number; columnNumber: number };
      url: string;
    }>;

    const topFrames: CallFrameInfo[] = await Promise.all(
      callFrames.slice(0, 5).map(async (frame) => {
        const loc = frame.location;
        const symbolicated = await api.sourceResolver.symbolicate(
          frame.url,
          loc.lineNumber + 1,
          loc.columnNumber
        );

        return {
          functionName: frame.functionName || "(anonymous)",
          sourceFile: symbolicated?.file ?? null,
          sourceLine: symbolicated?.line ?? null,
          sourceColumn: symbolicated?.column ?? null,
          bundleLine: loc.lineNumber,
          bundleColumn: loc.columnNumber,
          scriptId: loc.scriptId,
        };
      })
    );

    return {
      paused: true,
      reason: pausedParams.reason as string,
      topFrames,
    };
  },
};
