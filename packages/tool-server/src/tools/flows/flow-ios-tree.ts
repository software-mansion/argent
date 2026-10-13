import { FAILURE_CODES, FailureError, getFailureSignal } from "@argent/registry";
import type { DeviceInfo, Registry } from "@argent/registry";
import { axServiceRef, type AXServiceApi } from "../../blueprints/ax-service";
import { nodeText } from "../../utils/ui-tree-match";
import { describeIosDevice } from "../describe/platforms/ios-device";
import { adaptAxTree } from "../ui-tree/ios";
import type { UiTree, UiTreeNode } from "../ui-tree";
import type { FlowTreeTarget } from "./flow-actions";
import { flattenHoisting, type FlatNode } from "./flow-tree-flatten";
import {
  type DescribeFrame,
  type DescribeNode,
  type DescribeTreeData,
  parseDescribeResult,
} from "../describe/contract";

/**
 * Flow-owned iOS tree sources (per-platform dispatch: `flow-tree.ts`).
 *
 * Simulators (`queryIosSimulatorFlowTree`): the accessibility tree the
 * ax-service daemon walks — the tree `describe` shows, with the hidden and
 * covered elements describe drops and the unlabelled containers it does not
 * print. Recording and replay therefore read one tree, so a selector copied
 * from `describe` (id, text, role) resolves at replay. Frames are normalized
 * to the screen's fixed (portrait-native) panel, the space touches are taken
 * in; the daemon reports the interface orientation, which turns the flow's
 * directions and reading order on a landscape UI (`flow-orientation.ts`).
 *
 * Physical devices (`queryIosDeviceFlowTree`): the XCUITest runner accessibility
 * snapshot, the same tree `describe` serves, reshaped into the flow contract.
 *
 * Both sources honor the contract `fetchFlowTree` states: a read that isn't
 * the screen THROWS rather than hand back a degraded tree. An empty tree is the
 * one thing a `hidden`/absent check accepts, and `settleTree` fingerprints two
 * identical blind reads as a settled screen, so returning one would flip flow
 * outcomes; see `fetchFlowTree`.
 */

// XCUIElementType names of containers that scroll. `scroll-to` anchors its
// settle on them, and a tap in their padding records as a scroll area.
const SCROLLING_TYPES = new Set(["ScrollView", "Table", "CollectionView", "WebView"]);

/**
 * UIKit's scroll indicator ("Vertical scroll bar, 3 pages"): an adjustable
 * element of no type of its own, in a scrolling container. Nobody taps it or
 * reads it as content, so it is neither a leaf nor hoisted text.
 */
function isScrollIndicator(node: UiTreeNode): boolean {
  return node.type === "Other" && node.traits?.length === 1 && node.traits[0] === "adjustable";
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function roundNormalized(value: number): number {
  return Math.round(value * 1e12) / 1e12;
}

/** The on-screen part of a frame, as describe's adapter clamps it; undefined when nothing is on screen. */
function onScreenFrame(frame: DescribeFrame): DescribeFrame | undefined {
  const x1 = clamp01(frame.x);
  const y1 = clamp01(frame.y);
  const x2 = clamp01(frame.x + frame.width);
  const y2 = clamp01(frame.y + frame.height);
  if (x2 - x1 <= 0 || y2 - y1 <= 0) return undefined;
  return {
    x: roundNormalized(x1),
    y: roundNormalized(y1),
    width: roundNormalized(x2 - x1),
    height: roundNormalized(y2 - y1),
  };
}

/**
 * Project one accessibility node for the shared flatten (see
 * `flow-tree-flatten`). Covered subtrees (under a system alert) are dropped,
 * as describe drops them, and so are a scroller's indicators; what a scrolling
 * container has scrolled out of its frame is pruned by the flatten's scroll
 * clip (`rect` + `scrolls`). Only scrolling ancestors clip: a UIKit stack view
 * reports a frame smaller than its children, so clipping by every framed
 * ancestor (the tree's `hidden`) would drop buttons describe shows. A leaf is emitted for every node
 * describe would print — an id, a label, a value, a non-group role, input
 * focus — and for a scrolling container. An identifier shields hoisted text
 * to the nearest identified ancestor; a password never contributes its value.
 */
function projectAxNode(node: UiTreeNode): FlatNode<UiTreeNode> {
  if (node.covered) {
    return { skip: true, children: [], ownText: "", leaf: null, shield: false };
  }
  const frame = node.frame && onScreenFrame(node.frame);
  const scrollable = node.type !== undefined && SCROLLING_TYPES.has(node.type);
  const addressable =
    scrollable ||
    Boolean(node.identifier || node.label || node.value || node.placeholder || node.focused) ||
    node.role !== "AXGroup";
  // An empty input reports its placeholder as its value, as `describe` prints it.
  const value = node.value ?? (node.hintShowing ? node.placeholder : undefined);
  let leaf: DescribeNode | null = null;
  if (frame && addressable) {
    leaf = {
      role: node.role,
      frame,
      children: [],
      ...(node.label !== undefined ? { label: node.label } : {}),
      ...(value !== undefined && !node.password ? { value } : {}),
      ...(node.identifier !== undefined ? { identifier: node.identifier } : {}),
      ...(node.focused ? { focused: true } : {}),
      ...(node.disabled ? { disabled: true } : {}),
      ...(node.selected ? { selected: true } : {}),
      ...(node.password ? { password: true } : {}),
      ...(node.checked !== undefined ? { checked: node.checked } : {}),
      ...(scrollable ? { scrollable: true } : {}),
    };
  }
  return {
    skip: false,
    children: scrollable ? node.children.filter((c) => !isScrollIndicator(c)) : node.children,
    // Off-screen text must not hoist: a `text` assert guards what the screen shows.
    ownText: leaf ? nodeText(leaf) : "",
    leaf,
    shield: Boolean(node.identifier) || node.password === true,
    // Scroll-clip inputs, unclamped and in the tree's normalized space.
    rect: node.frame && {
      x: node.frame.x,
      y: node.frame.y,
      w: node.frame.width,
      h: node.frame.height,
    },
    scrolls: scrollable,
  };
}

/**
 * Flatten the accessibility tree into the flow contract: flat leaves under one
 * synthetic root, descendant text hoisted onto container leaves. Each app root
 * (the daemon lists the system app first while an alert shows) contributes its
 * children; the Application nodes themselves are not leaves.
 */
export function adaptIosUiTreeForFlows(tree: UiTree): DescribeNode {
  const children: DescribeNode[] = [];
  for (const root of tree.roots) {
    if (root.covered) continue;
    for (const child of root.children) flattenHoisting(child, projectAxNode, children);
  }
  return parseDescribeResult({
    role: "AXGroup",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children,
  });
}

const UPDATE_REMEDY =
  "The accessibility service bundled with this argent is too old for flows: update argent " +
  "(the `update-argent` tool or `npm i -g @swmansion/argent@latest`), then run " +
  "`argent server stop` so the new service starts.";

const BOOT_REMEDY =
  "Boot the simulator with `boot-device` (`force: true` when it is already booted), then " +
  "run the flow again.";

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A tree source too old for flows: the launch gate reports it without waiting. */
function unsupportedTree(message: string): FailureError {
  return new FailureError(message, {
    error_code: FAILURE_CODES.AX_TREE_UNSUPPORTED,
    failure_stage: "flow_tree_read",
    failure_area: "tool_server",
    error_kind: "unknown",
  });
}

/** The reason a tree read failed, followed by what to do about it. */
function treeUnavailable(device: DeviceInfo, err: unknown): Error {
  const code = getFailureSignal(err)?.error_code;
  if (code === FAILURE_CODES.AX_TREE_UNSUPPORTED) {
    return unsupportedTree(
      `the accessibility tree of ${device.id} cannot be read: ${errMsg(err)}. ${UPDATE_REMEDY}`
    );
  }
  const remedy =
    code === FAILURE_CODES.AX_QUERY_TIMEOUT
      ? "The screen took too long to read: wait for the app to settle, or scroll a long list or " +
        "web page out of view, then run the flow again."
      : BOOT_REMEDY;
  return new Error(
    `the accessibility tree of ${device.id} could not be read: ${errMsg(err)}. ${remedy}`
  );
}

/**
 * One read of the simulator's accessibility tree, as `ui-tree` adapts it. Every
 * failure is rethrown with a remedy: an accessibility service too old for
 * flows (`AX_TREE_UNSUPPORTED`, also when it serves a tree without
 * `foregroundApp` or `interfaceOrientation`), a simulator the service cannot
 * reach, a read that timed out. Flows on a simulator have no other tree source.
 */
export async function readIosSimulatorUiTree(
  registry: Registry,
  device: DeviceInfo
): Promise<UiTree & { degraded: boolean }> {
  const ref = axServiceRef(device);
  let ax: AXServiceApi;
  let tree: UiTree;
  try {
    ax = await registry.resolveService<AXServiceApi>(ref.urn, ref.options);
    tree = adaptAxTree(await ax.tree());
  } catch (err) {
    throw treeUnavailable(device, err);
  }
  if (
    tree.unsupportedFields.includes("foregroundApp") ||
    tree.unsupportedFields.includes("interfaceOrientation")
  ) {
    throw unsupportedTree(
      `the accessibility tree of ${device.id} names no foreground app or interface ` +
        `orientation. ${UPDATE_REMEDY}`
    );
  }
  return { ...tree, degraded: ax.degraded };
}

/**
 * Simulator flow tree from the ax-service accessibility tree. Throws, with a
 * remedy, when the tree cannot be read, when a pinned launch's app is no
 * longer in the foreground (it crashed, or a tap opened another app), and on a
 * blind read: an app serving no accessible elements must not settle or satisfy
 * `hidden`.
 */
export async function queryIosSimulatorFlowTree(
  registry: Registry,
  device: DeviceInfo,
  target?: FlowTreeTarget
): Promise<DescribeTreeData> {
  const tree = await readIosSimulatorUiTree(registry, device);
  if (target?.pinned && tree.foregroundApp && tree.foregroundApp !== target.bundleId) {
    throw new Error(
      `${target.bundleId} is not the foreground app on ${device.id} (${tree.foregroundApp} is). ` +
        `It may have crashed or opened another app. If the flow meant to leave it, switch apps ` +
        `with a \`launch:\` or a \`tool: launch-app\` step first.`
    );
  }
  if (tree.roots.every((root) => root.children.length === 0)) {
    throw new Error(
      tree.degraded
        ? `the accessibility tree of ${device.id} is empty: argent did not boot this simulator, so ` +
            `its accessibility service cannot see the app. ${BOOT_REMEDY}`
        : `the accessibility tree of ${device.id} is empty: the foreground app ` +
            `(${tree.foregroundApp ?? "unknown"}) exposes no accessible elements. Wait for it to ` +
            `draw, or relaunch it with \`restart-app\`, then run the flow again.`
    );
  }
  return {
    tree: adaptIosUiTreeForFlows(tree),
    source: "ax-service",
    screen: tree.screen,
    uiOrientation: tree.interfaceOrientation,
  };
}

/**
 * Project a runner node for the shared flatten (see `flow-tree-flatten`).
 */
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
