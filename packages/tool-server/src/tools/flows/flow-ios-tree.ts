/**
 * The physical-iPhone flow tree: the XCUITest runner's accessibility snapshot,
 * the same one `describe` shows on hardware, projected into the flat flow
 * contract. Simulators read the accessibility daemon instead (flow-ax-tree.ts).
 */
import type { DeviceInfo, Registry } from "@argent/registry";
import { nodeText } from "../../utils/ui-tree-match";
import { describeIosDevice } from "../describe/platforms/ios-device";
import { flattenHoisting, FlatNode } from "./flow-tree-flatten";
import { DescribeNode, DescribeTreeData, parseDescribeResult } from "../describe/contract";

function projectIosDeviceNode(node: DescribeNode): FlatNode<DescribeNode> {
  const onScreen = node.frame.width > 0 && node.frame.height > 0;
  return {
    skip: false,
    children: node.children,
    // Off-screen text must not hoist.
    ownText: onScreen ? nodeText(node) : "",
    leaf: { ...node, children: [] },
    shield: Boolean(node.identifier),
    // Scroll-clip inputs (see `flattenHoisting`), in the adapter's normalized
    // space. The runner drops only what lies outside the Application frame: a
    // row scrolled out of a nested ScrollView whose own frame is still on
    // screen arrives with its raw frame, so the scroller's frame must clip its
    // subtree exactly as the simulator and Android projections do.
    rect: { x: node.frame.x, y: node.frame.y, w: node.frame.width, h: node.frame.height },
    scrolls: node.scrollable === true,
  };
}

/**
 * Flatten the runner tree into the flow contract (flat leaves, hoisted text).
 */
function adaptIosDeviceTreeForFlows(tree: DescribeNode): DescribeNode {
  const children: DescribeNode[] = [];
  // Children only, never the Application root.
  for (const child of tree.children) {
    flattenHoisting(child, projectIosDeviceNode, children);
  }
  return parseDescribeResult({
    role: tree.role,
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children,
  });
}

/**
 * Physical-device flow tree from the XCUITest runner snapshot.
 * Throws on a blind read: an empty tree must not settle or satisfy hidden.
 */
export async function queryIosDeviceFlowTree(
  registry: Registry,
  device: DeviceInfo
): Promise<DescribeTreeData> {
  const data = await describeIosDevice(registry, device);
  // Empty children plus a hint is the describe blind-read shape. A quality
  // hint on a non-empty tree still has nodes.
  if (data.tree.children.length === 0 && data.hint) {
    throw new Error(
      `${data.hint} Flows resolve selectors against this runner tree, so the step fails ` +
        `rather than treating the unreadable screen as empty.`
    );
  }
  return { ...data, tree: adaptIosDeviceTreeForFlows(data.tree) };
}
