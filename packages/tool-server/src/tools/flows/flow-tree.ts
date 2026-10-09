import type { DeviceInfo, Platform, Registry } from "@argent/registry";
import type { FlowTreeTarget } from "./flow-actions";
import { queryIosDeviceFlowTree, queryIosSimulatorFlowTree } from "./flow-ios-tree";
import { queryAndroidFullHierarchy } from "./flow-android-tree";
import { queryChromiumTree } from "./flow-chromium-tree";
import { queryVegaTree } from "./flow-vega-tree";
import type { DescribeTreeData } from "../describe/contract";

/**
 * Fetch the tree a flow resolves selectors against: on an iOS simulator the
 * accessibility tree `describe` shows, on Android the full view hierarchy
 * rather than the trimmed tree `describe` walks, on Chromium/Vega that same
 * describe tree re-shaped into the flow contract (flat leaves, hoisted
 * `subtreeText`).
 *
 * There is deliberately NO fallback to another source: a different tree
 * changes what selectors match and what `text` / `hidden` checks see (a
 * `hidden` assert can even falsely pass against a tree that simply omits the
 * node). The helpers throw instead, with a remedy in the message: transient
 * failures are absorbed by the callers' retry loops (`settleTree`, the
 * await/assert poll), and a persistent outage fails the step - except where the
 * caller needs no frame out of the tree and swallows the throw:
 * `settleForGesture` (the gesture passes carrying a warning),
 * `fetchScreenAspect` (degrades to a legacy orbit), `runSnapshot` (captures
 * pixels anyway).
 */
export async function fetchFlowTree(
  registry: Registry,
  device: DeviceInfo,
  target?: FlowTreeTarget
): Promise<DescribeTreeData> {
  return FLOW_TREE_SOURCES[device.platform](registry, device, target);
}

/**
 * The source {@link fetchFlowTree} reads on each platform. Total by type: a
 * `Platform` added without a source here is a compile error, not a read that
 * quietly degrades at runtime.
 */
const FLOW_TREE_SOURCES: Record<
  Platform,
  (registry: Registry, device: DeviceInfo, target?: FlowTreeTarget) => Promise<DescribeTreeData>
> = {
  // Simulator iOS reads the ax-service accessibility tree; the launch pin
  // (`target`) is checked against its foreground app. Physical devices use the
  // XCUITest runner tree.
  "ios": (registry, device, target) =>
    device.kind === "device"
      ? queryIosDeviceFlowTree(registry, device)
      : queryIosSimulatorFlowTree(registry, device, target),
  // A remote sim is an iOS simulator reached over the sim-remote tunnel, and
  // the ax-service blueprint serves it over TCP. So it is the local simulator
  // source with no `kind === "device"` arm: `ios-remote` is always kind
  // "simulator" (utils/device-info.ts) and has no physical-device variant.
  "ios-remote": (registry, device, target) => queryIosSimulatorFlowTree(registry, device, target),
  "android": (registry, device) => queryAndroidFullHierarchy(registry, device),
  "chromium": (registry, device) => queryChromiumTree(registry, device),
  "vega": (_registry, device) => queryVegaTree(device),
};
