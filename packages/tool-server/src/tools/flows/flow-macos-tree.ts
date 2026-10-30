import type { DeviceInfo, Registry } from "@argent/registry";
import {
  MACOS_JUDGING_LIMITS,
  macosTreeData,
  projectMacosDescribeTree,
  readMacosTree,
  type MacosNode,
  type MacosTreeRead,
} from "../describe/platforms/macos";
import { flattenHoisting, type FlatNode } from "./flow-tree-flatten";
import { resolveMacosApp } from "../../utils/macos-input";
import {
  parseDescribeResult,
  type DescribeNode,
  type DescribeTreeData,
} from "../describe/contract";

/**
 * Flow-owned adaptation of a native Mac app's tree, the counterpart to
 * `flow-chromium-tree.ts`: what `describe` reads, re-shaped into a flat list of
 * leaves under one root, with `subtreeText` hoisted onto containers.
 */

/**
 * A leaf when the element shows and has something a selector can address
 * (identifier, label, value, a clickable role) or input focus, which the type
 * directive's focus wait reads: the Chromium rule. `visible` is already clipped
 * by every scroll area, so the flatten's own scroll prune gets no rects.
 */
function projectMacosNode(node: MacosNode): FlatNode<MacosNode> {
  const { d } = node;
  const shows = node.visible !== null && node.leafEligible;
  // Off-screen text must not hoist, or a text check on a container would pass
  // on content the screen does not show. Neither does a password's text, nor a
  // scroll bar's position.
  const ownText = shows && !d.password ? [d.label, d.value].filter(Boolean).join(" ") : "";
  let leaf: DescribeNode | null = null;
  if (shows && (d.identifier || d.label || d.value || d.clickable || d.focused)) {
    leaf = { ...d, frame: node.visible!, children: [] };
    // A failing text check echoes a leaf's text; `[password]` mirrors the
    // Chromium and Android adapters. The value never arrives.
    if (d.password) leaf.label = "[password]";
    // Text the library collected below a web container or an identified view:
    // its descendants are not nodes here, so the flatten cannot hoist it.
    else if (node.subtreeText && node.subtreeText !== ownText) {
      leaf.subtreeText = node.subtreeText;
    }
  }
  return {
    skip: false,
    children: node.children,
    ownText,
    leaf,
    shield: Boolean(d.identifier || d.password),
  };
}

/**
 * Flatten the app's elements into leaves. With `stamp`, each element also
 * keeps the text hoisted onto its leaf, for the await tools' tree.
 */
function flattenMacosNodes(nodes: MacosNode[], stamp = false): DescribeNode[] {
  const leaves: DescribeNode[] = [];
  const stamped: Array<[MacosNode, DescribeNode]> = [];
  const project = (node: MacosNode): FlatNode<MacosNode> => {
    const view = projectMacosNode(node);
    if (stamp && view.leaf) stamped.push([node, view.leaf]);
    return view;
  };
  for (const root of nodes) flattenHoisting(root, project, leaves);
  for (const [node, leaf] of stamped) node.hoistedText = leaf.subtreeText;
  return leaves;
}

/** A library read as the flat-leaves-under-one-root shape the other flow adapters emit. */
export function adaptMacosTreeForFlows(read: MacosTreeRead): DescribeNode {
  return parseDescribeResult({
    role: "Screen",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children: flattenMacosNodes(read.nodes),
  });
}

/**
 * A read that judges the screen. Refuses when the macos-apps flag is off, and
 * when the read is known to miss content (a web view that could not be read,
 * elements that still did not answer after the re-read): a `hidden` check would
 * pass on content that is still on screen. The callers retry. A cut at the node
 * limit is only hinted, as Chromium's walk limit is.
 */
async function readForJudging(
  registry: Registry,
  device: DeviceInfo,
  toolId: string
): Promise<MacosTreeRead> {
  const api = await resolveMacosApp(registry, device, toolId);
  const read = await readMacosTree(api, MACOS_JUDGING_LIMITS);
  if (read.webErrors.length > 0) {
    throw new Error(
      `could not read the web content of ${read.bundleId}: ${read.webErrors.join("; ")}`
    );
  }
  if (read.unreachableCount > 0) {
    throw new Error(
      `the tree of ${read.bundleId} is incomplete: ${read.unreachableCount} element(s) did not ` +
        "answer (a view in the middle of an update)"
    );
  }
  return read;
}

/**
 * The tree the await tools judge on a Mac app: the `describe` tree, read as a
 * flow reads, with the flow tree's hoisted text on the same elements, so a
 * `text` check on a container passes or fails as it does in a flow.
 */
export async function describeMacosForJudging(
  registry: Registry,
  device: DeviceInfo,
  toolId: string
): Promise<DescribeTreeData> {
  const read = await readForJudging(registry, device, toolId);
  flattenMacosNodes(read.nodes, true);
  return projectMacosDescribeTree(read);
}

/** Read a Mac app's tree for a flow. */
export async function queryMacosTree(
  registry: Registry,
  device: DeviceInfo
): Promise<DescribeTreeData> {
  const read = await readForJudging(registry, device, "flow-execute");
  return macosTreeData(read, adaptMacosTreeForFlows(read));
}
