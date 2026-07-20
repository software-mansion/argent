import type { DescribeNode } from "../describe/contract";
import { hasVisibleText } from "../../utils/ui-tree-match";
import type { MapAction, MapSelector } from "./contract";

/**
 * Action enumeration for the `map-app` crawler: which elements on a screen are
 * worth tapping, in what order, and how each one is re-located at replay time.
 *
 * The filters are deliberately conservative — the crawler's job is breadth
 * (discover screens), not coverage (exercise every control) — so anything that
 * derails a crawl is skipped up front: disabled and invisible elements, text
 * fields (a raised keyboard swallows the next taps), and state-destroying
 * actions (log out / sign out / delete would end the crawl or the account).
 */

export interface EnumerateActionsOptions {
  platform: "ios" | "android";
  /** Hard cap on returned actions (`limits.maxActionsPerScreen`). */
  maxActions: number;
}

// Minimum on-screen area (fraction of the screen) an element needs to be a
// believable tap target: 0.5% — filters zero-size and decorative slivers.
const MIN_TAP_AREA = 0.005;

// State-destroying labels the crawler must never tap.
const DESTRUCTIVE_LABEL = /\b(log ?out|sign ?out|delete)\b/i;

// Sibling-collapse tolerance: elements count as "the same list item shape"
// when their heights AND left edges agree within 1% of the screen.
const COLLAPSE_TOLERANCE = 0.01;
// How many of a repeated run of list items to keep.
const COLLAPSE_KEEP = 3;

/**
 * iOS tappable roles: Button / Link / Cell / Tab / MenuItem-ish, matched as
 * role substrings (the describe adapters emit `AXButton`, `AXLink`, …). The
 * tab BAR itself is excluded — it is the container, its items are the targets.
 * This is the interactive subset of the CONTENT_ROLES thinking in
 * describe/format-tree.ts: content worth *rendering* includes static text and
 * images, content worth *tapping* does not.
 */
function isTappableIosRole(role: string): boolean {
  const r = role.toLowerCase();
  if (r.includes("tabbar")) return false;
  return (
    r.includes("button") ||
    r.includes("link") ||
    r.includes("cell") ||
    r.includes("menuitem") ||
    r.includes("tab")
  );
}

// Text inputs raise the keyboard, which covers the screen and swallows
// subsequent taps — out of scope for the v1 crawler on both platforms.
function isTextInput(node: DescribeNode): boolean {
  if (node.password === true) return true;
  const r = node.role.toLowerCase();
  return (
    r.includes("textfield") ||
    r.includes("searchfield") ||
    r.includes("textarea") ||
    r.includes("edittext") ||
    r.includes("autocompletetextview")
  );
}

function isCandidate(node: DescribeNode, platform: "ios" | "android"): boolean {
  if (node.disabled === true) return false;
  if (node.frame.width * node.frame.height < MIN_TAP_AREA) return false;
  if (isTextInput(node)) return false;
  const text = [node.label, node.value].filter(Boolean).join(" ");
  if (DESTRUCTIVE_LABEL.test(text)) return false;
  // Android marks interactivity explicitly; iOS only through roles.
  return platform === "android" ? node.clickable === true : isTappableIosRole(node.role);
}

/**
 * Collapse repeated list items: within one parent, candidates sharing a role
 * whose heights and left edges agree within tolerance are one visual list —
 * item 4 leads to the same detail screen shape as item 1, so runs longer than
 * {@link COLLAPSE_KEEP} keep only their first 3 (document order). Requiring
 * the left edges to align keeps this to *vertically stacked* lists: a
 * horizontal run of same-height elements (a tab bar's items — each a distinct
 * navigation branch) has distinct x positions and is never collapsed.
 */
function collapseRepeats(
  candidates: Array<{ node: DescribeNode; parent: DescribeNode }>
): DescribeNode[] {
  const kept: DescribeNode[] = [];
  const byParent = new Map<DescribeNode, DescribeNode[]>();
  for (const { node, parent } of candidates) {
    const group = byParent.get(parent);
    if (group) group.push(node);
    else byParent.set(parent, [node]);
  }
  for (const group of byParent.values()) {
    const byRole = new Map<string, DescribeNode[]>();
    for (const node of group) {
      const roleGroup = byRole.get(node.role);
      if (roleGroup) roleGroup.push(node);
      else byRole.set(node.role, [node]);
    }
    for (const roleGroup of byRole.values()) {
      const clusters: Array<{ h: number; x: number; items: DescribeNode[] }> = [];
      for (const node of roleGroup) {
        const cluster = clusters.find(
          (c) =>
            Math.abs(c.h - node.frame.height) <= COLLAPSE_TOLERANCE &&
            Math.abs(c.x - node.frame.x) <= COLLAPSE_TOLERANCE
        );
        if (cluster) cluster.items.push(node);
        else clusters.push({ h: node.frame.height, x: node.frame.x, items: [node] });
      }
      for (const cluster of clusters) {
        kept.push(
          ...(cluster.items.length > COLLAPSE_KEEP
            ? cluster.items.slice(0, COLLAPSE_KEEP)
            : cluster.items)
        );
      }
    }
  }
  return kept;
}

/**
 * The most stable replay handle for a node: identifier if present, else the
 * exact (visibly rendered) label, else the recorded frame. Icon-font labels
 * (Private Use Area glyphs) don't count as text — see `hasVisibleText` — so a
 * glyph-only button replays by frame rather than by an invisible "label".
 */
export function deriveMapSelector(node: DescribeNode): MapSelector {
  const identifier = node.identifier?.trim();
  if (identifier) return { by: "identifier", value: identifier };
  const label = node.label?.trim();
  if (label && hasVisibleText(label)) return { by: "label", value: label };
  return { by: "frame", value: "" };
}

function toAction(node: DescribeNode): MapAction {
  const label = node.label?.trim() || node.identifier?.trim() || node.role;
  return {
    label,
    role: node.role,
    selector: deriveMapSelector(node),
    frame: {
      x: node.frame.x,
      y: node.frame.y,
      w: node.frame.width,
      h: node.frame.height,
    },
  };
}

/**
 * Enumerate the actions the crawler will try on a screen, top-to-bottom then
 * left-to-right, capped at `maxActions`. The synthetic root itself is never a
 * candidate.
 */
export function enumerateActions(root: DescribeNode, opts: EnumerateActionsOptions): MapAction[] {
  const candidates: Array<{ node: DescribeNode; parent: DescribeNode }> = [];
  const walk = (node: DescribeNode, parent: DescribeNode | null): void => {
    if (parent && isCandidate(node, opts.platform)) candidates.push({ node, parent });
    for (const child of node.children) walk(child, node);
  };
  walk(root, null);

  const kept = collapseRepeats(candidates);
  kept.sort((a, b) => a.frame.y - b.frame.y || a.frame.x - b.frame.x);
  return kept.slice(0, opts.maxActions).map(toAction);
}
