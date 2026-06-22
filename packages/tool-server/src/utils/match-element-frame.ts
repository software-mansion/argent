import type { Registry } from "@argent/registry";
import type { DescribeNode } from "../tools/describe/contract";
import { describeIos } from "../tools/describe/platforms/ios";
import { describeAndroid } from "../tools/describe/platforms/android";
import { resolveDevice } from "./device-info";
import type { VariantMatch } from "./variant-proposals";

export interface NormalizedFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Mirror of the preview UI's `vpNormLabel` so server-side matching resolves the
// same element the floating bubble anchors to: lowercase, drop hyphens, collapse
// whitespace/commas, trim.
function normLabel(s: string | undefined): string {
  return (s || "")
    .toLowerCase()
    .replace(/-/g, "")
    .replace(/[\s,]+/g, " ")
    .trim();
}

// Matches above this fraction of the screen are treated as containers (a
// proposal accidentally resolving to a root view), not the target element —
// mirrors the UI's `spotMaxFrameArea` guard.
const MAX_FRAME_AREA = 0.85;

// Whether a node matches, and whether that match is EXACT (the whole normalized
// label/identifier/value equals the needle) rather than a looser substring.
// Exact hits win: a propose for "Favourites" should anchor the header
// (label === needle), not the "Favourites (5)" tab (a same-text distractor).
function matchNode(
  n: DescribeNode,
  match: VariantMatch,
  needle: string
): { exact: boolean } | null {
  const label = normLabel(n.label);
  const ident = normLabel(n.identifier);
  const value = normLabel(n.value);
  const role = (n.role || "").toLowerCase();
  switch (match.by) {
    case "label":
      if (label === needle) return { exact: true };
      return label.includes(needle) ? { exact: false } : null;
    case "identifier":
      return ident === needle ? { exact: true } : null;
    case "role":
      return role === needle ? { exact: true } : null;
    default: // "text" — exact across label/identifier/value, else substring
      if (label === needle || ident === needle || value === needle) return { exact: true };
      if (label.includes(needle) || ident.includes(needle) || value.includes(needle)) {
        return { exact: false };
      }
      return null;
  }
}

// Walk the accessibility tree for the on-screen element matching `match`. An
// exact hit always beats a substring one; within a tier the smallest sane,
// centered box wins (the same selection the preview UI's `vpMatchNode` makes).
// `exact` is reported so the caller can hold out for the intended element while
// the screen is still rendering. Returns null when nothing matches.
export function findElementMatch(
  tree: DescribeNode,
  match: VariantMatch
): { frame: NormalizedFrame; exact: boolean } | null {
  const needle = normLabel(match.value);
  if (!needle) return null;
  const candidates: { frame: NormalizedFrame; area: number; exact: boolean }[] = [];
  const walk = (n: DescribeNode | null | undefined): void => {
    if (!n || typeof n !== "object") return;
    const m = matchNode(n, match, needle);
    if (m && n.frame) {
      const f = n.frame;
      const cx = f.x + f.width / 2;
      const cy = f.y + f.height / 2;
      const area = f.width * f.height;
      if (
        f.width > 0 &&
        f.height > 0 &&
        cx >= 0 &&
        cx <= 1 &&
        cy >= 0 &&
        cy <= 1 &&
        area <= MAX_FRAME_AREA
      ) {
        candidates.push({
          frame: { x: f.x, y: f.y, width: f.width, height: f.height },
          area,
          exact: m.exact,
        });
      }
    }
    if (Array.isArray(n.children)) n.children.forEach(walk);
  };
  walk(tree);
  if (candidates.length === 0) return null;
  // Exact beats substring; within a tier, the smallest sane box wins.
  candidates.sort((a, b) => (a.exact !== b.exact ? (a.exact ? -1 : 1) : a.area - b.area));
  return { frame: candidates[0].frame, exact: candidates[0].exact };
}

// Frame-only convenience (exact-preferred). Returns null when nothing matches.
export function matchFrameInTree(tree: DescribeNode, match: VariantMatch): NormalizedFrame | null {
  return findElementMatch(tree, match)?.frame ?? null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retry budget for the warm-up window. For the first ~1s+ after a screen appears
// — navigate → screenshot → propose, exactly the Lens workflow — iOS' AX tree
// comes back empty and, a beat later, half-built (nav chrome before screen
// content), so a single describe matches nothing or only a distractor. 8 ×
// ~300ms comfortably spans that window.
const CAPTURE_ATTEMPTS = 8;
const CAPTURE_RETRY_MS = 300;

// Resolve the on-screen frame of the matched element for the device the agent
// proposed against, by describing it RIGHT NOW (the variant is on screen at
// propose time) and matching. The accessibility tree lands incrementally after a
// screen appears — empty for ~1s+, then nav chrome (e.g. the "Favourites" tab)
// before the screen's own content (the "Favourites" header). So we retry across
// the warm-up window and HOLD OUT for an exact hit (the intended element), only
// falling back to a substring match once the budget is spent — otherwise a
// propose that closely follows navigation either captures no frame or anchors to
// a same-text distractor. Best-effort: any failure returns null so
// `propose_variant` never fails just because a frame couldn't be auto-captured.
export async function captureElementFrame(
  registry: Registry,
  udid: string,
  match: VariantMatch,
  opts: { attempts?: number; retryMs?: number } = {}
): Promise<NormalizedFrame | null> {
  const attempts = Math.max(1, opts.attempts ?? CAPTURE_ATTEMPTS);
  const retryMs = opts.retryMs ?? CAPTURE_RETRY_MS;
  try {
    const device = resolveDevice(udid);
    // Chromium (CDP) devices have no adb/sim-server describe path; skip frame
    // auto-capture rather than shelling adb against a non-existent serial.
    if (device.platform === "chromium") return null;
    let bestPartial: NormalizedFrame | null = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const data =
        device.platform === "ios"
          ? await describeIos(registry, device, {})
          : await describeAndroid(registry, udid);
      const tree = data?.tree ?? null;
      const hit = tree ? findElementMatch(tree, match) : null;
      // An exact hit is the intended element — take it at once. This is what
      // skips a half-built tree where only a same-text distractor exists yet.
      if (hit?.exact) return hit.frame;
      if (hit) bestPartial = hit.frame;
      if (attempt < attempts - 1) await delay(retryMs);
    }
    // No exact hit within the budget → best-effort substring match (or null).
    return bestPartial;
  } catch {
    return null;
  }
}
