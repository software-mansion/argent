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

function fmtFrame(f: DescribeFrame): string {
  return `(${clampFinite(f.x).toFixed(3)}, ${clampFinite(f.y).toFixed(3)}, ${clampFinite(
    f.width
  ).toFixed(3)}, ${clampFinite(f.height).toFixed(3)})`;
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

function formatFlags(n: DescribeNode): string {
  const flags: string[] = [];
  if (n.clickable) flags.push("clickable");
  if (n.longClickable) flags.push("long-clickable");
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

function formatLine(n: DescribeNode, indent: number, note?: string): string {
  const pad = "  ".repeat(indent);
  // iOS reports a text input's placeholder as both label and value; printing
  // it twice costs bytes for no signal.
  const dedupedValue = n.value && n.value !== n.label ? n.value : undefined;
  const labelPart = formatLabel(n.label);
  const valuePart = formatAttr("value", dedupedValue);
  const idPart = formatAttr("id", n.identifier);
  const flagPart = formatFlags(n);
  const notePart = note ? ` [${note}]` : "";
  const annotations = `${labelPart}${valuePart}${idPart}${flagPart}${notePart}`.trim();
  const annotated = annotations ? ` ${annotations}` : "";
  return `${pad}${n.role}${annotated}  ${fmtFrame(n.frame)}`;
}

function renderFlat(
  root: DescribeNode,
  contentRoles: ReadonlySet<string>,
  notes: Map<DescribeNode, string>
): string[] {
  return root.children
    .filter((n) => shouldEmit(n, contentRoles))
    .slice()
    .sort((a, b) => a.frame.y - b.frame.y || a.frame.x - b.frame.x)
    .map((n) => formatLine(n, 1, notes.get(n)));
}

/**
 * Expo's development builds float a "Tools" button (a `gearshape.fill` icon
 * over a "Tools" caption) above the app. The accessibility tree reports only
 * the small icon, with no z-order, so an app control under it looks tappable:
 * a tap on an app's own settings or header button there opens the Expo dev
 * menu instead.
 *
 * Mark every element whose centre falls in the button's touch area. The menu
 * it opens has a "Tools button" switch that hides it.
 */
function expoDevButtonNotes(root: DescribeNode): Map<DescribeNode, string> {
  const notes = new Map<DescribeNode, string>();
  const all: DescribeNode[] = [];
  const stack = [...root.children];
  while (stack.length) {
    const n = stack.pop()!;
    all.push(n);
    stack.push(...n.children);
  }
  // The Expo dev launcher's own Settings tab uses the same icon in its tab bar.
  const tabBars = all.filter((n) => n.label === "Tab Bar" || /tab ?bar/i.test(n.role));
  const inside = (f: DescribeNode["frame"], o: DescribeNode["frame"]) =>
    f.x >= o.x && f.y >= o.y && f.x + f.width <= o.x + o.width && f.y + f.height <= o.y + o.height;
  const gear = all.find(
    (n) =>
      (n.identifier === "gearshape.fill" || n.label === "gearshape.fill") &&
      /image/i.test(n.role) &&
      n.frame.x > 0.5 &&
      n.frame.width < 0.15 &&
      !tabBars.some((t) => inside(n.frame, t.frame))
  );
  if (!gear) return notes;
  const g = gear.frame;
  // The floating button is larger than its icon: a tap 0.02 above the icon
  // still opened the menu on a device.
  const area = {
    x0: g.x - 0.03,
    x1: g.x + g.width + 0.03,
    y0: g.y - 0.04,
    y1: g.y + g.height + 0.06,
  };
  for (const n of all) {
    if (n === gear || (n.role === "AXStaticText" && n.label === "Tools")) continue;
    const f = n.frame;
    if (f.width >= 0.9 && f.height >= 0.9) continue; // full-screen containers
    const cx = f.x + f.width / 2;
    const cy = f.y + f.height / 2;
    // Only a centre inside the button is a trap: that is where agents tap.
    if (cx < area.x0 || cx > area.x1 || cy < area.y0 || cy > area.y1) continue;
    notes.set(
      n,
      "under the Expo dev Tools button: it may take a tap here and open the Expo dev menu — " +
        "switch off 'Tools button' in that menu first"
    );
  }
  return notes;
}

function renderNested(
  root: DescribeNode,
  contentRoles: ReadonlySet<string>,
  notes: Map<DescribeNode, string>
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
      lines.push(formatLine(node, depth, notes.get(node)));
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
  // The iOS providers emit a flat list of leaves under a synthetic root; the
  // sources below return a real parent/child tree, whose descendants beyond
  // depth 1 are only visible in nested mode.
  const mode: "flat" | "nested" =
    opts.source === "uiautomator" ||
    opts.source === "android-devtools" ||
    opts.source === "cdp-dom" ||
    opts.source === "vega-automation" ||
    // Physical iOS: the runner reports a parent/child tree. Nested mode keeps that structure.
    opts.source === "xcuitest-runner"
      ? "nested"
      : "flat";
  const isVega = opts.source === "vega-automation";
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
    // Physical iOS has no two-finger gestures. Do not recommend gesture-pinch for this source.
    header.push(
      opts.source === "xcuitest-runner"
        ? "Pass them straight to gesture-tap / gesture-swipe, which expect this same space. " +
            "No two-finger gestures on physical iOS."
        : "Pass them straight to gesture-tap / gesture-swipe / gesture-pinch, which expect this same space."
    );
    header.push(
      "To tap an element, use its centre: tap_x = frame.x + frame.width / 2, tap_y = frame.y + frame.height / 2."
    );
  }
  header.push("");
  header.push(`ROOT  ${root.role} ${fmtFrame(root.frame)}`);
  header.push("");

  // Vega's lowercase toolkit roles count as content only for its own source.
  const contentRoles = isVega ? VEGA_CONTENT_ROLES : CONTENT_ROLES;
  const notes = expoDevButtonNotes(root);
  const body =
    mode === "flat"
      ? renderFlat(root, contentRoles, notes)
      : renderNested(root, contentRoles, notes);
  return [...header, ...body].join("\n").replace(/\n+$/, "\n");
}
