import { z } from "zod";
import * as crypto from "node:crypto";
import type { ToolDefinition } from "@radon-lite/registry";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";
import { makeInspectScript } from "../../utils/debugger/scripts/inspect-at-point";

interface InspectItem {
  name: string;
  source: { file: string; line: number; column: number } | null;
  code: string | null;
}

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
  x: z.coerce.number().describe("Logical X coordinate on device screen"),
  y: z.coerce.number().describe("Logical Y coordinate on device screen"),
  contextLines: z
    .coerce.number()
    .default(3)
    .describe("Lines of source context to include around the component definition"),
  resolveSourceMaps: z
    .boolean()
    .default(true)
    .describe(
      "When true, resolves bundled frame locations to original source files via Metro symbolication and includes a code fragment. When false, returns the raw bundled frame info (file, line, column) without symbolication or source reading."
    ),
});

export const debuggerInspectElementTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { x: number; y: number; items: InspectItem[] } | { error: string }
> = {
  id: "debugger-inspect-element",
  description: `Inspect the React component hierarchy at a screen coordinate (x, y).
Returns each component in the hierarchy with its source file:line and a code fragment.
Uses getInspectorDataForViewAtPoint + _debugStack + Metro /symbolicate.
Set resolveSourceMaps to false to skip symbolication and get raw bundled locations instead.`,
  zodSchema,
  services: (params) => ({
    debugger: `JsRuntimeDebugger:${params.port}`,
  }),
  async execute(services, params) {
    const api = services.debugger as JsRuntimeDebuggerApi;
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
          if (params.resolveSourceMaps) {
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
          } else {
            source = {
              file: item.frame.file,
              line: item.frame.line,
              column: item.frame.col,
            };
          }
        }

        return { name: item.name, source, code };
      })
    );

    return { x: params.x, y: params.y, items };
  },
};
