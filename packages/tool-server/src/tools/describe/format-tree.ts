import type { DescribeFrame, DescribeNode, DescribeSource } from "./contract";

// Token-efficient text rendering of an already-pruned DescribeNode tree: the
// per-platform adapters (and the Android v2 trimmer in uiautomator-parser) do
// the pruning, this layer only formats. The one exception is `offscreenNodes`,
// which leaves Chromium rows outside the window out of this text. `describe`
// returns only this text, so every caller of it (agent, SDK, `argent run`, HTTP)
// gets the shorter view; await-ui-element and flows read the tree, not this text.
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

type WindowSide = "above" | "below" | "left" | "right";

const WINDOW_SIDES: readonly WindowSide[] = ["above", "below", "left", "right"];

/** `scrollHidden=N`, with the sides of the window the rows lie on when they are known. */
function scrollHiddenFlag(count: number, sides: readonly WindowSide[] = []): string {
  return `scrollHidden=${count}${sides.length > 0 ? `(${sides.join(",")})` : ""}`;
}

function formatFlags(
  n: DescribeNode,
  source: DescribeSource,
  foldedSides?: readonly WindowSide[]
): string {
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
    flags.push(scrollHiddenFlag(n.scrollHidden, foldedSides));
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

function formatLine(
  n: DescribeNode,
  indent: number,
  source: DescribeSource,
  foldedSides?: readonly WindowSide[]
): string {
  const pad = "  ".repeat(indent);
  // iOS reports a text input's placeholder as both label and value; printing
  // it twice costs bytes for no signal.
  const dedupedValue = n.value && n.value !== n.label ? n.value : undefined;
  const labelPart = formatLabel(n.label);
  const valuePart = formatAttr("value", dedupedValue);
  const idPart = formatAttr("id", n.identifier);
  const flagPart = formatFlags(n, source, foldedSides);
  const annotations = `${labelPart}${valuePart}${idPart}${flagPart}`.trim();
  const annotated = annotations ? ` ${annotations}` : "";
  return `${pad}${n.role}${annotated}  ${fmtFrame(n.frame)}`;
}

function isZeroArea(f: DescribeFrame): boolean {
  return clampFinite(f.width) <= 0 || clampFinite(f.height) <= 0;
}

/**
 * The rows to leave out of a Chromium tree. The DOM walker lists a whole page and
 * clamps an element outside the window to a zero-area frame at its edge, so on a
 * long page most rows are of that kind. They cannot be tapped: an agent has to
 * scroll to them first. A row stays if anything inside it has an area: a
 * `position: fixed` child can be on screen inside an off-screen parent. A focused
 * row stays too: `keyboard` types into it wherever it is.
 */
function offscreenNodes(root: DescribeNode): Set<DescribeNode> {
  const order: DescribeNode[] = [];
  const stack = [...root.children];
  while (stack.length > 0) {
    const node = stack.pop()!;
    order.push(node);
    for (const child of node.children) stack.push(child);
  }
  const offscreen = new Set<DescribeNode>();
  // A parent comes before its children in `order`, so walking back sees the children first.
  for (let i = order.length - 1; i >= 0; i--) {
    const node = order[i]!;
    if (isZeroArea(node.frame) && !node.focused && node.children.every((c) => offscreen.has(c))) {
      offscreen.add(node);
    }
  }
  return offscreen;
}

function printsLine(n: DescribeNode, contentRoles: ReadonlySet<string>): boolean {
  return shouldEmit(n, contentRoles) || n.children.length > 0;
}

/** The sides of the window a folded row lies on, from the edges `normRect` clamped it to. */
function foldedSides(node: DescribeNode, contentRoles: ReadonlySet<string>): WindowSide[] {
  const { x, y, width, height } = node.frame;
  if (x === 0 && y === 0 && width === 0 && height === 0 && node.children.length > 0) {
    // What `unionFrame` gives a box-less wrapper, so it says nothing about where the
    // row is: its children do, and only those that would print, as in the count. A
    // leaf cannot be such a wrapper, because the walker drops those. It is a box
    // above and left of the window, read below as a corner.
    return node.children
      .filter((c) => printsLine(c, contentRoles))
      .flatMap((c) => foldedSides(c, contentRoles));
  }
  if (height <= 0 && y >= 1) return ["below"];
  if (height <= 0 && y <= 0) return ["above"];
  if (width <= 0 && x >= 1) return ["right"];
  if (width <= 0 && x <= 0) return ["left"];
  return [];
}

interface FoldedChildren {
  /** How many rows `offscreen` removes from directly under the node; a folded subtree counts once. */
  count: number;
  sides: readonly WindowSide[];
}

function foldedChildren(
  node: DescribeNode,
  offscreen: ReadonlySet<DescribeNode>,
  contentRoles: ReadonlySet<string>
): FoldedChildren {
  const folded = node.children.filter((c) => offscreen.has(c) && printsLine(c, contentRoles));
  const present = new Set(folded.flatMap((c) => foldedSides(c, contentRoles)));
  return { count: folded.length, sides: WINDOW_SIDES.filter((side) => present.has(side)) };
}

function renderFlat(
  root: DescribeNode,
  contentRoles: ReadonlySet<string>,
  source: DescribeSource
): string[] {
  return root.children
    .filter((n) => shouldEmit(n, contentRoles))
    .slice()
    .sort((a, b) => a.frame.y - b.frame.y || a.frame.x - b.frame.x)
    .map((n) => formatLine(n, 1, source));
}

function renderNested(
  root: DescribeNode,
  contentRoles: ReadonlySet<string>,
  source: DescribeSource,
  offscreen: ReadonlySet<DescribeNode>
): string[] {
  const lines: string[] = [];
  // Iterative DFS so very deep Compose / RN trees can't overflow the stack.
  // Start at depth 1: the header already prints the root as its ROOT line.
  type Frame = { node: DescribeNode; depth: number };
  const stack: Frame[] = [];
  const pushChildren = (node: DescribeNode, depth: number) => {
    for (let i = node.children.length - 1; i >= 0; i--) {
      const child = node.children[i]!;
      if (!offscreen.has(child)) stack.push({ node: child, depth });
    }
  };
  pushChildren(root, 1);
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (printsLine(node, contentRoles)) {
      const { count, sides } = foldedChildren(node, offscreen, contentRoles);
      lines.push(
        formatLine(count > 0 ? { ...node, scrollHidden: count } : node, depth, source, sides)
      );
    }
    pushChildren(node, depth + 1);
  }
  return lines;
}

interface FormatDescribeOptions {
  source: DescribeSource;
}

export function formatDescribeTree(root: DescribeNode, opts: FormatDescribeOptions): string {
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
    opts.source === "xcuitest-runner"
      ? "nested"
      : "flat";
  const isVega = opts.source === "vega-automation";
  // Vega's lowercase toolkit roles count as content only for its own source.
  const contentRoles = isVega ? VEGA_CONTENT_ROLES : CONTENT_ROLES;
  const offscreen = opts.source === "cdp-dom" ? offscreenNodes(root) : new Set<DescribeNode>();
  const header: string[] = [];
  header.push(`Source: ${opts.source}`);
  header.push(`Mode: ${mode}`);
  header.push(
    "Coordinates are normalized [0,1] fractions of the screen (x, y, width, height), not pixels."
  );
  if (isVega) {
    header.push(
      "Vega is remote-driven, not touch — there is no tap. Use the frames as spatial hints to plan " +
        "D-pad moves with the `tv-remote` tool: compare the target's frame to the cursor's — the " +
        "`[focused]` element, or `[selected]` when no element reports `[focused]` (the toolkit often " +
        "marks the highlighted item `selected` while `focused` stays false) — " +
        'and count rows/columns to build the path (e.g. one row down and two columns right → ["down","right","right","select"]).'
    );
  } else {
    header.push(
      "Pass them straight to gesture-tap / gesture-swipe / gesture-pinch, which expect this same space."
    );
    header.push(
      "To tap an element, use its centre: tap_x = frame.x + frame.width / 2, tap_y = frame.y + frame.height / 2."
    );
  }
  header.push("");
  const foldedAtRoot = foldedChildren(root, offscreen, contentRoles);
  const rootFlag =
    foldedAtRoot.count > 0 ? ` [${scrollHiddenFlag(foldedAtRoot.count, foldedAtRoot.sides)}]` : "";
  header.push(`ROOT  ${root.role}${rootFlag} ${fmtFrame(root.frame)}`);
  header.push("");

  const body =
    mode === "flat"
      ? renderFlat(root, contentRoles, opts.source)
      : renderNested(root, contentRoles, opts.source, offscreen);
  return [...header, ...body].join("\n").replace(/\n+$/, "\n");
}
