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
 * only cross-process source. On Chromium the CDP DOM walker's tree already has
 * full selector coverage, so it is only re-shaped (flattened + text hoisted)
 * into the same flow contract. Platforms with no flow-specific source (vega)
 * use the shared `fetchTree` — their only tree source — directly.
 *
 * There is deliberately NO fallback from the iOS/Android full-hierarchy source
 * to the trimmed AX/uiautomator tree. The trimmed tree lacks the testID nodes
 * and the hoisted `subtreeText` flows resolve against, so a degraded read
 * doesn't fail loudly — it changes what selectors match and what `text` /
 * `hidden` checks see, flipping a flow's outcome with devtools availability
 * instead of with what's on screen (a `hidden` assert can even falsely pass
 * against a tree that simply omits the node). The helpers throw instead:
 * transient failures are absorbed by the callers' retry loops (`settleTree`,
 * the await/assert poll), and a persistent outage fails the step with the
 * helper's reason.
 */
export async function fetchFlowTree(
  registry: Registry,
  device: DeviceInfo
): Promise<DescribeTreeData> {
  if (device.platform === "ios") {
    return queryFullHierarchyTree(registry, device);
  }
  if (device.platform === "android") {
    return queryAndroidFullHierarchy(registry, device);
  }
  if (device.platform === "chromium") {
    return queryChromiumTree(registry, device);
  }
  return fetchTree(registry, device);
}
