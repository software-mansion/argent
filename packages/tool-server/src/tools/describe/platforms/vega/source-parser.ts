import { XMLParser } from "fast-xml-parser";
import type { DescribeFrame, DescribeNode } from "../../contract";

/**
 * Parse the Vega automation toolkit's `getPageSource` XML into the shared
 * `DescribeNode` tree, with frames normalized to [0,1].
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
 * The outermost element (`<root>`) as a `VegaXmlNode` tree with `<traits>`
 * metadata subtrees dropped, or null if nothing parsed.
 */
export function parseVegaXml(xml: string): VegaXmlNode | null {
  for (const entry of parser.parse(xml) as FxpEntry[]) {
    const node = adapt(entry);
    if (node) return node;
  }
  return null;
}

function isTrue(attrs: Record<string, string>, key: string): boolean {
  const v = attrs[key];
  if (v === undefined) return false;
  const t = v.trim().toLowerCase();
  return t === "true" || t === "1";
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

// The toolkit auto-generates numeric `test_id`s; only a non-numeric one is an
// authored RN `testID`. Auto ids must not make a bare wrapper meaningful (that
// would disable flattening entirely), while an authored testID is a deliberate
// selector target and so earns a node with no role/interactivity/text.
// `flow-vega-tree` splits on the same test for text hoisting: only an authored
// testID shields.
export function isAuthoredVegaTestId(testId: string | undefined): boolean {
  return Boolean(testId && !/^\d+$/.test(testId));
}

function hasAuthoredTestId(attrs: Record<string, string>): boolean {
  return isAuthoredVegaTestId(attrs.test_id);
}

// A node's own text: its inline text plus the text of its direct `<text>`
// *element* children. The Chromium toolkit inside a `WebView` emits text as bare
// `<child>` wrappers with no `role`, so reading only inline `node.text` made
// every WebView text node look empty and flattened the whole web DOM (grid
// tiles, headings, labels) away (argent#474). Meaningfulness and the label are
// derived from this one notion so they can't drift apart.
function ownText(node: VegaXmlNode): string {
  const parts: string[] = [];
  if (node.text) parts.push(node.text);
  for (const c of node.children) {
    if (c.tag === "text" && c.text) parts.push(c.text);
  }
  return parts.join(" ").trim();
}

// A node earns a line in the tree when it carries semantic meaning: an explicit
// `role`, interactivity, its own text, or an authored testID. Bare structural
// `<child>` wrappers are flattened away. Takes the already-computed own text so
// `convert` derives it once per node rather than twice.
function isMeaningful(node: VegaXmlNode, ownTextValue: string): boolean {
  return (
    Boolean(node.attrs.role) ||
    isInteractive(node.attrs) ||
    ownTextValue.length > 0 ||
    hasAuthoredTestId(node.attrs)
  );
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

// A plain text span: a leaf that carries only a label. The Chromium a11y tree
// behind a `WebView` aggregates an element's accessible name onto the container
// *and* keeps the per-span text elements underneath it, so these leaves sit
// under a node that already states their combined text. A span counts only when
// it adds nothing else — anything structural (a role, a test_id, a
// focusable/selected span) is not one.
function isPlainTextSpan(n: DescribeNode): boolean {
  return (
    n.role === "view" &&
    n.label !== undefined &&
    n.children.length === 0 &&
    n.identifier === undefined &&
    !n.clickable &&
    !n.focused &&
    !n.selected
  );
}

// Whether `children` are exactly the duplicated sub-spans of `label`. Chromium
// joins inline sub-spans with no separator ("10" + "Tile 10" -> "10Tile 10"), so
// exact reconstruction — rather than substring containment — is what identifies
// the duplication: a distinct "Play" under "Playlist" or "Tile 1" under
// "Tile 10" is never swallowed, and a real list whose container name joins rows
// with spaces ("Home Settings About") keeps its separately-navigable rows.
function childrenReconstructLabel(children: DescribeNode[], label: string): boolean {
  if (children.length === 0 || !children.every(isPlainTextSpan)) return false;
  return children.map((c) => c.label).join("") === label;
}

/**
 * The DescribeNodes that should appear where `node` sits: `[node]` when it's
 * meaningful, or its flattened meaningful descendants when it's a bare
 * structural wrapper.
 */
function convert(node: VegaXmlNode, screenW: number, screenH: number): DescribeNode[] {
  const childNodes: DescribeNode[] = [];
  for (const c of node.children) {
    if (c.tag === "text") continue; // consumed as this node's label
    childNodes.push(...convert(c, screenW, screenH));
  }

  const label = ownText(node);
  if (!isMeaningful(node, label)) return childNodes;

  const attrs = node.attrs;
  // Absorb the WebView a11y tree's duplicated sub-spans: children that exactly
  // reconstruct this node's aggregated label are the label's pieces, not
  // distinct elements, so drop them and keep the node as one clean leaf.
  const keptChildren = label && childrenReconstructLabel(childNodes, label) ? [] : childNodes;

  const out: DescribeNode = {
    role: attrs.role || "view",
    frame: normalizeFrame(attrs, screenW, screenH),
    children: keptChildren,
  };
  if (label) out.label = label;
  if (attrs.test_id) out.identifier = attrs.test_id;
  if (isInteractive(attrs)) out.clickable = true;
  if (isTrue(attrs, "focused")) out.focused = true;
  if (isTrue(attrs, "selected")) out.selected = true;
  return [out];
}

/**
 * Screen dimensions every frame is normalized against: the sized `<window>`
 * element, else the first sized node, else the VVD default. Taking the first
 * sized node outright is order-fragile — a sized leaf (an icon/badge) preceding
 * `<window>` in breadth-first order would masquerade as the screen and clamp
 * every normalized frame off-screen to ~{x:1,y:1,w:0,h:0}.
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

// The persistent Kepler launcher renders its own `<app>` ("Register this
// device", "…is ready") into every page source alongside the foreground app.
// Its controls aren't part of the app under test, so merging them produces
// phantom elements and duplicate `test_id`s.
const LAUNCHER_APP_NAME = "com.amazon.keplerlauncherapp";

/**
 * The XML subtree(s) to render: for a `<root><app>…</app></root>` shape the
 * non-launcher apps (all of them if the launcher is somehow the only one),
 * otherwise the root as-is.
 */
function foregroundScopes(root: VegaXmlNode): VegaXmlNode[] {
  const apps = root.children.filter((c) => c.tag === "app");
  if (apps.length === 0) return [root];
  const foreground = apps.filter((a) => a.attrs.appName !== LAUNCHER_APP_NAME);
  return foreground.length > 0 ? foreground : apps;
}

/**
 * Parse Vega `getPageSource` XML into a DescribeNode tree. Throws if the XML is
 * unparseable; returns a root with no children for an empty/structural-only tree.
 */
export function parseVegaPageSource(xml: string): DescribeNode {
  const root = parseVegaXml(xml);
  if (!root) throw new Error("Failed to parse Vega page source");
  const scopes = foregroundScopes(root);
  const children: DescribeNode[] = [];
  for (const scope of scopes) {
    // Per scope, not once for scopes[0]: split-screen / picture-in-picture can
    // surface foreground apps with different window sizes, and normalizing one
    // app's frames against another's clamps them off-screen (a visible control
    // would read as untappable).
    const { w, h } = findScreenSize(scope);
    children.push(...convert(scope, w, h));
  }
  return {
    role: "Screen",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children,
  };
}
