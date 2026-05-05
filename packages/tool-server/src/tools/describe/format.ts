import type { DescribeNode } from "./contract";

// Roles that ARE interactable on their own — they carry signal even without a
// label, because the agent can still tap/scroll them. An unlabelled Button
// surfaces; an unlabelled `View` does not. Anything outside this set is kept
// only when it carries text (label or value) — pure layout containers
// (LinearLayout, AXGroup, …) and decorative leaves (StaticText / Image with
// no label) are dropped and replaced by their useful descendants.
const INTERACTABLE_ROLES = new Set([
  // Android
  "Button",
  "Switch",
  "CheckBox",
  "RadioButton",
  "TextField",
  "ScrollView",
  "WebView",
  // iOS
  "AXButton",
  "AXLink",
  "AXTextField",
  "AXSearchField",
  "AXSwitch",
  "AXAdjustable",
  "AXScrollView",
  "AXTabBar",
  "AXKeyboardKey",
]);

function isUsefulNode(node: DescribeNode): boolean {
  // Has its own text content (accessibility label or input value).
  if (node.label || node.value) return true;
  // Itself a tap/scroll target — surfaces even without a label.
  if (INTERACTABLE_ROLES.has(node.role)) return true;
  // Otherwise: either a noise container (LinearLayout, AXGroup, …) or a
  // text/image-role node carrying no text. In both cases drop the node and
  // let useful descendants surface at the parent's level.
  return false;
}

/**
 * Drop noise containers and flatten layout chains. A non-useful node is
 * replaced by its useful descendants, hoisted to the parent's level. The
 * result is a list of roots — typically multiple, since the synthetic "Screen"
 * (Android) or "AXGroup" (iOS) wrapper at the top is itself filtered out.
 */
export function filterDescribeTree(node: DescribeNode): DescribeNode[] {
  const filteredChildren = node.children.flatMap(filterDescribeTree);
  if (isUsefulNode(node)) {
    return [{ ...node, children: filteredChildren }];
  }
  return filteredChildren;
}

function fmtNum(n: number): string {
  return n.toFixed(2);
}

function escapeQuoted(s: string): string {
  // Single-quote-wrapped values; the only character that must be escaped is
  // the single quote itself. Newlines collapse so each node renders on one
  // line.
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "");
}

function formatNode(node: DescribeNode, depth: number): string {
  const indent = "  ".repeat(depth);
  const f = node.frame;
  const head = `${indent}${node.role} [${fmtNum(f.x)},${fmtNum(f.y)} ${fmtNum(f.width)}x${fmtNum(f.height)}]`;
  const parts: string[] = [head];
  if (node.label) parts.push(`label='${escapeQuoted(node.label)}'`);
  if (node.identifier) parts.push(`id='${escapeQuoted(node.identifier)}'`);
  if (node.value && node.value !== node.label) parts.push(`value='${escapeQuoted(node.value)}'`);
  const lines = [parts.join(" ")];
  for (const c of node.children) {
    lines.push(formatNode(c, depth + 1));
  }
  return lines.join("\n");
}

/**
 * Pretty-print a filtered tree as a text outline. One node per line, in the
 * form `Role [x,y wxh] label='…' id='…' value='…'`, with 2-space indentation
 * per depth. Roles, frames, and labels are the only fields the agent needs to
 * pick a tap target — the prior JSON shape buried that signal under nested
 * layout containers.
 */
export function formatDescribeTreeAsText(roots: DescribeNode[]): string {
  if (roots.length === 0) return "(no elements)";
  return roots.map((r) => formatNode(r, 0)).join("\n");
}
