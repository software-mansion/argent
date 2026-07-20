import { createHash } from "node:crypto";
import type { DescribeNode } from "../describe/contract";
import { hasVisibleText } from "../../utils/ui-tree-match";

/**
 * Coarse structural screen fingerprinting for the `map-app` crawler.
 *
 * `treeFingerprint` (utils/ui-tree-match) answers "did ANYTHING change" for
 * settle detection, so it includes labels/values and rounds frames to 1e-3.
 * A crawler needs the opposite: two visits to the SAME screen with different
 * dynamic content — feed items, counters, timestamps, usernames — must produce
 * the SAME key, or every revisit mints a phantom new screen and the graph
 * never closes. `screenKey` therefore hashes only the structural skeleton:
 * role + identifier + a coarsely rounded frame per node, labels and values
 * excluded entirely.
 */

/** Frame rounding step: 0.05 of the screen, so sub-5% layout jitter (a badge
 * appearing, a label growing a character) does not split a screen in two. */
function round05(n: number): string {
  return (Math.round(n * 20) / 20).toFixed(2);
}

/**
 * The screen's dedup key: sha1-hex (first 16 chars) over the in-order
 * concatenation of `role|identifier|frame` per node. Same structure with
 * different text ⇒ same key; a structurally different screen ⇒ a new key.
 */
export function screenKey(root: DescribeNode): string {
  const parts: string[] = [];
  const walk = (node: DescribeNode): void => {
    const f = node.frame;
    parts.push(
      `${node.role}|${node.identifier ?? ""}|` +
        `${round05(f.x)},${round05(f.y)},${round05(f.width)},${round05(f.height)}`
    );
    for (const child of node.children) walk(child);
  };
  walk(root);
  return createHash("sha1").update(parts.join("\n")).digest("hex").slice(0, 16);
}

// Roles that suggest a navigation-bar / header text (substring match): the
// screen's own name usually lives in one of these near the top edge.
const HEADERISH_ROLE = /head|nav|toolbar|title/i;

const MAX_TITLE_LENGTH = 80;

/**
 * Best-effort human title for a screen: the first (reading-order) visibly
 * labelled header/nav-ish node in the top 15% of the screen, else the longest
 * label in the top 25%, else null (the store falls back to "Screen N").
 */
export function screenTitle(root: DescribeNode): string | null {
  const labelled: DescribeNode[] = [];
  const walk = (node: DescribeNode): void => {
    const label = node.label?.trim();
    if (label && hasVisibleText(label) && node.frame.width > 0 && node.frame.height > 0) {
      labelled.push(node);
    }
    for (const child of node.children) walk(child);
  };
  // Skip the synthetic full-screen root itself — its label (if any) never
  // names the screen.
  for (const child of root.children) walk(child);

  labelled.sort((a, b) => a.frame.y - b.frame.y || a.frame.x - b.frame.x);

  const headerish = labelled.find((n) => n.frame.y <= 0.15 && HEADERISH_ROLE.test(n.role));
  if (headerish) return clip(headerish.label!.trim());

  const top = labelled.filter((n) => n.frame.y <= 0.25);
  if (top.length > 0) {
    let best = top[0]!;
    for (const n of top) {
      if (n.label!.trim().length > best.label!.trim().length) best = n;
    }
    return clip(best.label!.trim());
  }
  return null;
}

function clip(title: string): string {
  return title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH - 1)}…` : title;
}
