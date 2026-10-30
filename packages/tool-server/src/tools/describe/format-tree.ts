import type { DescribeFrame, DescribeNode, DescribeSource } from "./contract";

// Token-efficient text rendering of an already-pruned DescribeNode tree: the
// per-platform adapters (and the Android v2 trimmer in uiautomator-parser) do
// the pruning, this layer formats. The one thing it adds is a note on
// elements under Expo's floating dev Tools button (expoDevButtonNotes).
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

function formatLine(
  n: DescribeNode,
  indent: number,
  source: DescribeSource,
  note?: string
): string {
  const pad = "  ".repeat(indent);
  // iOS reports a text input's placeholder as both label and value; printing
  // it twice costs bytes for no signal.
  const dedupedValue = n.value && n.value !== n.label ? n.value : undefined;
  const labelPart = formatLabel(n.label);
  const valuePart = formatAttr("value", dedupedValue);
  const idPart = formatAttr("id", n.identifier);
  const flagPart = formatFlags(n, source);
  const notePart = note ? ` [${note}]` : "";
  const annotations = `${labelPart}${valuePart}${idPart}${flagPart}${notePart}`.trim();
  const annotated = annotations ? ` ${annotations}` : "";
  return `${pad}${n.role}${annotated}  ${fmtFrame(n.frame)}`;
}

function renderFlat(
  root: DescribeNode,
  contentRoles: ReadonlySet<string>,
  source: DescribeSource,
  notes: Map<DescribeNode, string>
): string[] {
  return root.children
    .filter((n) => shouldEmit(n, contentRoles))
    .slice()
    .sort((a, b) => a.frame.y - b.frame.y || a.frame.x - b.frame.x)
    .map((n) => formatLine(n, 1, source, notes.get(n)));
}

interface ExpoFabReach {
  // Along the edge, towards the top and the bottom of the UI.
  before: number;
  after: number;
}

interface ExpoFabModel {
  isIcon: (n: DescribeNode) => boolean;
  // Ranges of the distance from the side edge the button snaps to, to the
  // icon centre.
  edgeToCentre: ReadonlyArray<readonly [number, number]>;
  // The touch area around the icon centre: across the edge each way, and
  // along it while the "Tools" caption shows and once it has gone.
  halfAcross: number;
  withCaption: ExpoFabReach;
  withoutCaption: ExpoFabReach;
  // Whether the UI's side edge can be the top or bottom of the frame space.
  portraitNativeFrames: boolean;
}

// Sizes are in the icon's own units (pt on iOS, dp on Android). The icon is
// 26 x 26 on both, so its frame gives the size of one unit on each axis.
const EXPO_FAB_ICON = 26;
// A 26 unit icon on a screen at least 260 units across.
const EXPO_FAB_MAX_ICON_FRACTION = 0.1;

// expo-dev-menu `ios/FAB/DevMenuFABView.swift` and `DevMenuFABWindow.swift`.
// Up to 58.0.4 the button snaps 5 pt in from the nearer side edge, with the
// icon centre 41 pt in. From 58.0.5 (`FABPlacement.swift`) its 52 pt pill
// keeps max(safe area, 10) pt from the edge: the icon centre is 36 pt in
// without a side safe area, and safe area + 26 pt in a notched landscape
// iPhone (44 to 62 pt safe area). `hitTest` takes any point in the
// 72 x 94 pt frame grown by 10 pt on each side. Along the edge the icon sits
// 32.5 pt below the frame top while the caption shows, and 47 pt once it has
// gone.
const IOS_EXPO_FAB: ExpoFabModel = {
  isIcon: (n) =>
    (n.identifier === "gearshape.fill" || n.label === "gearshape.fill") && /image/i.test(n.role),
  edgeToCentre: [
    [34.5, 43],
    [68, 90],
  ],
  halfAcross: 46,
  withCaption: { before: 42.5, after: 71.5 },
  withoutCaption: { before: 57, after: 57 },
  portraitNativeFrames: true,
};

// expo-dev-menu `android/.../fab/MovableFloatingActionButton.kt` and
// `FloatingActionButtonContent.kt`. The pointer area is 52 dp wide, 16 dp in
// from the nearer safe-drawing edge, with the 52 dp circle at its top and the
// icon in the circle's centre: 42 dp in, plus up to a 48 dp navigation bar or
// a cutout on that side in landscape. It is 94 dp tall while the caption
// shows, 52 dp after. The icon is a plain view without click semantics.
const ANDROID_EXPO_FAB: ExpoFabModel = {
  isIcon: (n) => n.label === "Tools" && !n.clickable && !/text|button/i.test(n.role),
  edgeToCentre: [[38, 94]],
  halfAcross: 26,
  withCaption: { before: 26, after: 68 },
  withoutCaption: { before: 26, after: 26 },
  portraitNativeFrames: false,
};

const EXPO_FAB_NOTE =
  "under the Expo dev Tools button: a tap here may open the Expo dev menu. " +
  "Switch off 'Tools button' in that menu first; the app keeps it off until it is switched back on";

function expoFabModel(source: DescribeSource | undefined): ExpoFabModel | undefined {
  switch (source) {
    case "ax-service":
    case "native-devtools":
    case "xcuitest-runner":
      return IOS_EXPO_FAB;
    case "uiautomator":
    case "android-devtools":
      return ANDROID_EXPO_FAB;
    default:
      return undefined;
  }
}

// The frame axis that runs across the side edge the button snaps to: x when
// the frames are in the UI's own space, y for a landscape UI in
// portrait-native frames.
type ExpoFabAcrossAxis = "x" | "y";

interface ExpoFab {
  icon: DescribeNode;
  caption?: DescribeNode;
  area: { x0: number; x1: number; y0: number; y1: number };
}

function centreOf(f: DescribeFrame) {
  return { x: f.x + f.width / 2, y: f.y + f.height / 2 };
}

function collectNodes(root: DescribeNode) {
  const all: DescribeNode[] = [];
  const parent = new Map<DescribeNode, DescribeNode>();
  const stack = [...root.children];
  while (stack.length) {
    const n = stack.pop()!;
    all.push(n);
    for (const c of n.children) {
      parent.set(c, n);
      stack.push(c);
    }
  }
  return { all, parent };
}

/**
 * Expo's development builds float a "Tools" button (a gear icon over a
 * "Tools" caption that fades after 10 s) above the app. The accessibility
 * tree reports only the small icon, with no z-order, so an app control under
 * it looks tappable: a tap on an app's own settings or header button there
 * opens the Expo dev menu instead.
 *
 * Mark every element whose centre falls in the button's touch area. The menu
 * it opens has a "Tools button" switch that hides it.
 */
function expoDevButtonNotes(root: DescribeNode, model: ExpoFabModel): Map<DescribeNode, string> {
  const notes = new Map<DescribeNode, string>();
  const { all, parent } = collectNodes(root);
  const fabs = findExpoFabs(all, model);
  // The icon's own containers and its caption belong to the button, not to the app.
  const own = new Set<DescribeNode>();
  for (const fab of fabs) {
    if (fab.caption) own.add(fab.caption);
    for (let p: DescribeNode | undefined = fab.icon; p; p = parent.get(p)) own.add(p);
  }
  for (const n of all) {
    if (own.has(n)) continue;
    // Only a centre inside the button is a trap: that is where agents tap.
    const c = centreOf(n.frame);
    const covered = fabs.some(
      ({ area }) => c.x >= area.x0 && c.x <= area.x1 && c.y >= area.y0 && c.y <= area.y1
    );
    if (covered) notes.set(n, EXPO_FAB_NOTE);
  }
  return notes;
}

function findExpoFabs(all: DescribeNode[], model: ExpoFabModel): ExpoFab[] {
  const icons = all.filter((n) => model.isIcon(n) && hasIconSize(n.frame));
  if (icons.length === 0) return [];
  for (const axis of expoFabAxesToTry(all, icons[0]!.frame, model)) {
    const fabs = icons
      .filter((icon) => isSnapped(icon.frame, model, axis))
      .map((icon) => toExpoFab(icon, all, model, axis));
    if (fabs.length > 0) return fabs;
  }
  return [];
}

function toExpoFab(
  icon: DescribeNode,
  all: DescribeNode[],
  model: ExpoFabModel,
  axis: ExpoFabAcrossAxis
): ExpoFab {
  const caption = all.find((n) => isCaptionOf(n, icon.frame, model, axis));
  return { icon, caption, area: expoFabArea(icon.frame, model, axis, caption) };
}

function hasIconSize(f: DescribeFrame): boolean {
  return (
    f.width > 0 &&
    f.height > 0 &&
    f.width <= EXPO_FAB_MAX_ICON_FRACTION &&
    f.height <= EXPO_FAB_MAX_ICON_FRACTION
  );
}

// A text at least this many times longer than it is tall reads as a line.
const EXPO_TEXT_LINE_RATIO = 2;

/**
 * The axes a snapped icon may sit across, most likely first. A landscape UI
 * on the iOS simulator keeps portrait-native frames, where the UI's side edge
 * is the top or bottom of the frame space. The tree does not report the
 * orientation, so it is read from the text: a line of text runs across the
 * UI, which is down the frame space when the UI is rotated. Short texts such
 * as "12" or a badge are about as tall as they are wide and do not vote.
 */
function expoFabAxesToTry(
  all: DescribeNode[],
  iconFrame: DescribeFrame,
  model: ExpoFabModel
): ExpoFabAcrossAxis[] {
  if (!model.portraitNativeFrames) return ["x"];
  const unitX = iconFrame.width / EXPO_FAB_ICON;
  const unitY = iconFrame.height / EXPO_FAB_ICON;
  let wide = 0;
  let tall = 0;
  for (const n of all) {
    if (!n.label || !/text/i.test(n.role)) continue;
    const w = n.frame.width / unitX;
    const h = n.frame.height / unitY;
    if (w >= h * EXPO_TEXT_LINE_RATIO) wide++;
    else if (h >= w * EXPO_TEXT_LINE_RATIO) tall++;
  }
  if (wide > tall) return ["x"];
  if (tall > wide) return ["y"];
  return ["x", "y"];
}

function isSnapped(f: DescribeFrame, model: ExpoFabModel, axis: ExpoFabAcrossAxis): boolean {
  const c = centreOf(f);
  const unit = (axis === "x" ? f.width : f.height) / EXPO_FAB_ICON;
  const pos = axis === "x" ? c.x : c.y;
  const fromEdges = [pos / unit, (1 - pos) / unit];
  return fromEdges.some((d) => model.edgeToCentre.some(([min, max]) => d >= min && d <= max));
}

// The offset from the icon centre to `n`'s centre in icon units, across the
// edge and along it.
function offsetFromIcon(n: DescribeNode, iconFrame: DescribeFrame, axis: ExpoFabAcrossAxis) {
  const icon = centreOf(iconFrame);
  const c = centreOf(n.frame);
  const dx = (c.x - icon.x) / (iconFrame.width / EXPO_FAB_ICON);
  const dy = (c.y - icon.y) / (iconFrame.height / EXPO_FAB_ICON);
  return axis === "x" ? { across: dx, along: dy } : { across: dy, along: dx };
}

/**
 * The "Tools" caption sits centred under the icon, inside the button. With
 * portrait-native frames (a rotated or upside-down UI) the UI's "under" may be
 * either way along the edge.
 */
function isCaptionOf(
  n: DescribeNode,
  iconFrame: DescribeFrame,
  model: ExpoFabModel,
  axis: ExpoFabAcrossAxis
): boolean {
  if (n.label !== "Tools" || !/text/i.test(n.role)) return false;
  const { across, along } = offsetFromIcon(n, iconFrame, axis);
  const below = model.portraitNativeFrames ? Math.abs(along) : along;
  return Math.abs(across) <= EXPO_FAB_ICON / 2 && below > 0 && below <= model.withCaption.after;
}

function expoFabArea(
  f: DescribeFrame,
  model: ExpoFabModel,
  axis: ExpoFabAcrossAxis,
  caption: DescribeNode | undefined
): ExpoFab["area"] {
  const unitX = f.width / EXPO_FAB_ICON;
  const unitY = f.height / EXPO_FAB_ICON;
  const c = centreOf(f);
  const reach = caption ? model.withCaption : model.withoutCaption;
  // The caption marks the UI's bottom. Without it the reach is the same both ways.
  const uiBottomIsBackwards = caption !== undefined && offsetFromIcon(caption, f, axis).along < 0;
  const [back, forward] = uiBottomIsBackwards
    ? [reach.after, reach.before]
    : [reach.before, reach.after];
  if (axis === "x") {
    return {
      x0: c.x - model.halfAcross * unitX,
      x1: c.x + model.halfAcross * unitX,
      y0: c.y - back * unitY,
      y1: c.y + forward * unitY,
    };
  }
  return {
    x0: c.x - back * unitX,
    x1: c.x + forward * unitX,
    y0: c.y - model.halfAcross * unitY,
    y1: c.y + model.halfAcross * unitY,
  };
}

function renderNested(
  root: DescribeNode,
  contentRoles: ReadonlySet<string>,
  source: DescribeSource,
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
      lines.push(formatLine(node, depth, source, notes.get(node)));
    }
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push({ node: node.children[i]!, depth: depth + 1 });
    }
  }
  return lines;
}

interface FormatDescribeOptions {
  source: DescribeSource;
  // False for TV: no taps reach the Expo Tools button there, so no note.
  touchScreen?: boolean;
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
  const fabModel = opts.touchScreen === false ? undefined : expoFabModel(opts.source);
  const notes = fabModel ? expoDevButtonNotes(root, fabModel) : new Map<DescribeNode, string>();
  const body =
    mode === "flat"
      ? renderFlat(root, contentRoles, opts.source, notes)
      : renderNested(root, contentRoles, opts.source, notes);
  return [...header, ...body].join("\n").replace(/\n+$/, "\n");
}
