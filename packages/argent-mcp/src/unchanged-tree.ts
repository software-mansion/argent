/**
 * Shrinks or omits an element tree the agent already has. The tree appended
 * after an interaction is often identical to, or differs by only a few lines
 * from, the last full tree (a wait, a toggle, typing into a field, a swipe at
 * the end of a list), and every full copy stays in context for the rest of the
 * session. An identical tree is replaced by a note; a slightly changed tree is
 * replaced by an order-preserving cumulative `-` / `+` line diff against the
 * last full tree.
 *
 * The id is what makes both notes and diffs safe. This process cannot tell
 * which agent on the connection received a tree (a parent and its subagents
 * share one), nor whether a client still holds an old result. Every diff is
 * computed purely against one named full tree rather than chained across turns,
 * so an agent only ever applies one diff on top of the id it holds — and if it
 * does not find that id in its context, it knows to call `describe`. When a
 * later tree reverts or drops lines from a prior diff (including returning to
 * the base tree after a diff), we send a fresh full tree instead of expecting
 * the agent to notice the silence or chaining off the previous turn.
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

/** Upper bound on Myers edit distance before falling back to the full tree. */
const MAX_EDIT_DISTANCE = 256;

/** Unchanged lines shown before and after each diff hunk to disambiguate duplicates/order. */
const CONTEXT_LINES = 1;

type TreeRenderMode = "full" | "diff" | "unchanged";

interface PriorDiffLines {
  removed: string[];
  added: string[];
}

interface SentTree {
  id: string;
  tree: string;
  /** The tool whose result carried the full tree. */
  tool: string;
  sentAt: number;
  /** Non-full results (notes or diffs) sent in place of this tree since. */
  shortResults: number;
  /**
   * Removed/added lines of the last diff emitted against `tree`, or `null` if
   * no diff has been emitted since `tree` was sent in full. Used solely as a
   * monotonicity guard: if a later step reverts or drops any of these lines
   * (including returning to `tree` itself), we fall back to a fresh full tree.
   */
  priorDiff: PriorDiffLines | null;
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
  return `Diff against \`${id}\` (\`${tool}\`) — all other lines match \`${id}\` (- gone, + new; call \`describe\` if you lack \`${id}\`):`;
}

function countLines(lines: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
}

/** True when every line in `subset` appears at least as many times in `superset`. */
function isMultisetSubset(subset: readonly string[], superset: readonly string[]): boolean {
  if (subset.length === 0) return true;
  if (subset.length > superset.length) return false;
  const counts = countLines(superset);
  for (const line of subset) {
    const left = counts.get(line) ?? 0;
    if (left === 0) return false;
    counts.set(line, left - 1);
  }
  return true;
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

type EditOp = { kind: "eq" | "del" | "ins"; line: string };

/**
 * Order-preserving shortest edit script (Myers O((n+m)*D)) bounded by `maxD`.
 * Returns `null` when more than `maxD` single-line edits are needed.
 */
function myersDiff(a: readonly string[], b: readonly string[], maxD: number): EditOp[] | null {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(maxD, n + m);
  const offset = limit;
  const v = new Int32Array(2 * limit + 1);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
        x = v[offset + k + 1]!;
      } else {
        x = v[offset + k - 1]! + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x === n && y === m) {
        const ops: EditOp[] = [];
        let bx = n;
        let by = m;
        for (let step = d; step > 0; step--) {
          const prevV = trace[step]!;
          const bk = bx - by;
          const prevK =
            bk === -step || (bk !== step && prevV[offset + bk - 1]! < prevV[offset + bk + 1]!)
              ? bk + 1
              : bk - 1;
          const prevX = prevV[offset + prevK]!;
          const prevY = prevX - prevK;
          while (bx > prevX && by > prevY) {
            bx--;
            by--;
            ops.push({ kind: "eq", line: a[bx]! });
          }
          if (bx === prevX) {
            by--;
            ops.push({ kind: "ins", line: b[by]! });
          } else {
            bx--;
            ops.push({ kind: "del", line: a[bx]! });
          }
        }
        while (bx > 0 && by > 0) {
          bx--;
          by--;
          ops.push({ kind: "eq", line: a[bx]! });
        }
        ops.reverse();
        return ops;
      }
    }
  }
  return null;
}

function diffLines(before: readonly string[], after: readonly string[]): EditOp[] | null {
  let prefix = 0;
  const minLen = Math.min(before.length, after.length);
  while (prefix < minLen && before[prefix] === after[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }

  const midBefore = before.slice(prefix, before.length - suffix);
  const midAfter = after.slice(prefix, after.length - suffix);
  const midOps =
    midBefore.length === 0 && midAfter.length === 0
      ? []
      : myersDiff(midBefore, midAfter, MAX_EDIT_DISTANCE);
  if (midOps === null) return null;

  const ops: EditOp[] = [];
  for (let i = 0; i < prefix; i++) ops.push({ kind: "eq", line: before[i]! });
  for (const op of midOps) ops.push(op);
  for (let i = before.length - suffix; i < before.length; i++) {
    ops.push({ kind: "eq", line: before[i]! });
  }
  return ops;
}

function renderHunks(ops: readonly EditOp[]): string[] {
  const visible = new Uint8Array(ops.length);
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.kind === "eq") continue;
    const start = Math.max(0, i - CONTEXT_LINES);
    const end = Math.min(ops.length - 1, i + CONTEXT_LINES);
    for (let j = start; j <= end; j++) visible[j] = 1;
  }

  const out: string[] = [];
  let inHunk = false;
  let hadHunk = false;
  for (let i = 0; i < ops.length; i++) {
    if (!visible[i]) {
      inHunk = false;
      continue;
    }
    if (!inHunk) {
      if (hadHunk) out.push("...");
      inHunk = true;
      hadHunk = true;
    }
    const op = ops[i]!;
    if (op.kind === "del") out.push(`- ${op.line}`);
    else if (op.kind === "ins") out.push(`+ ${op.line}`);
    else out.push(`  ${op.line}`);
  }
  return out;
}

function splitTreeLines(tree: string): string[] {
  // Drop a single trailing newline so the last content line is not followed by a
  // phantom empty line, while preserving interior blank lines and exact order.
  const trimmed = tree.endsWith("\n") ? tree.slice(0, -1) : tree;
  return trimmed.split("\n");
}

interface TreeDiffResult {
  mode: "unchanged" | "diff";
  text: string;
  removed: string[];
  added: string[];
}

function computeTreeDiff(
  base: string,
  next: string,
  id: string,
  tool: string
): TreeDiffResult | null {
  if (treeMetaSignature(base) !== treeMetaSignature(next)) return null;
  if (base === next) {
    return { mode: "unchanged", text: unchangedTreeNote(id, tool), removed: [], added: [] };
  }
  const before = splitTreeLines(base);
  const after = splitTreeLines(next);
  const ops = diffLines(before, after);
  if (ops === null) return null;

  const removed: string[] = [];
  const added: string[] = [];
  for (const op of ops) {
    if (op.kind === "del") removed.push(op.line);
    else if (op.kind === "ins") added.push(op.line);
  }
  if (removed.length === 0 && added.length === 0) {
    // Only trailing-newline formatting differed (not line content or order).
    return { mode: "unchanged", text: unchangedTreeNote(id, tool), removed, added };
  }

  const text = [treeDiffHeader(id, tool), ...renderHunks(ops)].join("\n");
  if (text.length > Math.floor(next.length * MAX_DIFF_RATIO)) return null;
  return { mode: "diff", text, removed, added };
}

/**
 * Computes an order-preserving `-` / `+` line diff (with surrounding context)
 * from `base` to `next`. Returns `null` when metadata changed, when line edits
 * exceed the bound, or when the diff exceeds `MAX_DIFF_RATIO` of `next`.
 */
export function formatTreeDiff(
  base: string,
  next: string,
  id: string,
  tool: string
): { mode: "unchanged" | "diff"; text: string } | null {
  const diff = computeTreeDiff(base, next, id, tool);
  return diff ? { mode: diff.mode, text: diff.text } : null;
}

/** Tells the ids of this process from those of an earlier one in the same conversation. */
function randomTag(): string {
  return randomInt(36 ** 3)
    .toString(36)
    .padStart(3, "0");
}

/**
 * One per MCP session. It holds the last full tree per device, a few kB each.
 * An exact equality check runs first so identical trees skip diffing.
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
      tool: normalizeToolName(toolName),
      sentAt: now(),
      shortResults: 0,
      priorDiff: null,
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
          // Returning to the base tree after a diff is a revert (e.g. toggling
          // a switch on then off): send the full tree instead of an unchanged
          // note so the agent never assumes the earlier diff still applies.
          if (last.priorDiff === null) {
            last.shortResults += 1;
            return {
              text: unchangedTreeNote(last.id, last.tool),
              mode: "unchanged",
              identical: true,
              note: true,
            };
          }
        } else {
          const diff = computeTreeDiff(last.tree, tree, last.id, last.tool);
          if (diff !== null) {
            if (diff.mode === "unchanged") {
              if (last.priorDiff === null) {
                last.shortResults += 1;
                return {
                  text: diff.text,
                  mode: "unchanged",
                  identical: true,
                  note: true,
                };
              }
            } else {
              const monotonic =
                last.priorDiff === null ||
                (isMultisetSubset(last.priorDiff.removed, diff.removed) &&
                  isMultisetSubset(last.priorDiff.added, diff.added));
              if (monotonic) {
                last.shortResults += 1;
                last.priorDiff = { removed: diff.removed, added: diff.added };
                return {
                  text: diff.text,
                  mode: "diff",
                  identical: false,
                  note: false,
                };
              }
            }
          }
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
