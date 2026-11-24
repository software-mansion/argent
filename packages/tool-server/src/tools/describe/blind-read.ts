import type { DescribeTreeData } from "./contract";
import type { WaitCondition } from "../../utils/ui-tree-match";

/**
 * True when an arrived tree is not trustworthy evidence about the screen.
 * `hidden` must not resolve from a childless or previously-matched-then-blank read,
 * nor from a Mac app's fallback walk, which misses an open context menu.
 */
export function isBlindRead(
  data: DescribeTreeData,
  everMatched: boolean,
  condition?: WaitCondition
): boolean {
  if (condition === "hidden" && data.source === "macos-fallback") return true;
  if (data.tree.children.length > 0) return false;
  // The physical-device and HarmonyOS describe paths stamp a hint on every childless tree. This predicate depends on that.
  return Boolean(data.hint || data.should_restart || everMatched);
}
