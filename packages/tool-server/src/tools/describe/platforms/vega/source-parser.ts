import { XMLParser } from "fast-xml-parser";
import type { DescribeFrame, DescribeNode } from "../../contract";

/**
 * Parse the Vega automation toolkit's `getPageSource` XML into the shared
 * `DescribeNode` tree (normalized [0,1] frames). `<traits>` subtrees are metadata
 * and dropped; a node's label is its direct `<text>` child; only role-bearing /
 * interactive / authored-testID nodes are kept (bare `<child>` wrappers are
 * flattened — see `convert`).
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

// Toolkit booleans normally arrive lowercase, but `ro.serialno`-style vendor
// variance means casing/`1` can't be assumed; accept `true`/`1` case-insensitively
// rather than silently dropping a state flag on `"True"`.
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

// The toolkit stamps EVERY node with an auto-generated numeric `test_id`; only
// a non-numeric one is an authored RN `testID`. The distinction matters for
// flattening: auto ids must not make a bare wrapper meaningful (they'd disable
// flattening entirely), but an authored testID is a deliberate selector target
// — e.g. a plain container View a flow asserts on — so it earns a node even
// with no role/interactivity/text.
function hasAuthoredTestId(attrs: Record<string, string>): boolean {
  const t = attrs.test_id;
  return Boolean(t) && !/^\d+$/.test(t);
}

// A node's own text: its inline text plus the text of its direct `<text>`
// *element* children. The native RN UIToolkit tags text nodes with `role="text"`
// and puts the string inline, but the Chromium toolkit inside a `WebView` emits
// text as bare `<child>` wrappers whose string sits in a nested `<text>` element
// (no role). Reading only inline `node.text` therefore made every WebView text
// node look empty — so the whole web DOM (grid tiles, headings, labels) was
// judged unmeaningful and flattened away (argent#474). Both meaningfulness and
// the label are derived from this same notion so they can't drift apart.
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
// `<child>` wrappers (full-screen containers with none of these) are flattened
// away. Takes the node's already-computed own text (which is also its label) so
// `convert` computes `ownText` once per node instead of here and again for the label.
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
// *and* keeps the per-span text elements underneath it, so these leaves show up
// as children of a node that already states their combined text. A span counts
// only when it adds nothing else: default `view` role, no identifier, no
// interactivity or focus/selection state, and no descendants of its own —
// anything structural (a role, a test_id, a focusable/selected span) is not one.
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

// Whether `children` are exactly the duplicated sub-spans of `label`: every
// child is a plain text span and their in-order labels, concatenated with no
// separator, reconstruct the parent's aggregated label. Chromium joins inline
// sub-spans with no separator ("10" + "Tile 10" -> "10Tile 10"), so an exact
// reconstruction identifies the duplication precisely — unlike substring
// containment, which would wrongly swallow a distinct "Play" under "Playlist"
// (a substring but not a sub-span), or a distinct "Tile 1" under "Tile 10". A
// real list whose container name joins rows with spaces ("Home Settings About")
// never reconstructs from its rows ("Home" + "Settings" + ...), so genuine,
// separately-navigable rows are kept with their individual frames.
function childrenReconstructLabel(children: DescribeNode[], label: string): boolean {
  if (children.length === 0 || !children.every(isPlainTextSpan)) return false;
  return children.map((c) => c.label).join("") === label;
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

  // `ownText` is a node's inline text plus its direct `<text>` element children;
  // it doubles as the node's label. Compute it once and reuse it for both the
  // meaningfulness gate and the label below.
  const label = ownText(node);
  if (!isMeaningful(node, label)) return childNodes;

  const attrs = node.attrs;
  // Absorb the WebView a11y tree's duplicated sub-spans: when this node's own
  // aggregated label is exactly reconstructed by its plain-text-span children,
  // those children are the label's pieces (not distinct elements), so drop them
  // and keep the node as a single clean leaf (see `childrenReconstructLabel`).
  // Anything that isn't a perfect reconstruction is left untouched.
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

// The persistent Kepler launcher renders its own `<app>` ("Register this
// device", "…is ready") into every page source alongside the foreground app.
// Its controls aren't part of the app under test, so merging them produces
// phantom off-screen elements and duplicate `test_id`s — scope describe to the
// foreground app(s) and drop the launcher.
const LAUNCHER_APP_NAME = "com.amazon.keplerlauncherapp";

/**
 * The XML subtree(s) to actually render. For the `<root><app>…</app></root>`
 * shape, return the non-launcher apps (falling back to all apps if the launcher
 * is somehow the only one). For any other shape, render the root as-is.
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
    // surface multiple foreground apps with different window sizes, and normalizing
    // a second app's frames against the first app's dimensions clamps them
    // off-screen (a visible control would read as untappable).
    const { w, h } = findScreenSize(scope);
    children.push(...convert(scope, w, h));
  }
  return {
    role: "Screen",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children,
  };
}
