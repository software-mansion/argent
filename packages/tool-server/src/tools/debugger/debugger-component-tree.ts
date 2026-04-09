import { z } from "zod";
import * as crypto from "node:crypto";
import type { ToolDefinition } from "@argent/registry";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";
import { makeComponentTreeScript } from "../../utils/debugger/scripts/component-tree";

export interface RawEntry {
  id: number;
  name: string;
  rect: { x: number; y: number; w: number; h: number } | null;
  parentIdx: number;
  testID?: string;
  accLabel?: string;
  text?: string;
}

export interface RawResult {
  screenW: number;
  screenH: number;
  components: RawEntry[];
  error?: string;
  totalFibers?: number;
  skippedCounts?: Record<string, number>;
}

function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number }
): boolean {
  return (
    Math.abs(a.x - b.x) < 8 &&
    Math.abs(a.y - b.y) < 8 &&
    Math.abs(a.w - b.w) < 8 &&
    Math.abs(a.h - b.h) < 8
  );
}

export function buildTextTree(
  data: RawResult,
  opts: { onScreenOnly: boolean; maxNodes?: number; includeSkipped?: boolean }
): string {
  const { screenW, screenH, components } = data;

  if (components.length === 0) {
    return "No visible components found on screen.";
  }

  const canNormalize = screenW > 0 && screenH > 0;
  const removed = new Set<number>();

  const filterStats = {
    sameNameDedup: { count: 0, names: new Map<string, number>() },
    offScreen: { count: 0 },
    sameTestID: { count: 0 },
    fullScreenWrapper: { count: 0 },
    ancestorText: { count: 0 },
    contentFreeWrapper: { count: 0 },
    soleChildLeaf: { count: 0 },
  };

  // Collapse parent→child when both have the same name and nearly identical rects.
  // Walk up through already-removed parents so chains of 3+ (e.g. ScrollView×3) fully collapse.
  for (const c of components) {
    if (removed.has(c.id)) continue;
    let effectiveParentIdx = c.parentIdx;
    while (effectiveParentIdx >= 0 && removed.has(effectiveParentIdx)) {
      effectiveParentIdx = components[effectiveParentIdx].parentIdx;
    }
    const parent = effectiveParentIdx >= 0 ? components[effectiveParentIdx] : null;
    if (
      parent &&
      parent.name === c.name &&
      parent.rect &&
      c.rect &&
      rectsOverlap(parent.rect, c.rect)
    ) {
      removed.add(c.id);
      filterStats.sameNameDedup.count++;
      filterStats.sameNameDedup.names.set(
        c.name,
        (filterStats.sameNameDedup.names.get(c.name) ?? 0) + 1
      );
    }
  }

  // Remove components that are entirely off-screen and prune their entire subtree.
  // This catches off-canvas navigation stacks (drawer, hidden tabs) whose children
  // would otherwise survive because they lack rects.
  if (canNormalize && opts.onScreenOnly) {
    // Build a quick parent→children index for subtree pruning
    const tempChildren = new Map<number, number[]>();
    for (const c of components) {
      if (c.parentIdx >= 0) {
        let list = tempChildren.get(c.parentIdx);
        if (!list) {
          list = [];
          tempChildren.set(c.parentIdx, list);
        }
        list.push(c.id);
      }
    }

    function removeSubtree(id: number) {
      removed.add(id);
      filterStats.offScreen.count++;
      const ch = tempChildren.get(id);
      if (ch) for (const cid of ch) removeSubtree(cid);
    }

    for (const c of components) {
      if (removed.has(c.id) || !c.rect) continue;
      const centerY = c.rect.y + c.rect.h / 2;
      const centerX = c.rect.x + c.rect.w / 2;
      if (
        centerY < -screenH * 0.1 ||
        centerY > screenH * 1.05 ||
        centerX < -screenW * 0.05 ||
        centerX > screenW * 1.05
      ) {
        removeSubtree(c.id);
      }
    }

    // Also remove rectless components whose entire ancestor chain is removed.
    // These are children of off-screen containers that have no rect themselves.
    for (const c of components) {
      if (removed.has(c.id) || c.rect) continue;
      let ancestor = c.parentIdx;
      while (ancestor >= 0 && !components[ancestor].rect) {
        if (removed.has(ancestor)) break;
        ancestor = components[ancestor].parentIdx;
      }
      if (ancestor >= 0 && removed.has(ancestor)) {
        removed.add(c.id);
        filterStats.offScreen.count++;
      }
    }
  }

  // Collapse same-testID parent→child chains caused by prop drilling through HOC layers.
  // e.g. ScreenWrapper [testID=X] → ScreenWrapperContainer [testID=X] → View [testID=X]
  // Keep only the topmost component carrying each testID.
  for (const c of components) {
    if (removed.has(c.id) || !c.testID) continue;
    let ancestor = c.parentIdx;
    while (ancestor >= 0) {
      const a = components[ancestor];
      if (!removed.has(a.id) && a.testID === c.testID) {
        removed.add(c.id);
        filterStats.sameTestID.count++;
        break;
      }
      ancestor = a.parentIdx;
    }
  }

  // Collapse full-screen transparent wrappers — components that span the entire screen
  // with no meaningful content (no text, testID, or accessibilityLabel) are pure layout
  // infrastructure and add nothing but indentation noise.
  if (canNormalize) {
    for (const c of components) {
      if (removed.has(c.id) || c.text || c.testID || c.accLabel) continue;
      if (!c.rect) continue;
      if (
        Math.abs(c.rect.x) <= 5 &&
        Math.abs(c.rect.y) <= 5 &&
        Math.abs(c.rect.w - screenW) <= 5 &&
        Math.abs(c.rect.h - screenH) <= 5
      ) {
        removed.add(c.id);
        filterStats.fullScreenWrapper.count++;
      }
    }
  }

  // Remove components whose display text (text or accLabel) is already present
  // in an ancestor's display text. Handles chains like:
  //   Link "Browse topic X" → Button "Browse topic X" → Text "X"
  // where children repeat or subset the parent's label. Up to 6 levels deep.
  for (const c of components) {
    const cDisplay = c.text ?? c.accLabel;
    if (removed.has(c.id) || !cDisplay || c.testID) continue;
    let ancestor = c.parentIdx;
    let depth = 0;
    while (ancestor >= 0 && depth < 6) {
      if (removed.has(ancestor)) {
        ancestor = components[ancestor].parentIdx;
        continue;
      }
      const a = components[ancestor];
      const aDisplay = a.text ?? a.accLabel;
      if (aDisplay && aDisplay.length >= cDisplay.length && aDisplay.includes(cDisplay)) {
        removed.add(c.id);
        filterStats.ancestorText.count++;
        break;
      }
      ancestor = a.parentIdx;
      depth++;
    }
  }

  // Collapse content-free wrappers with same rect as their effective parent.
  // A component that has no text, testID, or accLabel and overlaps its parent's
  // rect is a layout wrapper that adds indentation noise without navigation value.
  for (const c of components) {
    if (removed.has(c.id) || c.text || c.testID || c.accLabel) continue;
    if (!c.rect) continue;
    let effectiveParentIdx = c.parentIdx;
    while (effectiveParentIdx >= 0 && removed.has(effectiveParentIdx)) {
      effectiveParentIdx = components[effectiveParentIdx].parentIdx;
    }
    const parent = effectiveParentIdx >= 0 ? components[effectiveParentIdx] : null;
    if (parent && parent.rect && rectsOverlap(parent.rect, c.rect)) {
      removed.add(c.id);
      filterStats.contentFreeWrapper.count++;
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

  // Remove single-child leaf nodes that add no navigation value: the component
  // has no testID, is the sole child of a parent that already has text/testID,
  // and has no children of its own. Catches patterns like:
  //   WebOnlyInlineLinkText "Rachel Maddow" → UITextView "View profile"
  //   ShareMenuButton [testID=postShareBtn] → Trigger "Open share menu"
  {
    const toRemove: number[] = [];
    for (const [parentId, children] of childrenOf) {
      if (children.length !== 1) continue;
      const childId = children[0];
      const child = components[childId];
      const parent = components[parentId];
      if (child.testID) continue;
      if (!parent.text && !parent.accLabel && !parent.testID) continue;
      if (childrenOf.has(childId)) continue; // not a leaf
      toRemove.push(childId);
    }
    if (toRemove.length > 0) {
      for (const id of toRemove) {
        removed.add(id);
        filterStats.soleChildLeaf.count++;
      }
      // Rebuild childrenOf after removals
      childrenOf.clear();
      roots.length = 0;
      for (const c of components) {
        if (removed.has(c.id)) continue;
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
    }
  }

  // Count visible nodes and identify collapsible single-child wrapper chains
  // for maxNodes truncation.
  function countNodes(id: number): number {
    let n = 1;
    const ch = childrenOf.get(id);
    if (ch) for (const cid of ch) n += countNodes(cid);
    return n;
  }

  let totalVisible = 0;
  for (const rid of roots) totalVisible += countNodes(rid);

  // A node is a "content-free single-child wrapper" if it has exactly 1 child
  // and carries no text, testID, or accLabel.
  function isWrapper(id: number): boolean {
    const c = components[id];
    const ch = childrenOf.get(id);
    if (!ch || ch.length !== 1) return false;
    return !c.text && !c.testID && !c.accLabel;
  }

  // collapsed maps a node id → number of wrappers collapsed below it.
  // When set, the node's single-child chain is replaced with "... via N wrappers".
  const collapsed = new Map<number, number>();
  let collapsedCount = 0;

  if (opts.maxNodes !== undefined && totalVisible > opts.maxNodes) {
    // Find all maximal single-child wrapper chains: sequences of consecutive
    // wrapper nodes (each with exactly 1 child and no content).
    type Chain = { startId: number; length: number };
    const chains: Chain[] = [];

    function findChains(id: number) {
      if (isWrapper(id)) {
        let len = 0;
        let cur = id;
        while (isWrapper(cur)) {
          len++;
          cur = childrenOf.get(cur)![0];
        }
        if (len >= 2) {
          chains.push({ startId: id, length: len });
        }
      }
      const ch = childrenOf.get(id);
      if (ch) {
        for (const cid of ch) {
          if (!collapsed.has(cid)) findChains(cid);
        }
      }
    }

    for (const rid of roots) findChains(rid);

    // Sort by chain length descending — collapse longest chains first
    chains.sort((a, b) => b.length - a.length);

    const excess = totalVisible - opts.maxNodes;
    for (const chain of chains) {
      if (collapsedCount >= excess) break;
      // Collapsing a chain of N wrappers saves (N - 1) nodes
      // (we keep the chain start, replace middle with summary, keep the end)
      // Actually we replace all N wrappers with 1 summary line, saving N - 1.
      collapsed.set(chain.startId, chain.length);
      collapsedCount += chain.length - 1;
    }
  }

  const lines: string[] = [];

  if (canNormalize) {
    lines.push(`Screen: ${screenW}x${screenH}`);
    lines.push("");
  }

  function formatLabel(c: RawEntry): string {
    let label = c.name;
    const displayText = c.text ?? c.accLabel;
    if (displayText) label += ` "${displayText}"`;
    if (c.testID) label += ` [testID=${c.testID}]`;
    if (c.rect && canNormalize) {
      const tapX = ((c.rect.x + c.rect.w / 2) / screenW).toFixed(2);
      const tapY = ((c.rect.y + c.rect.h / 2) / screenH).toFixed(2);
      label += ` (tap: ${tapX},${tapY})`;
    }
    return label;
  }

  function renderNode(id: number, depth: number) {
    const c = components[id];
    if (!c) return;

    const chainLen = collapsed.get(id);
    if (chainLen !== undefined) {
      // Skip through the wrapper chain to find the end node
      let cur = id;
      for (let i = 0; i < chainLen; i++) {
        cur = childrenOf.get(cur)![0];
      }
      const indent = "  ".repeat(depth);
      lines.push(`${indent}${formatLabel(c)}`);
      lines.push(`${indent}  ... via ${chainLen} wrapper${chainLen > 1 ? "s" : ""}`);
      renderNode(cur, depth + 1);
      return;
    }

    lines.push("  ".repeat(depth) + formatLabel(c));

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

  if (collapsedCount > 0) {
    lines.push("");
    lines.push(
      `... ${collapsedCount} wrapper node${collapsedCount > 1 ? "s" : ""} collapsed. Call without maxNodes to see full tree.`
    );
  }

  if (opts.includeSkipped) {
    const tsTotal =
      filterStats.sameNameDedup.count +
      filterStats.offScreen.count +
      filterStats.sameTestID.count +
      filterStats.fullScreenWrapper.count +
      filterStats.ancestorText.count +
      filterStats.contentFreeWrapper.count +
      filterStats.soleChildLeaf.count;

    lines.push("");
    lines.push("--- Filtered ---");

    if (data.totalFibers !== undefined) {
      lines.push(`Total fibers walked: ${data.totalFibers}`);
    }

    if (data.skippedCounts && Object.keys(data.skippedCounts).length > 0) {
      const jsTotal = Object.values(data.skippedCounts).reduce((a, b) => a + b, 0);
      const top = Object.entries(data.skippedCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([name, count]) => `${name}: ${count}`)
        .join(", ");
      lines.push(`JS-side skipped: ${jsTotal} (${top})`);
    }

    if (tsTotal > 0) {
      lines.push(`TS-side removed: ${tsTotal}`);
      if (filterStats.sameNameDedup.count > 0) {
        const detail = Array.from(filterStats.sameNameDedup.names.entries())
          .map(([name, count]) => `${name} x${count}`)
          .join(", ");
        lines.push(`  Same-name dedup: ${filterStats.sameNameDedup.count} (${detail})`);
      }
      if (filterStats.offScreen.count > 0) {
        lines.push(`  Off-screen: ${filterStats.offScreen.count}`);
      }
      if (filterStats.fullScreenWrapper.count > 0) {
        lines.push(`  Full-screen wrapper: ${filterStats.fullScreenWrapper.count}`);
      }
      if (filterStats.sameTestID.count > 0) {
        lines.push(`  Same-testID chain: ${filterStats.sameTestID.count}`);
      }
      if (filterStats.ancestorText.count > 0) {
        lines.push(`  Ancestor text dedup: ${filterStats.ancestorText.count}`);
      }
      if (filterStats.contentFreeWrapper.count > 0) {
        lines.push(`  Content-free wrapper: ${filterStats.contentFreeWrapper.count}`);
      }
      if (filterStats.soleChildLeaf.count > 0) {
        lines.push(`  Sole-child leaf: ${filterStats.soleChildLeaf.count}`);
      }
    }
  }

  return lines.join("\n");
}

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
  onScreenOnly: z
    .boolean()
    .default(true)
    .describe(
      "When true (default), only components visible on screen are returned. " +
        "Set to false to include all mounted components including those scrolled " +
        "off-screen. Useful when you need to understand the full page structure."
    ),
  maxNodes: z.coerce
    .number()
    .optional()
    .describe(
      "Maximum total nodes to include. When exceeded, intermediate single-child " +
        "wrapper chains are collapsed to preserve both root structure and leaf elements. " +
        "Default: no limit."
    ),
  includeSkipped: z
    .boolean()
    .default(false)
    .describe(
      "When true, appends a summary of all filtered components: total fiber count, " +
        "JS-side skip counts by name, and TS-side filter pass removals. " +
        "Useful for understanding what was pruned from the tree."
    ),
});

export const debuggerComponentTreeTool: ToolDefinition<z.infer<typeof zodSchema>, string> = {
  id: "debugger-component-tree",
  description: `Fetch the current screen of a running React Native app as a compact component text tree.
Only shows on-screen components with unique positions — off-screen (scrolled) content,
full-screen transparent wrappers, and implementation-detail components are pruned.

Each visible component is listed with its name, text content, and normalized
tap coordinates in [0,1] space (fractions of the screen, not pixels—same space as tap/swipe/gesture and simulator-server touch).

This is the preferred element discovery tool for React Native apps. More information in react-native-app-workflow skill.

Workflow:
  1. Call this tool to get the component tree.
  2. Find the desired element by name, text, testID, or accessibilityLabel.
  3. Use the (tap: x,y) coordinates directly with the tap tool.

Call again after navigation or state changes since positions may shift.
Set includeSkipped=true to see a summary of all filtered components.
Use when you need tap coordinates for a React Native UI element. Returns a compact text tree with (tap: x,y) coords. Fails if Metro debugger is not connected.`,
  zodSchema,
  services: (params) => ({
    debugger: `JsRuntimeDebugger:${params.port}`,
  }),
  async execute(services, params) {
    const api = services.debugger as JsRuntimeDebuggerApi;
    const requestId = crypto.randomUUID();
    const script = makeComponentTreeScript({
      includeSkipped: params.includeSkipped,
      requestId,
    });
    const response = await api.cdp.evaluateWithBinding(script, requestId, {
      timeout: 15_000,
    });

    const raw = response.result;
    if (typeof raw !== "string") {
      return "Error: no result from component tree script";
    }

    const parsed: RawResult = JSON.parse(raw);
    if (parsed.error) {
      return `Error: ${parsed.error}`;
    }

    const tree = buildTextTree(parsed, {
      onScreenOnly: params.onScreenOnly,
      maxNodes: params.maxNodes,
      includeSkipped: params.includeSkipped,
    });

    const deviceLine = [
      `device: ${api.deviceName}`,
      `app: ${api.appName}`,
      ...(api.logicalDeviceId ? [`udid: ${api.logicalDeviceId}`] : []),
    ].join(" | ");

    return `[${deviceLine}]\n${tree}`;
  },
};
