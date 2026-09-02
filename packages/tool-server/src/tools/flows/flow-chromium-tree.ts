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
 * `flow-ios-tree.ts` / `flow-android-tree.ts`.
 *
 * The CDP DOM walker's tree already has full selector coverage, so unlike
 * iOS/Android there is no richer source to query. What it lacks is the flow
 * contract: flat leaves under one root and `subtreeText` hoisting — without the
 * hoist a `text` assert against a container (`{ in: { id: "log-box" },
 * contains: ... }`) reads the container's own (empty) text instead of the lines
 * it visibly wraps.
 */

/**
 * Project a describe node for the shared flatten (see `flow-tree-flatten`).
 * Emitted as a leaf when it has an on-screen frame and something a selector
 * could address — identifier, label, text, clickable — or input focus, which
 * the type directive's focus wait reads. An identifier or a password shields,
 * scoping hoisted text to the nearest identified ancestor.
 */
function projectChromiumNode(node: DescribeNode): FlatNode<DescribeNode> {
  // The walker already pruned hidden subtrees; an off-viewport frame clamps to
  // zero area, which is the "no on-screen frame" signal here.
  const onScreen = node.frame.width > 0 && node.frame.height > 0;
  const addressable = Boolean(
    node.identifier || node.label || node.value || node.clickable || node.focused
  );

  let leaf: DescribeNode | null = null;
  if (onScreen && addressable) {
    leaf = { ...node, children: [] };
    // The walker already withholds a password's value, but a failing text
    // assert echoes a leaf's text verbatim; `[password]` mirrors the Android
    // adapter.
    if (node.password) {
      leaf.label = "[password]";
      delete leaf.value;
    }
  }

  return {
    skip: false,
    children: node.children,
    // Off-screen text must not hoist, or a text assert against an ancestor
    // would pass on content the screen doesn't show. A password's text never
    // bubbles up.
    ownText: onScreen && !node.password ? nodeText(node) : "",
    leaf,
    shield: Boolean(node.identifier) || node.password === true,
  };
}

/**
 * Flatten a Chromium describe tree into the flat-leaves-under-one-root shape
 * the other flow adapters emit, hoisting descendant text onto container leaves.
 * Unaddressable scaffolding is dropped, its addressable descendants kept.
 */
export function adaptChromiumTreeForFlows(tree: DescribeNode): DescribeNode {
  const children: DescribeNode[] = [];
  // Children only, never the root — matching the iOS/Android adapters. The
  // walker reads id/data-testid off <html> too, so projecting the root would
  // turn a page whose root carries one into a full-screen leaf that shields and
  // aggregates the whole page's text, letting a broad assert pass spuriously.
  for (const child of tree.children) {
    flattenHoisting(child, projectChromiumNode, children);
  }
  return parseDescribeResult({
    role: "Screen",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children,
  });
}

// Raised over the walker's describe defaults (60 / 5000): asserts need every
// text node and the flatten collapses wrappers anyway. The node cap mirrors
// Android's FLOW_MAX_NODES.
const FLOW_WALK_LIMITS: ChromiumWalkLimits = { maxDepth: 96, maxNodes: 12_000 };

/**
 * Fetch the CDP DOM walker's tree with flow-sized limits and adapt it into the
 * flow contract — the chromium counterpart to `queryFullHierarchyTree` (iOS)
 * and `queryAndroidFullHierarchy` (Android).
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
