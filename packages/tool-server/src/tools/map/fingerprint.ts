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
 *
 * Known limitation: the skeleton still counts nodes, so a list/feed whose
 * item COUNT differs between two visits keys differently (10 rows vs 11 rows
 * are structurally distinct). Within one crawl the settle + `fetchStableTree`
 * sampling drives both visits to the same fully-loaded state, so the usual
 * trigger (a half-loaded list) is absorbed; only a genuinely live feed that
 * mutates between visits can still mint a few duplicate nodes — a bounded
 * quality cost no purely-structural or text-based fingerprint can avoid.
 */

/** Frame rounding step: 0.05 of the screen, so sub-5% layout jitter (a badge
 * appearing, a label growing a character) does not split a screen in two. */
function round05(n: number): string {
  return (Math.round(n * 20) / 20).toFixed(2);
}

/**
 * Transient scroll-indicator overlays. iOS exposes them as plain `AXGroup`s
 * whose label is the only tell ("Vertical scroll bar, 2 pages"), and they come
 * and go with the indicator's fade — so screen identity, titles, and action
 * enumeration must all ignore them or the same screen flips fingerprints
 * between visits.
 */
export function isScrollDecoration(node: DescribeNode): boolean {
  return /^(vertical|horizontal) scroll bar\b/i.test(node.label?.trim() ?? "");
}

/**
 * Count of the nodes that contribute to `screenKey` — every node EXCEPT the
 * scroll-decoration overlays the key excludes (matching `screenKey`'s own walk:
 * the decoration node itself is skipped, its children still count). This is the
 * "fullness" metric `fetchStableTree` picks its best sample by, so fullness is
 * measured over the SAME node set the fingerprint keys on: a fading scroll
 * indicator — counted by a raw node walk but ignored by the key — can no longer
 * bias the capture toward a lower-CONTENT snapshot whose key then flips between
 * visits.
 */
export function screenNodeCount(root: DescribeNode): number {
  let n = 0;
  const walk = (node: DescribeNode): void => {
    if (!isScrollDecoration(node)) n += 1;
    for (const child of node.children) walk(child);
  };
  walk(root);
  return n;
}

/**
 * The screen's dedup key: sha1-hex (first 16 chars) over the in-order
 * concatenation of `role|identifier|frame` per node. Same structure with
 * different text ⇒ same key; a structurally different screen ⇒ a new key.
 */
export function screenKey(root: DescribeNode): string {
  const parts: string[] = [];
  const walk = (node: DescribeNode): void => {
    if (!isScrollDecoration(node)) {
      const f = node.frame;
      parts.push(
        `${node.role}|${node.identifier ?? ""}|` +
          `${round05(f.x)},${round05(f.y)},${round05(f.width)},${round05(f.height)}`
      );
    }
    for (const child of node.children) walk(child);
  };
  walk(root);
  return createHash("sha1").update(parts.join("\n")).digest("hex").slice(0, 16);
}

// Roles that suggest a navigation-bar / header text (substring match): the
// screen's own name usually lives in one of these near the top edge — but
// roles are unreliable (iOS renders the Settings large title as a bare
// AXGroup), so this is a preference between geometric candidates, not a
// requirement.
const HEADERISH_ROLE = /head|nav|toolbar|title/i;

const MAX_TITLE_LENGTH = 80;

// Title candidates live in the top band of the screen and look like a text
// row: thin (a scroll bar is a 0.8-tall edge strip, a hero banner 0.1+), and
// wide enough to be prose rather than an icon button.
const TITLE_MAX_Y = 0.2;
const TITLE_MAX_HEIGHT = 0.08;
const TITLE_MIN_HEIGHT = 0.01;
const TITLE_MIN_WIDTH = 0.1;
// Candidates within this y-distance of the topmost one count as the same
// visual bar (an iOS nav bar holds the back label AND the centred title).
const TITLE_BAND = 0.03;
// A screen name is short; prefer it over same-band prose like a subtitle.
const TITLE_SHORT_LENGTH = 45;
// Navigation chrome that shares the title bar but never names the screen —
// a sheet whose band holds only "Cancel" is better off as "Screen N".
const CHROME_LABEL = /^(back|cancel|close|done|dismiss)$/i;

/**
 * Best-effort human title for a screen. Geometric, not role-based: among
 * visibly labelled thin rows in the top band, take the topmost bar and pick
 * the most horizontally centred label (an iOS nav bar centres the screen name
 * while the back button hugs the left edge — sorting by position alone would
 * name every pushed screen after its parent). Headerish-roled candidates win
 * outright when present; null when nothing qualifies (the store falls back to
 * "Screen N").
 */
export function screenTitle(root: DescribeNode): string | null {
  const candidates: DescribeNode[] = [];
  const walk = (node: DescribeNode): void => {
    const label = node.label?.trim();
    if (
      label &&
      hasVisibleText(label) &&
      !isScrollDecoration(node) &&
      !CHROME_LABEL.test(label) &&
      node.frame.y <= TITLE_MAX_Y &&
      node.frame.height >= TITLE_MIN_HEIGHT &&
      node.frame.height <= TITLE_MAX_HEIGHT &&
      node.frame.width >= TITLE_MIN_WIDTH
    ) {
      candidates.push(node);
    }
    for (const child of node.children) walk(child);
  };
  // Skip the synthetic full-screen root itself — its label (if any) never
  // names the screen.
  for (const child of root.children) walk(child);
  if (candidates.length === 0) return null;

  const headerish = candidates.filter((n) => HEADERISH_ROLE.test(n.role));
  const pool = headerish.length > 0 ? headerish : candidates;

  const topY = Math.min(...pool.map((n) => n.frame.y));
  const band = pool.filter((n) => n.frame.y <= topY + TITLE_BAND);
  const centredness = (n: DescribeNode): number => Math.abs(n.frame.x + n.frame.width / 2 - 0.5);
  band.sort((a, b) => {
    const shortA = a.label!.trim().length <= TITLE_SHORT_LENGTH ? 0 : 1;
    const shortB = b.label!.trim().length <= TITLE_SHORT_LENGTH ? 0 : 1;
    return shortA - shortB || centredness(a) - centredness(b);
  });
  return clip(band[0]!.label!.trim());
}

function clip(title: string): string {
  return title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH - 1)}…` : title;
}
