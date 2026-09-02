import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { DescribeFrame, DescribeNode } from "../../contract";

interface ParsedXmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: ParsedXmlNode[];
}

/** Minimal XML parser for `uiautomator dump`: attributes only, no CDATA, no dependency. */
export function parseUiAutomatorXml(xml: string): ParsedXmlNode | null {
  const body = xml.replace(/^\s*<\?xml[^?]*\?>\s*/, "");
  // Quoted attribute values may hold `>` (XML escapes only `<` and `&`), so the
  // attr block matches quoted runs; its unquoted class excludes `/` so the
  // trailing `\s*(\/?)` still recognises self-closing tags.
  const tagRe = /<(\/?)([A-Za-z_][\w.-]*)((?:"[^"]*"|'[^']*'|[^"'/<>])*?)\s*(\/?)>/gs;
  const stack: ParsedXmlNode[] = [];
  let root: ParsedXmlNode | null = null;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(body)) !== null) {
    const [, closing, tag, rawAttrs, selfClose] = match;
    if (closing) {
      if (stack.length > 0) stack.pop();
      continue;
    }
    const attrs = parseAttributes(rawAttrs ?? "");
    const node: ParsedXmlNode = { tag: tag!, attrs, children: [] };
    const parent = stack[stack.length - 1];
    if (parent) {
      parent.children.push(node);
    } else if (root === null) {
      root = node;
    } else {
      // Malformed input lost the stack context (typically an extra `</node>`);
      // re-attach the orphan to the root so later siblings stay reachable.
      root.children.push(node);
    }
    if (!selfClose) stack.push(node);
  }
  return root;
}

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_][\w.-]*)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    attrs[m[1]!] = decodeXmlEntities(m[2]!);
  }
  return attrs;
}

// One alternation, not chained per-entity replaces: those double-decode
// `&amp;lt;` (the encoding of the literal `&lt;`) all the way down to `<`.
function decodeXmlEntities(s: string): string {
  return s.replace(
    /&(?:#x([0-9A-Fa-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/g,
    (match, hex, dec, name) => {
      if (hex) return safeFromCodePoint(parseInt(hex, 16));
      if (dec) return safeFromCodePoint(parseInt(dec, 10));
      switch (name) {
        case "amp":
          return "&";
        case "lt":
          return "<";
        case "gt":
          return ">";
        case "quot":
          return '"';
        case "apos":
          return "'";
        default:
          return match;
      }
    }
  );
}

function safeFromCodePoint(n: number): string {
  // Numeric references can name values outside Unicode, or surrogate halves;
  // drop the glyph rather than throw.
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return "";
  if (n >= 0xd800 && n <= 0xdfff) return "";
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}

export function parseUiAutomatorBounds(
  bounds: string
): { x: number; y: number; w: number; h: number } | null {
  const m = bounds.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
  if (!m) return null;
  const x1 = parseInt(m[1]!, 10);
  const y1 = parseInt(m[2]!, 10);
  const x2 = parseInt(m[3]!, 10);
  const y2 = parseInt(m[4]!, 10);
  return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
}

/**
 * Intersect a uiautomator-pixel rect with the screen rect. `parseUiAutomatorBounds`
 * keeps negative origins and out-of-range corners so callers can spot
 * partially-off-screen views; this returns the visible portion `describe`
 * normalises into [0,1].
 */
export function clipBoundsToScreen(
  b: { x: number; y: number; w: number; h: number },
  screenW: number,
  screenH: number
): { x: number; y: number; w: number; h: number } {
  if (screenW <= 0 || screenH <= 0) return { x: 0, y: 0, w: 0, h: 0 };
  const x1 = Math.max(0, Math.min(b.x, screenW));
  const y1 = Math.max(0, Math.min(b.y, screenH));
  const x2 = Math.max(0, Math.min(b.x + b.w, screenW));
  const y2 = Math.max(0, Math.min(b.y + b.h, screenH));
  return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
}

export function deriveUiAutomatorRole(className: string): string {
  const short = className.split(".").pop() ?? className;
  const lower = short.toLowerCase();
  // `radiobutton` contains `button`, so the specific classes must match first.
  if (lower.includes("radiobutton")) return "RadioButton";
  if (lower.includes("checkbox")) return "CheckBox";
  if (lower.includes("button")) return "Button";
  if (lower.includes("edittext") || lower.includes("textinput")) return "TextField";
  if (lower.includes("textview") || lower === "text") return "StaticText";
  if (lower.includes("image")) return "Image";
  if (lower.includes("switch")) return "Switch";
  if (lower.includes("scrollview") || lower.includes("recyclerview") || lower.includes("listview"))
    return "ScrollView";
  if (lower.includes("webview")) return "WebView";
  return short || "View";
}

// v2 interactables-only trim: drop scaffolding and decoration, keep every
// clickable, text label, content-desc and resource-id.

const NOISY_CLASSES = new Set([
  // react-native-svg icon internals: never tappable, and the parent already
  // carries the icon's content-desc.
  "com.horcrux.svg.PathView",
  "com.horcrux.svg.GroupView",
  "com.horcrux.svg.SvgView",
]);

/** Whether a raw class is decorative implementation detail to drop with its subtree. */
export function isNoisyUiAutomatorClass(className: string): boolean {
  return NOISY_CLASSES.has(className);
}

const SYSTEM_PACKAGES = new Set([
  // Status bar / nav bar / quick settings. Only systemui is listed on purpose:
  // a foreground system app (settings, permission dialog) must still surface.
  "com.android.systemui",
]);

const SYSTEM_RID_PREFIXES = [
  "android:id/navigationBarBackground",
  "android:id/statusBarBackground",
  "com.android.systemui:id/",
];

const LAYOUT_CONTAINERS = new Set([
  "android.widget.FrameLayout",
  "android.widget.LinearLayout",
  "android.widget.RelativeLayout",
  "androidx.constraintlayout.widget.ConstraintLayout",
  "androidx.coordinatorlayout.widget.CoordinatorLayout",
  "android.view.ViewGroup",
  // Compose emits bare android.view.View for semantics nodes with no widget
  // mapping.
  "android.view.View",
]);

/** Whether a raw class is hierarchy scaffolding rather than a role target. */
export function isUiAutomatorLayoutContainer(className: string): boolean {
  return !className || LAYOUT_CONTAINERS.has(className);
}

const SCROLL_CLASSES = new Set([
  "android.widget.ScrollView",
  "android.widget.HorizontalScrollView",
  "androidx.recyclerview.widget.RecyclerView",
  "android.widget.ListView",
]);

/**
 * Whether a node scrolls its content — a known scroll class, or anything marked
 * `scrollable` (RN's ScrollView dumps as a scrollable ViewGroup). Its bounds become
 * the clip window for the scroll-clip prune. Shared with `flow-android-tree` so
 * both trees agree on which containers clip.
 *
 * Inside a WebView the class name is Chromium's mapping of an HTML tag, not a
 * real scroll container: a `<ul>` arrives as `android.widget.ListView` carrying
 * `scrollable="false"`, and a web list does not scroll — the page scrolls in
 * the WebView, or in the element Chromium marks `scrollable` itself.
 * `ListView` is the only `SCROLL_CLASSES` member a web tag is known to reach,
 * so it is the one this arm changes. Trust the framework's own flag there and
 * never the class name, so an element positioned outside its list's box is not
 * treated as scrolled away and dropped.
 */
export function isUiAutomatorScrollable(attrs: Record<string, string>, inWebView = false): boolean {
  if (inWebView) return attrIsTrue(attrs, "scrollable");
  return SCROLL_CLASSES.has(attrs.class ?? "") || attrIsTrue(attrs, "scrollable");
}

const WEBVIEW_CLASSES = new Set(["android.webkit.WebView", "android.webkit.WebViewChromium"]);

/**
 * Whether a raw class hosts web content. Shared with the flow tree adapter
 * (`flow-android-tree`) so both trees agree on where the web DOM starts.
 */
export function isUiAutomatorWebView(className: string): boolean {
  return WEBVIEW_CLASSES.has(className);
}

interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Internal representation for the trim pass. Pixel bounds rather than [0,1] so
// the duplicate-wrapper and scroll-clip checks can use exact equality.
interface UiNode {
  role: string;
  pixelBounds: PixelRect | null;
  label?: string;
  identifier?: string;
  value?: string;
  clickable: boolean;
  longClickable: boolean;
  scrollable: boolean;
  checkable: boolean;
  checked: boolean;
  disabled: boolean;
  password: boolean;
  scrollHidden: number;
  children: UiNode[];
  // Set only on the landmark emitted for a real `WEBVIEW_CLASSES` host, so the
  // doubled-WebView merge can recognise its own kind. The role cannot: any
  // class whose name contains "webview" derives the role "WebView". A WebView
  // subclass is not the shape that reaches this — `getAccessibilityClassName`
  // hard-codes `android.webkit.WebView`, so a subclass dumps under the base
  // name. An app's own control does: a view that is no WebView at all but
  // overrides `getAccessibilityClassName()` to a name containing "webview".
  // A WebView publishes such a child for as long as it holds no document
  // (measured on API 35 / WebView 124: the child is in the dump until a page
  // loads and the render process supplies its own node provider, and stays
  // there for good if the app never loads one). Internal to this module —
  // `finalizeUiNode` copies named fields only, so it never reaches the public
  // tree.
  hostsWebContent?: boolean;
}

interface PruneOptions {
  screenW: number;
  screenH: number;
  includeSystem: boolean;
}

export function attrIsTrue(attrs: Record<string, string>, key: string): boolean {
  return attrs[key] === "true";
}

/**
 * Whether the node itself receives touch/selection input. Narrower than
 * `isInteractive`, which also counts a labelled focusable node. Inside a
 * WebView `focusable` does not track what a user can act on — Chromium sets it
 * on some plain text runs and leaves it off others — so only the gesture flags
 * separate a link from a paragraph.
 */
function isTapTarget(attrs: Record<string, string>): boolean {
  return (
    attrIsTrue(attrs, "clickable") ||
    attrIsTrue(attrs, "long-clickable") ||
    attrIsTrue(attrs, "checkable") ||
    attrIsTrue(attrs, "scrollable")
  );
}

function isInteractive(attrs: Record<string, string>): boolean {
  if (isTapTarget(attrs)) return true;
  // Focusable without a label is just a focus trap on a layout wrapper.
  if (attrIsTrue(attrs, "focusable") && labelOf(attrs) !== "") return true;
  return false;
}

/**
 * Role for a node read in the context of the tree around it, rather than from
 * its class name alone. Chromium maps a generic web text run onto a bare
 * `android.view.View`, which `deriveUiAutomatorRole` reports as "View": it
 * reads wrong in the tree, and `View` is a generic role no selector can use.
 *
 * The remap is deliberately contextual rather than a rule inside
 * `deriveUiAutomatorRole`: on a native screen a bare `android.view.View` is a
 * Compose semantics node with no widget mapping, and reclassifying those would
 * shift matching on every native screen. Gating on `inWebView` touches web
 * content only.
 *
 * The second rule keeps a role off the class name where `isUiAutomatorScrollable`
 * already refuses to read one: a `<ul>` arrives as `android.widget.ListView`,
 * whose role is "ScrollView", on a node Chromium marks `scrollable="false"`.
 * That node both asserts and denies scrolling, and `isScrollContainer` in
 * `flow-actions` counts any `/scroll/i` role as a scroller — against the
 * `scrolls: false` the flow tree sets for the same node. A web scroller the
 * framework does flag (`overflow: scroll`) keeps its role.
 *
 * Both Android trees call this — the agent-facing `describe` trim and the flow
 * selector tree (`flow-android-tree`) — so a `role` an agent reads out of
 * `describe` still matches when a flow replays it.
 */
export function deriveUiAutomatorRoleInContext(
  className: string,
  attrs: Record<string, string>,
  // `hasChildren` is the RAW published child count, never the count that
  // survives a trim: the two trees prune differently, so a role derived from
  // each tree's own survivors would drift apart on exactly the nodes this
  // function exists to keep in step. The two do read separate captures, taken
  // under different node budgets (describe 5,000, the flow tree 12,000), and
  // the helper publishes a node at the boundary childless in the narrower one
  // — so on a screen past 5,000 nodes the counts can differ. describe reports
  // that capture as PARTIAL.
  ctx: { inWebView: boolean; label: string; hasChildren: boolean }
): string {
  if (
    ctx.inWebView &&
    className === "android.view.View" &&
    ctx.label !== "" &&
    !ctx.hasChildren &&
    // A tappable web node is a control (a link, a custom button), not a text
    // run. Gesture flags are the only signal that separates the two: inside a
    // WebView `focusable` says nothing, so `isInteractive` cannot be used here.
    !isTapTarget(attrs)
  ) {
    return "StaticText";
  }
  const role = deriveUiAutomatorRole(className);
  // The same regex `isScrollContainer` uses, so no node inside a WebView can
  // report a scroll role to it unless the framework flagged the node scrollable.
  if (ctx.inWebView && /scroll/i.test(role) && !attrIsTrue(attrs, "scrollable")) {
    return "List";
  }
  return role;
}

export function labelOf(attrs: Record<string, string>): string {
  // Prefer `content-desc` so an EditText with content-desc="Email" text="x@y"
  // emits label="Email" and (via `makeUiNode`) value="x@y".
  const cd = (attrs["content-desc"] ?? "").trim();
  if (cd) return cd;
  return (attrs.text ?? "").trim();
}

function isVisibleRect(b: PixelRect | null, sw: number, sh: number): boolean {
  if (!b) return false;
  if (b.w <= 0 || b.h <= 0) return false;
  if (b.x >= sw || b.y >= sh || b.x + b.w <= 0 || b.y + b.h <= 0) return false;
  return true;
}

function isSystemChrome(attrs: Record<string, string>): boolean {
  if (SYSTEM_PACKAGES.has(attrs.package ?? "")) return true;
  const rid = attrs["resource-id"] ?? "";
  return SYSTEM_RID_PREFIXES.some((p) => rid.startsWith(p));
}

function rectsEqual(a: PixelRect, b: PixelRect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/**
 * Whether a rect lies entirely outside a clip window — the scroll-clip test
 * `pruneSubtree` applies to views scrolled out of their container's viewport.
 * Exported so `flow-tree-flatten` agrees with describe on what "scrolled out" means.
 */
export function rectFullyOutside(
  kid: { x: number; y: number; w: number; h: number },
  clip: { x: number; y: number; w: number; h: number }
): boolean {
  return (
    kid.x + kid.w <= clip.x ||
    kid.x >= clip.x + clip.w ||
    kid.y + kid.h <= clip.y ||
    kid.y >= clip.y + clip.h
  );
}

/**
 * Concatenate every non-empty `text` / `content-desc` under `parsed`, deduped and
 * capped, so a clickable container with no label of its own can borrow its
 * descendants' (the "row-as-tap-target" pattern).
 */
function descendantText(parsed: ParsedXmlNode, maxChars = 120): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  const stack: ParsedXmlNode[] = [parsed];
  while (stack.length > 0) {
    const x = stack.pop()!;
    // A password field's `text` is the secret, and this walk reads the raw XML,
    // bypassing the "[password]" redaction applied to the node's own label.
    if (attrIsTrue(x.attrs, "password")) {
      if (!seen.has("[password]")) {
        seen.add("[password]");
        parts.push("[password]");
      }
      continue;
    }
    for (const k of ["text", "content-desc"] as const) {
      const v = (x.attrs[k] ?? "").trim();
      if (v && !seen.has(v)) {
        seen.add(v);
        parts.push(v);
      }
    }
    // Push in reverse so we pop in original document order.
    for (let i = x.children.length - 1; i >= 0; i--) {
      const c = x.children[i]!;
      if (c.tag === "node") stack.push(c);
    }
  }
  const s = parts.join(" / ");
  return s.length > maxChars ? s.slice(0, maxChars) + "…" : s;
}

function makeUiNode(
  attrs: Record<string, string>,
  role: string,
  pixelBounds: PixelRect | null,
  label: string,
  children: UiNode[]
): UiNode {
  const out: UiNode = {
    role,
    pixelBounds,
    children,
    clickable: attrIsTrue(attrs, "clickable"),
    longClickable: attrIsTrue(attrs, "long-clickable"),
    scrollable: attrIsTrue(attrs, "scrollable"),
    checkable: attrIsTrue(attrs, "checkable"),
    checked: attrIsTrue(attrs, "checked"),
    disabled: attrs.enabled === "false",
    password: attrIsTrue(attrs, "password"),
    scrollHidden: 0,
  };
  if (label) out.label = label;
  const rid = attrs["resource-id"];
  if (rid) out.identifier = rid;
  // Expose a diverging `text` as `value` (an EditText's content while the
  // placeholder lives in `content-desc`). Skipped for password fields: `label` is
  // redacted but `attrs.text` still holds the secret.
  if (!out.password) {
    const text = (attrs.text ?? "").trim();
    if (text && text !== label) out.value = text;
  }
  return out;
}

/**
 * Apply the v2 trim rules to `parsed`'s subtree, returning the UiNodes that take
 * its place in the output:
 *   []        — dropped
 *   [n]       — kept, possibly collapsed/aggregated
 *   [a,b,...] — passthrough wrapper; its kept children inline into the parent
 */
function pruneSubtree(root: ParsedXmlNode, opts: PruneOptions): UiNode[] {
  // Iterative post-order. Each frame carries the clip this node must enforce on
  // its own children, so the filter fires at the parent of the clipped node.
  type Frame = {
    parsed: ParsedXmlNode;
    scrollClip: PixelRect | null;
    inWebView: boolean;
    visited: boolean;
  };
  const stack: Frame[] = [{ parsed: root, scrollClip: null, inWebView: false, visited: false }];
  const outputs = new Map<ParsedXmlNode, UiNode[]>();
  // Hidden-child counts belonging to nodes that hand their children up and
  // disappear. Their `scrollHidden` has nowhere to live, so the parent adds it
  // to its own — see `passUp` in `computeNodeOutput`.
  const orphanHidden = new Map<ParsedXmlNode, number>();

  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    if (!top.visited) {
      top.visited = true;
      const attrs = top.parsed.attrs;
      const myBounds = parseUiAutomatorBounds(attrs.bounds ?? "");
      // Children inherit my bounds if I scroll, else the clip I was handed.
      const childClip = scrollClipOf(attrs, myBounds, top.inWebView, opts, top.scrollClip);
      // Everything below a WebView is web DOM, not native widgets — the flag
      // rides down the frame the same way `scrollClip` does, so the contextual
      // role remap needs no second walk.
      const childInWebView = top.inWebView || WEBVIEW_CLASSES.has(attrs.class ?? "");
      for (let i = top.parsed.children.length - 1; i >= 0; i--) {
        const c = top.parsed.children[i]!;
        if (c.tag === "node") {
          stack.push({
            parsed: c,
            scrollClip: childClip,
            inWebView: childInWebView,
            visited: false,
          });
        }
      }
    } else {
      outputs.set(
        top.parsed,
        computeNodeOutput(top.parsed, top.scrollClip, top.inWebView, outputs, orphanHidden, opts)
      );
      stack.pop();
    }
  }
  return outputs.get(root) ?? [];
}

/**
 * The clip window a node's children live under: the node's own box if it
 * scrolls, else the one it was handed.
 *
 * Both `pruneSubtree` (for the level below) and `computeNodeOutput` (for the
 * node's own children) call this. Filtering at BOTH levels is what makes a
 * scroller's own children obey its clip: the walk otherwise first bit at a
 * scroller's grandchildren, so a row the layout puts outside the viewport —
 * where a scrolled-away row sits — survived as on-screen and tappable with
 * nothing to say it had to be scrolled to. The flow selector tree has always
 * clipped at this level.
 *
 * A scroller whose own box is unusable clips nothing. `rectFullyOutside` reads
 * a zero-height window as "everything is outside", so trusting a degenerate box
 * would delete the whole subtree — and Chromium does report a WebView at
 * negative height while its content is still on screen.
 */
function scrollClipOf(
  attrs: Record<string, string>,
  bounds: PixelRect | null,
  inWebView: boolean,
  opts: PruneOptions,
  inherited: PixelRect | null
): PixelRect | null {
  if (!isUiAutomatorScrollable(attrs, inWebView)) return inherited;
  if (!bounds || !isVisibleRect(bounds, opts.screenW, opts.screenH)) return inherited;
  return bounds;
}

/**
 * The box to publish for a node whose own one is unusable — clipped to zero or
 * negative area — while children of it are still on screen. The dump's numbers
 * render as a zero-height frame, and `getDescribeTapPoint` on that returns a
 * point on the frame's top edge rather than on anything the node covers. The
 * union of the children that survived is the region those children cover, which
 * is the best-known region for the node: the trim runs first, so a child it
 * dropped (a decorative `ImageView`) contributes nothing here. When nothing
 * survives — the label dedup can empty a node's children after the visibility
 * guard has let it through — there is no region to read and the caller keeps
 * the dump's numbers, tap point and all.
 *
 * Chromium reports a loaded WebView this way under load, so the node this hits
 * is the landmark covering the whole page.
 */
function boundsOverChildren(children: UiNode[]): PixelRect | null {
  let out: PixelRect | null = null;
  for (const c of children) {
    const b = c.pixelBounds;
    if (!b || b.w <= 0 || b.h <= 0) continue;
    if (!out) {
      out = { ...b };
      continue;
    }
    const x = Math.min(out.x, b.x);
    const y = Math.min(out.y, b.y);
    out = {
      x,
      y,
      w: Math.max(out.x + out.w, b.x + b.w) - x,
      h: Math.max(out.y + out.h, b.y + b.h) - y,
    };
  }
  return out;
}

/**
 * Whether the trim drops this node and hands its children up in its place, so
 * the region below it stands for it. Reads the two passthrough arms of
 * `computeNodeOutput` — the decorative `ImageView`, and the layout container
 * with nothing of its own.
 */
function passesChildrenUp(attrs: Record<string, string>, cls: string): boolean {
  if (isInteractive(attrs) || labelOf(attrs) !== "") return false;
  return cls.endsWith(".ImageView") || LAYOUT_CONTAINERS.has(cls);
}

/**
 * The region a node's descendants cover, read straight off the dump rather than
 * off the trim's survivors. `boundsOverChildren` answers the same question for
 * the trim, which has its survivors to hand; the flow selector tree
 * (`flow-android-tree`) keeps a different set of nodes and still has to publish
 * the same box, or a frame an author copies out of `describe` addresses a
 * different region at replay.
 *
 * The descent follows the trim rather than stopping at the first usable box: a
 * node the trim hands its children up for — a bare wrapper `<div>`, a
 * decorative `ImageView`, a node whose own box is unusable — contributes those
 * children in its place, a node the trim drops with its subtree contributes
 * nothing, and a descendant an ancestor's scroll clip hides is not on screen to
 * contribute at all. `scrollClip` is the window the node's own children live
 * under, which is the one it inherited: a node with an unusable box scrolls
 * nothing.
 */
export function regionOverDescendants(
  node: ParsedXmlNode,
  opts: { screenW: number; screenH: number; inWebView: boolean; scrollClip: PixelRect | null }
): PixelRect | null {
  const pruneOpts: PruneOptions = {
    screenW: opts.screenW,
    screenH: opts.screenH,
    includeSystem: false,
  };
  type Frame = { node: ParsedXmlNode; clip: PixelRect | null; inWebView: boolean };
  const stack: Frame[] = [];
  const descend = (parent: ParsedXmlNode, clip: PixelRect | null, inWebView: boolean): void => {
    for (const c of parent.children) {
      if (c.tag === "node") stack.push({ node: c, clip, inWebView });
    }
  };
  descend(node, opts.scrollClip, opts.inWebView);
  let out: PixelRect | null = null;
  while (stack.length > 0) {
    const { node: n, clip, inWebView } = stack.pop()!;
    const attrs = n.attrs;
    const cls = attrs.class ?? "";
    if (NOISY_CLASSES.has(cls) || isSystemChrome(attrs)) continue;
    const bounds = parseUiAutomatorBounds(attrs.bounds ?? "");
    if (bounds && clip && rectFullyOutside(bounds, clip)) continue;
    if (!isVisibleRect(bounds, opts.screenW, opts.screenH) || passesChildrenUp(attrs, cls)) {
      descend(
        n,
        scrollClipOf(attrs, bounds, inWebView, pruneOpts, clip),
        inWebView || WEBVIEW_CLASSES.has(cls)
      );
      continue;
    }
    const b = bounds!;
    if (!out) {
      out = { ...b };
      continue;
    }
    const x = Math.min(out.x, b.x);
    const y = Math.min(out.y, b.y);
    out = {
      x,
      y,
      w: Math.max(out.x + out.w, b.x + b.w) - x,
      h: Math.max(out.y + out.h, b.y + b.h) - y,
    };
  }
  return out;
}

/**
 * The box a node publishes: its own, or — when it HAS one and that one is
 * unusable — the region its surviving children cover.
 *
 * A node with no `bounds` attribute at all is a different case and must keep
 * its `null`: `finalizeUiNode` has its own rule for a bounds-less wrapper
 * (drop it when empty, pass through its sole child, union the frames
 * otherwise), and handing it a pixel box here routes it past that rule — a
 * bounds-less Compose wrapper would publish as an extra node whose frame just
 * repeats its only child's.
 */
function publishedBounds(
  bounds: PixelRect | null,
  visible: boolean,
  children: UiNode[]
): PixelRect | null {
  if (visible || !bounds) return bounds;
  return boundsOverChildren(children) ?? bounds;
}

function computeNodeOutput(
  parsed: ParsedXmlNode,
  scrollClip: PixelRect | null,
  inWebView: boolean,
  outputs: Map<ParsedXmlNode, UiNode[]>,
  orphanHidden: Map<ParsedXmlNode, number>,
  opts: PruneOptions
): UiNode[] {
  const attrs = parsed.attrs;
  const cls = attrs.class ?? "";

  if (NOISY_CLASSES.has(cls)) return [];
  if (!opts.includeSystem && isSystemChrome(attrs)) return [];

  const bounds = parseUiAutomatorBounds(attrs.bounds ?? "");
  const visible = isVisibleRect(bounds, opts.screenW, opts.screenH);

  // The clip my children live under, computed exactly as `pruneSubtree` computes
  // it for the level below, so the two levels cannot drift apart.
  const childClip = scrollClipOf(attrs, bounds, inWebView, opts, scrollClip);

  let keptChildren: UiNode[] = [];
  let hiddenInScroll = 0;
  for (const c of parsed.children) {
    if (c.tag !== "node") continue;
    const kids = outputs.get(c);
    if (!kids) continue;
    // A child that handed its own children up counted what its clip hid before
    // it disappeared. Adopt the count, or it is lost with the node.
    hiddenInScroll += orphanHidden.get(c) ?? 0;
    for (const kid of kids) {
      if (childClip && kid.pixelBounds && rectFullyOutside(kid.pixelBounds, childClip)) {
        hiddenInScroll += 1;
        continue;
      }
      keptChildren.push(kid);
    }
  }

  // Every path that discards this node routes through here: the count of what
  // this node's clip hid has no node left to sit on, so it moves to the nearest
  // surviving ancestor. An unnamed wrapper `<div>` — or the
  // `<ScrollView><View>{rows}</View></ScrollView>` a React Native screen dumps
  // as — is exactly such a node, so without this the "swipe before you tap"
  // signal disappears on the most ordinary layout there is. A node dropped with
  // NO survivors needs it too: when the node's own box is unusable and its clip
  // hid every child it had, the guards below discard it, and the count is the
  // only record left that those rows are there.
  const passUp = (out: UiNode[]): UiNode[] => {
    if (hiddenInScroll > 0) orphanHidden.set(parsed, hiddenInScroll);
    return out;
  };

  // WebView: the DOM *is* published to the accessibility tree — on most builds
  // Chromium maps an HTML `id` onto `resource-id`, so web controls are
  // addressable exactly like native ones (some WebView versions publish no ids
  // at all, and then only text and frames identify a control). Keep the WebView
  // as a landmark and let the normal trim rules run over the DOM underneath.
  //
  // The landmark can be unlabelled. The page <title> arrives as the `text` of
  // Chromium's root web area — the single node of a browser tab, and the inner
  // half of an in-app pair. The app's own WebView view, the outer half, never
  // carries it, so a WebView whose renderer has published nothing yet has no
  // label at all. The renderer keeps the node in the describe output either
  // way — "WebView" is one of its content roles — so an unlabelled landmark
  // still reports its bounds instead of vanishing.
  //
  // The visibility guard matches every other branch: a WebView clipped to zero
  // area whose children are still on screen must not take the subtree down
  // with it.
  if (WEBVIEW_CLASSES.has(cls)) {
    if (!visible && keptChildren.length === 0) return passUp([]);
    const own = labelOf(attrs);
    // An app that hosts its own WebView reaches the dump twice, nested: the
    // app's `android.webkit.WebView` view, and Chromium's root web area, which
    // reports the same class name. The second node appears only when the
    // renderer publishes the page, which is what identifies it — before that
    // the app's view stands alone. A browser has no WebView view of its own,
    // so a Chrome tab arrives as one node; the checked-in captures show both
    // shapes (in-app two, Chrome one).
    //
    // Without a merge the in-app tree reads `WebView > WebView > ...`. The
    // generic duplicate-wrapper collapse further down cannot help: this branch
    // returns before reaching it, and the pair is rarely clickable anyway. The
    // two nodes sit at identical bounds on some builds and a few pixels apart
    // on others, so the merge must not depend on the bounds matching. Keep the
    // outer node's on-screen bounds and whichever of the two carries a label.
    let webChildren = keptChildren;
    let webLabel = own;
    let inner: UiNode | undefined;
    if (keptChildren.length === 1 && keptChildren[0]!.hostsWebContent) {
      inner = keptChildren[0]!;
      webChildren = inner.children;
      if (!webLabel && inner.label) webLabel = inner.label;
    }
    const webView = makeUiNode(
      attrs,
      "WebView",
      publishedBounds(bounds, visible, webChildren),
      webLabel,
      webChildren
    );
    webView.hostsWebContent = true;
    if (inner) {
      // Either half of the pair can be the one the framework marked, and which
      // half varies by WebView build, so the merged landmark inherits the union
      // rather than whichever side happened to survive. The flags decide
      // whether an agent treats the region as tappable or scrollable at all.
      webView.clickable ||= inner.clickable;
      webView.longClickable ||= inner.longClickable;
      webView.scrollable ||= inner.scrollable;
      webView.checkable ||= inner.checkable;
      webView.checked ||= inner.checked;
      webView.disabled ||= inner.disabled;
      if (!webView.identifier && inner.identifier) webView.identifier = inner.identifier;
      if (!webView.value && inner.value) webView.value = inner.value;
    }
    const hiddenUnderWebView = hiddenInScroll + (inner?.scrollHidden ?? 0);
    if (hiddenUnderWebView > 0) webView.scrollHidden = hiddenUnderWebView;
    return [webView];
  }

  const interactive = isInteractive(attrs);
  let label = labelOf(attrs);

  // Redact where the label is derived, not at `makeUiNode`: the collapse sites
  // below copy this label onto a surviving child and return early, so a later
  // redaction would be bypassed.
  if (attrIsTrue(attrs, "password")) {
    label = "[password]";
  }

  // Decorative ImageView — drop it, passing surviving descendants through.
  if (cls.endsWith(".ImageView") && !interactive && !label) {
    return passUp(keptChildren);
  }

  // Layout container with no own info — pass children through, flattening the
  // FrameLayout > LinearLayout > ConstraintLayout chains --compressed leaves.
  if (LAYOUT_CONTAINERS.has(cls) && !interactive && !label) {
    return passUp(keptChildren);
  }

  if (!visible && keptChildren.length === 0) return passUp([]);

  // Compound clickable with no label of its own: borrow descendant labels. Pure
  // scrollables are excluded — their descendants are a screenful of text.
  if (
    (attrIsTrue(attrs, "clickable") || attrIsTrue(attrs, "long-clickable")) &&
    !label &&
    keptChildren.length > 0
  ) {
    const agg = descendantText(parsed);
    if (agg) label = agg;
  }

  // Duplicate-wrapper collapse: a clickable parent whose only kept descendant is
  // clickable with identical bounds is the same tap target twice; keep the inner.
  if (interactive && bounds && keptChildren.length === 1) {
    const c = keptChildren[0]!;
    if (c.clickable && c.pixelBounds && rectsEqual(c.pixelBounds, bounds)) {
      // The label can live ONLY on the outer wrapper (an RN `Pressable
      // accessibilityLabel` around a bare clickable native view), so fall back to
      // the wrapper's values instead of dropping them.
      if (!c.label && label) c.label = label;
      const rid = attrs["resource-id"];
      if (!c.identifier && rid) c.identifier = rid;
      return passUp([c]);
    }
  }

  // Drop child Text nodes whose label is already inside mine, so the agent doesn't
  // see both "Like (634 likes)" and a bare "634" as separate items.
  if (interactive && label) {
    const lower = label.toLowerCase();
    keptChildren = keptChildren.filter(
      (c) =>
        !(
          c.role === "StaticText" &&
          c.label &&
          lower.includes(c.label.toLowerCase()) &&
          !c.clickable
        )
    );
  }

  const role = deriveUiAutomatorRoleInContext(cls, attrs, {
    inWebView,
    label,
    // The published child count, not `keptChildren`: a text run is childless in
    // the dump itself, and the flow selector tree reads the same dump with its
    // own (wider) trim. Reading survivors here would report `StaticText` for a
    // container whose children this trim dropped while the flow tree still
    // reported `View` — the mismatch a copied `role` selector then fails on.
    hasChildren: parsed.children.some((c) => c.tag === "node"),
  });

  const node = makeUiNode(
    attrs,
    role,
    publishedBounds(bounds, visible, keptChildren),
    label,
    keptChildren
  );
  if (hiddenInScroll > 0) node.scrollHidden = hiddenInScroll;
  return [node];
}

/**
 * Lower a UiNode tree to the public DescribeNode contract. Iterative post-order so
 * deep trees (RN screens stacked ~30 levels) can't overflow the stack.
 */
function describeFromUiTree(root: UiNode, sw: number, sh: number): DescribeNode | null {
  const out = new Map<UiNode, DescribeNode | null>();
  type S = { node: UiNode; visited: boolean };
  const stack: S[] = [{ node: root, visited: false }];
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    if (!top.visited) {
      top.visited = true;
      for (let i = top.node.children.length - 1; i >= 0; i--) {
        stack.push({ node: top.node.children[i]!, visited: false });
      }
    } else {
      const childDns: DescribeNode[] = [];
      for (const c of top.node.children) {
        const dn = out.get(c);
        if (dn) childDns.push(dn);
      }
      out.set(top.node, finalizeUiNode(top.node, childDns, sw, sh));
      stack.pop();
    }
  }
  return out.get(root) ?? null;
}

function finalizeUiNode(
  n: UiNode,
  children: DescribeNode[],
  sw: number,
  sh: number
): DescribeNode | null {
  let frame: DescribeFrame;
  if (n.pixelBounds) {
    // Clip before normalising: clamping `x` and `width` to [0,1] independently
    // lets `x + width` exceed 1 (bounds=[1090,0][1280,200] on a 1080-wide screen
    // gives x=1, width≈0.176, so the tap centre lands off-screen).
    const clipped = clipBoundsToScreen(n.pixelBounds, sw, sh);
    frame = {
      x: sw > 0 ? clipped.x / sw : 0,
      y: sh > 0 ? clipped.y / sh : 0,
      width: sw > 0 ? clipped.w / sw : 0,
      height: sh > 0 ? clipped.h / sh : 0,
    };
  } else {
    // Bounds-less Compose group containers: drop empty wrappers, pass through a
    // single-child scaffold, union the children's frames otherwise. A single-child
    // wrapper with its own label/identifier is kept, not flattened, so that label
    // survives.
    if (children.length === 0) return null;
    if (children.length === 1 && !n.label && !n.identifier) return children[0]!;
    const x1 = Math.min(...children.map((c) => c.frame.x));
    const y1 = Math.min(...children.map((c) => c.frame.y));
    const x2 = Math.max(...children.map((c) => c.frame.x + c.frame.width));
    const y2 = Math.max(...children.map((c) => c.frame.y + c.frame.height));
    frame = { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
  }
  const out: DescribeNode = {
    role: n.role,
    frame,
    children,
  };
  if (n.label) out.label = n.label;
  if (n.identifier) out.identifier = n.identifier;
  if (n.value) out.value = n.value;
  if (n.clickable) out.clickable = true;
  if (n.longClickable) out.longClickable = true;
  if (n.scrollable) out.scrollable = true;
  if (n.checkable) out.checkable = true;
  if (n.checked) out.checked = true;
  if (n.disabled) out.disabled = true;
  if (n.password) out.password = true;
  if (n.scrollHidden > 0) out.scrollHidden = n.scrollHidden;
  return out;
}

/**
 * Parse `uiautomator dump` output into a DescribeNode tree matching the iOS
 * describe contract, so the same agent guidance about frames + tap points applies.
 * Applies the v2 interactables-only trim above.
 *
 * `includeSystem` defaults to false: SystemUI chrome is noise on app-level tasks.
 */
export function parseUiAutomatorDump(
  rawOutput: string,
  screenW: number,
  screenH: number,
  options: { includeSystem?: boolean } = {}
): DescribeNode {
  let xml = rawOutput;
  const xmlEnd = xml.lastIndexOf("</hierarchy>");
  if (xmlEnd !== -1) xml = xml.slice(0, xmlEnd + "</hierarchy>".length);
  const root = parseUiAutomatorXml(xml);
  if (!root) {
    throw new FailureError("Failed to parse uiautomator dump output", {
      error_code: FAILURE_CODES.ANDROID_UIAUTOMATOR_PARSE_FAILED,
      failure_stage: "android_uiautomator_parse_dump",
      failure_area: "tool_server",
      error_kind: "subprocess",
    });
  }
  const includeSystem = options.includeSystem === true;
  const opts: PruneOptions = { screenW, screenH, includeSystem };
  const topChildren: DescribeNode[] = [];
  for (const c of root.children) {
    if (c.tag !== "node") continue;
    const ui = pruneSubtree(c, opts);
    for (const n of ui) {
      const dn = describeFromUiTree(n, screenW, screenH);
      if (dn) topChildren.push(dn);
    }
  }
  return {
    role: "Screen",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children: topChildren,
  };
}
