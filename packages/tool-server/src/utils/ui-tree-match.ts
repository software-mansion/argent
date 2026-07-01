import { z } from "zod";
import type { DeviceInfo, Registry } from "@argent/registry";
import type { DescribeFrame, DescribeNode, DescribeTreeData } from "../tools/describe/contract";
import { describeIos } from "../tools/describe/platforms/ios";
import { describeAndroid } from "../tools/describe/platforms/android";
import { describeChromium } from "../tools/describe/platforms/chromium";
import { chromiumCdpRef, type ChromiumCdpApi } from "../blueprints/chromium-cdp";

/**
 * Shared accessibility/DOM-tree matching, extracted from `await-ui-element` so
 * the flow directives (`tap`, `type`, `assert`) and the recorder's reverse
 * lookup consume the same selector semantics the wait engine uses.
 */

// A selector locates a node in the tree returned by `describe`. Every provided
// field must match (logical AND); matching is a case-insensitive substring test
// so callers don't need the exact label.
export const selectorSchema = z
  .object({
    text: z
      .string()
      .min(1)
      .optional()
      .describe("Case-insensitive substring of the element's visible label or value."),
    identifier: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Case-insensitive substring of the element's identifier (accessibilityIdentifier / resource-id / testid)."
      ),
    role: z
      .string()
      .min(1)
      .optional()
      .describe("Case-insensitive substring of the element's role (e.g. AXButton, button, TextView)."),
  })
  .refine((s) => Boolean(s.text || s.identifier || s.role), {
    message: "selector needs at least one of text, identifier, or role",
  });

export type Selector = z.infer<typeof selectorSchema>;

export type WaitCondition = "exists" | "visible" | "hidden" | "text";

// How a `text` condition compares the located element's text to the expected
// string: `contains` (default) is a case-insensitive substring; `equals` is a
// case-insensitive full-string match (so "1" no longer satisfies "10"). Both
// are offered so a caller can assert "shows this somewhere" or "shows exactly
// this" interchangeably.
export type TextMatchMode = "contains" | "equals";

// ── Tree matching ──────────────────────────────────────────────────────────

export function nodeText(node: DescribeNode): string {
  return [node.label, node.value].filter(Boolean).join(" ");
}

// Text used to evaluate a `text` condition. Prefers `subtreeText` — the text
// hoisted from descendants by the flow adapters — so a `text` check against a
// testID container reads the text it visibly wraps (e.g. a counter whose number
// is a child node), not the container's own (empty) label. Falls back to the
// node's own text when no descendant text was hoisted (every non-flow tree, and
// any leaf that already carries its own text). Selector matching stays on
// `nodeText` so `tap`/`{ text }` targeting is unaffected.
export function assertText(node: DescribeNode): string {
  return node.subtreeText ?? nodeText(node);
}

export function includesCI(haystack: string | undefined, needle: string): boolean {
  return Boolean(haystack) && haystack!.toLowerCase().includes(needle.toLowerCase());
}

export function equalsCI(actual: string | undefined, expected: string): boolean {
  return (actual ?? "").toLowerCase() === expected.toLowerCase();
}

/** Compare an element's text to the expected string under the chosen mode. */
export function textMatches(
  actual: string | undefined,
  expected: string,
  mode: TextMatchMode
): boolean {
  return mode === "equals" ? equalsCI(actual, expected) : includesCI(actual, expected);
}

export function matchNode(node: DescribeNode, selector: Selector): boolean {
  if (selector.text !== undefined) {
    if (!includesCI(node.label, selector.text) && !includesCI(node.value, selector.text)) {
      return false;
    }
  }
  if (selector.identifier !== undefined && !includesCI(node.identifier, selector.identifier)) {
    return false;
  }
  if (selector.role !== undefined && !includesCI(node.role, selector.role)) {
    return false;
  }
  return true;
}

function collectMatches(node: DescribeNode, selector: Selector, acc: DescribeNode[]): void {
  if (matchNode(node, selector)) acc.push(node);
  for (const child of node.children) collectMatches(child, selector, acc);
}

// Every node matching the selector in the subtree, EXCLUDING `root` itself — the
// synthetic full-screen container describe puts at the head of the tree. See the
// long-form rationale in await-ui-element: matching the root would let a broad
// role selector satisfy `visible`/`exists` on any screen.
export function findAll(root: DescribeNode, selector: Selector): DescribeNode[] {
  const acc: DescribeNode[] = [];
  for (const child of root.children) collectMatches(child, selector, acc);
  return acc;
}

// describe prunes off-screen / zero-size nodes, so a non-zero frame area is a
// cheap, reliable proxy for "visible".
export function isVisible(node: DescribeNode): boolean {
  return node.frame.width > 0 && node.frame.height > 0;
}

// The element a reader "sees first": smallest (y, then x), matching how
// format-tree renders iOS leaves in reading order. Returns undefined for [].
export function firstInReadingOrder(matches: DescribeNode[]): DescribeNode | undefined {
  let best: DescribeNode | undefined;
  for (const n of matches) {
    if (
      best === undefined ||
      n.frame.y < best.frame.y ||
      (n.frame.y === best.frame.y && n.frame.x < best.frame.x)
    ) {
      best = n;
    }
  }
  return best;
}

// Evaluate a wait/assert condition over ALL elements matching a selector.
// `visible` holds if ANY match is on-screen; `hidden` only if NONE is; `text`
// inspects the first match in reading order.
export function evaluateCondition(
  condition: WaitCondition,
  expectedText: string | undefined,
  matches: DescribeNode[],
  textMatch: TextMatchMode = "contains"
): boolean {
  switch (condition) {
    case "exists":
      return matches.length > 0;
    case "visible":
      return matches.some(isVisible);
    case "hidden":
      return !matches.some(isVisible);
    case "text": {
      const first = firstInReadingOrder(matches);
      return (
        first !== undefined &&
        expectedText !== undefined &&
        textMatches(assertText(first), expectedText, textMatch)
      );
    }
    default:
      return false;
  }
}

// ── Settle detection ────────────────────────────────────────────────────────

/**
 * A stable fingerprint of the tree's visible structure — every node's role,
 * rounded frame, and text/identifier. Two consecutive identical fingerprints
 * mean the UI has settled (a scroll's momentum has stopped, an animation has
 * finished): the flow runner uses this to wait out a fling before reading or
 * tapping, so a tap can't land mid-deceleration (where a scroll view would
 * swallow it to halt the scroll) and a resolved frame can't be stale by the time
 * we act on it. Frames are rounded to 1e-3 so sub-pixel jitter does not read as
 * motion.
 */
export function treeFingerprint(root: DescribeNode): string {
  const parts: string[] = [];
  const round = (n: number): number => Math.round(n * 1000) / 1000;
  const walk = (node: DescribeNode): void => {
    const f = node.frame;
    parts.push(
      `${node.role}|${round(f.x)},${round(f.y)},${round(f.width)},${round(f.height)}` +
        `|${node.label ?? ""}|${node.value ?? ""}|${node.identifier ?? ""}`
    );
    for (const child of node.children) walk(child);
  };
  walk(root);
  return parts.join("\n");
}

// ── Reverse lookup & selector → frame ──────────────────────────────────────

function frameContains(frame: DescribeFrame, x: number, y: number): boolean {
  return (
    x >= frame.x && x <= frame.x + frame.width && y >= frame.y && y <= frame.y + frame.height
  );
}

function frameArea(frame: DescribeFrame): number {
  return frame.width * frame.height;
}

/**
 * Reverse lookup for recording: the smallest visible node whose frame contains
 * the tapped point. "Smallest" picks the most specific element (a button over
 * its container). Skips the synthetic root. Returns undefined if nothing
 * sensible is under the point.
 */
export function nodeAtPoint(
  root: DescribeNode,
  point: { x: number; y: number }
): DescribeNode | undefined {
  let best: DescribeNode | undefined;
  const walk = (node: DescribeNode): void => {
    if (isVisible(node) && frameContains(node.frame, point.x, point.y)) {
      if (best === undefined || frameArea(node.frame) < frameArea(best.frame)) best = node;
    }
    for (const child of node.children) walk(child);
  };
  for (const child of root.children) walk(child);
  return best;
}

/**
 * Resolve a selector to the on-screen frame of its first visible match in
 * reading order — the element a `tap`/`type` action should target. Returns
 * undefined when no visible element matches.
 */
export function selectorToFrame(root: DescribeNode, selector: Selector): DescribeFrame | undefined {
  const visible = findAll(root, selector).filter(isVisible);
  return firstInReadingOrder(visible)?.frame;
}

/**
 * Derive the most stable selector that identifies a node, used by the recorder
 * to turn a tapped element into a `tap: { selector }` step. Prefers identifier,
 * then text; falls back to a specific (non-generic) role. Returns null when the
 * node has nothing stable to match on — the caller then keeps coordinates.
 */
const GENERIC_ROLES = new Set([
  "axgroup",
  "group",
  "view",
  "other",
  "axother",
  "none",
  "viewgroup",
  "android.view.view",
  "android.view.viewgroup",
]);

export function deriveSelector(node: DescribeNode): Selector | null {
  if (node.identifier && node.identifier.trim()) return { identifier: node.identifier };
  const text = nodeText(node).trim();
  if (text) return { text };
  if (node.role && !GENERIC_ROLES.has(node.role.toLowerCase())) return { role: node.role };
  return null;
}

// ── Tree fetch ─────────────────────────────────────────────────────────────

/**
 * Fetch the describe tree for a device, resolving services through the registry
 * (the chromium CDP session is the only one that flows in as a service). iOS /
 * Android describe resolve their own services internally. Vega is not supported
 * by the matching directives yet.
 */
export async function fetchTree(
  registry: Registry,
  device: DeviceInfo,
  opts: { bundleId?: string } = {}
): Promise<DescribeTreeData> {
  if (device.platform === "ios") {
    return describeIos(registry, device, { bundleId: opts.bundleId });
  }
  if (device.platform === "android") {
    return describeAndroid(registry, device.id);
  }
  if (device.platform === "chromium") {
    const ref = chromiumCdpRef(device);
    const api = await registry.resolveService<ChromiumCdpApi>(ref.urn, ref.options);
    return describeChromium(api);
  }
  throw new Error(`ui-tree matching is not supported on platform "${device.platform}"`);
}
