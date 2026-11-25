import type { DescribeFrame, DescribeNode, DescribeSource } from "./contract";

// Token-efficient text rendering of an already-pruned DescribeNode tree: the
// per-platform adapters (and the Android v2 trimmer in uiautomator-parser) do
// the pruning, this layer only formats.
//
// Render mode comes from `source`, not the tree silhouette — a single
// accidental grandchild used to flip an ax-service response into nested mode,
// which broke callers diffing two close-in-time describes.

const CONTENT_ROLES = new Set([
  // The roles mapNativeTraitsToDescribeRole can return. AXGroup is excluded on
  // purpose: as its catch-all fallback, requiring it to carry its own
  // label/value before we emit a line keeps decorative groupings out.
  "AXButton",
  "AXStaticText",
  "AXImage",
  "AXLink",
  "AXTextField",
  "AXHeading",
  "AXTabBar",
  "AXAdjustable",
]);

// Vega UIToolkit roles: the toolkit emits these as undecorated leaves, which
// the nested renderer's content gate would otherwise drop. Kept separate from
// CONTENT_ROLES because the same lowercase roles occur on Chromium (an SVG
// `<text>`/`<image>`, `role="image"`), where counting them as content would
// print lines that are pruned today.
const VEGA_CONTENT_ROLES = new Set([...CONTENT_ROLES, "button", "text", "image"]);

function clampFinite(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

function fmtCoord(n: number): string {
  return clampFinite(n).toFixed(3);
}

// A tree prints this on every row, so the numbers are not separated by spaces.
// The leading zeros are needed: `.5` is not a valid JSON number, and a model
// copying the value into a tool call would have the call rejected.
function fmtFrame(f: DescribeFrame): string {
  return `(${fmtCoord(f.x)},${fmtCoord(f.y)},${fmtCoord(f.width)},${fmtCoord(f.height)})`;
}

function escapeForLine(s: string): string {
  // Escape rather than strip: a raw newline/tab breaks the one-line-per-node
  // shape callers grep, and escaping keeps the original character recoverable.
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

/** Sources whose platform cannot long-press, so `long-clickable` would be a dead end. */
const NO_LONG_PRESS_SOURCES: ReadonlySet<DescribeSource> = new Set(["harmony-uitest"]);

function formatFlags(n: DescribeNode, source: DescribeSource): string {
  const flags: string[] = [];
  if (n.clickable) flags.push("clickable");
  if (n.longClickable && !NO_LONG_PRESS_SOURCES.has(source)) flags.push("long-clickable");
  if (n.scrollable) flags.push("scrollable");
  // The Chromium walker reports `checked` without `checkable`, so the state
  // flag cannot be gated on the pair.
  if (n.checked) flags.push("checked");
  else if (n.checkable) flags.push("checkable");
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
    n.checked ||
    (typeof n.scrollHidden === "number" && n.scrollHidden > 0)
  );
}

// The role check is what keeps unlabeled `AXImage`s and icon-only `AXButton`s
// in the output — without it, anything missing `accessibilityLabel` on iOS
// would silently vanish from describe.
function shouldEmit(n: DescribeNode, contentRoles: ReadonlySet<string>): boolean {
  return hasContent(n) || contentRoles.has(n.role);
}

// What an iOS simulator element can report with no label, value or id, which
// maps it to the AXGroup fallback. Only the flat renderer counts these: the tree
// sources also set `disabled` and `selected`, and counting them there would
// print leaves that are pruned today.
function hasIosState(n: DescribeNode): boolean {
  return Boolean(n.hint || n.disabled || n.selected);
}

function formatLine(n: DescribeNode, indent: number, source: DescribeSource): string {
  const pad = "  ".repeat(indent);
  // With `AutomationEnabled` set (cloud iOS sims), a text input reports its
  // placeholder as both label and value; printing it twice costs bytes for no signal.
  const dedupedValue = n.value && n.value !== n.label ? n.value : undefined;
  // Safari reports an HTML `title` as the hint, and it is often the link's own text.
  const dedupedHint = n.hint && n.hint !== n.label ? n.hint : undefined;
  const labelPart = formatLabel(n.label);
  const valuePart = formatAttr("value", dedupedValue);
  const idPart = formatAttr("id", n.identifier);
  const hintPart = formatAttr("hint", dedupedHint);
  const flagPart = formatFlags(n, source);
  const annotations = `${labelPart}${valuePart}${idPart}${hintPart}${flagPart}`.trim();
  const annotated = annotations ? ` ${annotations}` : "";
  return `${pad}${n.role}${annotated}  ${fmtFrame(n.frame)}`;
}

function renderFlat(
  root: DescribeNode,
  contentRoles: ReadonlySet<string>,
  source: DescribeSource
): string[] {
  return root.children
    .filter((n) => shouldEmit(n, contentRoles) || hasIosState(n))
    .slice()
    .sort((a, b) => a.frame.y - b.frame.y || a.frame.x - b.frame.x)
    .map((n) => formatLine(n, 1, source));
}

function renderNested(
  root: DescribeNode,
  contentRoles: ReadonlySet<string>,
  source: DescribeSource
): string[] {
  const lines: string[] = [];
  // Iterative DFS so very deep Compose / RN trees can't overflow the stack.
  // Start at depth 1: the header already prints the root as its ROOT line.
  type Frame = { node: DescribeNode; depth: number };
  const stack: Frame[] = [];
  for (let i = root.children.length - 1; i >= 0; i--) {
    stack.push({ node: root.children[i]!, depth: 1 });
  }
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (shouldEmit(node, contentRoles) || node.children.length > 0) {
      lines.push(formatLine(node, depth, source));
    }
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push({ node: node.children[i]!, depth: depth + 1 });
    }
  }
  return lines;
}

interface FormatDescribeOptions {
  source: DescribeSource;
}

export function formatDescribeTree(root: DescribeNode, opts: FormatDescribeOptions): string {
  const isMacos = opts.source === "macos-devtools" || opts.source === "macos-fallback";
  // The iOS providers emit a flat list of leaves under a synthetic root; the
  // sources below return a real parent/child tree, whose descendants beyond
  // depth 1 are only visible in nested mode.
  const mode: "flat" | "nested" =
    opts.source === "uiautomator" ||
    opts.source === "android-devtools" ||
    opts.source === "cdp-dom" ||
    opts.source === "vega-automation" ||
    opts.source === "harmony-uitest" ||
    // Physical iOS: the runner reports a parent/child tree. Nested mode keeps that structure.
    opts.source === "xcuitest-runner" ||
    // A Mac app: the library's accessibility tree, with web content under its web view.
    isMacos
      ? "nested"
      : "flat";
  const isVega = opts.source === "vega-automation";
  const header: string[] = [];
  header.push(`Source: ${opts.source} | Mode: ${mode}`);
  if (isVega) {
    header.push(
      "Coordinates: normalized [0,1] screen (x,y,w,h), not pixels. " +
        "Vega is remote-driven (no tap): use frames to plan D-pad moves via `tv-remote` from " +
        "`[focused]` (or `[selected]` when none reports `[focused]`), counting rows/columns " +
        '(e.g. ["down","right","right","select"]).'
    );
  } else if (isMacos) {
    // A Mac app has no touch gestures at all.
    header.push(
      "Coordinates: normalized [0,1] app window (title bar + overhanging sheets/alerts/menus; x,y,w,h), not pixels. " +
        "Mouse input only: pass to gesture-tap / gesture-drag / gesture-scroll; tap centre = (x+w/2, y+h/2). " +
        "Menu bar not in tree: use menu-bar."
    );
  } else {
    header.push(
      "Coordinates: normalized [0,1] screen (x,y,w,h), not pixels; " +
        "pass to gesture-tap / gesture-swipe / gesture-pinch; tap centre = (x+w/2, y+h/2)."
    );
  }
  header.push("");
  header.push(`ROOT  ${root.role} ${fmtFrame(root.frame)}`);
  header.push("");

  // Vega's lowercase toolkit roles count as content only for its own source.
  const contentRoles = isVega ? VEGA_CONTENT_ROLES : CONTENT_ROLES;
  const body =
    mode === "flat"
      ? renderFlat(root, contentRoles, opts.source)
      : renderNested(root, contentRoles, opts.source);
  return [...header, ...body].join("\n").replace(/\n+$/, "\n");
}
