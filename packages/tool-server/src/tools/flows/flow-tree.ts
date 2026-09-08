import type { DeviceInfo, Platform, Registry } from "@argent/registry";
import { fetchTree } from "../../utils/ui-tree-match";
import type { FlowTreeTarget } from "./flow-actions";
import { queryFullHierarchyTree, queryIosDeviceFlowTree } from "./flow-ios-tree";
import { queryAndroidFullHierarchy } from "./flow-android-tree";
import { queryChromiumTree } from "./flow-chromium-tree";
import { queryVegaTree } from "./flow-vega-tree";
import type { DescribeTreeData } from "../describe/contract";

/**
 * Fetch the tree a flow resolves selectors against: on iOS/Android the full
 * view hierarchy rather than the trimmed tree `describe` walks, on
 * Chromium/Vega that same describe tree re-shaped into the flow contract (flat
 * leaves, hoisted `subtreeText`).
 *
 * There is deliberately NO fallback to the trimmed AX/uiautomator tree: it
 * lacks the testID nodes and hoisted `subtreeText` flows resolve against, so a
 * degraded read doesn't fail loudly — it changes what selectors match and what
 * `text` / `hidden` checks see (a `hidden` assert can even falsely pass against
 * a tree that simply omits the node). The helpers throw instead: transient
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
  const source = FLOW_TREE_SOURCES[device.platform];
  // Every platform a flow can run on has a source, so nothing reaches this;
  // `fetchTree` throws its not-supported error naming the platform.
  if (!source) return fetchTree(registry, device);
  return source(registry, device, target);
}

/** The source {@link fetchFlowTree} reads on each platform that has one. */
const FLOW_TREE_SOURCES: Partial<
  Record<
    Platform,
    (registry: Registry, device: DeviceInfo, target?: FlowTreeTarget) => Promise<DescribeTreeData>
  >
> = {
  // Simulator iOS uses the injected hierarchy and an optional target.
  // Physical devices use the XCUITest runner tree.
  "ios": (registry, device, target) =>
    device.kind === "device"
      ? queryIosDeviceFlowTree(registry, device)
      : queryFullHierarchyTree(registry, device, target),
  // A remote sim is an iOS simulator reached over the sim-remote tunnel, and
  // the native-devtools blueprint routes `getFullHierarchy` over TCP for one.
  // So it is the local simulator source with no `kind === "device"` arm:
  // `ios-remote` is always kind "simulator" (utils/device-info.ts) and has no
  // physical-device variant.
  "ios-remote": (registry, device, target) => queryFullHierarchyTree(registry, device, target),
  "android": (registry, device) => queryAndroidFullHierarchy(registry, device),
  "chromium": (registry, device) => queryChromiumTree(registry, device),
  "vega": (_registry, device) => queryVegaTree(device),
};

/**
 * Whether a platform has a flow tree source at all — read off the table
 * {@link fetchFlowTree} dispatches through, so it cannot drift from what a read
 * would do.
 *
 * The distinction a caller needs is "structurally absent" versus "down": a
 * platform with no source at all would fail every read by construction, so a
 * best-effort caller would otherwise report a degradation on every gesture of
 * every run there — see `settleForGesture`. No platform is in that position
 * today; the callers are kept honest by reading the table rather than
 * assuming it.
 */
export function supportsFlowTree(platform: Platform): boolean {
  // Lookup, not `in`: `fetchFlowTree` also treats an explicit undefined entry
  // as no source.
  return FLOW_TREE_SOURCES[platform] !== undefined;
}
