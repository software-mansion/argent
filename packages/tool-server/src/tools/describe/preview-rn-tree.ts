import * as crypto from "node:crypto";
import type { Registry } from "@argent/registry";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";
import { makeComponentTreeScript } from "../../utils/debugger/scripts/component-tree";
import type { RawResult } from "../debugger/debugger-component-tree";
import { type DescribeNode, type DescribeResult, parseDescribeResult } from "./contract";

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function roundNormalized(v: number): number {
  return Math.round(v * 1e12) / 1e12;
}

/**
 * Preview-only element tree for React Native apps.
 *
 * Walks the React fiber tree with the SAME inner logic the
 * `debugger-component-tree` tool uses (`makeComponentTreeScript` over the JS
 * runtime debugger) but WITHOUT the agent-readability pruning that tool layers
 * on top — so the preview UI can anchor a variant card / comment spotlight to
 * the *actual* element, including non-accessibility container views, instead
 * of the coarse interactive-only subset the iOS ax-service exposes.
 *
 * `describe` tool behaviour is intentionally NOT touched: this is a separate
 * path used only by `GET /preview/describe`. Returns `null` whenever a RN JS
 * runtime debugger is not reachable (the caller then falls back to the regular
 * `describe` tool); never throws into the HTTP layer.
 */
export async function buildRnPreviewTree(
  registry: Registry,
  udid: string,
  port = 8081
): Promise<DescribeResult | null> {
  let api: JsRuntimeDebuggerApi;
  try {
    api = await registry.resolveService<JsRuntimeDebuggerApi>(`JsRuntimeDebugger:${port}:${udid}`);
  } catch {
    return null; // Metro / RN debugger not reachable → caller falls back
  }

  let parsed: RawResult;
  try {
    const requestId = crypto.randomUUID();
    const script = makeComponentTreeScript({ includeSkipped: false, requestId });
    const response = await api.cdp.evaluateWithBinding(script, requestId, {
      timeout: 15_000,
    });
    if (typeof response.result !== "string") return null;
    parsed = JSON.parse(response.result) as RawResult;
  } catch {
    return null;
  }
  if (parsed.error || !Array.isArray(parsed.components)) return null;
  const sw = parsed.screenW;
  const sh = parsed.screenH;
  if (!(sw > 0) || !(sh > 0)) return null;

  // One DescribeNode per measured fiber (rect present, positive on-screen
  // area). Nesting is preserved via parentIdx so the UI's smallest-containing
  // matchers (vpMatchNode / vpNodeAtPoint) still resolve precisely.
  const nodeByIdx = new Map<number, DescribeNode>();
  const order: number[] = [];
  parsed.components.forEach((e, idx) => {
    const r = e.rect;
    if (!r) return;
    const x1 = clamp01(r.x / sw);
    const y1 = clamp01(r.y / sh);
    const x2 = clamp01((r.x + r.w) / sw);
    const y2 = clamp01((r.y + r.h) / sh);
    const width = x2 - x1;
    const height = y2 - y1;
    if (width <= 0 || height <= 0) return;
    const node: DescribeNode = {
      role: e.name || "View",
      frame: {
        x: roundNormalized(x1),
        y: roundNormalized(y1),
        width: roundNormalized(width),
        height: roundNormalized(height),
      },
      children: [],
    };
    if (e.accLabel) node.label = e.accLabel;
    if (e.testID) node.identifier = e.testID;
    if (e.text) node.value = e.text;
    nodeByIdx.set(idx, node);
    order.push(idx);
  });

  // No fiber yielded a usable on-screen rect (e.g. RN measurement returned
  // nothing, or every node collapsed to zero area). Returning an empty tree
  // would be a regression vs the ax-service fallback, so bail and let the
  // caller use the regular `describe` tool instead.
  if (order.length === 0) return null;

  const root: DescribeNode = {
    role: "AXGroup",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children: [],
  };

  // Nearest ancestor that survived (climb parentIdx through dropped wrappers
  // so a skipped/no-rect parent doesn't flatten its descendants to the root).
  const effectiveParent = (idx: number): DescribeNode => {
    let p = parsed.components[idx]?.parentIdx ?? -1;
    const guard = new Set<number>();
    while (p >= 0 && !nodeByIdx.has(p) && !guard.has(p)) {
      guard.add(p);
      p = parsed.components[p]?.parentIdx ?? -1;
    }
    return p >= 0 ? (nodeByIdx.get(p) ?? root) : root;
  };

  for (const idx of order) {
    effectiveParent(idx).children.push(nodeByIdx.get(idx)!);
  }

  return { tree: parseDescribeResult(root), source: "native-devtools" };
}
