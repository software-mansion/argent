import { z } from "zod";
import * as crypto from "node:crypto";
import type { ToolDefinition } from "@argent/registry";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";
import { makeInspectScript } from "../../utils/debugger/scripts/inspect-at-point";
import { shouldSkip, isHardSkip } from "../../utils/debugger/skip-rules";

export interface InspectItem {
  name: string;
  source: { file: string; line: number; column: number } | null;
  code: string | null;
}

/**
 * Filters and deduplicates the raw inspect-element hierarchy.
 * Applied after source resolution, before maxItems truncation.
 */
export function filterInspectItems(items: InspectItem[]): InspectItem[] {
  // Deduplicate consecutive AnimatedComponent(X) / Animated(X) that wrap the
  // immediately preceding host component.
  const animDeduped: InspectItem[] = [];
  for (const item of items) {
    const inner =
      item.name.startsWith("AnimatedComponent(")
        ? item.name.slice("AnimatedComponent(".length, -1)
        : item.name.startsWith("Animated(")
          ? item.name.slice("Animated(".length, -1)
          : null;
    if (inner !== null && animDeduped.length > 0 && animDeduped[animDeduped.length - 1].name === inner) {
      continue;
    }
    animDeduped.push(item);
  }

  // Pass 1: Source-aware skip-rule filter.
  // Remove items that match skip patterns ONLY when they have no source file.
  // Always keep index 0 (the leaf / tapped element) regardless of skip rules.
  const skipFiltered: InspectItem[] = [];
  for (let i = 0; i < animDeduped.length; i++) {
    const item = animDeduped[i];
    const hasSource = item.source !== null;
    if (i > 0 && !hasSource && (isHardSkip(item.name) || shouldSkip(item.name))) {
      continue;
    }
    skipFiltered.push(item);
  }

  // Pass 2: Same-source deduplication.
  // When consecutive items share the exact same source file:line, keep only the first.
  const srcDeduped: InspectItem[] = [];
  for (const item of skipFiltered) {
    if (srcDeduped.length > 0 && item.source && srcDeduped[srcDeduped.length - 1].source) {
      const prev = srcDeduped[srcDeduped.length - 1].source!;
      if (prev.file === item.source.file && prev.line === item.source.line) {
        continue;
      }
    }
    srcDeduped.push(item);
  }

  // Pass 3: Anonymous host element pruning.
  // Remove "View" items with no source (keep the leaf at index 0).
  const result: InspectItem[] = [];
  for (let i = 0; i < srcDeduped.length; i++) {
    const item = srcDeduped[i];
    if (
      i > 0 &&
      item.name === "View" &&
      item.source === null
    ) {
      continue;
    }
    result.push(item);
  }

  return result;
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
  maxItems: z
    .coerce.number()
    .default(35)
    .describe(
      "Maximum number of hierarchy items to return, counted from the bottom (most specific component first). The hierarchy walks from the tapped element up to the root — the first items are the most relevant for editing. Increase to 70+ if you need to understand the broader navigation/screen structure."
    ),
});

export const debuggerInspectElementTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  | { x: number; y: number; items: InspectItem[]; truncated?: boolean; hiddenCount?: number; hint?: string }
  | { error: string }
> = {
  id: "debugger-inspect-element",
  description: `Inspect the React component hierarchy at a screen coordinate (x, y).
Returns components from the tapped element upward through its parent hierarchy,
each with its source file:line and a code fragment.

The first items (lowest indices) are the most specific — the exact component under
the tap point and its direct parents. Higher indices are broader context (page, navigator).
Default shows 35 items which covers all app-specific code; use maxItems=70+ to also
see the navigation/screen structure.

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
      frame: {
        fn: string;
        file: string;
        line: number;
        col: number;
        original?: boolean;
      } | null;
    }>;

    const items: InspectItem[] = await Promise.all(
      rawItems.map(async (item) => {
        let source: InspectItem["source"] = null;
        let code: string | null = null;

        if (item.frame?.file) {
          if (item.frame.original) {
            source = {
              file: item.frame.file,
              line: item.frame.line,
              column: item.frame.col,
            };
            code = await api.sourceResolver.readSourceFragment(
              source,
              params.contextLines
            );
          } else if (params.resolveSourceMaps) {
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

    const deduped = filterInspectItems(items);
    const totalItems = deduped.length;
    const truncated = deduped.slice(0, params.maxItems);
    const hiddenCount = totalItems - truncated.length;

    return {
      x: params.x,
      y: params.y,
      items: truncated,
      ...(hiddenCount > 0
        ? {
            truncated: true,
            hiddenCount,
            hint: `${hiddenCount} more parent components hidden (framework/navigation wrappers). Pass maxItems=${Math.min(totalItems, params.maxItems + 35)} to see more.`,
          }
        : {}),
    };
  },
};
