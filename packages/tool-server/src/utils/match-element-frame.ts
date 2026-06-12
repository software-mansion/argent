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
const MAX_FRAME_AREA = 0.8;

function nodeMatches(n: DescribeNode, match: VariantMatch, needle: string): boolean {
  if (!needle) return false;
  const label = normLabel(n.label);
  const ident = normLabel(n.identifier);
  const value = normLabel(n.value);
  const role = (n.role || "").toLowerCase();
  switch (match.by) {
    case "label":
      return label === needle || label.includes(needle);
    case "identifier":
      return ident === needle;
    case "role":
      return role === needle;
    default: // "text" — fuzzy contains across label / identifier / value
      return label.includes(needle) || ident.includes(needle) || value.includes(needle);
  }
}

// Walk the accessibility tree and return the smallest on-screen element whose
// frame is a sane, centered box — the same selection the preview UI's
// `vpMatchNode` makes. Returns null when nothing matches.
export function matchFrameInTree(tree: DescribeNode, match: VariantMatch): NormalizedFrame | null {
  const needle = normLabel(match.value);
  let best: NormalizedFrame | null = null;
  let bestArea = Infinity;
  const walk = (n: DescribeNode | null | undefined): void => {
    if (!n || typeof n !== "object") return;
    if (nodeMatches(n, match, needle) && n.frame) {
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
        area <= MAX_FRAME_AREA &&
        area < bestArea
      ) {
        bestArea = area;
        best = { x: f.x, y: f.y, width: f.width, height: f.height };
      }
    }
    if (Array.isArray(n.children)) n.children.forEach(walk);
  };
  walk(tree);
  return best;
}

// Resolve the on-screen frame of the matched element for the device the agent
// proposed against, by describing it RIGHT NOW (the variant is on screen at
// propose time) and matching. Best-effort: any failure returns null so
// `propose_variant` never fails just because a frame couldn't be auto-captured.
export async function captureElementFrame(
  registry: Registry,
  udid: string,
  match: VariantMatch
): Promise<NormalizedFrame | null> {
  try {
    const device = resolveDevice(udid);
    const data =
      device.platform === "ios"
        ? await describeIos(registry, device, {})
        : await describeAndroid(registry, udid);
    if (!data?.tree) return null;
    return matchFrameInTree(data.tree, match);
  } catch {
    return null;
  }
}
