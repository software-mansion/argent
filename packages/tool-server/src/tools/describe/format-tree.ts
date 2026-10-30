import type { DescribeFrame, DescribeNode, DescribeSource } from "./contract";
import { SCROLL_INDICATOR_LABELS } from "./scroll-indicator-labels";

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

type RenderMode = "flat" | "nested";

interface FormatDescribeOptions {
  source: DescribeSource;
}

// Sliders and page dots sit on the content they control. HarmonyOS wraps each
// window in a synthetic "Window" node that is not drawn.
const OVERLAP_SKIP_ROLES = new Set(["AXAdjustable", "PageIndicator", "Window"]);
// Text over text is a layout quirk, not a tap trap. Lists the iOS AX roles,
// the Android parser's roles and the DOM tags and ARIA roles of text and images.
const PASSIVE_ROLES = new Set([
  "AXStaticText",
  "AXImage",
  "AXHeading",
  "StaticText",
  "Image",
  "p",
  "div",
  "span",
  "label",
  "strong",
  "em",
  "b",
  "i",
  "small",
  "img",
  "figcaption",
  "svg",
  "g",
  "path",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "heading",
  "text",
]);
// A browser gives each inline run of a wrapped paragraph the box of every line
// it spans, so neighbouring runs of one parent overlap while nothing covers
// anything. Android names a WebView link "View".
const TEXT_RUN_ROLES = new Set([
  "AXStaticText",
  "AXLink",
  "StaticText",
  "View",
  "a",
  "link",
  "span",
  "strong",
  "em",
  "b",
  "i",
  "small",
  "code",
  "label",
  "sup",
  "sub",
  "abbr",
  "time",
  "mark",
  "cite",
  "q",
  "kbd",
]);
const KEYBOARD_ROLES = new Set(["Key", "Keyboard"]);
const KEYBOARD_ID_PATTERN = /\.inputmethod[.:]/;
// ax-service reports UIKit scroll indicators as labelled AXGroups. They sit
// over the content they scroll, alert button stacks included, and no scroll
// can separate an indicator from its own content.
const SCROLL_INDICATOR_PREFIXES = SCROLL_INDICATOR_LABELS.map((l) => l.toLowerCase());
const EMPTY_FRAME: DescribeFrame = { x: 0, y: 0, width: 0, height: 0 };
const OVERLAP_MIN_ELEMENT_AREA = 0.0001;
const OVERLAP_MAX_ELEMENT_AREA = 0.5;
const OVERLAP_MIN_RATIO = 0.25;
const OVERLAP_CONTAINED_RATIO = 0.95;
const OVERLAP_SAME_FRAME_TOLERANCE = 0.002;
const OVERLAP_PARKED_MIN = 3;
const OVERLAP_NAME_MAX = 40;
const OVERLAP_PARTNERS_MAX = 3;

// `start`/`end` span the node's subtree in pre-order, so a pair whose ranges
// nest is an ancestor and its descendant. `frame` is the node's frame clipped
// to its scrollable ancestors.
interface OverlapCandidate {
  node: DescribeNode;
  parent: DescribeNode;
  frame: DescribeFrame;
  start: number;
  end: number;
}

interface OverlapPartner {
  other: DescribeNode;
  ratio: number;
}

function frameArea(f: DescribeFrame): number {
  return f.width * f.height;
}

function intersectFrames(a: DescribeFrame, b: DescribeFrame): DescribeFrame | undefined {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : undefined;
}

function overlapRatio(a: DescribeFrame, b: DescribeFrame): number {
  const shared = intersectFrames(a, b);
  if (!shared) return 0;
  return frameArea(shared) / Math.min(frameArea(a), frameArea(b));
}

function coversCentreOf(cover: DescribeFrame, f: DescribeFrame): boolean {
  const cx = f.x + f.width / 2;
  const cy = f.y + f.height / 2;
  return (
    cover.x <= cx && cx <= cover.x + cover.width && cover.y <= cy && cy <= cover.y + cover.height
  );
}

function isScrollIndicator(n: DescribeNode): boolean {
  const label = (n.label ?? "").toLowerCase();
  return SCROLL_INDICATOR_PREFIXES.some((prefix) => label.startsWith(prefix));
}

function isKeyboardKey(n: DescribeNode): boolean {
  return KEYBOARD_ROLES.has(n.role) || KEYBOARD_ID_PATTERN.test(n.identifier ?? "");
}

function isPassive(n: DescribeNode): boolean {
  return PASSIVE_ROLES.has(n.role) && !n.clickable;
}

function isOverlapCandidate(n: DescribeNode, frame: DescribeFrame): boolean {
  return (
    Boolean(n.label || n.identifier || n.value) &&
    !OVERLAP_SKIP_ROLES.has(n.role) &&
    !isScrollIndicator(n) &&
    frameArea(frame) >= OVERLAP_MIN_ELEMENT_AREA
  );
}

// Sheets, drawers and keyboard keys still cover other elements, but they are
// on top or too large for the note to help.
function receivesNote(c: OverlapCandidate): boolean {
  return frameArea(c.node.frame) < OVERLAP_MAX_ELEMENT_AREA && !isKeyboardKey(c.node);
}

function originKey(n: DescribeNode): string {
  return `${n.frame.x},${n.frame.y}`;
}

// ax-service parks below-the-fold rows at one shared origin where nothing is
// drawn, so a stack of elements on one origin is dropped.
function withoutParkedRows(nodes: DescribeNode[]): DescribeNode[] {
  const counts = new Map<string, number>();
  for (const n of nodes) counts.set(originKey(n), (counts.get(originKey(n)) ?? 0) + 1);
  return nodes.filter((n) => counts.get(originKey(n))! < OVERLAP_PARKED_MIN);
}

function flatCandidates(root: DescribeNode): OverlapCandidate[] {
  const nodes = root.children.filter((n) => isOverlapCandidate(n, n.frame));
  return withoutParkedRows(nodes).map((node, i) => ({
    node,
    parent: root,
    frame: node.frame,
    start: i,
    end: i,
  }));
}

interface CandidateWalkEntry {
  node: DescribeNode;
  parent: DescribeNode;
  clip?: DescribeFrame;
  closes?: OverlapCandidate;
}

function childClip(node: DescribeNode, clip: DescribeFrame | undefined): DescribeFrame | undefined {
  if (!node.scrollable) return clip;
  return clip ? (intersectFrames(clip, node.frame) ?? EMPTY_FRAME) : node.frame;
}

function nestedCandidates(root: DescribeNode): OverlapCandidate[] {
  const candidates: OverlapCandidate[] = [];
  const stack: CandidateWalkEntry[] = root.children
    .slice()
    .reverse()
    .map((node) => ({ node, parent: root }));
  let index = 0;
  while (stack.length > 0) {
    const { node, parent, clip, closes } = stack.pop()!;
    if (closes) {
      closes.end = index - 1;
      continue;
    }
    const start = index++;
    const frame = clip ? intersectFrames(node.frame, clip) : node.frame;
    if (frame && isOverlapCandidate(node, frame)) {
      const candidate = { node, parent, frame, start, end: start };
      candidates.push(candidate);
      stack.push({ node, parent, closes: candidate });
    }
    const nextClip = childClip(node, clip);
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push({ node: node.children[i]!, parent: node, clip: nextClip });
    }
  }
  return candidates;
}

function isAncestorPair(a: OverlapCandidate, b: OverlapCandidate): boolean {
  return (a.start <= b.start && b.start <= a.end) || (b.start <= a.start && a.start <= b.end);
}

function isSameElement(a: OverlapCandidate, b: OverlapCandidate): boolean {
  const close = (x: number, y: number) => Math.abs(x - y) <= OVERLAP_SAME_FRAME_TOLERANCE;
  const fa = a.node.frame;
  const fb = b.node.frame;
  return (
    a.node.role === b.node.role &&
    overlapName(a.node) === overlapName(b.node) &&
    close(fa.x, fb.x) &&
    close(fa.y, fb.y) &&
    close(fa.width, fb.width) &&
    close(fa.height, fb.height)
  );
}

function isRunOfOneParagraph(a: OverlapCandidate, b: OverlapCandidate): boolean {
  return (
    a.parent === b.parent && TEXT_RUN_ROLES.has(a.node.role) && TEXT_RUN_ROLES.has(b.node.role)
  );
}

// A control inside its own row or field is drawn over it, so a pair where one
// element lies wholly inside the other is skipped.
function canCover(a: OverlapCandidate, b: OverlapCandidate, ratio: number): boolean {
  return (
    ratio > OVERLAP_MIN_RATIO &&
    ratio < OVERLAP_CONTAINED_RATIO &&
    !isAncestorPair(a, b) &&
    !isSameElement(a, b) &&
    !(isPassive(a.node) && isPassive(b.node)) &&
    !isRunOfOneParagraph(a, b)
  );
}

// Android resource ids repeat the package before the name.
function shortIdentifier(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1) || id;
}

function overlapNameParts(n: DescribeNode): [string, string] {
  if (n.label) return ["", n.label];
  if (n.identifier) return ["id=", shortIdentifier(n.identifier)];
  if (n.value) return ["value=", n.value];
  return ["", n.role];
}

function overlapName(n: DescribeNode): string {
  const [prefix, raw] = overlapNameParts(n);
  // Cut by code point: a lone surrogate left by a UTF-16 slice makes strict
  // JSON parsers reject the whole MCP message.
  const cut = Array.from(raw).slice(0, OVERLAP_NAME_MAX).join("");
  return `${prefix}"${escapeForLine(cut).replace(/"/g, "'")}"`;
}

// The element list carries no stacking order, so a tap at an element's centre
// may hit another element that covers that centre (a tab bar over a list row).
function overlapNotes(candidates: OverlapCandidate[]): Map<DescribeNode, string> {
  const partners = new Map<DescribeNode, OverlapPartner[]>();
  const addPartnerIfCentreCovered = (
    self: OverlapCandidate,
    other: OverlapCandidate,
    ratio: number
  ) => {
    if (!receivesNote(self) || !coversCentreOf(other.frame, self.frame)) return;
    const list = partners.get(self.node) ?? [];
    list.push({ other: other.node, ratio });
    partners.set(self.node, list);
  };

  candidates.forEach((first, i) => {
    for (const second of candidates.slice(i + 1)) {
      const ratio = overlapRatio(first.frame, second.frame);
      if (!canCover(first, second, ratio)) continue;
      addPartnerIfCentreCovered(first, second, ratio);
      addPartnerIfCentreCovered(second, first, ratio);
    }
  });

  const notes = new Map<DescribeNode, string>();
  for (const [self, list] of partners) {
    const ranked = list.sort((x, y) => y.ratio - x.ratio).map((p) => overlapName(p.other));
    const names = [...new Set(ranked)].slice(0, OVERLAP_PARTNERS_MAX).join(", ");
    notes.set(self, `overlaps ${names}: either may be on top, check a screenshot before tapping`);
  }
  return notes;
}

export function formatDescribeTree(root: DescribeNode, opts: FormatDescribeOptions): string {
  // The iOS providers emit a flat list of leaves under a synthetic root; the
  // sources below return a real parent/child tree, whose descendants beyond
  // depth 1 are only visible in nested mode.
  const mode: RenderMode =
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
  // Vega has no tap, so the note's advice does not apply there.
  const notes = isVega
    ? new Map<DescribeNode, string>()
    : overlapNotes(mode === "flat" ? flatCandidates(root) : nestedCandidates(root));
  const body =
    mode === "flat"
      ? renderFlat(root, contentRoles, opts.source, notes)
      : renderNested(root, contentRoles, opts.source, notes);
  return [...header, ...body].join("\n").replace(/\n+$/, "\n");
}
