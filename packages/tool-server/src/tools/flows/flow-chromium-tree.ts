import type { DeviceInfo, Registry } from "@argent/registry";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { describeChromium, type ChromiumWalkLimits } from "../describe/platforms/chromium";
import { flattenHoisting, type FlatNode } from "./flow-tree-flatten";
import { nodeText } from "../../utils/ui-tree-match";
import {
  parseDescribeResult,
  type DescribeNode,
  type DescribeTreeData,
} from "../describe/contract";

/**
 * Flow-owned adaptation of the Chromium describe tree — the counterpart to
 * `flow-ios-tree.ts` / `flow-android-tree.ts` on the native platforms.
 *
 * The CDP DOM walker already returns a `DescribeNode` tree with full selector
 * coverage (testids, ARIA labels, visible text), so unlike iOS/Android there is
 * no richer source to query. What the raw tree lacks is the flow contract the
 * other adapters provide: the flat-leaves-under-one-root shape and, above all,
 * `subtreeText` hoisting — without it a `text` assert against a container
 * (`{ in: { identifier: "log-box" }, contains: ... }`) reads the container's
 * own (empty) text instead of the lines it visibly wraps.
 */

/**
 * Project a describe node for the shared flatten (see `flow-tree-flatten`). A
 * node is emitted as a leaf when a selector could address it — an identifier
 * (DOM id / testid), a label (ARIA), visible text, or a clickable control —
 * and it has an on-screen frame; an identified node — or a password field —
 * shields its text so hoisting scopes to the nearest identified ancestor.
 */
function projectChromiumNode(node: DescribeNode): FlatNode<DescribeNode> {
  // The walker already pruned hidden subtrees; frames of off-viewport elements
  // clamp to zero area, which is the "no on-screen frame" signal here.
  const onScreen = node.frame.width > 0 && node.frame.height > 0;
  const addressable = Boolean(node.identifier || node.label || node.value || node.clickable);

  const leaf: DescribeNode | null =
    onScreen && addressable ? { ...node, children: [] } : null;

  return {
    skip: false,
    children: node.children,
    // Text hoists only from on-screen nodes — otherwise a text assert against
    // an ancestor would pass on content the screen doesn't show. A password
    // field's text never bubbles up (the walker already withholds its value).
    ownText: onScreen && !node.password ? nodeText(node) : "",
    leaf,
    shield: Boolean(node.identifier) || node.password === true,
  };
}

/**
 * Flatten a Chromium describe tree into the flat-leaves-under-one-root shape
 * the other flow adapters emit, hoisting descendant text onto container leaves.
 * Pure DOM scaffolding (anonymous divs with nothing a selector could address)
 * is dropped while its addressable descendants are preserved.
 */
export function adaptChromiumTreeForFlows(tree: DescribeNode): DescribeNode {
  const children: DescribeNode[] = [];
  flattenHoisting(tree, projectChromiumNode, children);
  return parseDescribeResult({
    role: "Screen",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children,
  });
}

// Flows keep far more of the DOM than the agent-facing describe (asserts need
// every text node, and flattening collapses wrappers anyway), so raise both
// walker caps — the node cap mirrors Android's FLOW_MAX_NODES, the depth cap
// stays a backstop against pathological nesting.
const FLOW_WALK_LIMITS: ChromiumWalkLimits = { maxDepth: 96, maxNodes: 12_000 };

/**
 * Fetch the CDP DOM walker's tree with flow-sized limits and adapt it into the
 * flow contract — the chromium counterpart to `queryFullHierarchyTree` (iOS)
 * and `queryAndroidFullHierarchy` (Android). Unlike those there is no richer
 * source to fall back from, so this never returns null.
 */
export async function queryChromiumTree(
  registry: Registry,
  device: DeviceInfo
): Promise<DescribeTreeData> {
  const ref = chromiumCdpRef(device);
  const api = await registry.resolveService<ChromiumCdpApi>(ref.urn, ref.options);
  const data = await describeChromium(api, FLOW_WALK_LIMITS);
  return { tree: adaptChromiumTreeForFlows(data.tree), source: data.source };
}
