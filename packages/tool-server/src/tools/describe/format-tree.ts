import type { DescribeFrame, DescribeNode } from "./contract";

// Token-efficient view of a pruned DescribeNode tree. The previous shape sent
// the full JSON tree to the agent, which on a typical iOS screen ran ~6× the
// byte cost of this rendering once nested object braces, keys, and indentation
// were counted. Runs after the per-platform adapters (and the Android v2
// trimmer in uiautomator-parser) finish — this layer only re-presents what's
// already in the tree, never drops or merges nodes.
//
// Two rendering modes are picked automatically:
//   - "flat" trees (AXGroup root with no grandchildren — what ax-service returns
//     on iOS): bucket by y into screen zones, then split the bottom zone into
//     keyboard rows by rounded y. This produces the same shape as the hand-
//     formatted iOS output an agent gets used to seeing.
//   - "nested" trees (uiautomator on Android, or native-devtools fallback that
//     produces hierarchy): indented DFS, one labeled / interactive node per line.
// The chosen mode is reported at the top so a consumer that wants to re-parse
// the formatted text can branch on it.

function clampFinite(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

function fmtFrame(f: DescribeFrame): string {
  return `(${clampFinite(f.x).toFixed(3)}, ${clampFinite(f.y).toFixed(3)}, ${clampFinite(
    f.width
  ).toFixed(3)}, ${clampFinite(f.height).toFixed(3)})`;
}

function escapeForLine(s: string): string {
  // Embedded newlines / tabs in labels break the per-line alignment that callers
  // grep against. Backslash-escape rather than strip so the original character is
  // recoverable when an agent passes the line back through a parser.
  return s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
}

function formatLabel(label: string | undefined): string {
  if (!label) return "";
  return `"${escapeForLine(label)}"`;
}

function formatAttr(name: string, value: string | undefined): string {
  if (!value) return "";
  return ` ${name}="${escapeForLine(value)}"`;
}

function formatFlags(n: DescribeNode): string {
  const flags: string[] = [];
  if (n.clickable) flags.push("clickable");
  if (n.longClickable) flags.push("long-clickable");
  if (n.scrollable) flags.push("scrollable");
  if (n.checkable) flags.push(n.checked ? "checked" : "checkable");
  if (n.disabled) flags.push("disabled");
  if (n.password) flags.push("password");
  if (typeof n.scrollHidden === "number" && n.scrollHidden > 0) {
    flags.push(`scrollHidden=${n.scrollHidden}`);
  }
  return flags.length === 0 ? "" : ` [${flags.join(",")}]`;
}

function hasContent(n: DescribeNode): boolean {
  return Boolean(
    n.label ||
    n.value ||
    n.identifier ||
    n.clickable ||
    n.longClickable ||
    n.scrollable ||
    n.checkable ||
    (typeof n.scrollHidden === "number" && n.scrollHidden > 0)
  );
}

function formatLine(n: DescribeNode, indent: number): string {
  const pad = "  ".repeat(indent);
  const role = n.role.padEnd(12);
  const labelPart = formatLabel(n.label);
  const valuePart = formatAttr("value", n.value);
  const idPart = formatAttr("id", n.identifier);
  const flagPart = formatFlags(n);
  return `${pad}${role} ${labelPart}${valuePart}${idPart}${flagPart}  ${fmtFrame(n.frame)}`;
}

function isFlatTree(root: DescribeNode): boolean {
  // A flat tree is one with only root → leaves. This is what the iOS
  // ax-service adapter emits today; treating it as flat lets us use the
  // zone-based layout, which is far more legible than a 50-item indented list.
  if (root.children.length === 0) return true;
  return root.children.every((c) => c.children.length === 0);
}

// ---- flat (iOS-style) renderer ----

// Zone boundaries are tuned for portrait phones with the standard iOS keyboard
// surface (~y >= 0.66). On iPad / landscape, the formatter still renders — but
// the section headers become "Body" / "Bottom" without further keyboard
// splitting since the row-detection heuristic only fires for tight y clusters.
const ZONE_TOP_MAX = 0.15;
const ZONE_BODY_MAX = 0.5;
// 0.66 ceiling so the iOS predictive bar (AXTabBar elements at y≈0.62) and any
// other content sitting between the composer and the keyboard land in the action
// zone rather than the catch-all "Other" section.
const ZONE_ACTION_MAX = 0.66;
const ZONE_KEYBOARD_MIN = 0.66;

type Zone = "top" | "body" | "action" | "keyboard" | "other";

function zoneOf(n: DescribeNode): Zone {
  const y = n.frame.y;
  if (y < ZONE_TOP_MAX) return "top";
  if (y < ZONE_BODY_MAX) return "body";
  if (y < ZONE_ACTION_MAX) return "action";
  if (y >= ZONE_KEYBOARD_MIN) return "keyboard";
  return "other";
}

const ZONE_TITLES: Record<Zone, string> = {
  top: "Top bar",
  body: "Body / content",
  action: "Composer / predictive / action bar",
  keyboard: "Bottom / keyboard",
  other: "Other",
};

function classifyKeyboardRow(items: DescribeNode[]): string {
  const labels = items.map((i) => i.label ?? "");
  if (labels.some((l) => l === "Dictate" || l === "Next keyboard")) return "globe / dictate";
  if (labels.some((l) => l === "return")) return "numbers / emoji / space / return";
  if (labels.some((l) => l === "shift")) return "shift + letters + delete";
  const onlyLetters = labels.filter((l) => l.length > 0).every((l) => l.length <= 2);
  if (onlyLetters && labels.some((l) => l.length === 1)) return "letters";
  return "row";
}

function renderFlat(root: DescribeNode): string[] {
  const lines: string[] = [];
  const interesting = root.children.filter(hasContent);

  const byZone = new Map<Zone, DescribeNode[]>();
  for (const n of interesting) {
    const z = zoneOf(n);
    if (!byZone.has(z)) byZone.set(z, []);
    byZone.get(z)!.push(n);
  }

  const orderedZones: Zone[] = ["top", "body", "action"];
  for (const z of orderedZones) {
    const items = byZone.get(z);
    if (!items?.length) continue;
    items.sort((a, b) => a.frame.y - b.frame.y || a.frame.x - b.frame.x);
    lines.push(`— ${ZONE_TITLES[z]} —`);
    for (const n of items) lines.push(formatLine(n, 1));
    lines.push("");
  }

  // Keyboard zone: subdivide by row using rounded y. iOS QWERTY rows are
  // ~0.062 tall and exactly aligned, so rounding to two decimals collapses
  // each row to a single bucket. Any other "bottom" cluster (e.g. iPad
  // toolbar) falls into one row bucket and renders as a single section.
  const keyboard = byZone.get("keyboard");
  if (keyboard?.length) {
    const rows = new Map<number, DescribeNode[]>();
    for (const n of keyboard) {
      const key = Math.round(n.frame.y * 100);
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key)!.push(n);
    }
    const orderedKeys = [...rows.keys()].sort((a, b) => a - b);
    let idx = 1;
    for (const k of orderedKeys) {
      const row = rows.get(k)!.sort((a, b) => a.frame.x - b.frame.x);
      const cat = classifyKeyboardRow(row);
      lines.push(`— Bottom row ${idx}: ${cat} —`);
      for (const n of row) lines.push(formatLine(n, 1));
      lines.push("");
      idx++;
    }
  }

  const other = byZone.get("other");
  if (other?.length) {
    other.sort((a, b) => a.frame.y - b.frame.y || a.frame.x - b.frame.x);
    lines.push("— Other —");
    for (const n of other) lines.push(formatLine(n, 1));
    lines.push("");
  }

  return lines;
}

// ---- nested (Android-style) renderer ----

function renderNested(root: DescribeNode): string[] {
  const lines: string[] = [];
  // Iterative DFS so very deep Compose / RN trees don't risk a stack overflow.
  type Frame = { node: DescribeNode; depth: number };
  const stack: Frame[] = [{ node: root, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth === 0 || hasContent(node) || node.children.length > 0) {
      lines.push(formatLine(node, depth));
    }
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push({ node: node.children[i]!, depth: depth + 1 });
    }
  }
  return lines;
}

export interface FormatDescribeOptions {
  source?: string;
}

export function formatDescribeTree(root: DescribeNode, opts: FormatDescribeOptions = {}): string {
  const mode: "flat" | "nested" = isFlatTree(root) ? "flat" : "nested";
  const header: string[] = [];
  if (opts.source) header.push(`Source: ${opts.source}`);
  header.push(`Mode: ${mode}`);
  header.push(
    "Coordinates are normalized [0,1] fractions of the screen (x, y, width, height), " +
      "not pixels — pass them straight to gesture-tap / gesture-swipe / gesture-pinch, " +
      "which expect this same space. " +
      "To tap an element, use its centre: tap_x = frame.x + frame.width / 2, " +
      "tap_y = frame.y + frame.height / 2."
  );
  header.push("");
  header.push(`ROOT  ${root.role} ${fmtFrame(root.frame)}`);
  header.push("");

  const body = mode === "flat" ? renderFlat(root) : renderNested(root);
  return [...header, ...body].join("\n").replace(/\n+$/, "\n");
}
