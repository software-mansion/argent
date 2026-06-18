import { XMLParser } from "fast-xml-parser";
import type { DescribeFrame, DescribeNode } from "../../contract";

/**
 * Parse the Vega automation toolkit's `getPageSource` XML into the shared
 * `DescribeNode` tree (normalized [0,1] frames). `<traits>` subtrees are metadata
 * and dropped; a node's label is its direct `<text>` child; only role-bearing /
 * interactive nodes are kept (bare `<child>` wrappers are flattened — see `convert`).
 */

interface VegaXmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: VegaXmlNode[];
  /** Concatenated direct text content (only populated for `<text>` elements). */
  text: string;
}

// fast-xml-parser in `preserveOrder` mode: each node is `{ <tag>: [children],
// ":@": {attrs} }` and a text run is `{ "#text": "…" }`. `htmlEntities` decodes
// numeric/hex char refs (`&#x2605;`) on top of the named XML entities.
const ATTRS_KEY = ":@";
const TEXT_KEY = "#text";
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  preserveOrder: true,
  textNodeName: TEXT_KEY,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
});

type FxpEntry = Record<string, unknown>;

/** Tag name of a preserveOrder entry (the single key that isn't the attr key). */
function tagOf(entry: FxpEntry): string | undefined {
  return Object.keys(entry).find((k) => k !== ATTRS_KEY);
}

/** Adapt a preserveOrder element entry into a `VegaXmlNode`, dropping `<traits>`. */
function adapt(entry: FxpEntry): VegaXmlNode | null {
  const tag = tagOf(entry);
  if (!tag || tag === TEXT_KEY || tag === "?xml" || tag === "traits") return null;
  const node: VegaXmlNode = {
    tag,
    attrs: (entry[ATTRS_KEY] as Record<string, string>) ?? {},
    children: [],
    text: "",
  };
  for (const child of (entry[tag] as FxpEntry[]) ?? []) {
    if (TEXT_KEY in child) {
      const raw = child[TEXT_KEY];
      const t = (typeof raw === "string" ? raw : "").trim();
      if (t) node.text += node.text ? " " + t : t;
      continue;
    }
    const c = adapt(child);
    if (c) node.children.push(c);
  }
  return node;
}

/**
 * Parse the page source into a `VegaXmlNode` tree, dropping `<traits>` metadata
 * subtrees. Returns the outermost element (`<root>`), or null if nothing parsed.
 */
export function parseVegaXml(xml: string): VegaXmlNode | null {
  for (const entry of parser.parse(xml) as FxpEntry[]) {
    const node = adapt(entry);
    if (node) return node;
  }
  return null;
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

/**
 * Screen dimensions used to normalize every frame. Prefer the sized `<window>`
 * element (the actual screen rect); only if there is no sized `<window>` fall
 * back to the first sized node, then to the VVD default. Returning the first
 * sized node outright is order-fragile: any sized leaf (an icon/badge) that
 * happens to precede `<window>` in breadth-first order would masquerade as the
 * screen, clamping every normalized frame off-screen to ~{x:1,y:1,w:0,h:0}.
 */
function findScreenSize(root: VegaXmlNode): { w: number; h: number } {
  let firstSized: { w: number; h: number } | null = null;
  const stack: VegaXmlNode[] = [root];
  while (stack.length > 0) {
    const n = stack.shift()!;
    const w = num(n.attrs, "width");
    const h = num(n.attrs, "height");
    if (w && h) {
      if (n.tag === "window") return { w, h };
      if (!firstSized) firstSized = { w, h };
    }
    stack.push(...n.children);
  }
  return firstSized ?? { w: 1920, h: 1080 }; // VVD default
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
