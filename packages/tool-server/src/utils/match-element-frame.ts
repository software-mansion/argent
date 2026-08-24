import type { Registry } from "@argent/registry";
import type { DescribeNode } from "../tools/describe/contract";
import { describeIos } from "../tools/describe/platforms/ios";
import { describeAndroid } from "../tools/describe/platforms/android";
import { resolveDevice } from "./device-info";
import { isTvOsSimulator } from "./ios-devices";
import type { VariantMatch } from "./variant-proposals";

export interface NormalizedFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Mirror of the preview UI's `vpNormLabel`, so server-side matching resolves the
// same element the floating bubble anchors to.
function normLabel(s: string | undefined): string {
  return (s || "")
    .toLowerCase()
    .replace(/-/g, "")
    .replace(/[\s,]+/g, " ")
    .trim();
}

// Above this fraction of the screen a match is a container (a proposal resolving
// to a root view), not the target element — mirrors the UI's `spotMaxFrameArea`.
const MAX_FRAME_AREA = 0.85;

// Exact hits win: a propose for "Favourites" should anchor the header
// (label === needle), not the "Favourites (5)" tab, a same-text distractor.
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
    default: // "text"
      if (label === needle || ident === needle || value === needle) return { exact: true };
      if (label.includes(needle) || ident.includes(needle) || value.includes(needle)) {
        return { exact: false };
      }
      return null;
  }
}

// Walk the accessibility tree for the on-screen element matching `match`: an
// exact hit beats a substring one, and within a tier the smallest sane, centered
// box wins. `exact` is reported so the caller can hold out for the intended
// element while the screen is still rendering.
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
  candidates.sort((a, b) => (a.exact !== b.exact ? (a.exact ? -1 : 1) : a.area - b.area));
  return { frame: candidates[0].frame, exact: candidates[0].exact };
}

export function matchFrameInTree(tree: DescribeNode, match: VariantMatch): NormalizedFrame | null {
  return findElementMatch(tree, match)?.frame ?? null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retry budget for the warm-up window: for the first ~1s+ after a screen appears
// — navigate → screenshot → propose, exactly the Lens workflow — iOS' AX tree
// comes back empty and, a beat later, half-built (nav chrome before screen
// content), so a single describe matches nothing or only a distractor.
const CAPTURE_ATTEMPTS = 8;
const CAPTURE_RETRY_MS = 300;
// Wall-clock ceiling on the whole retry loop: `attempts × retryMs` bounds it only
// while each describe is near-instant (iOS), not on Android, where 8 attempts on
// the `uiautomator` fallback measured 18-23s. Capping elapsed time needs no
// platform branching — a describe slow enough to spend the budget in one shot has
// already outlasted the warm-up, so its tree is settled.
const CAPTURE_BUDGET_MS = 2_000;

// Resolve the on-screen frame of the matched element by describing the device
// RIGHT NOW (the variant is on screen at propose time). The accessibility tree
// lands incrementally after a screen appears — empty for ~1s+, then nav chrome
// (e.g. the "Favourites" tab) before the screen's own content (the "Favourites"
// header) — so retry across the warm-up window and hold out for an exact hit,
// falling back to a substring match only once the budget is spent; otherwise a
// propose that closely follows navigation captures no frame or a same-text
// distractor. Best-effort: any failure returns null so `propose_variant` never
// fails just because a frame couldn't be auto-captured.
export async function captureElementFrame(
  registry: Registry,
  udid: string,
  match: VariantMatch,
  opts: { attempts?: number; retryMs?: number; budgetMs?: number } = {}
): Promise<NormalizedFrame | null> {
  const attempts = Math.max(1, opts.attempts ?? CAPTURE_ATTEMPTS);
  const retryMs = opts.retryMs ?? CAPTURE_RETRY_MS;
  const budgetMs = opts.budgetMs ?? CAPTURE_BUDGET_MS;
  try {
    const device = resolveDevice(udid);
    // Chromium (CDP) has no adb/sim-server describe path; skipping beats shelling
    // adb against a serial that does not exist.
    if (device.platform === "chromium") return null;
    // Resolved once so describeIos doesn't re-shell `xcrun` per attempt.
    const isTvOs = device.platform === "ios" && (await isTvOsSimulator(device.id));
    let bestPartial: NormalizedFrame | null = null;
    const startedAt = Date.now();
    for (let attempt = 0; attempt < attempts; attempt++) {
      const data =
        device.platform === "ios"
          ? await describeIos(registry, device, {}, { isTvOs })
          : await describeAndroid(registry, udid);
      const tree = data?.tree ?? null;
      const hit = tree ? findElementMatch(tree, match) : null;
      // An exact hit is the intended element; anything less keeps retrying past a
      // half-built tree holding only a same-text distractor.
      if (hit?.exact) return hit.frame;
      if (hit) bestPartial = hit.frame;
      if (attempt >= attempts - 1) break;
      // Bounds the slow-describe (Android `uiautomator`) worst case.
      if (Date.now() - startedAt >= budgetMs) break;
      await delay(retryMs);
    }
    // No exact hit within the budget → best-effort substring match.
    return bestPartial;
  } catch {
    return null;
  }
}
