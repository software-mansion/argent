import type { DescribeTreeData } from "./contract";

/**
 * True when an arrived tree is not trustworthy evidence about the screen.
 * `hidden` must not resolve from a childless or previously-matched-then-blank read.
 */
export function isBlindRead(data: DescribeTreeData, everMatched: boolean): boolean {
  if (data.tree.children.length > 0) return false;
  // The physical-device describe path stamps a hint on every childless tree. This predicate depends on that.
  return Boolean(data.hint || data.should_restart || everMatched);
}
