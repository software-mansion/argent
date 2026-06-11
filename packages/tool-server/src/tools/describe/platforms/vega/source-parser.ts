import type { DescribeFrame, DescribeNode } from "../../contract";
import { decodeXmlEntities } from "../android/uiautomator-parser";

/**
 * Parse the Vega automation toolkit's `getPageSource` XML into the shared
 * `DescribeNode` tree (normalized [0,1] frames), so the same describe formatter,
 * tap-point header, and agent guidance apply on Fire TV as on iOS / Android.
 *
 * The page source looks like:
 *
 *   <root id="1">
 *     <app appName="…"><traits>…</traits>
 *       <window x="0" y="0" width="1920" height="1080" …>
 *         <traits>…</traits>
 *         <child x="67" y="23" width="177" height="74" role="button"
 *                selectable="true" selected="false" focusable="true" focused="false" test_id="14">
 *           <child … role="text" test_id="10"><text>Search</text><traits>…</traits></child>
 *           <traits>…</traits>
 *         </child>
 *         …
 *
 * Two structural facts drive the parser:
 *   1. `<traits>` subtrees are pure metadata (visibility, action handles, an
 *      internal `<window id="3"/>`, …) — they are NOT UI nodes and are skipped
 *      wholesale, or they would pollute the tree with phantom windows.
 *   2. A node's text label lives in a direct `<text>…</text>` child element
 *      (e.g. a `role="text"` node), not in an attribute.
 *
 * Only `role`-bearing / interactive nodes are kept; the structural `<child>`
 * scaffolding (full-screen containers with no role) is flattened by hoisting
 * each meaningful descendant up to the nearest kept ancestor. The result is a
 * compact tree of buttons / text / images that mirrors the on-screen layout.
 */

interface VegaXmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: VegaXmlNode[];
  /** Concatenated direct text content (only populated for `<text>` elements). */
  text: string;
}

// One regex, two alternatives: an element tag (open / close / self-closing) OR
// a run of text between tags. Attribute values may contain `>` (XML §2.4 only
// requires `<` and `&` escaped), so the attr block allows quoted `>` and stops
// at the unquoted closing `>`.
const TOKEN_RE = /<(\/?)([A-Za-z_][\w.-]*)((?:"[^"]*"|'[^']*'|[^"'>])*?)\s*(\/?)>|([^<]+)/gs;
const ATTR_RE = /([A-Za-z_][\w.-]*)\s*=\s*"([^"]*)"/g;

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(raw)) !== null) {
    attrs[m[1]!] = decodeXmlEntities(m[2]!);
  }
  ATTR_RE.lastIndex = 0;
  return attrs;
}

/**
 * Tokenize the page source into a `VegaXmlNode` tree, dropping every `<traits>`
 * subtree. Returns the outermost element (`<root>`), or null if nothing parsed.
 */
export function parseVegaXml(xml: string): VegaXmlNode | null {
  const body = xml.replace(/^\s*<\?xml[^?]*\?>\s*/, "");
  const stack: VegaXmlNode[] = [];
  let root: VegaXmlNode | null = null;
  // Depth of `<traits>` nesting we are currently inside; >0 means "skip".
  let traitsDepth = 0;
  let match: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(body)) !== null) {
    const [, closing, tag, rawAttrs, selfClose, textRun] = match;

    // Text run between tags — attach to the current open element.
    if (textRun !== undefined) {
      if (traitsDepth === 0) {
        const parent = stack[stack.length - 1];
        const t = decodeXmlEntities(textRun).trim();
        if (parent && t) parent.text += parent.text ? " " + t : t;
      }
      continue;
    }

    if (tag === "traits") {
      // Enter / leave a metadata subtree. Self-closing `<traits/>` is a no-op.
      if (closing) {
        if (traitsDepth > 0) traitsDepth -= 1;
      } else if (!selfClose) {
        traitsDepth += 1;
      }
      continue;
    }

    // Inside a traits subtree: ignore every tag until it closes.
    if (traitsDepth > 0) continue;

    if (closing) {
      if (stack.length > 0) stack.pop();
      continue;
    }

    const node: VegaXmlNode = {
      tag: tag!,
      attrs: parseAttributes(rawAttrs ?? ""),
      children: [],
      text: "",
    };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else if (root === null) root = node;
    else root.children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}

function isTrue(attrs: Record<string, string>, key: string): boolean {
  return attrs[key] === "true";
}

function num(attrs: Record<string, string>, key: string): number | null {
  const v = attrs[key];
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isInteractive(attrs: Record<string, string>): boolean {
  return isTrue(attrs, "focusable") || isTrue(attrs, "selectable") || isTrue(attrs, "clickable");
}

// A node earns a line in the tree when it carries semantic meaning: an explicit
// `role`, interactivity, or its own text. Bare structural `<child>` wrappers
// (full-screen containers with none of these) are flattened away.
function isMeaningful(node: VegaXmlNode): boolean {
  return Boolean(node.attrs.role) || isInteractive(node.attrs) || node.text.length > 0;
}

/** Pull the label for a node from its direct `<text>` element children. */
function labelOf(node: VegaXmlNode): string {
  const parts: string[] = [];
  if (node.text) parts.push(node.text);
  for (const c of node.children) {
    if (c.tag === "text" && c.text) parts.push(c.text);
  }
  return parts.join(" ").trim();
}

function normalizeFrame(
  attrs: Record<string, string>,
  screenW: number,
  screenH: number
): DescribeFrame {
  const x = num(attrs, "x") ?? 0;
  const y = num(attrs, "y") ?? 0;
  const w = num(attrs, "width") ?? 0;
  const h = num(attrs, "height") ?? 0;
  // Clip to the screen rect before normalising so x+width never exceeds 1 for a
  // partially off-screen node (same discipline as the Android adapter).
  const x1 = clamp(x, 0, screenW);
  const y1 = clamp(y, 0, screenH);
  const x2 = clamp(x + w, 0, screenW);
  const y2 = clamp(y + h, 0, screenH);
  return {
    x: screenW > 0 ? x1 / screenW : 0,
    y: screenH > 0 ? y1 / screenH : 0,
    width: screenW > 0 ? Math.max(0, x2 - x1) / screenW : 0,
    height: screenH > 0 ? Math.max(0, y2 - y1) / screenH : 0,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(n, hi));
}

/**
 * Convert a parsed XML node into the DescribeNodes that should appear where it
 * sits: `[node]` when it's meaningful, or its flattened meaningful descendants
 * when it's a bare structural wrapper. Iterative would be overkill — the toolkit
 * tree is shallow (a handful of nesting levels) and well-formed.
 */
function convert(node: VegaXmlNode, screenW: number, screenH: number): DescribeNode[] {
  const childNodes: DescribeNode[] = [];
  for (const c of node.children) {
    if (c.tag === "text") continue; // consumed as this node's label
    childNodes.push(...convert(c, screenW, screenH));
  }

  if (!isMeaningful(node)) return childNodes;

  const attrs = node.attrs;
  const out: DescribeNode = {
    role: attrs.role || "view",
    frame: normalizeFrame(attrs, screenW, screenH),
    children: childNodes,
  };
  const label = labelOf(node);
  if (label) out.label = label;
  if (attrs.test_id) out.identifier = attrs.test_id;
  if (isInteractive(attrs)) out.clickable = true;
  if (isTrue(attrs, "focused")) out.focused = true;
  if (isTrue(attrs, "selected")) out.selected = true;
  return [out];
}

/** Find the screen dimensions from the first element carrying width & height. */
function findScreenSize(root: VegaXmlNode): { w: number; h: number } {
  const stack: VegaXmlNode[] = [root];
  while (stack.length > 0) {
    const n = stack.shift()!;
    const w = num(n.attrs, "width");
    const h = num(n.attrs, "height");
    if (w && h) return { w, h };
    stack.push(...n.children);
  }
  return { w: 1920, h: 1080 }; // VVD default
}

/**
 * Parse Vega `getPageSource` XML into a DescribeNode tree. Throws if the XML is
 * unparseable; returns a root with no children for an empty/structural-only tree.
 */
export function parseVegaPageSource(xml: string): DescribeNode {
  const root = parseVegaXml(xml);
  if (!root) throw new Error("Failed to parse Vega page source");
  const { w, h } = findScreenSize(root);
  return {
    role: "Screen",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children: convert(root, w, h),
  };
}
