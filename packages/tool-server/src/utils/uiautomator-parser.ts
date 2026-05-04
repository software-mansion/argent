import type { DescribeNode } from "../tools/describe/contract";

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
  // root. Match either a complete quoted string or any non-quote non-`>`
  // character. `s` flag keeps newline tolerance for builds that wrap dumps
  // at ~1 KB boundaries.
  const tagRe = /<(\/?)([A-Za-z_][\w.-]*)((?:"[^"]*"|'[^']*'|[^"'<>])*)(\/?)>/gs;
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
    if (parent) parent.children.push(node);
    else if (root === null) root = node;
    // else: malformed input emitted a second top-level element; first root wins.
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

/**
 * Convert a parsed `<node>` element into a `DescribeNode` with normalized frame
 * coordinates. Returns `null` when the node has no bounds AND no useful children.
 *
 * Iterative post-order walk (no recursion) so deeply nested hierarchies — which
 * are realistic on mis-configured RecyclerViews / stacked overlays — don't blow
 * the JS call stack. We use a work queue keyed by parsed-node identity.
 */
export function convertUiAutomatorNode(
  n: ParsedXmlNode,
  screenW: number,
  screenH: number
): DescribeNode | null {
  if (n.tag !== "node") return null;

  // 1. Collect all `<node>` descendants in post-order (children before parent).
  const postOrder: ParsedXmlNode[] = [];
  const stack: Array<{ node: ParsedXmlNode; visited: boolean }> = [{ node: n, visited: false }];
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    if (!top.visited) {
      top.visited = true;
      // Push children in reverse so they pop in original order.
      for (let i = top.node.children.length - 1; i >= 0; i--) {
        const child = top.node.children[i]!;
        if (child.tag === "node") {
          stack.push({ node: child, visited: false });
        }
      }
    } else {
      postOrder.push(top.node);
      stack.pop();
    }
  }

  // 2. Compute each node's DescribeNode using already-computed children.
  const converted = new Map<ParsedXmlNode, DescribeNode | null>();
  for (const parsed of postOrder) {
    const attrs = parsed.attrs;
    const bounds = parseUiAutomatorBounds(attrs.bounds ?? "");

    const childNodes: DescribeNode[] = [];
    for (const c of parsed.children) {
      if (c.tag !== "node") continue;
      const cc = converted.get(c);
      if (cc) childNodes.push(cc);
    }

    if (!bounds) {
      // No bounds: drop empty wrappers and pass through single-child wrappers.
      // For 2+ children, replacing the whole subtree with `null` silently
      // dropped every child — common on Compose hierarchies that emit
      // bounds-less group containers. Synthesise a frame that unions the
      // children's frames so the entire branch survives in the tree.
      if (childNodes.length === 0) {
        converted.set(parsed, null);
      } else if (childNodes.length === 1) {
        converted.set(parsed, childNodes[0]!);
      } else {
        const x1 = Math.min(...childNodes.map((c) => c.frame.x));
        const y1 = Math.min(...childNodes.map((c) => c.frame.y));
        const x2 = Math.max(...childNodes.map((c) => c.frame.x + c.frame.width));
        const y2 = Math.max(...childNodes.map((c) => c.frame.y + c.frame.height));
        converted.set(parsed, {
          role: deriveUiAutomatorRole(parsed.attrs.class ?? ""),
          frame: {
            x: x1,
            y: y1,
            width: Math.max(0, x2 - x1),
            height: Math.max(0, y2 - y1),
          },
          children: childNodes,
        });
      }
      continue;
    }

    // Clip the rectangle against the screen BEFORE normalising. Independently
    // clamping `x` and `width` to [0,1] lets `x + width` exceed 1 (e.g. an
    // off-screen item at bounds=[1090,0][1280,200] on a 1080-wide screen
    // produces x=1, width≈0.176 → tap centre lands off-screen). Clipping the
    // edges first guarantees the visible portion is what we normalise and the
    // rect always satisfies the describe-frame contract.
    const clipped = clipBoundsToScreen(bounds, screenW, screenH);
    const frame = {
      x: screenW > 0 ? clipped.x / screenW : 0,
      y: screenH > 0 ? clipped.y / screenH : 0,
      width: screenW > 0 ? clipped.w / screenW : 0,
      height: screenH > 0 ? clipped.h / screenH : 0,
    };
    const out: DescribeNode = {
      role: deriveUiAutomatorRole(attrs.class ?? ""),
      frame,
      children: childNodes,
    };
    const label = attrs["content-desc"] || attrs.text || undefined;
    if (label) out.label = label;
    const identifier = attrs["resource-id"] || undefined;
    if (identifier) out.identifier = identifier;
    if (attrs.text && label !== attrs.text) out.value = attrs.text;
    converted.set(parsed, out);
  }

  return converted.get(n) ?? null;
}

/**
 * Parse a full `uiautomator dump` output into a DescribeNode tree matching the
 * iOS describe contract, so the same agent guidance about frames + tap points applies.
 */
export function parseUiAutomatorDump(
  rawOutput: string,
  screenW: number,
  screenH: number
): DescribeNode {
  let xml = rawOutput;
  const xmlEnd = xml.lastIndexOf("</hierarchy>");
  if (xmlEnd !== -1) xml = xml.slice(0, xmlEnd + "</hierarchy>".length);
  const root = parseUiAutomatorXml(xml);
  if (!root) {
    throw new Error("Failed to parse uiautomator dump output");
  }
  const topChildren: DescribeNode[] = [];
  for (const c of root.children) {
    const converted = convertUiAutomatorNode(c, screenW, screenH);
    if (converted) topChildren.push(converted);
  }
  return {
    role: "Screen",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children: topChildren,
  };
}
