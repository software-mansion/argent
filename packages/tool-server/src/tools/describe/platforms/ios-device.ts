import type { DeviceInfo, Registry } from "@argent/registry";
import { iosDeviceRunnerRef, type IosDeviceRunnerApi } from "../../../blueprints/ios-device-runner";
import { requireCurrentIosDeviceApp } from "../../../utils/ios-device/app-session";
import {
  captureSnapshot,
  type RunnerSnapshotNode,
} from "../../../utils/ios-device/runner-commands";
import type { DescribeNode, DescribeTreeData } from "../contract";

/**
 * Describe the current screen on a physical iOS device.
 * Adapts the XCUITest runner snapshot into the describe contract tree.
 */
export async function describeIosDevice(
  registry: Registry,
  device: DeviceInfo
): Promise<DescribeTreeData> {
  const bundleId = requireCurrentIosDeviceApp(device.id);
  const ref = iosDeviceRunnerRef(device);
  const api = await registry.resolveService<IosDeviceRunnerApi>(ref.urn, ref.options);

  let { nodes, quality } = await captureSnapshot(api, bundleId);

  // XCTest can attach before the UI is built and report a root-only tree. One retry recovers the common case.
  if (nodes.length <= 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    ({ nodes, quality } = await captureSnapshot(api, bundleId));
  }

  const data = adaptRunnerSnapshot(nodes);

  if (quality?.state && quality.state !== "healthy") {
    const summary =
      `Snapshot quality: ${quality.state} (backend ${quality.backend ?? "?"}, ` +
      `reason ${quality.reasonCode ?? quality.reason ?? "?"}). `;

    // The runner reports node_cap when the flattened tree hit its node budget.
    // Retrying without changing the screen returns the same capped tree, so
    // the way out is fewer nodes, not another read.
    data.hint =
      quality.reasonCode === "node_cap"
        ? summary +
          "The tree was truncated at the runner's node budget, so retrying returns the same capped tree. " +
          "Dismiss the keyboard if it is up (its keys alone add about 100 Key nodes), or wait for the " +
          "target with await-ui-element and a selector, which succeeds once it lands inside the budget. " +
          "The screenshot shows what the tree dropped."
        : summary +
          "The tree may be incomplete; retry after the UI settles, or fall back to the screenshot.";
  } else if (data.tree.children.length === 0) {
    // Blind-read guards key off this hint. Every childless tree must carry one.
    data.hint =
      "The runner returned an empty or root-only accessibility tree. The app may still " +
      "be launching, or this screen exposes no accessibility elements.";
  }

  return data;
}

/**
 * XCTest element types mapped to the AX-style roles the describe formatter emits.
 * Unmapped types keep their XCTest name, SegmentedControl included (its Button children carry the interaction).
 */
export const RUNNER_TYPE_TO_ROLE: Record<string, string> = {
  Button: "AXButton",
  CheckBox: "AXButton",
  MenuItem: "AXButton",
  Cell: "AXButton",
  StaticText: "AXStaticText",
  Image: "AXImage",
  Link: "AXLink",
  TextField: "AXTextField",
  SecureTextField: "AXTextField",
  SearchField: "AXTextField",
  TextView: "AXTextField",
  TabBar: "AXTabBar",
  Switch: "AXAdjustable",
  Toggle: "AXAdjustable",
  Slider: "AXAdjustable",
  Stepper: "AXAdjustable",
  DatePicker: "AXAdjustable",
  Picker: "AXAdjustable",
  PickerWheel: "AXAdjustable",
};

/**
 * Scroll container types kept in lockstep with the Swift runner `scrollContainerTypes` list.
 * They carry no content role and stay emitted via the `scrollable` flag.
 */
export const SCROLL_CONTAINER_TYPES = new Set(["ScrollView", "Table", "CollectionView", "WebView"]);

function adaptRunnerSnapshot(nodes: RunnerSnapshotNode[]): DescribeTreeData {
  // Empty snapshot has no root rect. Return the same childless Application shape as a root-only tree.
  if (nodes.length === 0) {
    return {
      tree: { role: "Application", frame: { x: 0, y: 0, width: 1, height: 1 }, children: [] },
      source: "xcuitest-runner",
    };
  }

  // Normalize against the Application frame. Clamp because XCTest can report children a point outside the root.
  const root = nodes.reduce((a, b) => (b.depth < a.depth ? b : a));
  const refW = root.rect.width > 0 ? root.rect.width : 1;
  const refH = root.rect.height > 0 ? root.rect.height : 1;

  const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

  const toDescribe = (node: RunnerSnapshotNode): DescribeNode => {
    const x = clamp01((node.rect.x - root.rect.x) / refW);
    const y = clamp01((node.rect.y - root.rect.y) / refH);

    return {
      role: RUNNER_TYPE_TO_ROLE[node.type] ?? node.type,
      frame: {
        x,
        y,
        width: clamp01((node.rect.x - root.rect.x + node.rect.width) / refW) - x,
        height: clamp01((node.rect.y - root.rect.y + node.rect.height) / refH) - y,
      },
      children: [],
      ...(node.label ? { label: node.label } : {}),
      ...(node.identifier ? { identifier: node.identifier } : {}),
      ...(node.value != null ? { value: String(node.value) } : {}),
      ...(node.focused ? { focused: true } : {}),
      ...(node.selected ? { selected: true } : {}),
      ...(node.enabled === false ? { disabled: true } : {}),
      ...(SCROLL_CONTAINER_TYPES.has(node.type) ? { scrollable: true } : {}),
    };
  };

  const describeByIndex = new Map<number, DescribeNode>();

  for (const node of nodes) {
    describeByIndex.set(node.index, toDescribe(node));
  }

  const rootDescribe = describeByIndex.get(root.index)!;

  for (const node of nodes) {
    if (node.index === root.index) {
      continue;
    }

    const parent =
      (node.parentIndex != null ? describeByIndex.get(node.parentIndex) : undefined) ??
      rootDescribe;

    parent.children.push(describeByIndex.get(node.index)!);
  }

  return {
    tree: rootDescribe,
    source: "xcuitest-runner",
    screen: {
      width: refW,
      height: refH,
    },
  };
}
