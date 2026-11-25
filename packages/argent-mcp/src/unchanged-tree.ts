/**
 * Shrinks or omits an element tree the agent already has. The tree appended
 * after an interaction is often identical to, or differs by only a few lines
 * from, the last full tree (a wait, a toggle, typing into a field, a swipe at
 * the end of a list), and every full copy stays in context for the rest of the
 * session. An identical tree is replaced by a note; a slightly changed tree is
 * replaced by a cumulative `-` / `+` line diff against the last full tree.
 *
 * The id is what makes both notes and diffs safe. This process cannot tell
 * which agent on the connection received a tree (a parent and its subagents
 * share one), nor whether a client still holds an old result. Every diff is
 * computed against one named full tree rather than chained across turns, so an
 * agent only ever applies one diff on top of the id it holds — and if it does
 * not find that id in its context, it knows to call `describe`.
 */

import { randomInt } from "node:crypto";
import { normalizeToolName } from "./auto-capture.js";

/**
 * Short results (unchanged notes or diffs) sent in a row for one full tree
 * before the full tree is sent again. It limits how long an agent works from
 * one old copy. Results of other tools between them are not counted, so it
 * does not bound how far back that copy is.
 */
export const MAX_UNCHANGED_IN_A_ROW = 3;

/**
 * Age of the last full tree past which it is sent again. After an idle gap the
 * conversation may have been cleared or compacted while this process kept
 * running.
 */
export const UNCHANGED_MAX_AGE_MS = 5 * 60_000;

/**
 * A diff is sent only when it is at most this fraction of the full tree's
 * length (at least a 40% reduction). Larger changes (navigation, scroll, big
 * modals) fall back to the full tree so the agent never has to reconstruct a
 * mostly-replaced screen from a long diff.
 */
const MAX_DIFF_RATIO = 0.6;

type TreeRenderMode = "full" | "diff" | "unchanged";

interface SentTree {
  id: string;
  tree: string;
  /** Most recent screen tree for this device, used to surface lines that revert back to `tree`. */
  prevTree: string;
  /** The tool whose result carried the full tree. */
  tool: string;
  sentAt: number;
  /** Non-full results (notes or diffs) sent in place of this tree since. */
  shortResults: number;
}

interface AfterAction {
  /** The text to append: the full tree under its id line, a diff, or a note. */
  text: string;
  /** How the tree was rendered. */
  mode: TreeRenderMode;
  /** The tree is the one last sent in full for the device, whether or not a note replaced it. */
  identical: boolean;
  /** An unchanged note replaced the tree. */
  note: boolean;
}

export interface TreeMemory {
  /**
   * Records a full tree the agent received another way: its own `describe`
   * call. Returns the id to send with it.
   */
  sent(udid: string, tree: string, toolName: string): string;
  /** What to append after an action: the full tree, a diff, or a note. */
  afterAction(udid: string, tree: string, toolName: string): AfterAction;
  /** Drops the tree of a device: the result that carried it did not reach the agent. */
  forget(udid: string): void;
}

/** The line that gives a full tree its id. */
export function treeIdLine(id: string): string {
  return `Tree id: ${id}`;
}

/**
 * The note sent in place of a tree identical to tree `id`, which a `tool`
 * result returned. Identical text is all the comparison shows: `describe`
 * leaves out state an action can change (the value of a web input that has a
 * placeholder, a password), so the note must not say that nothing changed.
 */
export function unchangedTreeNote(id: string, tool: string): string {
  return `Element tree matches \`${id}\` from an earlier \`${tool}\` result. Actions may have effects the tree omits. Call \`describe\` if you lack that tree.`;
}

/** Header line that introduces a cumulative diff against full tree `id`. */
export function treeDiffHeader(id: string, tool: string): string {
  return `Diff against \`${id}\` (\`${tool}\`) — all other lines match \`${id}\` (supersedes earlier diffs; - gone, + new; call \`describe\` if you lack \`${id}\`):`;
}

function nonBlankLines(tree: string): string[] {
  return tree.split("\n").filter((line) => line.trim() !== "");
}

function countLines(lines: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
}

/** Lines of `lines` left after subtracting, per line value, as many as `other` holds. */
function linesMissingFrom(lines: readonly string[], other: readonly string[]): string[] {
  const remaining = countLines(other);
  return lines.filter((line) => {
    const left = remaining.get(line) ?? 0;
    if (left === 0) return true;
    remaining.set(line, left - 1);
    return false;
  });
}

/**
 * Leading metadata lines (`Hint:`, `Source:`, `Mode:`) whose change means the
 * tree came from a different source/mode or carries a new degraded-read warning,
 * so the agent should see the full tree rather than a diff.
 */
function treeMetaSignature(tree: string): string {
  const meta: string[] = [];
  for (const line of tree.split("\n")) {
    if (line.startsWith("Hint: ") || line.startsWith("Source: ") || line.startsWith("Mode: ")) {
      meta.push(line);
    } else if (line.trim() !== "") {
      break;
    }
  }
  return meta.join("\n");
}

/**
 * Computes a `-` / `+` line diff from `base` to `next`, preserving tree order
 * and multiset counts for repeated lines. When `prev` (the tree from the
 * previous step) held diff lines against `base` that are no longer present in
 * `next` (e.g. a toggle reverted back to `base`'s state or a temporary error
 * banner disappeared), those changes are called out explicitly so smaller
 * models do not assume the prior diff still applies. Returns `null` when
 * metadata changed or when the diff exceeds `MAX_DIFF_RATIO` of `next`.
 */
export function formatTreeDiff(
  base: string,
  next: string,
  id: string,
  tool: string,
  prev: string = base
): { mode: "unchanged" | "diff"; text: string } | null {
  if (treeMetaSignature(base) !== treeMetaSignature(next)) return null;
  const before = nonBlankLines(base);
  const after = nonBlankLines(next);
  const removed = linesMissingFrom(before, after);
  const added = linesMissingFrom(after, before);
  if (removed.length === 0 && added.length === 0) {
    return { mode: "unchanged", text: unchangedTreeNote(id, tool) };
  }
  const lines = [
    treeDiffHeader(id, tool),
    ...removed.map((line) => `- ${line}`),
    ...added.map((line) => `+ ${line}`),
  ];
  if (prev !== base) {
    const prevLines = nonBlankLines(prev);
    const prevAdded = linesMissingFrom(prevLines, before);
    const prevRemoved = linesMissingFrom(before, prevLines);
    const goneFromPriorDiff = linesMissingFrom(prevAdded, added);
    const restoredToBase = linesMissingFrom(prevRemoved, removed);
    if (goneFromPriorDiff.length > 0 || restoredToBase.length > 0) {
      lines.push(`Also since previous step (- gone from prior diff, + restored to \`${id}\`):`);
      for (const line of goneFromPriorDiff) lines.push(`- ${line}`);
      for (const line of restoredToBase) lines.push(`+ ${line}`);
    }
  }
  const text = lines.join("\n");
  if (text.length > Math.floor(next.length * MAX_DIFF_RATIO)) return null;
  return { mode: "diff", text };
}

/** Tells the ids of this process from those of an earlier one in the same conversation. */
function randomTag(): string {
  return randomInt(36 ** 3)
    .toString(36)
    .padStart(3, "0");
}

/**
 * One per MCP session. It holds the last full tree per device, a few kB each.
 * An exact equality check runs first so identical trees skip splitting/diffing.
 */
export function createTreeMemory(
  now: () => number = Date.now,
  tag: string = randomTag()
): TreeMemory {
  const lastSent = new Map<string, SentTree>();
  let count = 0;

  const sent = (udid: string, tree: string, toolName: string): string => {
    const id = `${tag}-${++count}`;
    lastSent.set(udid, {
      id,
      tree,
      prevTree: tree,
      tool: normalizeToolName(toolName),
      sentAt: now(),
      shortResults: 0,
    });
    return id;
  };

  return {
    sent,
    afterAction(udid, tree, toolName) {
      const last = lastSent.get(udid);
      const identical = last !== undefined && last.tree === tree;
      const canShorten =
        last !== undefined &&
        last.shortResults < MAX_UNCHANGED_IN_A_ROW &&
        now() - last.sentAt <= UNCHANGED_MAX_AGE_MS;

      if (canShorten) {
        if (identical) {
          last.shortResults += 1;
          last.prevTree = tree;
          return {
            text: unchangedTreeNote(last.id, last.tool),
            mode: "unchanged",
            identical: true,
            note: true,
          };
        }
        const diff = formatTreeDiff(last.tree, tree, last.id, last.tool, last.prevTree);
        if (diff !== null) {
          last.shortResults += 1;
          last.prevTree = tree;
          return {
            text: diff.text,
            mode: diff.mode,
            identical: diff.mode === "unchanged",
            note: diff.mode === "unchanged",
          };
        }
      }

      const id = sent(udid, tree, toolName);
      return { text: `${treeIdLine(id)}\n${tree}`, mode: "full", identical, note: false };
    },
    forget(udid) {
      lastSent.delete(udid);
    },
  };
}

/**
 * The tree of a `describe` result as the agent reads it after an action: the
 * hint line, then the tree. Undefined when the result has no tree.
 */
export function describedTree(result: unknown): string | undefined {
  const { description, hint } =
    (result as { description?: unknown; hint?: unknown } | null | undefined) ?? {};
  if (typeof description !== "string" || description.length === 0) return undefined;
  // The agent reads this tree in place of describe, so it needs describe's warnings too
  // (the TV description already carries its hint).
  const hintLine =
    typeof hint === "string" && hint && !description.includes(hint) ? `Hint: ${hint}\n` : "";
  return `${hintLine}${description}`;
}
