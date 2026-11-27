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
  const rounded = clampFinite(n).toFixed(3);
  // Strip trailing fractional zeros while keeping the leading zero (`.5` is
  // invalid JSON if copied into a tool call) and normalizing `-0` to `0`.
  const trimmed = rounded.includes(".") ? rounded.replace(/\.?0+$/, "") : rounded;
  return trimmed === "-0" ? "0" : trimmed;
}

// A tree prints this on every row, so the numbers are not separated by spaces.
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
  return `${pad}${n.role}${annotated} ${fmtFrame(n.frame)}`;
}

// Small normalized tolerance (~2pt on a phone) for iOS cells whose inner
// text/button bounds touch or sit slightly inside the outer row bounds.
const CONTAIN_EPS = 0.005;

function frameContains(outer: DescribeFrame, inner: DescribeFrame): boolean {
  return (
    inner.x >= outer.x - CONTAIN_EPS &&
    inner.y >= outer.y - CONTAIN_EPS &&
    inner.x + inner.width <= outer.x + outer.width + CONTAIN_EPS &&
    inner.y + inner.height <= outer.y + outer.height + CONTAIN_EPS
  );
}

function normalizeLabel(s: string | undefined): string {
  return (s ?? "")
    .replace(/[\s,]+/g, " ")
    .trim()
    .toLowerCase();
}

const DECORATIVE_CHEVRON_RE = /^(chevron(\.(right|left|forward|backward))?|disclosure)$/i;

/**
 * Drops redundant flat iOS elements whose content and tap target are already
 * represented by an enclosing control:
 * - Inner exact duplicates (same role/label/id/value/hint/flags inside another).
 * - Outer `AXGroup` cells shadowed by an inner `AXButton`/`AXLink` with the same
 *   identifier and normalized label (keeps the interactive button).
 * - Disabled decorative disclosure chevrons inside an `AXButton`.
 * - Non-interactive `AXStaticText`/`AXImage` nodes whose text is already
 *   contained in an enclosing `AXButton`/`AXGroup`/`AXLink` label (unless they
 *   carry a distinct identifier, value, hint, or state flag).
 */
function pruneFlatDuplicates(nodes: DescribeNode[]): DescribeNode[] {
  const drop = new Set<number>();

  for (let i = 0; i < nodes.length; i++) {
    if (drop.has(i)) continue;
    const a = nodes[i]!;
    for (let j = 0; j < nodes.length; j++) {
      if (i === j || drop.has(j) || drop.has(i)) continue;
      const b = nodes[j]!;
      if (!frameContains(a.frame, b.frame)) continue;

      // Exact contained duplicate (only when named/identified so unlabeled icons survive).
      if (
        (a.label || a.identifier) &&
        a.role === b.role &&
        (a.label ?? "") === (b.label ?? "") &&
        (a.identifier ?? "") === (b.identifier ?? "") &&
        (a.value ?? "") === (b.value ?? "") &&
        (a.hint ?? "") === (b.hint ?? "") &&
        Boolean(a.disabled) === Boolean(b.disabled) &&
        Boolean(a.selected) === Boolean(b.selected) &&
        Boolean(a.focused) === Boolean(b.focused) &&
        Boolean(a.checked) === Boolean(b.checked)
      ) {
        // When frames are equal (mutual containment), keep the earlier element.
        if (!frameContains(b.frame, a.frame) || i < j) {
          drop.add(j);
        }
        continue;
      }

      // Outer AXGroup cell shadowing an identical interactive button/link.
      if (
        a.role === "AXGroup" &&
        (b.role === "AXButton" || b.role === "AXLink") &&
        !a.value &&
        !a.hint &&
        !a.disabled &&
        !a.selected &&
        a.identifier &&
        a.identifier === b.identifier &&
        a.label &&
        b.label &&
        normalizeLabel(a.label) === normalizeLabel(b.label)
      ) {
        drop.add(i);
        break;
      }

      // Decorative disabled disclosure chevron inside a button row.
      if (
        a.role === "AXButton" &&
        b.disabled &&
        !b.value &&
        !b.identifier &&
        b.label &&
        DECORATIVE_CHEVRON_RE.test(b.label.trim())
      ) {
        drop.add(j);
      }
    }
  }

  const stage1 = nodes.filter((_, idx) => !drop.has(idx));
  const drop2 = new Set<number>();

  for (let i = 0; i < stage1.length; i++) {
    const a = stage1[i]!;
    if ((a.role !== "AXButton" && a.role !== "AXGroup" && a.role !== "AXLink") || !a.label) {
      continue;
    }
    const aNorm = normalizeLabel(a.label);
    if (!aNorm) continue;
    for (let j = 0; j < stage1.length; j++) {
      if (i === j || drop2.has(j)) continue;
      const b = stage1[j]!;
      if (
        (b.role === "AXStaticText" || b.role === "AXImage") &&
        b.label &&
        !b.value &&
        !b.hint &&
        !b.disabled &&
        !b.selected &&
        !b.focused &&
        (!b.identifier || b.identifier === a.identifier) &&
        frameContains(a.frame, b.frame)
      ) {
        const bNorm = normalizeLabel(b.label);
        if (bNorm && aNorm.includes(bNorm)) {
          drop2.add(j);
        }
      }
    }
  }

  return stage1.filter((_, idx) => !drop2.has(idx));
}

function renderFlat(
  root: DescribeNode,
  contentRoles: ReadonlySet<string>,
  source: DescribeSource,
  raw: boolean
): string[] {
  const sorted = root.children
    .filter((n) => shouldEmit(n, contentRoles) || hasIosState(n))
    .slice()
    .sort((a, b) => a.frame.y - b.frame.y || a.frame.x - b.frame.x);
  const kept = raw ? sorted : pruneFlatDuplicates(sorted);
  return kept.map((n) => formatLine(n, 1, source));
}

function isRedundantChildImage(parent: DescribeNode, child: DescribeNode): boolean {
  if (child.children.length > 0) return false;
  if (child.role !== "Image" && child.role !== "AXImage" && child.role !== "img") return false;
  if (child.clickable || child.longClickable || child.identifier || child.value) return false;
  if (!parent.clickable || !parent.label || !child.label) return false;
  return normalizeLabel(child.label) === normalizeLabel(parent.label);
}

function renderNested(
  root: DescribeNode,
  contentRoles: ReadonlySet<string>,
  source: DescribeSource,
  raw: boolean
): string[] {
  const lines: string[] = [];
  // Iterative DFS so very deep Compose / RN trees can't overflow the stack.
  // Start at depth 1 so body lines keep their leading two-space indent.
  type Frame = { node: DescribeNode; depth: number; parent?: DescribeNode };
  const stack: Frame[] = [];
  for (let i = root.children.length - 1; i >= 0; i--) {
    stack.push({ node: root.children[i]!, depth: 1 });
  }
  while (stack.length > 0) {
    const { node, depth, parent } = stack.pop()!;
    if (!raw && parent && isRedundantChildImage(parent, node)) {
      continue;
    }
    const meaningful = shouldEmit(node, contentRoles) || Boolean(node.focused || node.password);
    const emit = raw ? shouldEmit(node, contentRoles) || node.children.length > 0 : meaningful;
    if (emit) {
      lines.push(formatLine(node, depth, source));
    }
    const childDepth = emit ? depth + 1 : depth;
    const nextParent = emit ? node : parent;
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push({ node: node.children[i]!, depth: childDepth, parent: nextParent });
    }
  }
  return lines;
}

interface FormatDescribeOptions {
  source: DescribeSource;
  /** Keep bare structural wrappers and contained duplicate child nodes. */
  raw?: boolean;
}

function isDefaultRoot(root: DescribeNode): boolean {
  return (
    !root.label &&
    !root.value &&
    !root.identifier &&
    !root.hint &&
    root.frame.x === 0 &&
    root.frame.y === 0 &&
    root.frame.width === 1 &&
    root.frame.height === 1
  );
}

export function formatDescribeTree(root: DescribeNode, opts: FormatDescribeOptions): string {
  const raw = opts.raw === true;
  const isMacos = opts.source === "macos-devtools" || opts.source === "macos-fallback";
  // The iOS providers emit a flat list of leaves under a synthetic root; the
  // sources below return a real parent/child tree, whose descendants beyond
  // depth 1 are only visible in nested mode.
  const mode: "flat" | "nested" =
    opts.source === "uiautomator" ||
    opts.source === "android-devtools" ||
    opts.source === "uiautomator+cdp" ||
    opts.source === "android-devtools+cdp" ||
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
  if (isVega) {
    header.push(`Source: ${opts.source} | Mode: ${mode} | Frame: (x,y,w,h) [0,1]`);
    header.push(
      "Vega is remote-driven (no tap): plan `tv-remote` D-pad moves from `[focused]`/`[selected]`."
    );
  } else if (isMacos) {
    // A Mac app has no touch gestures at all.
    header.push(`Source: ${opts.source} | Mode: ${mode} | Frame: (x,y,w,h) [0,1] app window`);
    header.push("Mouse only (gesture-tap / gesture-drag / gesture-scroll); menu bar via menu-bar.");
  } else {
    header.push(`Source: ${opts.source} | Mode: ${mode} | Frame: (x,y,w,h) [0,1]`);
  }
  if (raw || !isDefaultRoot(root)) {
    header.push(`ROOT ${root.role} ${fmtFrame(root.frame)}`);
  }

  // Vega's lowercase toolkit roles count as content only for its own source.
  const contentRoles = isVega ? VEGA_CONTENT_ROLES : CONTENT_ROLES;
  const body =
    mode === "flat"
      ? renderFlat(root, contentRoles, opts.source, raw)
      : renderNested(root, contentRoles, opts.source, raw);
  return [...header, ...body].join("\n").replace(/\n+$/, "\n");
}
