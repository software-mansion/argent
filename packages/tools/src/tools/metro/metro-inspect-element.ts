import { z } from "zod";
import * as crypto from "node:crypto";
import type { ToolDefinition } from "@radon-lite/registry";
import type { MetroDebuggerApi } from "../../blueprints/metro-debugger";
import { makeInspectScript } from "../../metro/scripts/inspect-at-point";

interface InspectItem {
  name: string;
  source: { file: string; line: number; column: number } | null;
  code: string | null;
}

const zodSchema = z.object({
  port: z.number().default(8081).describe("Metro server port"),
  x: z.number().describe("Logical X coordinate on device screen"),
  y: z.number().describe("Logical Y coordinate on device screen"),
  contextLines: z
    .number()
    .default(3)
    .describe("Lines of source context to include around the component definition"),
});

export const metroInspectElementTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { x: number; y: number; items: InspectItem[] } | { error: string }
> = {
  id: "metro-inspect-element",
  description: `Inspect the React component hierarchy at a screen coordinate (x, y).
Returns each component in the hierarchy with its source file:line and a code fragment.
Uses getInspectorDataForViewAtPoint + _debugStack + Metro /symbolicate.`,
  zodSchema,
  services: (params) => ({
    metroDebugger: `MetroDebugger:${params.port}`,
  }),
  async execute(services, params) {
    const api = services.metroDebugger as MetroDebuggerApi;
    const requestId = crypto.randomUUID();
    const script = makeInspectScript(params.x, params.y, requestId);

    const raw = await api.cdp.evaluateWithBinding(script, requestId, {
      timeout: 8000,
    });

    if (raw.error) {
      return { error: raw.error as string };
    }

    const rawItems = (raw.items ?? []) as Array<{
      name: string;
      frame: { fn: string; file: string; line: number; col: number } | null;
    }>;

    const items: InspectItem[] = await Promise.all(
      rawItems.map(async (item) => {
        let source: InspectItem["source"] = null;
        let code: string | null = null;

        if (item.frame?.file) {
          const resolved = await api.sourceResolver.symbolicate(
            item.frame.file,
            item.frame.line,
            item.frame.col,
            item.frame.fn
          );
          if (resolved) {
            source = resolved;
            code = await api.sourceResolver.readSourceFragment(
              resolved,
              params.contextLines
            );
          }
        }

        return { name: item.name, source, code };
      })
    );

    return { x: params.x, y: params.y, items };
  },
};
