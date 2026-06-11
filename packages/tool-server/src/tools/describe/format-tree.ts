import type { DescribeFrame, DescribeNode, DescribeSource } from "./contract";

// Token-efficient view of a pruned DescribeNode tree. The previous shape sent
// the full JSON tree to the agent, which on a typical iOS screen ran ~6× the
// byte cost of this rendering once nested object braces, keys, and indentation
// were counted. Runs after the per-platform adapters (and the Android v2
// trimmer in uiautomator-parser) finish — this layer only re-presents what's
// already in the tree, never drops or merges nodes.
//
// Mode is decided by the originating `source`, not the tree silhouette:
//   - "ax-service" and "native-devtools" (the iOS providers) emit a flat list
//     of leaves under a synthetic root; the flat renderer sorts those in
//     reading order (top-to-bottom, then left-to-right).
//   - "uiautomator" and "android-devtools" (Android) emit a real parent/child
//     tree; the nested renderer is an iterative DFS that preserves depth via
//     indentation.
// Picking by source (rather than checking `every child has no grandchildren`)
// keeps behaviour stable for callers that diff two close-in-time describes —
// a single accidental grandchild used to flip an ax-service response into
// nested mode discontinuously.
//
// What gets emitted: any node with a "content" role (AXButton, AXImage,
// AXStaticText, …) is printed even when its label is empty, so an icon-only
// button or an undecorated image still surfaces as `AXImage  (frame)`. Pure
// container roles (AXGroup, RCTView, …) only print when they carry their own
// label / value / identifier / interactivity flag, OR (in nested mode) when
// they have descendants worth showing.

const CONTENT_ROLES = new Set([
  // iOS AX traits surfaced by mapNativeTraitsToDescribeRole. AXGroup is
  // deliberately excluded: it's the catch-all wrapper, so requiring it to
  // carry its own label/value before we emit a line keeps decorative
  // groupings out of the output.
  "AXButton",
  "AXStaticText",
  "AXImage",
  "AXLink",
  "AXTextField",
  "AXHeading",
  "AXTabBar",
  "AXAdjustable",
  // Vega UIToolkit roles (lowercase, distinct from iOS AX* / Android's
  // capitalised names). The toolkit emits these as leaves (e.g. a poster
  // `image` or a label `text`); listing them here keeps undecorated leaves
  // from being dropped by the nested renderer's content gate.
  "button",
  "text",
  "image",
]);

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
  if (n.focused) flags.push("focused");
  if (n.selected) flags.push("selected");
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

// A node is worth its own line when EITHER it carries its own metadata
// (`hasContent`) OR its role tells us it's a thing the user can act on. The
// role check is what keeps unlabeled `AXImage`s and icon-only `AXButton`s on
// screen — without it, anything missing `accessibilityLabel` on iOS would
// silently vanish from describe (the bug the user originally flagged).
function shouldEmit(n: DescribeNode): boolean {
  return hasContent(n) || CONTENT_ROLES.has(n.role);
}

function formatLine(n: DescribeNode, indent: number): string {
  const pad = "  ".repeat(indent);
  // Drop value when it's the same string as label — iOS reports placeholder
  // text under both fields for text inputs, which doubled the byte cost for
  // zero added signal.
  const dedupedValue = n.value && n.value !== n.label ? n.value : undefined;
  const labelPart = formatLabel(n.label);
  const valuePart = formatAttr("value", dedupedValue);
  const idPart = formatAttr("id", n.identifier);
  const flagPart = formatFlags(n);
  // Single space between role and the rest — we deliberately don't pad the
  // role to a fixed column. Padding to 12 chars worked for iOS AX roles (all
  // ≤12 chars) but broke alignment the moment Android passed through raw
  // class names like `androidx.compose.ui.platform.ComposeView` (41 chars).
  const annotations = `${labelPart}${valuePart}${idPart}${flagPart}`.trim();
  const annotated = annotations ? ` ${annotations}` : "";
  return `${pad}${n.role}${annotated}  ${fmtFrame(n.frame)}`;
}

// ---- flat renderer (ax-service, native-devtools) ----

function renderFlat(root: DescribeNode): string[] {
  return root.children
    .filter(shouldEmit)
    .slice()
    .sort((a, b) => a.frame.y - b.frame.y || a.frame.x - b.frame.x)
    .map((n) => formatLine(n, 1));
}

// ---- nested renderer (uiautomator) ----

function renderNested(root: DescribeNode): string[] {
  const lines: string[] = [];
  // Iterative DFS so very deep Compose / RN trees don't risk a stack overflow.
  // Start at the root's children (depth 1) — the root itself is already
  // printed by the header's ROOT line, so emitting it again here just
  // duplicates the same role/frame for every nested-mode response.
  type Frame = { node: DescribeNode; depth: number };
  const stack: Frame[] = [];
  for (let i = root.children.length - 1; i >= 0; i--) {
    stack.push({ node: root.children[i]!, depth: 1 });
  }
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (shouldEmit(node) || node.children.length > 0) {
      lines.push(formatLine(node, depth));
    }
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push({ node: node.children[i]!, depth: depth + 1 });
    }
  }
  return lines;
}

export interface FormatDescribeOptions {
  source: DescribeSource;
}

export function formatDescribeTree(root: DescribeNode, opts: FormatDescribeOptions): string {
  // iOS providers (ax-service, native-devtools) emit a flat list under a
  // synthetic root, so the flat renderer is correct. Sources that produce
  // real parent/child trees (uiautomator / android-devtools on Android,
  // cdp-dom on Chromium) use the nested renderer so descendants beyond
  // depth 1 are visible.
  const mode: "flat" | "nested" =
<<<<<<< HEAD
    opts.source === "uiautomator" || opts.source === "android-devtools" || opts.source === "cdp-dom"
=======
    opts.source === "uiautomator" ||
    opts.source === "android-devtools" ||
    opts.source === "vega-automation"
>>>>>>> 56c10b1 (feat(tool-server): add Vega `describe` via the on-device automation toolkit)
      ? "nested"
      : "flat";
  const header: string[] = [];
  header.push(`Source: ${opts.source}`);
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
