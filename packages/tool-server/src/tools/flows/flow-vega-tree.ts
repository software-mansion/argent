import type { DeviceInfo } from "@argent/registry";
import { describeVega } from "../describe/platforms/vega";
import { isAuthoredVegaTestId } from "../describe/platforms/vega/source-parser";
import { flattenHoisting, type FlatNode } from "./flow-tree-flatten";
import { nodeText } from "../../utils/ui-tree-match";
import {
  parseDescribeResult,
  type DescribeNode,
  type DescribeTreeData,
} from "../describe/contract";

/**
 * Flow-owned adaptation of the Vega describe tree — the counterpart to
 * `flow-chromium-tree.ts` on Chromium.
 *
 * The automation toolkit's page source is Vega's only tree source, so like
 * Chromium there is no richer hierarchy to query — but the parsed tree lacks
 * the flow contract the other adapters provide: the flat-leaves-under-one-root
 * shape and, above all, `subtreeText` hoisting. The toolkit puts an element's
 * text on child `text` nodes (a nav `button` wraps a `text` leaf carrying
 * "Home"), so without hoisting a `text`/`assert` check against the button — or
 * against a wrapping authored-testID container — reads its own (empty) text
 * instead of what it visibly shows.
 */

/**
 * Project a describe node for the shared flatten (see `flow-tree-flatten`).
 * Every parsed node is emitted as a leaf: the source parser already flattened
 * bare structural wrappers and dropped launcher/`<traits>` noise, so whatever
 * survived is addressable, and dropping anything here would remove elements a
 * selector matched against the shared describe tree before this adapter
 * existed. Zero-area (scrolled-off) nodes stay too — `exists` deliberately
 * accepts them — but contribute no text. Only an AUTHORED testID shields: the
 * toolkit stamps every node with an auto-generated numeric `test_id` (surfaced
 * as its `identifier`), and letting those shield would scope hoisting to every
 * single node — i.e. disable it.
 */
function projectVegaNode(node: DescribeNode): FlatNode<DescribeNode> {
  const onScreen = node.frame.width > 0 && node.frame.height > 0;
  return {
    skip: false,
    children: node.children,
    // Text hoists only from on-screen nodes — otherwise a text assert against
    // an ancestor would pass on content the screen doesn't show.
    ownText: onScreen ? nodeText(node) : "",
    leaf: { ...node, children: [] },
    shield: isAuthoredVegaTestId(node.identifier),
  };
}

/**
 * Flatten a parsed Vega describe tree into the flat-leaves-under-one-root shape
 * the other flow adapters emit, hoisting descendant text onto container leaves.
 */
export function adaptVegaTreeForFlows(tree: DescribeNode): DescribeNode {
  const children: DescribeNode[] = [];
  // Children only, never the root — the parser's synthetic Screen wrapper is
  // the same full-screen container the other adapters refuse to project.
  for (const child of tree.children) {
    flattenHoisting(child, projectVegaNode, children);
  }
  return parseDescribeResult({
    role: "Screen",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children,
  });
}

/**
 * Fetch the toolkit page-source tree via `describeVega` and adapt it into the
 * flow contract — the Vega counterpart to `queryChromiumTree`. An unreachable
 * toolkit surfaces as `describeVega`'s empty tree + relaunch hint, passed
 * through unchanged so the runner's blind-read guard still sees the hint.
 */
export async function queryVegaTree(device: DeviceInfo): Promise<DescribeTreeData> {
  const data = await describeVega(device.id);
  return { ...data, tree: adaptVegaTreeForFlows(data.tree) };
}
