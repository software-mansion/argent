/**
 * Shrinks the element tree appended after an action to the lines that changed
 * since the last tree the agent received for the same device.
 */

import { AUTO_DESCRIBE_HEADER } from "./auto-capture.js";

export const TREE_DIFF_HEADER =
  "--- Elements changed since the last tree (- gone, + new; call describe for the full tree) ---";

export const TREE_UNCHANGED_TEXT =
  "--- Elements after action: same as the last tree (call describe for the full tree) ---";

export interface TreeRender {
  mode: "full" | "diff" | "unchanged";
  text: string;
}

function countLines(lines: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
}

/** The lines of `lines` left after taking out, per value, as many as `other` holds. */
function linesMissingFrom(lines: string[], other: string[]): string[] {
  const remaining = countLines(other);
  return lines.filter((line) => {
    const left = remaining.get(line) ?? 0;
    if (left === 0) return true;
    remaining.set(line, left - 1);
    return false;
  });
}

function treeLines(tree: string): string[] {
  return tree.split("\n").filter((line) => line.trim() !== "");
}

/**
 * Compares `tree` with the previous tree. The diff lists each element line that
 * disappeared or appeared, in tree order; a line whose frame or value changed
 * shows as one of each. Renders the full tree when there is no previous tree
 * or when the diff would not be shorter (a new screen, a scroll).
 */
export function renderTreeChange(previous: string | undefined, tree: string): TreeRender {
  const full: TreeRender = { mode: "full", text: `${AUTO_DESCRIBE_HEADER}\n${tree}` };
  if (previous === undefined) return full;
  const before = treeLines(previous);
  const after = treeLines(tree);
  const removed = linesMissingFrom(before, after);
  const added = linesMissingFrom(after, before);
  if (removed.length === 0 && added.length === 0) {
    return { mode: "unchanged", text: TREE_UNCHANGED_TEXT };
  }
  const text = [
    TREE_DIFF_HEADER,
    ...removed.map((line) => `- ${line}`),
    ...added.map((line) => `+ ${line}`),
  ].join("\n");
  return text.length < full.text.length ? { mode: "diff", text } : full;
}
