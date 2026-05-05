import type { DescribeFrame, DescribeNode } from "../tools/describe/contract";

interface ParsedXmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: ParsedXmlNode[];
}

/**
 * Minimal XML parser tuned for `uiautomator dump` output. The dump is always
 * well-formed and shallow (attributes only, no CDATA), so a full XML parser would
 * be overkill and add a dependency.
 */
export function parseUiAutomatorXml(xml: string): ParsedXmlNode | null {
  const body = xml.replace(/^\s*<\?xml[^?]*\?>\s*/, "");
  // The attr block must allow `>` inside quoted attribute values: XML §2.4
  // requires only `<` and `&` to be escaped, so `text="A > B"` is legal and
  // does occur in real uiautomator dumps. The previous `[^<>]*?` rejected
  // those tags entirely and silently reparented the dropped subtree onto the
  // root. The unquoted-character class also excludes `/` so the trailing
  // `\s*(\/?)` still recognises self-closing tags (`<node ... />`); without
  // that exclusion the `/` was consumed into the attr block and self-closing
  // tags were mistaken for openers, leaking unbalanced nesting downstream.
  // `s` flag keeps newline tolerance for builds that wrap dumps at ~1 KB
  // boundaries.
  const tagRe = /<(\/?)([A-Za-z_][\w.-]*)((?:"[^"]*"|'[^']*'|[^"'/<>])*?)\s*(\/?)>/gs;
  const stack: ParsedXmlNode[] = [];
  let root: ParsedXmlNode | null = null;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(body)) !== null) {
    const [, closing, tag, rawAttrs, selfClose] = match;
    if (closing) {
      // Guard against a stray `</node>` with no matching opener: an unguarded
      // pop on an empty stack returns undefined, but worse — it leaves the
      // next opening tag treated as a root candidate. The root-once guard
      // below also handles the related case where a malformed dump emits
      // multiple top-level elements.
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
      // Malformed input lost its stack context (typically: an extra `</node>`
      // popped the real parent). Re-attach the orphan to the existing root so
      // subsequent siblings stay reachable instead of being silently dropped.
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

// Single-pass decoder. Chained per-entity `.replace` calls double-decode:
// `&amp;lt;` (correct XML encoding of the literal string `&lt;`) becomes `&lt;`
// after the first pass and then `<` after the second — wrong per XML §4.6.
// A single regex alternation scans left-to-right and consumes each match
// once, so a decoded `&` produced by one step never feeds the next step.
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
  // Numeric character references can encode values outside the valid Unicode
  // range (or surrogate halves). Fall back to an empty string rather than
  // throwing — the parsed tree is still usable without the broken glyph.
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
 * preserves negative origins and out-of-range corners so callers can detect
 * partially-off-screen views; this helper produces the visible portion only,
 * which is what `describe` needs to normalise into the [0,1] contract.
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
  // Order matters: RadioButton and CheckBox both contain "button"/"box" as substrings
  // of more specific classes, so check the specific cases first.
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

// ---------- v2 interactables-only trim ------------------------------------
//
// On the Bluesky post-thread screen the trimmer cuts the parsed tree from 64
// nodes (`uiautomator dump --compressed`) to ~41 actionable / labelled nodes
// while preserving every clickable, every text label, every content-desc, and
// every resource-id we care about.

const NOISY_CLASSES = new Set([
  // React Native Skia/SVG icon internals: never tappable, parent already
  // carries the icon's content-desc, and a single icon can balloon a dump by
  // 40+ leaf nodes. Drop the entire subtree.
  "com.horcrux.svg.PathView",
  "com.horcrux.svg.GroupView",
  "com.horcrux.svg.SvgView",
]);

const SYSTEM_PACKAGES = new Set([
  // Status bar / nav bar / quick settings — these exist on every dump but
  // rarely matter for app-level navigation. Note we deliberately do NOT drop
  // the foreground-app's own package even when the foreground IS a system app
  // (settings, permission dialog), so permission prompts still surface.
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
  // Bare android.view.View is what Compose emits when a semantics node has
  // no widget mapping; treat it as a scaffold and walk through.
  "android.view.View",
]);

const SCROLL_CLASSES = new Set([
  "android.widget.ScrollView",
  "android.widget.HorizontalScrollView",
  "androidx.recyclerview.widget.RecyclerView",
  "android.widget.ListView",
]);

const WEBVIEW_CLASSES = new Set(["android.webkit.WebView", "android.webkit.WebViewChromium"]);

interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Internal representation kept during the trim pass. Carries pixel bounds so
// the duplicate-wrapper / scroll-clip checks can use exact equality and
// inclusion math (normalising to [0,1] first risks drift on the equality
// check and would force a denormalise-then-compare round trip).
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
}

interface PruneOptions {
  screenW: number;
  screenH: number;
  includeSystem: boolean;
}

function attrIsTrue(attrs: Record<string, string>, key: string): boolean {
  return attrs[key] === "true";
}

function isInteractive(attrs: Record<string, string>): boolean {
  if (
    attrIsTrue(attrs, "clickable") ||
    attrIsTrue(attrs, "long-clickable") ||
    attrIsTrue(attrs, "checkable") ||
    attrIsTrue(attrs, "scrollable")
  ) {
    return true;
  }
  // A focusable node only counts as interactive when it has a label —
  // otherwise it's just a focus-trap on a layout wrapper.
  if (attrIsTrue(attrs, "focusable") && labelOf(attrs) !== "") return true;
  return false;
}

function labelOf(attrs: Record<string, string>): string {
  // The DescribeNode contract surfaces the screen-reader-meaningful label and
  // the user-typed text separately, so we prefer `content-desc` (the role
  // description / placeholder) and let `text` come through as `value` when
  // the two diverge — e.g. an EditText with content-desc="Email" + text="x@y"
  // emits label="Email", value="x@y" so an agent can see both pieces.
  // For nodes with only one populated, the order doesn't matter.
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

function rectFullyOutside(kid: PixelRect, clip: PixelRect): boolean {
  return (
    kid.x + kid.w <= clip.x ||
    kid.x >= clip.x + clip.w ||
    kid.y + kid.h <= clip.y ||
    kid.y >= clip.y + clip.h
  );
}

/**
 * Concatenate every non-empty `text` / `content-desc` reachable from `parsed`,
 * deduped and capped, so a clickable container without its own label can
 * borrow its descendants' labels (the "row-as-tap-target" pattern: tapping a
 * profile cell where the cell itself has no content-desc but contains the
 * user's name + handle + bio).
 */
function descendantText(parsed: ParsedXmlNode, maxChars = 120): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  const stack: ParsedXmlNode[] = [parsed];
  while (stack.length > 0) {
    const x = stack.pop()!;
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
  // Match the existing contract: when text and the user-facing label diverge,
  // expose `text` separately so consumers can still read e.g. an EditText's
  // current value while the placeholder lives in `content-desc`/`label`.
  // Skip for password fields — `label` has already been redacted to
  // "[password]" but the raw `attrs.text` still holds the secret, and
  // `text !== label` would otherwise smuggle it through under `value`.
  if (!out.password) {
    const text = (attrs.text ?? "").trim();
    if (text && text !== label) out.value = text;
  }
  return out;
}

/**
 * Apply the v2 trim rules to `parsed`'s subtree, returning the list of
 * UiNodes that should appear in the output where `parsed` currently sits.
 * Returns:
 *   []        — node fully dropped (nothing replaces it)
 *   [n]       — node kept, possibly with collapsed/aggregated form
 *   [a,b,...] — node was a passthrough wrapper; its kept children inline
 *               directly into the parent's child list
 */
function pruneSubtree(root: ParsedXmlNode, opts: PruneOptions): UiNode[] {
  // Iterative post-order walk. Each frame records the scrollClip the parent
  // wants this node to enforce on its own children — see the python
  // reference for why the filter fires at the parent of the clipped node,
  // not at the scroll itself.
  type Frame = { parsed: ParsedXmlNode; scrollClip: PixelRect | null; visited: boolean };
  const stack: Frame[] = [{ parsed: root, scrollClip: null, visited: false }];
  const outputs = new Map<ParsedXmlNode, UiNode[]>();

  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    if (!top.visited) {
      top.visited = true;
      const attrs = top.parsed.attrs;
      const cls = attrs.class ?? "";
      const myBounds = parseUiAutomatorBounds(attrs.bounds ?? "");
      const isScroll = SCROLL_CLASSES.has(cls) || attrIsTrue(attrs, "scrollable");
      // Children inherit either MY bounds (if I'm a scroll) or whatever clip
      // I was handed. They'll filter their own kids against this rect.
      const childClip = isScroll && myBounds ? myBounds : top.scrollClip;
      for (let i = top.parsed.children.length - 1; i >= 0; i--) {
        const c = top.parsed.children[i]!;
        if (c.tag === "node") {
          stack.push({ parsed: c, scrollClip: childClip, visited: false });
        }
      }
    } else {
      outputs.set(top.parsed, computeNodeOutput(top.parsed, top.scrollClip, outputs, opts));
      stack.pop();
    }
  }
  return outputs.get(root) ?? [];
}

function computeNodeOutput(
  parsed: ParsedXmlNode,
  scrollClip: PixelRect | null,
  outputs: Map<ParsedXmlNode, UiNode[]>,
  opts: PruneOptions
): UiNode[] {
  const attrs = parsed.attrs;
  const cls = attrs.class ?? "";

  if (NOISY_CLASSES.has(cls)) return [];
  if (!opts.includeSystem && isSystemChrome(attrs)) return [];

  const bounds = parseUiAutomatorBounds(attrs.bounds ?? "");
  const visible = isVisibleRect(bounds, opts.screenW, opts.screenH);

  // Collect child outputs, filtering against my inherited scroll clip.
  let keptChildren: UiNode[] = [];
  let hiddenInScroll = 0;
  for (const c of parsed.children) {
    if (c.tag !== "node") continue;
    const kids = outputs.get(c);
    if (!kids) continue;
    for (const kid of kids) {
      if (scrollClip && kid.pixelBounds && rectFullyOutside(kid.pixelBounds, scrollClip)) {
        hiddenInScroll += 1;
        continue;
      }
      keptChildren.push(kid);
    }
  }

  // WebView: DOM is opaque to uiautomator, so emit a single sentinel leaf
  // and discard the (always misleading) accessibility scaffold underneath.
  if (WEBVIEW_CLASSES.has(cls)) {
    if (!visible) return [];
    const own = labelOf(attrs);
    return [makeUiNode(attrs, "WebView", bounds, "[web-view] " + (own || "(no label)"), [])];
  }

  const interactive = isInteractive(attrs);
  let label = labelOf(attrs);

  // Decorative ImageView (no clickable, no label) — drop, pass through any
  // surviving descendants. Most decorative images have zero kept children
  // and the entire branch evaporates.
  if (cls.endsWith(".ImageView") && !interactive && !label) {
    return keptChildren;
  }

  // Layout container with no own info — pass children through. With
  // --compressed dumps this is what flattens FrameLayout > LinearLayout >
  // ConstraintLayout chains down to their actual content.
  if (LAYOUT_CONTAINERS.has(cls) && !interactive && !label) {
    return keptChildren;
  }

  // Off-screen and contributes nothing → drop entirely.
  if (!visible && keptChildren.length === 0) return [];

  // Compound clickable: borrow descendant labels so the agent has something
  // to read. Skips pure scrollables (their descendants are usually a screen
  // worth of text).
  if (
    (attrIsTrue(attrs, "clickable") || attrIsTrue(attrs, "long-clickable")) &&
    !label &&
    keptChildren.length > 0
  ) {
    const agg = descendantText(parsed);
    if (agg) label = agg;
  }

  // Duplicate-wrapper collapse: a clickable parent whose only kept descendant
  // is also clickable and has identical bounds is just an extra layer of the
  // same tap target. Keep the inner (typically more specific) node.
  if (interactive && bounds && keptChildren.length === 1) {
    const c = keptChildren[0]!;
    if (c.clickable && c.pixelBounds && rectsEqual(c.pixelBounds, bounds)) {
      return [c];
    }
  }

  // If I have a label, drop child Text nodes whose label is already a
  // substring of mine. Stops the agent seeing both "Like (634 likes)" and a
  // bare "634" inside it as separate items.
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

  // Password fields: keep the ref but never leak the value.
  if (attrIsTrue(attrs, "password")) {
    label = "[password]";
  }

  const node = makeUiNode(attrs, deriveUiAutomatorRole(cls), bounds, label, keptChildren);
  if (hiddenInScroll > 0) node.scrollHidden = hiddenInScroll;
  return [node];
}

/**
 * Lower a UiNode tree to the public DescribeNode contract. Iterative post-order
 * so that very deep trees (RN screens stacked ~30 levels deep, ListView item
 * recyclers, etc.) don't risk a stack overflow even though the trim has
 * already shortened most chains.
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
    // Clip the rectangle against the screen BEFORE normalising. Independently
    // clamping `x` and `width` to [0,1] lets `x + width` exceed 1 (e.g. an
    // off-screen item at bounds=[1090,0][1280,200] on a 1080-wide screen
    // produces x=1, width≈0.176 → tap centre lands off-screen). Clipping the
    // edges first guarantees the visible portion is what we normalise and the
    // rect always satisfies the describe-frame contract.
    const clipped = clipBoundsToScreen(n.pixelBounds, sw, sh);
    frame = {
      x: sw > 0 ? clipped.x / sw : 0,
      y: sh > 0 ? clipped.y / sh : 0,
      width: sw > 0 ? clipped.w / sw : 0,
      height: sh > 0 ? clipped.h / sh : 0,
    };
  } else {
    // No bounds: drop empty wrappers, pass through single-child wrappers, and
    // synthesise a union frame for 2+ children. Replacing the whole subtree
    // with `null` silently dropped every child on Compose hierarchies that
    // emit bounds-less group containers — preserved here for that case.
    if (children.length === 0) return null;
    if (children.length === 1) return children[0]!;
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
 * Parse a full `uiautomator dump` output into a DescribeNode tree matching the
 * iOS describe contract, so the same agent guidance about frames + tap points
 * applies. Applies the v2 interactables-only trim defined above.
 *
 * `includeSystem` defaults to false: status bar / nav bar / SystemUI chrome
 * is dropped because it's noise on app-level tasks. Pass `true` when working
 * with a multi-window dump (uiautomator2) where systemui owns the IME or the
 * notification shade.
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
    throw new Error("Failed to parse uiautomator dump output");
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
