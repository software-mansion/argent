import type { DescribeNode } from "../describe/contract";
import { hasVisibleText } from "../../utils/ui-tree-match";
import { isScrollDecoration } from "./fingerprint";
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

// Minimum on-screen extent, PER AXIS, for an element to be a believable tap
// target, as a fraction of the screen: hairlines and zero-size decorations are
// thin in one dimension, so each side is tested on its own. An area threshold
// cannot express that — it multiplies the two dimensions together, so it both
// drops small-but-square real buttons (44x44pt, Apple's HIG minimum, is
// 0.1 x 0.046 = 0.0046 of an iPhone 16 Pro Max: under a 0.005 area floor) and
// keeps full-width slivers (1.0 x 0.006 = 0.006: over it). 1% of each axis is
// ~4x10pt on that device, well under any real target and well over any divider.
const MIN_TAP_EXTENT = 0.01;

// State-destroying labels the crawler must never tap.
const DESTRUCTIVE_LABEL = /\b(log ?out|sign ?out|delete)\b/i;

// Identity separators, so a resource-id reads as words for the destructive
// match. `\b` treats `_` as a word character, so `com.app:id/logout_button`
// does NOT match `\blogout\b` on its own — the boundary after "logout" fails
// against the following "_". Splitting on `._:/-` first turns that into
// "com app id logout button", where it does. Kept narrow: "undelete_item" and
// "deleted_items" still fail the boundary and stay tappable.
const IDENTITY_SEPARATORS = /[._:/-]+/g;

// Sibling-collapse tolerance: elements count as "the same list item shape"
// when their heights AND left edges agree within 1% of the screen.
const COLLAPSE_TOLERANCE = 0.01;
// How many of a repeated run of list items to keep.
const COLLAPSE_KEEP = 3;

// Primary navigation — a tab bar / bottom toolbar — is anchored to the bottom
// edge of the screen. An element whose vertical CENTRE falls in this band is
// treated as top-level navigation: each item is a distinct app section, and
// dropping one strands its whole subtree from the crawl. So the action cap
// reserves a share of its budget for these before filling the rest in reading
// order, instead of the plain top-down truncation that a tall feed would use to
// crowd a bottom bar out entirely.
const NAV_BAND_MIN_CENTRE_Y = 0.85;
// Ceiling on the budget share the bottom band may reserve, so a screen that is
// mostly a bottom sheet can't starve the reading-order content the other way.
// Half the budget comfortably holds a typical 3-5 item tab bar.
const NAV_RESERVE_RATIO = 0.5;

/**
 * iOS tappable roles. Both iOS describe adapters derive `role` from the same
 * trait mapper (`mapNativeTraitsToDescribeRole`), whose entire output set is
 * `AXHeading`, `AXButton`, `AXTextField`, `AXLink`, `AXImage`, `AXStaticText`,
 * `AXTabBar`, `AXAdjustable`, `AXGroup` — so only Button and Link name a tap
 * target. `AXTabBar` is the container of a tab bar rather than a target itself,
 * and it carries no per-item role, so its items are reached as whatever traits
 * they individually expose (a tab button arrives as `AXButton`).
 *
 * This is the interactive subset of the CONTENT_ROLES thinking in
 * describe/format-tree.ts: content worth *rendering* includes static text and
 * images, content worth *tapping* does not.
 *
 * Known limitation: a list/collection row that carries no `button` trait
 * arrives as a bare `AXGroup`, indistinguishable from a layout wrapper, so it
 * is not enumerated. Rows built from a pressable (React Native, SwiftUI
 * `Button`) do carry the trait and are covered; a row that only sets
 * `isAccessibilityElement` is not, and that subtree goes unexplored. Treating
 * every `AXGroup` as tappable instead would swamp the per-screen action budget
 * with layout wrappers, so the narrower rule is the deliberate v1 trade-off.
 */
function isTappableIosRole(role: string): boolean {
  const r = role.toLowerCase();
  // `"axtabbar".includes("button")` is false, so the container needs no explicit
  // exclusion — but spell it out: a tab bar is never itself a target.
  if (r.includes("tabbar")) return false;
  return r.includes("button") || r.includes("link");
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
  if (node.frame.width < MIN_TAP_EXTENT || node.frame.height < MIN_TAP_EXTENT) return false;
  if (isTextInput(node)) return false;
  if (isScrollDecoration(node)) return false;
  // `identifier` counts as destructive-label evidence too: an icon-only control
  // often carries no label or value at all, so a resource-id like
  // `com.app:id/logout_button` is the ONLY tell that tapping it ends the
  // session. Checking label/value alone lets exactly those through.
  const text = [node.label, node.value, node.identifier]
    .filter(Boolean)
    .join(" ")
    .replace(IDENTITY_SEPARATORS, " ");
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
 * The most stable replay handle for a node: identifier if present, else its
 * visibly-rendered label or value, else the recorded frame. Mirrors
 * `deriveSelector` (utils/ui-tree-match): label first — a value like "50%" is
 * the volatile part of a control while the label is the stabler anchor — but
 * value is a real fallback, because `matchNode` compares a text selector
 * against label and value separately, so a node whose only stable text is its
 * value (an Android `text` that diverged from `content-desc`, a control whose
 * name renders as the value) is still re-locatable rather than frame-only.
 * Icon-font labels (Private Use Area glyphs) don't count as text — see
 * `hasVisibleText` — so a glyph-only button replays by frame.
 */
export function deriveMapSelector(node: DescribeNode): MapSelector {
  const identifier = node.identifier?.trim();
  if (identifier) return { by: "identifier", value: identifier };
  const text = [node.label, node.value].map((t) => t?.trim()).find((t) => t && hasVisibleText(t));
  if (text) return { by: "label", value: text };
  return { by: "frame", value: "" };
}

function toAction(node: DescribeNode): MapAction {
  const label = node.label?.trim() || node.value?.trim() || node.identifier?.trim() || node.role;
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
 *
 * When the candidates overflow the cap, bottom-anchored primary navigation (a
 * tab bar / bottom toolbar — see {@link NAV_BAND_MIN_CENTRE_Y}) is reserved a
 * capped share of the budget so a top-heavy feed can never truncate the app's
 * top-level sections out of the crawl; the rest of the budget then fills in
 * reading order. The returned actions stay in reading order regardless.
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
  if (kept.length <= opts.maxActions) return kept.map(toAction);

  const isBottomNav = (n: DescribeNode): boolean =>
    n.frame.y + n.frame.height / 2 >= NAV_BAND_MIN_CENTRE_Y;
  const nav = kept.filter(isBottomNav);
  const rest = kept.filter((n) => !isBottomNav(n));
  const reserved = Math.min(nav.length, Math.ceil(opts.maxActions * NAV_RESERVE_RATIO));

  // Guaranteed navigation, then reading-order content, then any leftover budget
  // back to the remaining nav items. Membership is by node identity; the final
  // `kept.filter` restores reading order for the output.
  const chosen = new Set<DescribeNode>(nav.slice(0, reserved));
  for (const node of rest) {
    if (chosen.size >= opts.maxActions) break;
    chosen.add(node);
  }
  for (const node of nav.slice(reserved)) {
    if (chosen.size >= opts.maxActions) break;
    chosen.add(node);
  }
  return kept.filter((n) => chosen.has(n)).map(toAction);
}
