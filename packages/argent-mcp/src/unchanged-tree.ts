/**
 * Leaves out an element tree the agent already has. The tree appended after an
 * interaction is often the one the previous result carried (a wait, a tap with
 * no effect, a swipe at the end of a list), and every copy stays in the agent's
 * context for the rest of the session. An identical tree is replaced by a note
 * that names the earlier tree by its id.
 *
 * The id is what makes the note safe. This process cannot tell which agent on
 * the connection received a tree (a parent and its subagents share one), nor
 * whether a client still holds an old result. An agent that does not find the
 * id in its context knows that it does not have the tree.
 */

import { randomInt } from "node:crypto";
import { normalizeToolName } from "./auto-capture.js";

/**
 * Notes sent in a row for one tree before the tree is sent again. It limits how
 * long an agent works from one old copy. Results of other tools between the
 * notes are not counted, so it does not bound how far back that copy is.
 */
export const MAX_UNCHANGED_IN_A_ROW = 3;

/**
 * Age of the last full tree past which it is sent again. After an idle gap the
 * conversation may have been cleared or compacted while this process kept
 * running.
 */
export const UNCHANGED_MAX_AGE_MS = 5 * 60_000;

interface SentTree {
  id: string;
  tree: string;
  /** The tool whose result carried the full tree. */
  tool: string;
  sentAt: number;
  /** Notes sent in place of this tree since. */
  notes: number;
}

export interface AfterAction {
  /** The text to append: the tree under its id line, or the note. */
  text: string;
  /** The tree is the one last sent in full for the device, whether or not a note replaced it. */
  identical: boolean;
  /** A note replaced the tree. */
  note: boolean;
}

export interface TreeMemory {
  /**
   * Records a full tree the agent received another way: its own `describe`
   * call. Returns the id to send with it.
   */
  sent(udid: string, tree: string, toolName: string): string;
  /** What to append after an action: the tree, or the note when the agent already has it. */
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
  return `Identical to element tree \`${id}\`, which an earlier \`${tool}\` result returned, so it is not repeated here: take elements and frames from that tree. The action can still have had an effect that the tree does not show, such as text typed in a field. Call \`describe\` if you do not have tree \`${id}\`.`;
}

/** Tells the ids of this process from those of an earlier one in the same conversation. */
function randomTag(): string {
  return randomInt(36 ** 3)
    .toString(36)
    .padStart(3, "0");
}

/**
 * One per MCP session. It holds the last full tree per device, a few kB each.
 * The comparison is a plain string equality: it ends at once when the lengths
 * differ, and otherwise reads both trees once. A hash would read every new tree
 * in full instead.
 */
export function createTreeMemory(
  now: () => number = Date.now,
  tag: string = randomTag()
): TreeMemory {
  const lastSent = new Map<string, SentTree>();
  let count = 0;

  const sent = (udid: string, tree: string, toolName: string): string => {
    const id = `${tag}-${++count}`;
    lastSent.set(udid, { id, tree, tool: normalizeToolName(toolName), sentAt: now(), notes: 0 });
    return id;
  };

  return {
    sent,
    afterAction(udid, tree, toolName) {
      const last = lastSent.get(udid);
      const identical = last !== undefined && last.tree === tree;
      if (
        last !== undefined &&
        identical &&
        last.notes < MAX_UNCHANGED_IN_A_ROW &&
        now() - last.sentAt <= UNCHANGED_MAX_AGE_MS
      ) {
        last.notes += 1;
        return { text: unchangedTreeNote(last.id, last.tool), identical, note: true };
      }
      const id = sent(udid, tree, toolName);
      return { text: `${treeIdLine(id)}\n${tree}`, identical, note: false };
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
