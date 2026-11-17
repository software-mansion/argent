/**
 * Leaves out an element tree the agent already has. The tree appended after an
 * interaction is often the one the previous result carried (a wait, a tap with
 * no effect, a swipe at the end of a list), and every copy stays in the agent's
 * context for the rest of the session. An identical tree is replaced by a note
 * that says where the agent has it.
 */

import { normalizeToolName } from "./auto-capture.js";

/**
 * Identical trees left out in a row before the tree is sent again. The note
 * points back at an earlier result, which a long session compacts away; this
 * keeps the full tree at most four results back.
 */
export const MAX_UNCHANGED_IN_A_ROW = 3;

/**
 * Age of the last full tree past which it is sent again. After an idle gap the
 * conversation may have been cleared or compacted while this process kept
 * running.
 */
export const UNCHANGED_MAX_AGE_MS = 5 * 60_000;

interface SentTree {
  tree: string;
  /** The tool whose result carried the full tree. */
  tool: string;
  sentAt: number;
  /** Notes sent in place of this tree since. */
  notes: number;
}

export interface TreeMemory {
  /** Records a full tree the agent received another way: its own `describe` call. */
  sent(udid: string, tree: string, toolName: string): void;
  /** The text to append after an action: the tree, or the note when the agent already has it. */
  afterAction(udid: string, tree: string, toolName: string): { text: string; unchanged: boolean };
}

/** The note sent in place of a tree identical to the one `tool` returned. */
export function unchangedTreeNote(tool: string): string {
  return `Same as the last full element tree returned for this device (in a \`${tool}\` result): no element or frame changed, so it is not repeated here. Call describe if you no longer have that tree.`;
}

/**
 * One per MCP session. It holds the last full tree per device, a few kB each.
 * The comparison is a plain string equality: it ends at once when the lengths
 * differ, and otherwise reads both trees once. A hash would read every new tree
 * in full instead.
 */
export function createTreeMemory(now: () => number = Date.now): TreeMemory {
  const lastSent = new Map<string, SentTree>();

  const sent = (udid: string, tree: string, toolName: string): void => {
    lastSent.set(udid, { tree, tool: normalizeToolName(toolName), sentAt: now(), notes: 0 });
  };

  return {
    sent,
    afterAction(udid, tree, toolName) {
      const last = lastSent.get(udid);
      if (
        last !== undefined &&
        last.notes < MAX_UNCHANGED_IN_A_ROW &&
        now() - last.sentAt <= UNCHANGED_MAX_AGE_MS &&
        last.tree === tree
      ) {
        last.notes += 1;
        return { text: unchangedTreeNote(last.tool), unchanged: true };
      }
      sent(udid, tree, toolName);
      return { text: tree, unchanged: false };
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
