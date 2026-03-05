import { z } from "zod";
import type { ToolDefinition } from "@radon-lite/registry";
import type { MetroDebuggerApi } from "../../blueprints/metro-debugger";

interface StepLocation {
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
  action: z
    .enum(["stepOver", "stepInto", "stepOut"])
    .describe(
      "Stepping action: stepOver (next line), stepInto (enter function), stepOut (exit function)"
    ),
});

export const metroStepTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { action: string; sent: boolean; location?: StepLocation }
> = {
  id: "metro-step",
  description: `Perform a step operation while paused at a breakpoint.
Requires the debugger to be paused (via metro-pause or a breakpoint hit).
Returns the new location after stepping with source-mapped file info.`,
  zodSchema,
  services: (params) => ({
    metroDebugger: `MetroDebugger:${params.port}`,
  }),
  async execute(services, params) {
    const api = services.metroDebugger as MetroDebuggerApi;

    const pausedPromise = new Promise<Record<string, unknown> | null>(
      (resolve) => {
        const timeout = setTimeout(() => resolve(null), 5000);
        const handler = (pauseParams: Record<string, unknown>) => {
          clearTimeout(timeout);
          api.cdp.events.off("paused", handler);
          resolve(pauseParams);
        };
        api.cdp.events.on("paused", handler);
      }
    );

    await api.cdp.send(`Debugger.${params.action}`);

    const pausedParams = await pausedPromise;
    if (!pausedParams) {
      return { action: params.action, sent: true };
    }

    const callFrames = (pausedParams.callFrames ?? []) as Array<{
      functionName: string;
      location: { scriptId: string; lineNumber: number; columnNumber: number };
      url: string;
    }>;

    const topFrame = callFrames[0];
    if (!topFrame) {
      return { action: params.action, sent: true };
    }

    const loc = topFrame.location;
    const symbolicated = await api.sourceResolver.symbolicate(
      topFrame.url,
      loc.lineNumber + 1,
      loc.columnNumber
    );

    return {
      action: params.action,
      sent: true,
      location: {
        functionName: topFrame.functionName || "(anonymous)",
        sourceFile: symbolicated?.file ?? null,
        sourceLine: symbolicated?.line ?? null,
        sourceColumn: symbolicated?.column ?? null,
        bundleLine: loc.lineNumber,
        bundleColumn: loc.columnNumber,
        scriptId: loc.scriptId,
      },
    };
  },
};
