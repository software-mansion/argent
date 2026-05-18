import type { DescribeFrame, DescribeNode } from "./contract";

// Token-efficient view of a pruned DescribeNode tree. The previous shape sent
// the full JSON tree to the agent, which on a typical iOS screen ran ~6× the
// byte cost of this rendering once nested object braces, keys, and indentation
// were counted. Runs after the per-platform adapters (and the Android v2
// trimmer in uiautomator-parser) finish — this layer only re-presents what's
// already in the tree, never drops or merges nodes.
//
// Two rendering modes are picked automatically:
//   - "flat" trees (root → leaves, no grandchildren — what ax-service emits):
//     emit one line per labeled / interactive node, sorted in reading order
//     (top-to-bottom, then left-to-right). Spatial relationships are already
//     fully described by each line's frame, so no grouping or section
//     headers are added.
//   - "nested" trees (uiautomator on Android, or native-devtools fallback):
//     indented DFS so the parent / child structure is visible directly.
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
  // Root → leaves with no grandchildren. This is what the iOS ax-service
  // adapter emits; the flat renderer relies on the assumption that every
  // child is a positioned leaf.
  if (root.children.length === 0) return true;
  return root.children.every((c) => c.children.length === 0);
}

// ---- flat renderer ----

function renderFlat(root: DescribeNode): string[] {
  return root.children
    .filter(hasContent)
    .slice()
    .sort((a, b) => a.frame.y - b.frame.y || a.frame.x - b.frame.x)
    .map((n) => formatLine(n, 1));
}

// ---- nested renderer ----

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
