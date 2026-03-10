import { z } from "zod";
import type { ToolDefinition } from "@radon-lite/registry";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";
import { COMPONENT_TREE_SCRIPT } from "../../utils/debugger/scripts/component-tree";

interface RawEntry {
  id: number;
  name: string;
  rect: { x: number; y: number; w: number; h: number } | null;
  parentIdx: number;
  testID?: string;
  accLabel?: string;
  text?: string;
}

interface RawResult {
  screenW: number;
  screenH: number;
  components: RawEntry[];
  error?: string;
}

function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return (
    Math.abs(a.x - b.x) < 4 &&
    Math.abs(a.y - b.y) < 4 &&
    Math.abs(a.w - b.w) < 4 &&
    Math.abs(a.h - b.h) < 4
  );
}

function buildTextTree(data: RawResult): string {
  const { screenW, screenH, components } = data;

  if (components.length === 0) {
    return "No visible components found on screen.";
  }

  // Collapse parent→child when both have the same name and nearly identical rects
  const removed = new Set<number>();
  for (const c of components) {
    if (removed.has(c.id)) continue;
    const parent = c.parentIdx >= 0 ? components[c.parentIdx] : null;
    if (
      parent &&
      !removed.has(parent.id) &&
      parent.name === c.name &&
      parent.rect &&
      c.rect &&
      rectsOverlap(parent.rect, c.rect)
    ) {
      removed.add(c.id);
    }
  }

  const childrenOf = new Map<number, number[]>();
  const roots: number[] = [];
  for (const c of components) {
    if (removed.has(c.id)) {
      // Reparent children of the removed node to its parent
      continue;
    }
    // Walk up to find closest non-removed ancestor
    let effectiveParent = c.parentIdx;
    while (effectiveParent >= 0 && removed.has(effectiveParent)) {
      effectiveParent = components[effectiveParent].parentIdx;
    }
    if (effectiveParent === -1) {
      roots.push(c.id);
    } else {
      let list = childrenOf.get(effectiveParent);
      if (!list) {
        list = [];
        childrenOf.set(effectiveParent, list);
      }
      list.push(c.id);
    }
  }

  const canNormalize = screenW > 0 && screenH > 0;
  const lines: string[] = [];

  if (canNormalize) {
    lines.push(`Screen: ${screenW}x${screenH}`);
    lines.push("");
  }

  function renderNode(id: number, depth: number) {
    const c = components[id];
    if (!c) return;

    const indent = "  ".repeat(depth);
    let label = c.name;

    const displayText = c.text ?? c.accLabel;
    if (displayText) {
      label += ` "${displayText}"`;
    }

    if (c.testID) {
      label += ` [testID=${c.testID}]`;
    }

    if (c.rect && canNormalize) {
      const tapX = ((c.rect.x + c.rect.w / 2) / screenW).toFixed(2);
      const tapY = ((c.rect.y + c.rect.h / 2) / screenH).toFixed(2);
      label += ` (tap: ${tapX},${tapY})`;
    }

    lines.push(indent + label);

    const children = childrenOf.get(id);
    if (children) {
      let prevSibling: RawEntry | null = null;
      for (const childId of children) {
        const child = components[childId];
        if (
          prevSibling &&
          child.name === prevSibling.name &&
          child.rect &&
          prevSibling.rect &&
          rectsOverlap(child.rect, prevSibling.rect)
        ) {
          continue;
        }
        renderNode(childId, depth + 1);
        prevSibling = child;
      }
    }
  }

  for (const rootId of roots) {
    renderNode(rootId, 0);
  }

  return lines.join("\n");
}

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
});

export const debuggerComponentTreeTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  string
> = {
  id: "debugger-component-tree",
  description: `Describe the current screen of a running React Native app as a text tree.
Each visible component is listed with its name, text content, and normalized
tap coordinates in [0,1] space (same coordinate space as the tap/swipe tools).

Use this to understand what is on screen and to find tap targets:
  1. Call this tool to get the component tree.
  2. Find the desired element by name, text, testID, or accessibilityLabel.
  3. Use the (tap: x,y) coordinates directly with the tap tool.

Call again after navigation or state changes since positions may shift.`,
  zodSchema,
  services: (params) => ({
    debugger: `JsRuntimeDebugger:${params.port}`,
  }),
  async execute(services) {
    const api = services.debugger as JsRuntimeDebuggerApi;
    const raw = await api.cdp.evaluate(COMPONENT_TREE_SCRIPT);

    if (typeof raw !== "string") {
      return "Error: no result from component tree script";
    }

    const parsed: RawResult = JSON.parse(raw);
    if (parsed.error) {
      return `Error: ${parsed.error}`;
    }

    return buildTextTree(parsed);
  },
};
