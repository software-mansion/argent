import type { DeviceInfo, Registry } from "@argent/registry";
import { fetchTree } from "../../utils/ui-tree-match";
import { queryFullHierarchyTree } from "./flow-ios-tree";
import { queryAndroidFullHierarchy } from "./flow-android-tree";
import { queryChromiumTree } from "./flow-chromium-tree";
import type { DescribeTreeData } from "../describe/contract";

/**
 * Fetch the tree a flow resolves selectors against.
 *
 * On iOS this is the native UIView hierarchy (full testID coverage, no
 * `accessible`-container collapse). On Android it is the full accessibility
 * hierarchy including not-important views (full `resource-id`/testID coverage,
 * no interactables trim) — the Android counterpart to the same idea, since the
 * raw View tree is only reachable in-process there and the a11y tree is the
 * only cross-process source. Both degrade to the shared `fetchTree` (the
 * trimmed AX/uiautomator tree) when their helper is unavailable. On Chromium
 * the CDP DOM walker's tree already has full selector coverage, so it is only
 * re-shaped (flattened + text hoisted) into the same flow contract. Other
 * platforms use `fetchTree` directly — unchanged.
 */
export async function fetchFlowTree(
  registry: Registry,
  device: DeviceInfo
): Promise<DescribeTreeData> {
  if (device.platform === "ios") {
    const native = await queryFullHierarchyTree(registry, device);
    if (native) return native;
  } else if (device.platform === "android") {
    const full = await queryAndroidFullHierarchy(registry, device);
    if (full) return full;
  } else if (device.platform === "chromium") {
    return queryChromiumTree(registry, device);
  }
  return fetchTree(registry, device);
}
