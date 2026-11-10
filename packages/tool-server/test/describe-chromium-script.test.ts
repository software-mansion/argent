import { afterEach, describe, expect, it } from "vitest";
import { DESCRIBE_DOM_SCRIPT } from "../src/tools/describe/platforms/chromium";

/**
 * `DESCRIBE_DOM_SCRIPT` is an IIFE injected via Runtime.evaluate that walks the live
 * renderer DOM. The rest of the suite can only mock its CDP *response*, so this test
 * evals the real script against a hand-built mock DOM to lock in the visibility /
 * pruning rules — the part that broke describe on React Native Web (everything nested
 * under a zero-area display:contents box was pruned) and crashed it on pages with
 * DOM-clobbering forms. Mirrors test/debugger/component-tree-script.test.ts.
 *
 * The mock implements only the DOM surface the script reads: getBoundingClientRect,
 * getComputedStyle (display / visibility / opacity / overflow{,X,Y} / position, plus
 * whatever transform-like property a fixture sets, and a pseudo-element's own style),
 * client{Left,Top,Width,Height} and offset{Width,Height} (padding-box clipping),
 * offset{Left,Top,Parent} (legend layout), children,
 * childNodes (text, and <br> / comment nodes), localName/namespaceURI,
 * getAttribute/hasAttribute, open shadowRoot,
 * and a Range whose rect unions the element's own painted content with the still-laid-out
 * boxes of its descendants (everything but display:none) — so it reproduces the real
 * behaviour where a box-less wrapper's Range is non-zero purely from a visibility:hidden /
 * opacity:0 child, and returns zero only when an ancestor transform collapses the paint.
 */

const W = 1000;
const H = 1000;

class MockNode {}
class MockElement extends MockNode {}
class MockHTMLElement extends MockElement {}
class MockHTMLInputElement extends MockHTMLElement {}
class MockHTMLTextAreaElement extends MockHTMLElement {}
class MockHTMLImageElement extends MockHTMLElement {}
class MockSVGSVGElement extends MockElement {}
class MockHTMLSlotElement extends MockHTMLElement {
  // Like Chrome's, it throws on any other element.
  assignedNodes(this: Record<string, unknown>) {
    if (!(this instanceof MockHTMLSlotElement)) throw new TypeError("Illegal invocation");
    return this.__assigned ?? [];
  }
}

// The script reads childNodes / tagName / children through the native prototype getter
// (Object.getOwnPropertyDescriptor(proto, prop).get.call(el)) so a DOM-clobbering <form>
// can't shadow them. Mirror that here: expose each as a prototype accessor backed by a
// field, so a test can shadow the *public* property (see `clobberStructural`) while the
// prototype getter still returns the real value — exactly the real [LegacyOverrideBuiltins]
// behaviour the fix relies on. childNodes lives on Node.prototype, tagName/children on
// Element.prototype, matching where the script captures each getter. Like Chrome's, an
// Element.prototype getter throws on a non-element receiver (a text or comment node).
function defineNative(proto: object, prop: string, field: string): void {
  Object.defineProperty(proto, prop, {
    get(this: Record<string, unknown>) {
      if (proto === MockElement.prototype && !(this instanceof MockElement)) {
        throw new TypeError("Illegal invocation");
      }
      return this[field];
    },
    set(this: Record<string, unknown>, v: unknown) {
      this[field] = v;
    },
    configurable: true,
  });
}
defineNative(MockNode.prototype, "childNodes", "__childNodes");
defineNative(MockNode.prototype, "parentNode", "__parentNode");
// A node belongs to the page's document unless a fixture gives it another.
Object.defineProperty(MockNode.prototype, "ownerDocument", {
  get(this: Record<string, unknown>) {
    return this.__ownerDocument ?? (globalThis as Record<string, unknown>).document;
  },
  set(this: Record<string, unknown>, v: unknown) {
    this.__ownerDocument = v;
  },
  configurable: true,
});
// nodeType too, so a test can clobber an element's public nodeType. The fixtures' text,
// CDATA and comment nodes are plain objects, which keep their own nodeType field.
Object.defineProperty(MockNode.prototype, "nodeType", {
  get(this: Record<string, unknown>) {
    return this instanceof MockNode ? this.__nodeType : this.nodeType;
  },
  set(this: Record<string, unknown>, v: unknown) {
    this.__nodeType = v;
  },
  configurable: true,
});
defineNative(MockElement.prototype, "tagName", "__tagName");
defineNative(MockElement.prototype, "localName", "__localName");
defineNative(MockElement.prototype, "namespaceURI", "__namespaceURI");
defineNative(MockElement.prototype, "children", "__children");
defineNative(MockElement.prototype, "shadowRoot", "__shadowRoot");
defineNative(MockElement.prototype, "assignedSlot", "__assignedSlot");
// Scroll-dimension getters live on Element.prototype too; the script captures their
// descriptor up front (so they must exist) and only reads them for overflow:auto/scroll.
defineNative(MockElement.prototype, "scrollHeight", "__scrollHeight");
defineNative(MockElement.prototype, "clientHeight", "__clientHeight");
defineNative(MockElement.prototype, "scrollWidth", "__scrollWidth");
defineNative(MockElement.prototype, "clientWidth", "__clientWidth");
defineNative(MockElement.prototype, "clientLeft", "__clientLeft");
defineNative(MockElement.prototype, "clientTop", "__clientTop");
defineNative(MockHTMLElement.prototype, "offsetWidth", "__offsetWidth");
defineNative(MockHTMLElement.prototype, "offsetHeight", "__offsetHeight");
defineNative(MockHTMLElement.prototype, "offsetLeft", "__offsetLeft");
defineNative(MockHTMLElement.prototype, "offsetTop", "__offsetTop");
defineNative(MockHTMLElement.prototype, "offsetParent", "__offsetParent");
// getAttribute / hasAttribute / getBoundingClientRect are methods on Element.prototype.
// The script invokes them via the captured `Element.prototype.X` so a [LegacyOverrideBuiltins]
// form can't shadow them to a control element (which would crash with "not a function").
// Back them with per-element fields, mirroring the real DOM. Assigned through a cast
// because the bare mock classes declare no DOM members.
const elementProto = MockElement.prototype as unknown as Record<string, unknown>;
elementProto.getAttribute = function (this: Record<string, unknown>, n: string) {
  const a = (this.__attrs as Record<string, string>) ?? {};
  return n in a ? a[n] : null;
};
elementProto.hasAttribute = function (this: Record<string, unknown>, n: string) {
  return n in ((this.__attrs as Record<string, string>) ?? {});
};
// Hit testing: the elements of a tree whose `painted` rect holds the point, the last in
// tree order on top. A shadow root's own tree is separate: like Chrome's, the document
// returns its host wherever that tree paints, never the tree's nodes.
const paints = (n: Record<string, unknown>, x: number, y: number) => {
  const p = n.__painted as Rect | undefined;
  return !!p && x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h;
};
function paintedAt(nodes: unknown[], x: number, y: number): unknown[] {
  const hits: unknown[] = [];
  const visit = (n: Record<string, unknown>) => {
    const sr = n.__shadowRoot as { children: unknown[] } | null | undefined;
    if (paints(n, x, y) || (sr && paintedAt(sr.children, x, y).length)) hits.push(n);
    for (const k of (n.__children as Record<string, unknown>[]) ?? []) visit(k);
  };
  for (const n of nodes) visit(n as Record<string, unknown>);
  return hits.reverse();
}
const nodeProto = MockNode.prototype as unknown as Record<string, unknown>;
nodeProto.contains = function (this: Record<string, unknown>, other: unknown): boolean {
  if (other === this) return true;
  return ((this.__children as Record<string, unknown>[]) ?? []).some((k) =>
    (nodeProto.contains as (o: unknown) => boolean).call(k, other)
  );
};
class MockDocument {
  createElementNS(ns: string, tag: string): MockElement {
    const svg = ns === "http://www.w3.org/2000/svg";
    const made: Record<string, typeof MockElement> = svg
      ? { svg: MockSVGSVGElement }
      : {
          input: MockHTMLInputElement,
          textarea: MockHTMLTextAreaElement,
          img: MockHTMLImageElement,
          slot: MockHTMLSlotElement,
        };
    return new (made[tag] ?? (svg ? MockElement : MockHTMLElement))();
  }
  elementsFromPoint(this: { documentElement: unknown }, x: number, y: number): unknown[] {
    return paintedAt([this.documentElement], x, y);
  }
}
// The browser's globals of those names, which a page's own can replace.
const builtins = {
  Node: MockNode,
  Element: MockElement,
  HTMLElement: MockHTMLElement,
  HTMLInputElement: MockHTMLInputElement,
  HTMLTextAreaElement: MockHTMLTextAreaElement,
  HTMLImageElement: MockHTMLImageElement,
  SVGSVGElement: MockSVGSVGElement,
  HTMLSlotElement: MockHTMLSlotElement,
  Document: MockDocument,
};
// A node in a shadow tree carries that root as __root.
nodeProto.getRootNode = function (this: Record<string, unknown>) {
  return this.__root ?? (globalThis as Record<string, unknown>).document;
};
// Matches only the fixture's top-layer pseudo-class and throws on any other, as a
// Chromium does on a pseudo-class it lacks.
elementProto.matches = function (this: Record<string, unknown>, sel: string) {
  if (sel !== this.__topLayer) throw new SyntaxError(`unsupported selector ${sel}`);
  return true;
};
elementProto.getBoundingClientRect = function (this: Record<string, unknown>) {
  const r = this.__rect as Rect;
  return { left: r.x, top: r.y, right: r.x + r.w, bottom: r.y + r.h, width: r.w, height: r.h };
};

type Rect = { x: number; y: number; w: number; h: number };
type Opts = {
  tag?: string;
  text?: string;
  rect?: Rect;
  // client{Left,Top,Width,Height}: border-left/top and the padding box minus scrollbars
  client?: { left: number; top: number; width: number; height: number };
  // Untransformed border-box size, and position from the padding edge of offsetParent.
  offset?: { width: number; height: number; left?: number; top?: number };
  scrollSize?: { width: number; height: number }; // scrollWidth / scrollHeight
  svg?: boolean; // an Element in the SVG namespace
  outerSvg?: boolean; // an outermost <svg> element
  // A nested <svg>: its viewport in the parent's user space, mapped by the parent's
  // screen CTM [a, b, c, d, e, f].
  nestedSvg?: { viewport: Rect; ctm: number[] };
  topLayer?: string; // the pseudo-class (":modal", ...) that puts it in the top layer
  painted?: Rect; // where document.elementsFromPoint hits it
  content?: Rect | null; // painted extent of own inline content (Range)
  style?: Record<string, string>;
  attrs?: Record<string, string>;
  children?: MockElement[];
  shadow?: MockElement[]; // open shadow root children (walker pierces these)
  clobber?: boolean; // set .title/.id to non-string objects (DOM-clobbering)
  clobberStructural?: boolean; // shadow .children/.childNodes/.tagName with named controls (LegacyOverrideBuiltins)
  clobberAccessors?: boolean; // shadow getAttribute/hasAttribute/getBoundingClientRect/shadowRoot with a control element
};

function el(opts: Opts = {}): MockElement {
  const node = (
    opts.nestedSvg || opts.outerSvg
      ? new MockSVGSVGElement()
      : opts.svg
        ? new MockElement()
        : new MockHTMLElement()
  ) as MockElement & Record<string, unknown>;
  if (opts.svg || opts.nestedSvg || opts.outerSvg) node.namespaceURI = "http://www.w3.org/2000/svg";
  if (opts.nestedSvg) {
    const { viewport: v, ctm } = opts.nestedSvg;
    const len = (value: number) => ({ animVal: { value } });
    Object.assign(node, { x: len(v.x), y: len(v.y), width: len(v.w), height: len(v.h) });
    const [a, b, c, d, e, f] = ctm;
    node.ownerSVGElement = {};
    node.parentNode = { getScreenCTM: () => ({ a, b, c, d, e, f }) };
  }
  const rect = opts.rect ?? { x: 0, y: 0, w: 100, h: 20 };
  node.tagName = (opts.tag ?? "div").toUpperCase();
  node.localName = opts.tag ?? "div";
  if (!(opts.svg || opts.nestedSvg || opts.outerSvg)) {
    node.namespaceURI = "http://www.w3.org/1999/xhtml";
  }
  // Backing fields read by the Element.prototype getAttribute/hasAttribute/
  // getBoundingClientRect methods defined above (the script reads them via the prototype).
  node.__nodeType = 1;
  node.__attrs = opts.attrs ?? {};
  node.__rect = rect;
  node.__topLayer = opts.topLayer;
  node.__painted = opts.painted;
  if (opts.client) {
    node.__clientLeft = opts.client.left;
    node.__clientTop = opts.client.top;
    node.__clientWidth = opts.client.width;
    node.__clientHeight = opts.client.height;
  }
  if (opts.offset) {
    node.__offsetWidth = opts.offset.width;
    node.__offsetHeight = opts.offset.height;
    node.__offsetLeft = opts.offset.left;
    node.__offsetTop = opts.offset.top;
  }
  if (opts.scrollSize) {
    node.__scrollWidth = opts.scrollSize.width;
    node.__scrollHeight = opts.scrollSize.height;
  }
  node.children = opts.children ?? [];
  // The text node carries the element's own painted-text rect (`content`) so a Range
  // over just this text node measures the own-text extent — matching the real browser,
  // where selectNodeContents(textNode) spans the text and NOT sibling element boxes.
  node.childNodes = opts.text
    ? [{ nodeType: 3, nodeValue: opts.text, __content: opts.content ?? null }]
    : [];
  // An open shadow root is a DocumentFragment exposing `.children`; the walker reads
  // `getShadowRoot.call(el)` then iterates `shadow.children`. null unless a fixture sets it.
  if (opts.shadow) {
    // Like Chrome's, it lists the outer tree's hits below its own tree's nodes, the host
    // among them only where its own box is hit.
    const outerHits = (x: number, y: number) => {
      const outer = (nodeProto.getRootNode as () => Record<string, unknown>).call(node);
      const hits = (
        outer.nodeType === 9
          ? MockDocument.prototype.elementsFromPoint.call(outer as never, x, y)
          : (outer.elementsFromPoint as (x: number, y: number) => unknown[])(x, y)
      ) as unknown[];
      return hits.filter((n) => n !== node || paints(node, x, y));
    };
    let hitTests = 0;
    const shadowRoot = {
      nodeType: 11,
      host: node,
      children: opts.shadow,
      __childNodes: opts.shadow,
      elementsFromPoint: (x: number, y: number) => {
        // A script hit-testing one point over and over would otherwise hang the suite.
        if (++hitTests > 10_000) throw new Error("hit-tested a shadow root without end");
        return [...paintedAt(opts.shadow!, x, y), ...outerHits(x, y)];
      },
    };
    const own = (n: Record<string, unknown>, parent: unknown) => {
      n.__root = shadowRoot;
      if (n.__parentNode === undefined) n.__parentNode = parent;
      for (const k of (n.__children as Record<string, unknown>[]) ?? []) own(k, n);
    };
    for (const k of opts.shadow) own(k as unknown as Record<string, unknown>, shadowRoot);
    node.shadowRoot = shadowRoot;
  } else {
    node.shadowRoot = null;
  }
  (node as Record<string, unknown>).__content = opts.content ?? null;
  if (opts.clobber) {
    // simulate a <form> whose named control shadows the .title / .id properties
    node.title = node;
    node.id = node;
  }
  if (opts.clobberStructural) {
    // simulate a <form> with [LegacyOverrideBuiltins] whose controls are named
    // children / childNodes / tagName: the public property returns the control element
    // (not iterable / not a string), while the native prototype getter still returns the
    // real DOM value (preserved in the backing fields set above).
    const kids = opts.children ?? [];
    Object.defineProperty(node, "children", { value: kids[0], configurable: true });
    Object.defineProperty(node, "childNodes", { value: kids[1], configurable: true });
    Object.defineProperty(node, "tagName", { value: kids[2], configurable: true });
  }
  if (opts.clobberAccessors) {
    // simulate a <form> whose controls are named getAttribute / hasAttribute /
    // getBoundingClientRect / shadowRoot: each public member returns a control element,
    // so a direct el.getAttribute(...) throws "not a function" and a direct el.shadowRoot
    // read would re-walk the control's children (duplicating the subtree). The script must
    // route every one of these through the captured Element.prototype accessor.
    const ctrl = (opts.children ?? [])[0];
    for (const m of ["getAttribute", "hasAttribute", "getBoundingClientRect", "shadowRoot"]) {
      Object.defineProperty(node, m, { value: ctrl, configurable: true });
    }
  }
  const baseStyle: Record<string, string> = {
    display: "block",
    visibility: "visible",
    opacity: "1",
    overflow: "visible",
    overflowX: "visible",
    overflowY: "visible",
    position: "static",
    cssFloat: "none",
    writingMode: "horizontal-tb",
  };
  const s = { ...baseStyle, ...(opts.style ?? {}) };
  if (opts.style?.overflow && !opts.style.overflowX) s.overflowX = opts.style.overflow;
  if (opts.style?.overflow && !opts.style.overflowY) s.overflowY = opts.style.overflow;
  (node as Record<string, unknown>).__style = s;
  return node;
}

// An <input> the script's `instanceof HTMLInputElement` branches recognise
// (accessibleName's placeholder/value fallbacks, isPassword, isChecked): built
// like el(), then re-prototyped onto the mock input class with the live
// .type/.value/.placeholder properties those branches read directly.
function inputEl(opts: Opts & { type?: string; value?: string; placeholder?: string }) {
  const node = el({ ...opts, tag: "input" }) as MockElement & Record<string, unknown>;
  Object.setPrototypeOf(node, MockHTMLInputElement.prototype);
  if (opts.type) node.type = opts.type;
  if (opts.value) node.value = opts.value;
  if (opts.placeholder) node.placeholder = opts.placeholder;
  return node;
}

// `pageGlobals` are globals a page script defines, in scope while the script evaluates.
function run(
  rootChildren: MockElement[],
  body: MockElement = el({ tag: "body", rect: { x: 0, y: 0, w: W, h: H } }),
  rootStyle: Record<string, string> = {},
  compatMode = "CSS1Compat",
  pageGlobals: Record<string, unknown> = {}
): { tree: unknown; truncated: boolean } {
  const root = el({
    tag: "html",
    rect: { x: 0, y: 0, w: W, h: H },
    style: rootStyle,
  }) as MockElement & Record<string, unknown>;
  if (rootChildren.length) (body as Record<string, unknown>).children = rootChildren;
  root.children = [body];
  // Every element knows its parent, as in a real DOM, unless a fixture set one.
  const linkParents = (n: Record<string, unknown>) => {
    for (const k of (n.__children as Record<string, unknown>[]) ?? []) {
      if (k.__parentNode === undefined) k.__parentNode = n;
      linkParents(k);
    }
  };
  linkParents(root);

  const g = globalThis as Record<string, unknown>;
  const saved: Record<string, unknown> = {
    ...Object.fromEntries(Object.keys(pageGlobals).map((k) => [k, g[k]])),
    window: g.window,
    document: g.document,
    ...Object.fromEntries(Object.keys(builtins).map((k) => [k, g[k]])),
  };
  g.window = {
    innerWidth: W,
    innerHeight: H,
    // Like Chrome's, it rejects a non-element (a document, text or comment node).
    // A pseudo-element's style is the fixture's __pseudo entry, else one generating nothing.
    getComputedStyle: (e: Record<string, unknown>, pseudo?: string) => {
      if (!(e instanceof MockElement)) throw new TypeError("parameter 1 is not of type 'Element'");
      if (!pseudo) return e.__style;
      const styles = (e.__pseudo as Record<string, unknown>) ?? {};
      return styles[pseudo] ?? { display: "inline", visibility: "visible", content: "none" };
    },
  };
  g.document = Object.assign(new MockDocument(), {
    nodeType: 9,
    documentElement: root,
    compatMode,
    // Resolve aria-labelledby targets by walking the mock tree's backing __children
    // (the real children, unaffected by any structural clobber) for a matching id.
    getElementById: (id: string) => {
      const find = (n: Record<string, unknown>): Record<string, unknown> | null => {
        const attrs = (n.__attrs as Record<string, string>) ?? {};
        if (attrs.id === id) return n;
        for (const k of (n.__children as Record<string, unknown>[]) ?? []) {
          const f = find(k);
          if (f) return f;
        }
        return null;
      };
      return find(root);
    },
    createRange: () => {
      let target: Record<string, unknown> | null = null;
      return {
        selectNodeContents: (e: Record<string, unknown>) => {
          target = e;
        },
        // Model a real Range over selectNodeContents(el): the union of the element's own
        // painted inline content (__content) AND the layout boxes of its descendants that
        // still occupy layout — i.e. everything except display:none (visibility:hidden and
        // opacity:0 keep their box). This lets a fixture reproduce the real-browser case a
        // plain "return __content" mock could not: a box-less wrapper whose Range is
        // non-zero purely because an invisible child still lays out.
        getBoundingClientRect: () => {
          let box: { x: number; y: number; r: number; b: number } | null = null;
          const add = (r: Rect | null | undefined) => {
            if (!r || r.w <= 0 || r.h <= 0) return;
            box = box
              ? {
                  x: Math.min(box.x, r.x),
                  y: Math.min(box.y, r.y),
                  r: Math.max(box.r, r.x + r.w),
                  b: Math.max(box.b, r.y + r.h),
                }
              : { x: r.x, y: r.y, r: r.x + r.w, b: r.y + r.h };
          };
          add(target?.__content as Rect | null | undefined);
          const walkRects = (n: Record<string, unknown> | null | undefined) => {
            for (const c of (n?.__children as Record<string, unknown>[]) ?? []) {
              const st = (c.__style as Record<string, string>) ?? {};
              if (st.display === "none") continue; // display:none collapses layout
              add(c.__rect as Rect);
              walkRects(c);
            }
          };
          walkRects(target);
          if (!box) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
          const b = box as { x: number; y: number; r: number; b: number };
          return {
            left: b.x,
            top: b.y,
            right: b.r,
            bottom: b.b,
            width: b.r - b.x,
            height: b.b - b.y,
          };
        },
      };
    },
  });
  (body as Record<string, unknown>).ownerDocument = g.document;
  root.parentNode = g.document;
  Object.assign(g, builtins, pageGlobals);
  try {
    const payload = (0, eval)(DESCRIBE_DOM_SCRIPT) as string;
    return JSON.parse(payload);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete g[k];
      else g[k] = v;
    }
  }
}

function valuesOf(tree: unknown): string[] {
  const out: string[] = [];
  (function rec(n: Record<string, unknown> | null) {
    if (!n) return;
    if (typeof n.value === "string") out.push(n.value);
    for (const c of (n.children as Record<string, unknown>[]) ?? []) rec(c);
  })(tree as Record<string, unknown>);
  return out;
}

function identifiersOf(tree: unknown): string[] {
  const out: string[] = [];
  (function rec(n: Record<string, unknown> | null) {
    if (!n) return;
    if (typeof n.identifier === "string") out.push(n.identifier);
    for (const c of (n.children as Record<string, unknown>[]) ?? []) rec(c);
  })(tree as Record<string, unknown>);
  return out;
}

function rolesOf(tree: unknown): string[] {
  const out: string[] = [];
  (function rec(n: Record<string, unknown> | null) {
    if (!n) return;
    if (typeof n.role === "string") out.push(n.role);
    for (const c of (n.children as Record<string, unknown>[]) ?? []) rec(c);
  })(tree as Record<string, unknown>);
  return out;
}

function findById(tree: unknown, id: string): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null;
  (function rec(n: Record<string, unknown> | null) {
    if (!n || found) return;
    if (n.identifier === id) {
      found = n;
      return;
    }
    for (const c of (n.children as Record<string, unknown>[]) ?? []) rec(c);
  })(tree as Record<string, unknown>);
  return found;
}

function countNodes(tree: unknown): number {
  let n = 0;
  (function rec(node: Record<string, unknown> | null) {
    if (!node) return;
    n++;
    for (const c of (node.children as Record<string, unknown>[]) ?? []) rec(c);
  })(tree as Record<string, unknown>);
  return n;
}

const ZERO = { x: 0, y: 0, w: 0, h: 0 };
const BOX = { x: 0, y: 100, w: 200, h: 30 };

afterEach(() => {
  // run() restores globals in its finally, nothing else to clean up.
});

describe("DESCRIBE_DOM_SCRIPT visibility rules", () => {
  it("surfaces content nested under a display:contents wrapper (the RNW bug)", () => {
    const { tree } = run([
      el({
        style: { display: "contents" },
        rect: ZERO,
        children: [el({ text: "CONTENTS", rect: BOX })],
      }),
    ]);
    expect(valuesOf(tree)).toContain("CONTENTS");
  });

  it("surfaces content under a display:contents wrapper even at opacity:0 (opacity affects no box)", () => {
    const { tree } = run([
      el({
        style: { display: "contents", opacity: "0" },
        rect: ZERO,
        children: [el({ text: "CONTENTS0", rect: BOX })],
      }),
    ]);
    expect(valuesOf(tree)).toContain("CONTENTS0");
  });

  it("still prunes a normal (boxed) opacity:0 subtree", () => {
    const { tree } = run([
      el({
        style: { opacity: "0" },
        rect: { x: 0, y: 0, w: 200, h: 200 },
        children: [el({ text: "INVISIBLE", rect: BOX })],
      }),
    ]);
    expect(valuesOf(tree)).not.toContain("INVISIBLE");
  });

  it("surfaces an absolutely-positioned child of a zero-height overflow:visible wrapper", () => {
    const { tree } = run([
      el({
        rect: { x: 0, y: 100, w: 1000, h: 0 },
        children: [el({ text: "DROPDOWN", rect: BOX })],
      }),
    ]);
    expect(valuesOf(tree)).toContain("DROPDOWN");
  });

  it("keeps pruning a zero-area box that clips its overflow (collapsed content)", () => {
    const { tree } = run([
      el({
        rect: ZERO,
        style: { overflow: "hidden" },
        children: [el({ text: "CLIPPED", rect: BOX })],
      }),
    ]);
    expect(valuesOf(tree)).not.toContain("CLIPPED");
  });

  it("prunes a box-less leaf whose painted content is also zero-area (transform: scale(0))", () => {
    const { tree } = run([el({ text: "SCALE0", rect: ZERO, content: null })]);
    expect(valuesOf(tree)).not.toContain("SCALE0");
  });

  it("surfaces a box-less leaf whose text actually paints (overflowing / contents text)", () => {
    const { tree } = run([
      el({ text: "OVERFLOWTEXT", rect: ZERO, content: { x: 0, y: 50, w: 80, h: 15 } }),
    ]);
    expect(valuesOf(tree)).toContain("OVERFLOWTEXT");
  });

  it("does not crash and ignores DOM-clobbered .title / .id (uses getAttribute)", () => {
    let result: { tree: unknown } | undefined;
    expect(() => {
      result = run([
        el({
          text: "CLOBBER",
          rect: BOX,
          clobber: true,
          attrs: { title: "realtitle", id: "realid" },
        }),
      ]);
    }).not.toThrow();
    const tree = JSON.stringify(result!.tree);
    expect(tree).toContain("realid");
    expect(valuesOf(result!.tree)).toContain("CLOBBER");
  });

  it("does not crash on a <form> whose controls clobber children/childNodes/tagName (LegacyOverrideBuiltins)", () => {
    // Named controls shadow the form's inherited DOM properties: el.children returns a
    // single control (not iterable), el.childNodes / el.tagName likewise return elements.
    // Reading any of them directly aborts the whole walk; the fix routes through the
    // native prototype getter, so the form and its controls still surface.
    const fieldChildren = el({
      tag: "input",
      attrs: { name: "children", id: "field-children" },
      rect: { x: 0, y: 100, w: 200, h: 20 },
    });
    const fieldChildNodes = el({
      tag: "input",
      attrs: { name: "childNodes", id: "field-childnodes" },
      rect: { x: 0, y: 130, w: 200, h: 20 },
    });
    const fieldTagName = el({
      tag: "input",
      attrs: { name: "tagName", id: "field-tagname" },
      rect: { x: 0, y: 160, w: 200, h: 20 },
    });
    let result: { tree: unknown } | undefined;
    expect(() => {
      result = run([
        el({
          tag: "form",
          rect: { x: 0, y: 100, w: 200, h: 100 },
          children: [fieldChildren, fieldChildNodes, fieldTagName],
          clobberStructural: true,
        }),
      ]);
    }).not.toThrow();
    const serialized = JSON.stringify(result!.tree);
    expect(serialized).toContain("field-children");
    expect(serialized).toContain("field-childnodes");
    expect(serialized).toContain("field-tagname");
  });

  it("does not crash (or duplicate) on a <form> clobbering getAttribute/getBoundingClientRect/hasAttribute/shadowRoot", () => {
    // A <form> whose controls are named getAttribute / getBoundingClientRect /
    // hasAttribute reproduced "TypeError: el.X is not a function" on real Chrome (each
    // shadows the inherited method to a control element); a control named shadowRoot made
    // the walker re-walk the control's children and duplicate the subtree. The fix routes
    // all of these through the captured Element.prototype accessor.
    const inner = el({
      tag: "input",
      attrs: { id: "deep-inner" },
      rect: { x: 0, y: 130, w: 200, h: 20 },
    });
    const fieldset = el({
      tag: "fieldset",
      attrs: { id: "fs", name: "shadowRoot" },
      rect: { x: 0, y: 110, w: 200, h: 40 },
      children: [inner],
    });
    let result: { tree: unknown } | undefined;
    expect(() => {
      result = run([
        el({
          tag: "form",
          attrs: { id: "clobber-form" },
          rect: { x: 0, y: 100, w: 200, h: 60 },
          children: [fieldset],
          clobberAccessors: true,
        }),
      ]);
    }).not.toThrow();
    const serialized = JSON.stringify(result!.tree);
    // The form's own id is read via the prototype getAttribute despite the clobber.
    expect(serialized).toContain("clobber-form");
    // The child still surfaces — exactly once (the shadowRoot clobber must not re-walk it).
    expect(serialized).toContain("deep-inner");
    expect((serialized.match(/deep-inner/g) || []).length).toBe(1);
  });

  it("reads an aria-labelledby target whose form clobbers childNodes", () => {
    // accessibleName resolves aria-labelledby via getElementById, then walks the target's
    // childNodes. A <form id="lbl"> with a control named "childNodes" shadows the
    // inherited getter, so a direct read returns the control and loses the label.
    const control = el({
      tag: "input",
      attrs: { id: "cn", name: "childNodes" },
      rect: { x: 0, y: 200, w: 100, h: 20 },
    });
    const labelForm = el({
      tag: "form",
      attrs: { id: "lbl" },
      text: "Real Label",
      rect: { x: 0, y: 200, w: 200, h: 20 },
      children: [control],
    });
    Object.defineProperty(labelForm, "childNodes", { value: control, configurable: true });
    const labelled = el({
      tag: "div",
      attrs: { "id": "labelled", "aria-labelledby": "lbl" },
      rect: BOX,
      children: [el({ text: "BODY", rect: BOX })],
    });
    let result: { tree: unknown } | undefined;
    expect(() => {
      result = run([labelled, labelForm]);
    }).not.toThrow();
    expect(findById(result!.tree, "labelled")!.label).toBe("Real Label");
  });

  it("reads a form aria-labelledby target whose control clobbers parentNode", () => {
    // A direct read would reach the control (an <input type=hidden>, display:none) and treat
    // the rendered form as hidden, reading the <br> under its display:none span as a space.
    const control = el({ tag: "input", attrs: { name: "parentNode" }, style: { display: "none" } });
    const gone = el({ tag: "span", rect: ZERO, style: { display: "none" } }) as MockElement &
      Record<string, unknown>;
    gone.childNodes = [Object.assign(el({ tag: "br", rect: ZERO }), { nodeType: 1 })];
    const form = el({ tag: "form", rect: BOX, attrs: { id: "lbl" } }) as MockElement &
      Record<string, unknown>;
    form.childNodes = [
      { nodeType: 3, nodeValue: "Save" },
      Object.assign(gone, { nodeType: 1 }),
      { nodeType: 3, nodeValue: "draft" },
      Object.assign(control, { nodeType: 1 }),
    ];
    Object.assign(form, { nodeType: 1, parentNode: { nodeType: 9 } });
    Object.defineProperty(form, "parentNode", { value: control, configurable: true });
    const button = el({
      tag: "button",
      rect: BOX,
      attrs: { "id": "btn", "aria-labelledby": "lbl" },
    });
    const { tree } = run([button, form]);
    expect(findById(tree, "btn")!.label).toBe("Savedraft");
  });

  it("reads a deeply nested aria-labelledby target without overflowing the stack", () => {
    let inner = el({ tag: "span", text: "deep", rect: BOX }) as MockElement &
      Record<string, unknown>;
    for (let i = 0; i < 50000; i++) {
      const wrap = el({ tag: "span", rect: BOX }) as MockElement & Record<string, unknown>;
      wrap.childNodes = [Object.assign(inner, { nodeType: 1 })];
      inner = wrap;
    }
    (inner.__attrs as Record<string, string>).id = "lbl";
    // Reachable only through getElementById: walk() would stop at MAX_DEPTH anyway.
    const button = el({
      tag: "button",
      rect: BOX,
      attrs: { "id": "btn", "aria-labelledby": "lbl" },
    });
    const { tree } = run([button, el({ rect: BOX, children: [inner] })]);
    expect(findById(tree, "btn")!.label).toBe("deep");
  });

  it("keeps CDATA text and skips comments in an aria-labelledby target, as textContent does", () => {
    // React SSR puts <!-- --> markers between text nodes.
    const label = el({ tag: "span", rect: BOX, attrs: { id: "lbl" } }) as MockElement &
      Record<string, unknown>;
    label.childNodes = [
      { nodeType: 3, nodeValue: "Save " },
      { nodeType: 8, nodeValue: "$" },
      { nodeType: 4, nodeValue: "my" },
      { nodeType: 3, nodeValue: " draft" },
    ];
    const button = el({
      tag: "button",
      rect: BOX,
      attrs: { "id": "btn", "aria-labelledby": "lbl" },
    });
    const { tree } = run([button, label]);
    expect(findById(tree, "btn")!.label).toBe("Save my draft");
  });

  it("reads a nested form that clobbers nodeType in an aria-labelledby target", () => {
    const control = el({ tag: "input", attrs: { name: "nodeType" }, rect: BOX });
    const form = Object.assign(el({ tag: "form", text: "my", rect: BOX }), { nodeType: 1 });
    Object.defineProperty(form, "nodeType", { value: control, configurable: true });
    const label = el({ tag: "span", rect: BOX, attrs: { id: "lbl" } }) as MockElement &
      Record<string, unknown>;
    label.childNodes = [
      { nodeType: 3, nodeValue: "Save " },
      form,
      { nodeType: 3, nodeValue: " draft" },
    ];
    const button = el({
      tag: "button",
      rect: BOX,
      attrs: { "id": "btn", "aria-labelledby": "lbl" },
    });
    const { tree } = run([button, label]);
    expect(findById(tree, "btn")!.label).toBe("Save my draft");
  });

  it("reads a <br> in an aria-labelledby target as a space", () => {
    const label = el({ tag: "span", rect: BOX, attrs: { id: "lbl" } }) as MockElement &
      Record<string, unknown>;
    const br = Object.assign(el({ tag: "br", rect: ZERO }), { nodeType: 1 });
    const bold = Object.assign(el({ tag: "b", text: "draft", rect: BOX }), { nodeType: 1 });
    label.childNodes = [{ nodeType: 3, nodeValue: "Save" }, br, bold];
    const button = el({
      tag: "button",
      rect: BOX,
      attrs: { "id": "btn", "aria-labelledby": "lbl" },
    });
    const { tree } = run([button, label]);
    expect(findById(tree, "btn")!.label).toBe("Save draft");
  });

  it("reads an aria-labelledby target as Chrome names it, not as its textContent", () => {
    const child = (
      tag: string,
      text: string,
      style: Record<string, string> = {},
      attrs: Record<string, string> = {}
    ) =>
      Object.assign(el({ tag, text, rect: BOX, style: { display: "inline", ...style }, attrs }), {
        nodeType: 1,
      });
    const label = el({ tag: "span", rect: BOX, attrs: { id: "lbl" } }) as MockElement &
      Record<string, unknown>;
    Object.assign(label, { nodeType: 1, parentNode: { nodeType: 9 } });
    label.childNodes = [
      { nodeType: 3, nodeValue: "Plan" },
      child("p", "Pro", { display: "block" }),
      child("span", "HIDDEN", { display: "none" }),
      child("span", "INVISIBLE", { visibility: "hidden" }),
      child("span", "IGNORED", {}, { "aria-hidden": "true" }),
      child("script", "var q = 1", { display: "none" }),
      child("style", ".z{}", { display: "none" }),
      child("b", "monthly"),
      child("span", "inner", {}, { "aria-label": "billed" }),
      child("img", "", { display: "inline-block" }, { alt: "now" }),
      child("span", "kept", {}, { "aria-label": "  " }),
      child("span", "plain", {}, { alt: "not-an-image" }),
      { nodeType: 3, nodeValue: " end" },
    ];
    const button = el({
      tag: "button",
      rect: BOX,
      attrs: { "id": "btn", "aria-labelledby": "lbl" },
    });
    const { tree } = run([button, label]);
    expect(findById(tree, "btn")!.label).toBe("Plan Pro monthly billed now keptplain end");
  });

  // A span target labelling a button, holding `kids`.
  const labelledBy = (
    kids: unknown[],
    style: Record<string, string> = { display: "inline" },
    attrs: Record<string, string> = {}
  ) => {
    const label = el({
      tag: "span",
      rect: BOX,
      attrs: { id: "lbl", ...attrs },
      style,
    }) as MockElement & Record<string, unknown>;
    Object.assign(label, { nodeType: 1, parentNode: { nodeType: 9 } });
    label.childNodes = kids;
    const button = el({
      tag: "button",
      rect: BOX,
      attrs: { "id": "btn", "aria-labelledby": "lbl" },
    });
    return findById(run([button, label]).tree, "btn")!.label;
  };
  const elementNode = (tag: string, kids: unknown[], fields: Record<string, unknown> = {}) => {
    const style = { display: tag === "span" ? "inline" : "inline-block" };
    const node = el({ tag, rect: BOX, style }) as MockElement & Record<string, unknown>;
    Object.assign(node, { nodeType: 1, ...fields });
    node.childNodes = kids;
    return node;
  };
  const text = (nodeValue: string) => ({ nodeType: 3, nodeValue });

  it("parts words around an element unless it is a non-atomic inline box", () => {
    const styled = (display: string, kids: unknown[]) => {
      const node = elementNode("span", kids);
      (node.__style as Record<string, string>).display = display;
      return node;
    };
    for (const display of ["inline", "ruby", "ruby-text", "inline list-item"]) {
      expect(labelledBy([text("a"), styled(display, [text("b")]), text("c")]), display).toBe("abc");
    }
    for (const display of [
      "inline-block",
      "inline-flex",
      "inline-table",
      "inline flow-root list-item",
      "block ruby",
      "list-item",
      "contents",
      "math",
    ]) {
      expect(labelledBy([text("a"), styled(display, [text("b")]), text("c")]), display).toBe(
        "a b c"
      );
    }
    // <ruby>漢<rp>(</rp><rt>kan</rt><rp>)</rp></ruby>, with the UA's displays.
    const ruby = styled("ruby", [
      text("漢"),
      styled("none", [text("(")]),
      styled("ruby-text", [text("kan")]),
      styled("none", [text(")")]),
    ]);
    expect(labelledBy([text("東京"), ruby, text("字")])).toBe("東京漢kan字");
  });

  it("reads an embedded select's chosen options, not all of its options", () => {
    const small = elementNode("option", [text("Small")], { label: "Small" });
    const large = elementNode("option", [text("Large")], { label: "Large" });
    const size = elementNode("select", [small, large], { selectedOptions: [large] });
    expect(labelledBy([text("Size"), size, text("end")])).toBe("Size Large end");
    const both = elementNode("select", [small, large], { selectedOptions: [small, large] });
    expect(labelledBy([text("Size"), both, text("end")])).toBe("Size Small Large end");
    const none = elementNode("select", [small, large], { selectedOptions: [] });
    expect(labelledBy([text("Size"), none, text("end")])).toBe("Size end");
  });

  it("reads a select outside the HTML namespace by its content", () => {
    // The HTML parser keeps <math><select> and <svg><select> in the foreign namespace.
    const namespaceURI = "http://www.w3.org/1998/Math/MathML";
    const option = elementNode("option", [text("Opt")], { namespaceURI });
    const select = elementNode("select", [option], { namespaceURI });
    expect(labelledBy([text("Pick"), select, text("end")])).toBe("Pick Opt end");
  });

  it("reads an embedded textarea's live value or placeholder, not its default text", () => {
    const area = (value: string, placeholder: string) =>
      elementNode("textarea", [text("default")], { value, placeholder });
    expect(labelledBy([text("Qty"), area("typed", "hint"), text("items")])).toBe("Qty typed items");
    expect(labelledBy([text("Qty"), area("", "hint"), text("items")])).toBe("Qty hint items");
    expect(labelledBy([text("Qty"), area("", ""), text("items")])).toBe("Qty items");
  });

  it("reads a target that is itself a select or textarea by what it shows", () => {
    const label = (tag: string, fields: Record<string, unknown>, attrs = {}) => {
      const target = el({ tag, rect: BOX, attrs: { id: "lbl", ...attrs } }) as MockElement &
        Record<string, unknown>;
      Object.assign(target, { nodeType: 1, parentNode: { nodeType: 9 }, ...fields });
      target.childNodes = [text("default")];
      const button = el({
        tag: "button",
        rect: BOX,
        attrs: { "id": "btn", "aria-labelledby": "lbl" },
      });
      return findById(run([button, target]).tree, "btn")!.label;
    };
    expect(label("select", { selectedOptions: [{ label: "Large" }] })).toBe("Large");
    expect(label("textarea", { value: "typed", placeholder: "" })).toBe("typed");
    expect(label("textarea", { value: "typed", placeholder: "" }, { "aria-label": "Named" })).toBe(
      "typed"
    );
  });

  it("names an embedded control by what it shows, over its own aria-label", () => {
    const area = elementNode("textarea", [], { value: "typed", placeholder: "" });
    area.__attrs = { "aria-label": "ignored" };
    expect(labelledBy([text("Qty"), area, text("items")])).toBe("Qty typed items");
  });

  it("reads an embedded range widget's value and a listbox's chosen options", () => {
    const widget = (attrs: Record<string, string>, kids: unknown[] = [text("s")]) => {
      const node = elementNode("div", kids);
      node.__attrs = attrs;
      return node;
    };
    const vol = (attrs: Record<string, string>) =>
      labelledBy([text("Vol"), widget(attrs), text("end")]);
    expect(vol({ "role": "slider", "aria-valuetext": "five", "aria-label": "L" })).toBe(
      "Vol five end"
    );
    expect(vol({ "role": "Slider", "aria-valuenow": "33.3333333" })).toBe("Vol 33.3333 end");
    expect(vol({ "role": "slider", "aria-valuenow": "150" })).toBe("Vol 100 end");
    expect(vol({ "role": "slider", "aria-valuenow": "5px", "aria-valuemin": "10" })).toBe(
      "Vol 10 end"
    );
    expect(vol({ "role": "slider", "aria-valuemin": "50" })).toBe("Vol 75 end");
    expect(vol({ "role": "spinbutton", "aria-valuenow": "-500" })).toBe("Vol -500 end");
    expect(vol({ "role": "meter", "aria-valuemin": "10" })).toBe("Vol 10 end");
    expect(vol({ "role": "slider", "aria-valuenow": "1234567", "aria-valuemax": "1e9" })).toBe(
      "Vol 1.23457e+6 end"
    );
    expect(vol({ "role": "spinbutton", "aria-valuenow": "12345678901" })).toBe(
      "Vol 1.23457e+10 end"
    );
    expect(vol({ "role": "slider", "aria-valuenow": "1.5e-10" })).toBe("Vol 1.50000e-10 end");
    expect(vol({ "role": "slider bogus", "aria-valuenow": "7" })).toBe("Vol 7 end");
    expect(vol({ "role": " slider", "aria-valuenow": "7" })).toBe("Vol 7 end");
    expect(vol({ role: "progressbar" })).toBe("Vol s end");
    expect(vol({ "role": "slider", "aria-valuetext": "", "aria-valuenow": "7" })).toBe("Vol end");

    const option = (name: string, attrs: Record<string, string>, style = {}) => {
      const node = widget({ role: "option", ...attrs }, [text(name)]);
      Object.assign(node.__style as Record<string, string>, style);
      return node;
    };
    const listbox = (...options: unknown[]) =>
      labelledBy([
        text("A"),
        widget({ "role": "listbox", "aria-label": "LB" }, options),
        text("B"),
      ]);
    expect(listbox(option("O1", { "aria-selected": "TRUE" }), option("O2", {}))).toBe("A O1 B");
    expect(listbox(option("O1", {}), option("O2", {}))).toBe("A LB B");
    // A hidden target reads its hidden content, but not its hidden chosen options.
    const hiddenListbox = (target: Record<string, string>, ...options: unknown[]) =>
      labelledBy(
        [text("A"), widget({ role: "listbox" }, options), text("B")],
        { display: "inline", ...target },
        target.visibility ? {} : { "aria-hidden": "true" }
      );
    const chosen = { "aria-selected": "true" };
    expect(
      hiddenListbox({ visibility: "hidden" }, option("O1", chosen, { visibility: "hidden" }))
    ).toBe("A B");
    expect(hiddenListbox({}, option("O1", chosen), option("O2", {}))).toBe("A O1 B");
    expect(hiddenListbox({}, option("O1", { ...chosen, "aria-hidden": "true" }))).toBe("A B");
    expect(
      labelledBy([text("A"), widget({ role: "listbox" }, [option("O1", chosen)]), text("B")], {
        display: "none",
      })
    ).toBe("A B");
    // A target that is a listbox reads its chosen options, else its aria-label.
    const rootListbox = (...kids: unknown[]) =>
      labelledBy(kids, { display: "inline" }, { "role": "listbox", "aria-label": "Root" });
    expect(rootListbox(text("Text"), option("Opt", chosen), option("No", {}))).toBe("Opt");
    expect(rootListbox(text("Text"), option("Opt", {}))).toBe("Root");
  });

  it("leaves out a closed <details>' content, inert content and content-visibility:hidden content", () => {
    const summary = elementNode("summary", [text("Shipping")]);
    const details = (open: boolean, shown?: string) => {
      const node = elementNode("details", [summary, text("Ships in 3 days")]);
      if (open) node.__attrs = { open: "" };
      if (shown) node.__pseudo = { "::details-content": { contentVisibility: shown } };
      return node;
    };
    expect(labelledBy([details(false)])).toBe("Shipping");
    expect(labelledBy([details(true)])).toBe("Shipping Ships in 3 days");
    expect(labelledBy([details(false, "visible")])).toBe("Shipping Ships in 3 days");
    // Display:none content has no layout to skip.
    expect(labelledBy([details(false)], { display: "none" })).toBe("Shipping Ships in 3 days");

    const inert = elementNode("span", [text("(disabled)")]);
    inert.__attrs = { inert: "" };
    expect(labelledBy([text("Delete "), inert, text(" file")])).toBe("Delete file");
    expect(labelledBy([text("Inert")], { display: "inline" }, { inert: "" })).toBeUndefined();
    expect(labelledBy([text("Inert")], { display: "none" }, { inert: "" })).toBe("Inert");

    const collapsed = (display: string, attrs = {}) => {
      const node = elementNode("div", [text("x")]);
      Object.assign(node.__style as Record<string, string>, {
        display,
        contentVisibility: "hidden",
      });
      node.__attrs = attrs;
      return node;
    };
    expect(labelledBy([text("Keep"), collapsed("block"), text("going")])).toBe("Keep going");
    expect(labelledBy([text("Keep"), collapsed("block", { title: "T" }), text("going")])).toBe(
      "Keep T going"
    );
    expect(labelledBy([text("Keep "), collapsed("inline"), text(" going")])).toBe("Keep x going");
    expect(labelledBy([text("Keep"), collapsed("contents"), text("going")])).toBe("Keep x going");
  });

  it("reads an element's ::before and ::after, or its title when its content is blank", () => {
    const styled = (
      kids: unknown[],
      pseudo: Record<string, Record<string, string>>,
      attrs: Record<string, string> = {}
    ) => {
      const node = elementNode("span", kids);
      node.__pseudo = pseudo;
      node.__attrs = attrs;
      return node;
    };
    const shows = (content: string, rest: Record<string, string> = {}) => ({
      "::before": { display: "inline", visibility: "visible", content, ...rest },
    });
    expect(labelledBy([styled([text("Save")], shows('"Star "'))])).toBe("Star Save");
    // Chrome escapes '"', the backslash and controls (a line feed is \a) in computed strings.
    expect(labelledBy([styled([text("Save")], shows('"\\"Q\\\\\\a x "'))])).toBe('"Q\\ x Save');
    expect(labelledBy([styled([text("Save")], shows('"\\1 Z"'))])).toBe("\u0001ZSave");
    expect(labelledBy([styled([text("Save")], shows('counters(c, "-") "K"'))])).toBe("KSave");
    expect(labelledBy([styled([text("Save")], shows('"★" / "Starred"'))])).toBe("Starred Save");
    expect(labelledBy([styled([text("Save")], shows('"Star"', { display: "block" }))])).toBe(
      "Star Save"
    );
    expect(labelledBy([styled([text("Save")], shows('"Star"', { visibility: "hidden" }))])).toBe(
      "Save"
    );
    const after = { "::after": { display: "inline", visibility: "visible", content: '" More"' } };
    expect(labelledBy([styled([text("Read")], after)])).toBe("Read More");
    expect(
      labelledBy([text("a"), styled([text("m")], shows('"H"', { display: "none" })), text("c")])
    ).toBe("amc");
    // Alt text and a box that is not inline part a pseudo-element from the element's other
    // text only; a block-level box also ends the inline element's run.
    const around = (kids: unknown[], pseudo: Record<string, Record<string, string>>) =>
      labelledBy([text("pre"), styled(kids, pseudo), text("post")]);
    const save = [text("Save")];
    expect(around(save, shows('"★" / "Starred"'))).toBe("preStarred Savepost");
    expect(around(save, shows('"Star"', { display: "inline-block" }))).toBe("preStar Savepost");
    expect(around(save, shows('"Star"', { display: "table-cell" }))).toBe("preStar Savepost");
    expect(around(save, shows('"Star"', { display: "block" }))).toBe("preStar Save post");
    expect(around(save, shows('"Star"', { display: "contents" }))).toBe("preStarSavepost");
    expect(around(save, shows('"Star"', { display: "math" }))).toBe("preStarSavepost");
    expect(around([], shows('"Star"', { display: "inline-block" }))).toBe("preStarpost");
    expect(around([], shows('"★" / "Starred"'))).toBe("preStarredpost");
    expect(around([], shows('"Star"', { display: "block" }))).toBe("preStar post");
    const afterBox = (display: string) => ({
      "::after": { display, visibility: "visible", content: '"Star"' },
    });
    expect(around(save, afterBox("inline-block"))).toBe("preSave Starpost");
    expect(around(save, afterBox("block"))).toBe("preSave Star post");
    expect(around([], afterBox("inline-block"))).toBe("preStarpost");
    expect(around([], { ...shows('"B"'), ...afterBox("inline-block") })).toBe("preB Starpost");
    expect(
      around([], {
        ...shows('"B"', { display: "inline-block" }),
        "::after": { display: "inline", visibility: "visible", content: '"A"' },
      })
    ).toBe("preB Apost");
    const input = elementNode("input", []);
    input.__pseudo = shows('"PX"');
    expect(labelledBy([text("a"), input, text("c")])).toBe("a c");
    // An aria-hidden target reads its content, not its pseudo-elements.
    expect(
      labelledBy([styled([text("Read")], after)], { display: "inline" }, { "aria-hidden": "true" })
    ).toBe("Read");

    expect(labelledBy([text("a"), styled([], {}, { title: "Hi" }), text("b")])).toBe("a Hi b");
    expect(labelledBy([styled([text("Yo")], {}, { title: "Hi" }), text(" there")])).toBe(
      "Yo there"
    );
    expect(labelledBy([styled([text("   ")], {}, { title: "Tip" }), text("z")])).toBe("Tip z");
    const img = (attrs: Record<string, string>) => {
      const node = elementNode("img", []);
      (node.__style as Record<string, string>).display = "inline";
      node.__attrs = attrs;
      return node;
    };
    expect(labelledBy([text("x"), img({ title: "Pic" }), text("y")])).toBe("x Pic y");
    expect(labelledBy([text("x"), img({}), text("y")])).toBe("x y");
    expect(labelledBy([text("x"), img({ alt: "" }), text("y")])).toBe("xy");
    expect(labelledBy([text("x"), img({ alt: "", title: "T" }), text("y")])).toBe("x y");
    expect(labelledBy([text("x"), img({ alt: " ", title: "Pic" }), text("y")])).toBe("x y");
  });

  it("reads an <svg> in an aria-labelledby target as Chrome names it", () => {
    // The class is what Object.prototype.toString reports: a plain SVGElement is an
    // element SVG does not know.
    const svg = (tag: string, kids: unknown[], kind = "SVGGraphicsElement") => {
      const node = elementNode(tag, kids, {
        namespaceURI: "http://www.w3.org/2000/svg",
        [Symbol.toStringTag]: kind,
      });
      (node.__style as Record<string, string>).display = "inline";
      return node;
    };
    const unknown = (kids: unknown[]) => svg("select", kids, "SVGElement");
    const pick = (kids: unknown[], style?: Record<string, string>) =>
      labelledBy([text("Pick"), svg("svg", kids), text("end")], style);
    expect(pick([unknown([unknown([text("Opt")])])])).toBe("Pick end");
    expect(pick([unknown([])])).toBe("Pick end");
    expect(pick([text("raw")])).toBe("Pick raw end");
    expect(pick([])).toBe("Pickend");
    expect(pick([{ nodeType: 8, nodeValue: "c" }])).toBe("Pickend");
    expect(pick([svg("metadata", [text("md")], "SVGMetadataElement")])).toBe("Pick end");
    expect(pick([svg("script", [text("var a")], "SVGScriptElement")])).toBe("Pick end");
    expect(pick([svg("style", [text(".a{}")], "SVGStyleElement"), svg("text", [text("T")])])).toBe(
      "Pick T end"
    );
    expect(pick([svg("circle", [text("craw")])])).toBe("Pick craw end");
    // A hidden target reads unrendered SVG content too, but never an SVG <style>.
    const none = { display: "none" };
    expect(pick([unknown([text("selraw")])], none)).toBe("Pick selraw end");
    expect(pick([svg("script", [text("var a")], "SVGScriptElement")], none)).toBe("Pick var a end");
    expect(pick([svg("style", [text(".x{}")], "SVGStyleElement")], none)).toBe("Pick end");
    // A shown <svg> drops whitespace-only text; CDATA counts as text. Hidden, any <svg> parts.
    expect(pick([text(" ")])).toBe("Pickend");
    expect(pick([{ nodeType: 4, nodeValue: " " }])).toBe("Pickend");
    expect(pick([{ nodeType: 4, nodeValue: "cd" }])).toBe("Pick cd end");
    expect(pick([], { display: "inline", visibility: "hidden" })).toBe("Pick end");
    // An SVG element's first <title> stands in for its content, even when blank.
    const title = (t: string) =>
      Object.assign(svg("title", [text(t)], "SVGTitleElement"), { textContent: t });
    const x = svg("text", [text("X")]);
    expect(pick([x, title("T"), title("U")])).toBe("Pick T end");
    expect(pick([title(" "), x])).toBe("Pick end");
    expect(pick([title(""), x])).toBe("Pick X end");
    expect(pick([svg("g", [title("G"), x])])).toBe("Pick G end");
    expect(pick([title("T"), x], none)).toBe("Pick T end");
    // An SVG-namespace <slot> is no slot: it reads as its own children.
    expect(pick([svg("slot", [text("fb")], "SVGElement")], none)).toBe("Pick fb end");
  });

  it("parts words at every element under display:none, which has no inline layout", () => {
    const span = (t: string) => elementNode("span", [text(t)]);
    const none = { display: "none" };
    expect(labelledBy([span("Close"), span("dialog")], none)).toBe("Close dialog");
    expect(labelledBy([text("a"), span("b"), text("c")], none)).toBe("a b c");
    // A nested display:none parts its content in a target hidden another way, and the
    // inline layout resumes where it ends.
    const inner = elementNode("span", [span("a"), span("b")]);
    (inner.__style as Record<string, string>).display = "none";
    const hidden = { display: "inline", visibility: "hidden" };
    expect(labelledBy([text("x"), inner, span("y"), span("z")], hidden)).toBe("x a b yz");
  });

  it("reads a script, style or noscript by whether it has a box, as Chrome does", () => {
    const code = (tag: string, display: string) => {
      const node = elementNode(tag, [text("q")]);
      (node.__style as Record<string, string>).display = display;
      return node;
    };
    const hidden = { display: "inline", visibility: "hidden" };
    // Undisplayed, or a <noscript> while scripts run: no text, and no break in a hidden
    // target either.
    for (const tag of ["script", "style"]) {
      expect(labelledBy([text("A"), code(tag, "none"), text("B")], hidden), tag).toBe("AB");
    }
    expect(labelledBy([text("A"), code("noscript", "inline"), text("B")], hidden)).toBe("AB");
    expect(labelledBy([text("A"), code("noscript", "inline"), text("B")])).toBe("AB");
    // Displayed, it reads like any element, but not under display:none.
    expect(labelledBy([text("A"), code("script", "inline"), text("B")])).toBe("AqB");
    expect(labelledBy([text("A"), code("style", "block"), text("B")], hidden)).toBe("A q B");
    expect(labelledBy([text("A"), code("script", "block"), text("B")], { display: "none" })).toBe(
      "A B"
    );
    // An SVG <style> parts words, shown or hidden.
    const svgStyle = elementNode("style", [text(".a{}")], {
      namespaceURI: "http://www.w3.org/2000/svg",
    });
    (svgStyle.__style as Record<string, string>).display = "inline";
    expect(labelledBy([text("x"), svgStyle, text("y")])).toBe("x y");
  });

  it("reads aria-hidden as Chrome does: hidden for any value but false or undefined", () => {
    const hiding = (value: string) =>
      labelledBy([
        text("A "),
        elementNode("span", [text("B")], { __attrs: { "aria-hidden": value } }),
        text(" C"),
      ]);
    for (const value of ["true", "TRUE", "True", " true", "yes", "fals\u0435"]) {
      expect(hiding(value), JSON.stringify(value)).toBe("A C");
    }
    for (const value of ["", "false", "FALSE", "undefined", "Undefined"]) {
      expect(hiding(value), JSON.stringify(value)).toBe("A B C");
    }
    // An ancestor's aria-hidden hides the target, which then reads its display:none content.
    const none = elementNode("span", [text("D")]);
    (none.__style as Record<string, string>).display = "none";
    const label = elementNode("span", [text("A"), none, text("B")], { __attrs: { id: "lbl" } });
    const wrapper = el({ rect: BOX, attrs: { "aria-hidden": "True" }, children: [label] });
    const button = el({
      tag: "button",
      rect: BOX,
      attrs: { "id": "btn", "aria-labelledby": "lbl" },
    });
    expect(findById(run([button, wrapper]).tree, "btn")!.label).toBe("A D B");
  });

  it("reads a custom element in an aria-labelledby target through its open shadow tree", () => {
    const slot = (assigned: unknown[], fallback: unknown[] = []) => {
      const node = elementNode("slot", fallback, { __assigned: assigned });
      Object.setPrototypeOf(node, MockHTMLSlotElement.prototype);
      (node.__style as Record<string, string>).display = "contents";
      return node;
    };
    const host = (light: unknown[], shadow: unknown[], attrs: Record<string, string> = {}) => {
      const node = el({
        tag: "x-lab",
        rect: BOX,
        attrs,
        shadow: [],
        style: { display: "inline" },
      }) as MockElement & Record<string, unknown>;
      Object.assign(node, { nodeType: 1 });
      node.childNodes = light;
      (node.shadowRoot as Record<string, unknown>).__childNodes = shadow;
      return node;
    };
    const labelOf = (target: MockElement) => {
      const button = el({
        tag: "button",
        rect: BOX,
        attrs: { "id": "btn", "aria-labelledby": "lbl" },
      });
      return findById(run([button, target]).tree, "btn")!.label;
    };
    const shadowText = () => [elementNode("span", [text("Shadow text")])];
    expect(labelOf(host([], shadowText(), { id: "lbl" }))).toBe("Shadow text");
    const total = elementNode("span", [text("Total "), host([], shadowText())], {
      __attrs: { id: "lbl" },
    });
    expect(labelOf(total)).toBe("Total Shadow text");
    // Only slotted light children count, in their slots' order; an empty slot shows its fallback.
    const light = elementNode("b", [text("light")]);
    const unslotted = elementNode("i", [text("unslotted")]);
    expect(
      labelOf(host([light, unslotted], [text("pre "), slot([light]), text(" post")], { id: "lbl" }))
    ).toBe("pre light post");
    expect(
      labelOf(host([], [text("pre "), slot([], [text("fb")]), text(" post")], { id: "lbl" }))
    ).toBe("pre fb post");
    const first = elementNode("i", [text("first")]);
    const second = elementNode("b", [text("second")]);
    expect(labelOf(host([second, first], [slot([first]), slot([second])], { id: "lbl" }))).toBe(
      "first second"
    );
    // A listbox host's options are its shadow children, not its slotted light ones.
    const option = elementNode("span", [text("SL")], {
      __attrs: { "role": "option", "aria-selected": "true" },
    });
    const listbox = host([option], [slot([option])], { "role": "listbox", "aria-label": "LB" });
    expect(
      labelOf(elementNode("span", [text("A"), listbox, text("B")], { __attrs: { id: "lbl" } }))
    ).toBe("A LB B");
  });

  it("keeps inline elements joined in a target hidden without losing its layout", () => {
    const span = (t: string) => elementNode("span", [text(t)]);
    const hidden = { display: "inline", visibility: "hidden" };
    expect(labelledBy([span("Close"), span("dialog")], hidden)).toBe("Closedialog");
  });

  it("reads a hidden aria-labelledby target whole, and a target's own aria-label or alt", () => {
    const child = (tag: string, text: string, style: Record<string, string> = {}, attrs = {}) =>
      el({ tag, text, rect: BOX, style: { display: "inline", ...style }, attrs });
    const labelOf = (
      kids: unknown[],
      opts: { tag?: string; style?: Record<string, string>; attrs?: Record<string, string> } = {},
      wrapperAttrs?: Record<string, string>
    ) => {
      const label = el({
        tag: opts.tag ?? "span",
        rect: BOX,
        style: { display: "inline", ...opts.style },
        attrs: { id: "lbl", ...opts.attrs },
      }) as MockElement & Record<string, unknown>;
      label.childNodes = kids;
      const target = wrapperAttrs
        ? el({ rect: BOX, attrs: wrapperAttrs, children: [label] })
        : label;
      const button = el({
        tag: "button",
        rect: BOX,
        attrs: { "id": "btn", "aria-labelledby": "lbl" },
      });
      return findById(run([button, target]).tree, "btn")!.label;
    };
    const text = (nodeValue: string) => ({ nodeType: 3, nodeValue });
    // A visibility:hidden tooltip: its children inherit visibility:hidden.
    expect(
      labelOf([text("Delete "), child("span", "item", { visibility: "hidden" })], {
        style: { visibility: "hidden" },
      })
    ).toBe("Delete item");
    // Under an aria-hidden ancestor, its own aria-hidden children count too.
    expect(
      labelOf(
        [text("Keep "), child("b", "going", {}, { "aria-hidden": "true" })],
        {},
        {
          "aria-hidden": "true",
        }
      )
    ).toBe("Keep going");
    // A display:none target: its display:none and script/noscript children part words.
    expect(
      labelOf(
        [
          text("a"),
          child("span", "N", { display: "none" }),
          text("b"),
          child("script", "s = 1", { display: "none" }),
          text("c"),
          child("noscript", "NS"),
          text("d"),
        ],
        { style: { display: "none" } }
      )
    ).toBe("a N b c d");
    expect(labelOf([text("Visible")], { attrs: { "aria-label": "Real" } })).toBe("Real");
    expect(labelOf([], { tag: "img", attrs: { alt: "Pic" } })).toBe("Pic");
    expect(labelOf([text("Fallback")], { attrs: { "aria-label": "  " } })).toBe("Fallback");
  });

  it("reads a <br> under a display:none element of an aria-labelledby target as nothing", () => {
    // Each <br> sits two elements below the target. Its own display stays inline under
    // the display:none span, as display does not inherit.
    const nested = (display: string) => {
      const outer = el({ tag: "span", rect: ZERO, style: { display } }) as MockElement &
        Record<string, unknown>;
      const inner = el({ tag: "b", rect: ZERO }) as MockElement & Record<string, unknown>;
      inner.childNodes = [Object.assign(el({ tag: "br", rect: ZERO }), { nodeType: 1 })];
      outer.childNodes = [Object.assign(inner, { nodeType: 1 })];
      return Object.assign(outer, { nodeType: 1 });
    };
    const label = el({ tag: "span", rect: BOX, attrs: { id: "lbl" } }) as MockElement &
      Record<string, unknown>;
    // The script checks the target's ancestors up to the document.
    Object.assign(label, { nodeType: 1, parentNode: { nodeType: 9 } });
    label.childNodes = [
      { nodeType: 3, nodeValue: "Save" },
      nested("none"),
      { nodeType: 3, nodeValue: "my" },
      nested("inline"),
      { nodeType: 3, nodeValue: "draft" },
    ];
    const button = el({
      tag: "button",
      rect: BOX,
      attrs: { "id": "btn", "aria-labelledby": "lbl" },
    });
    const { tree } = run([button, label]);
    expect(findById(tree, "btn")!.label).toBe("Savemy draft");
  });

  it("reads every <br> in a display:none aria-labelledby target as a space", () => {
    // Nothing in the target renders, so a <br> under a further display:none element counts
    // too. The target is display:none itself, or sits under a display:none ancestor.
    const br = () => Object.assign(el({ tag: "br", rect: ZERO }), { nodeType: 1 });
    const label = (style: Record<string, string>) => {
      const node = el({ tag: "span", rect: ZERO, style, attrs: { id: "lbl" } }) as MockElement &
        Record<string, unknown>;
      const gone = el({ tag: "span", rect: ZERO, style: { display: "none" } }) as MockElement &
        Record<string, unknown>;
      gone.childNodes = [br()];
      node.childNodes = [
        { nodeType: 3, nodeValue: "Save" },
        br(),
        { nodeType: 3, nodeValue: "my" },
        Object.assign(gone, { nodeType: 1 }),
        { nodeType: 3, nodeValue: "draft" },
      ];
      return Object.assign(node, { nodeType: 1 });
    };
    const button = () =>
      el({ tag: "button", rect: BOX, attrs: { "id": "btn", "aria-labelledby": "lbl" } });

    const own = run([button(), label({ display: "none" })]);
    expect(findById(own.tree, "btn")!.label).toBe("Save my draft");

    const inner = label({});
    const host = el({ rect: ZERO, style: { display: "none" }, children: [inner] });
    inner.parentNode = Object.assign(host, { nodeType: 1, parentNode: { nodeType: 9 } });
    const viaAncestor = run([button(), host]);
    expect(findById(viaAncestor.tree, "btn")!.label).toBe("Save my draft");
  });

  it("reads a visibility:hidden <br> as a space, since it still breaks the line", () => {
    const br = () =>
      Object.assign(el({ tag: "br", rect: ZERO, style: { visibility: "hidden" } }), {
        nodeType: 1,
      });
    const text = () => [
      { nodeType: 3, nodeValue: "alpha" },
      br(),
      { nodeType: 3, nodeValue: "beta" },
    ];
    const div = el({ rect: BOX, attrs: { id: "own" } }) as MockElement & Record<string, unknown>;
    div.childNodes = text();
    const label = el({ tag: "span", rect: BOX, attrs: { id: "lbl" } }) as MockElement &
      Record<string, unknown>;
    label.childNodes = text();
    const button = el({
      tag: "button",
      rect: BOX,
      attrs: { "id": "btn", "aria-labelledby": "lbl" },
    });
    const { tree } = run([div, button, label]);
    expect(findById(tree, "own")!.value).toBe("alpha beta");
    expect(findById(tree, "btn")!.label).toBe("alpha beta");
  });

  it("keeps a U+FEFF, and folds other whitespace to a space, in own and aria-labelledby text", () => {
    for (const [text, expected] of [
      ["Save\uFEFFdraft", "Save\uFEFFdraft"],
      ["Save\u00A0draft", "Save draft"],
      ["Save\u2003\u2003draft", "Save draft"],
    ]) {
      const label = el({ tag: "span", text, rect: BOX, attrs: { id: "lbl" } });
      const labelled = el({
        tag: "button",
        rect: BOX,
        attrs: { "id": "labelled", "aria-labelledby": "lbl" },
      });
      const own = el({ tag: "button", text, rect: BOX, attrs: { id: "own" } });
      const { tree } = run([labelled, own, label]);
      expect(findById(tree, "labelled")!.label).toBe(expected);
      expect(findById(tree, "own")!.value).toBe(expected);
    }
  });

  it("walks an aria-labelledby target shared by many controls only once", () => {
    // An empty target too: its cached "" must count as a hit.
    const childNodesReads = (text: string, buttons: number) => {
      const label = el({ tag: "span", text, rect: BOX, attrs: { id: "lbl" } });
      let reads = 0;
      const kids = (label as MockElement & Record<string, unknown>).__childNodes;
      Object.defineProperty(label, "__childNodes", {
        get: () => (reads++, kids),
        configurable: true,
      });
      const controls = Array.from({ length: buttons }, (_, i) =>
        el({ tag: "button", rect: BOX, attrs: { "id": `b${i}`, "aria-labelledby": "lbl" } })
      );
      const { tree } = run([...controls, label]);
      expect(findById(tree, `b${buttons - 1}`)!.label).toBe(text || undefined);
      return reads;
    };
    for (const text of ["Shared", ""]) {
      expect(childNodesReads(text, 5)).toBe(childNodesReads(text, 1));
    }
  });

  it("reads a shared aria-labelledby target on a page whose own global Map is not the builtin", () => {
    // A classic page script's top-level `class Map` or `var Map = {...}` shadows the builtin.
    const label = el({ tag: "span", text: "Shared", rect: BOX, attrs: { id: "lbl" } });
    const controls = ["b1", "b2"].map((id) =>
      el({ tag: "button", rect: BOX, attrs: { "id": id, "aria-labelledby": "lbl" } })
    );
    for (const Map of [class {}, { tiles: [] }]) {
      const { tree } = run([...controls, label], undefined, {}, "CSS1Compat", { Map });
      expect(findById(tree, "b1")!.label).toBe("Shared");
      expect(findById(tree, "b2")!.label).toBe("Shared");
    }
  });

  it("falls back to the title when no aria-labelledby id resolves, however often", () => {
    const controls = ["b1", "b2"].map((id) =>
      el({ tag: "button", rect: BOX, attrs: { "id": id, "aria-labelledby": "nope", "title": "T" } })
    );
    const { tree } = run(controls);
    expect(findById(tree, "b1")!.label).toBe("T");
    expect(findById(tree, "b2")!.label).toBe("T");
  });

  it("reads aria-labelledby ids that name Object.prototype members", () => {
    const ids = ["constructor", "toString", "__proto__"];
    const labels = ids.map((id) => el({ tag: "span", text: `L-${id}`, rect: BOX, attrs: { id } }));
    const controls = ids.map((id) =>
      el({ tag: "button", rect: BOX, attrs: { "id": `b-${id}`, "aria-labelledby": id } })
    );
    const { tree } = run([...controls, ...labels]);
    for (const id of ids) expect(findById(tree, `b-${id}`)!.label).toBe(`L-${id}`);
  });

  it("reads each aria-labelledby target as its own text", () => {
    const one = el({ tag: "span", text: "One", rect: BOX, attrs: { id: "l1" } });
    const two = el({ tag: "span", text: "Two", rect: BOX, attrs: { id: "l2" } });
    const button = (id: string, labelledBy: string) =>
      el({ tag: "button", rect: BOX, attrs: { "id": id, "aria-labelledby": labelledBy } });
    const { tree } = run([button("b1", "l1"), button("b2", "l2"), button("b3", "l1 l2"), one, two]);
    expect(findById(tree, "b1")!.label).toBe("One");
    expect(findById(tree, "b2")!.label).toBe("Two");
    expect(findById(tree, "b3")!.label).toBe("One Two");
  });

  it("joins aria-labelledby targets without a separator for an empty one", () => {
    const icon = el({ tag: "span", rect: BOX, attrs: { id: "icon" } });
    const blank = el({ tag: "span", rect: BOX, attrs: { id: "blank" } });
    const close = el({ tag: "span", text: "Close", rect: BOX, attrs: { id: "close" } });
    const now = el({ tag: "span", text: "Now", rect: BOX, attrs: { id: "now" } });
    const button = (id: string, labelledBy: string) =>
      el({ tag: "button", rect: BOX, attrs: { id, "aria-labelledby": labelledBy, "title": "T" } });
    const { tree } = run([
      button("b1", "icon close"),
      button("b2", "close icon now"),
      button("b3", "icon blank"),
      icon,
      blank,
      close,
      now,
    ]);
    expect(findById(tree, "b1")!.label).toBe("Close");
    expect(findById(tree, "b2")!.label).toBe("Close Now");
    // Targets that all resolve to nothing fall through to the title, as in Chrome.
    expect(findById(tree, "b3")!.label).toBe("T");
  });

  it("collapses whitespace in an aria-labelledby target, as in own text", () => {
    // A <br> beside a space must not leave a double space a text selector would miss,
    // and a self-labelled button's label then equals its own text, so it is not repeated.
    const button = el({
      tag: "button",
      rect: BOX,
      attrs: { "id": "btn", "aria-labelledby": "btn" },
    }) as MockElement & Record<string, unknown>;
    const br = Object.assign(el({ tag: "br", rect: ZERO }), { nodeType: 1 });
    button.childNodes = [
      { nodeType: 3, nodeValue: "  Save as " },
      br,
      { nodeType: 3, nodeValue: "\n    draft  " },
    ];
    const node = findById(run([button]).tree, "btn")!;
    expect(node.label).toBe("Save as draft");
    expect(node.value).toBeUndefined();
  });

  it("falls through a blank aria-labelledby name or aria-label to the next name source, as Chrome does", () => {
    const span = (id: string, opts: Opts = {}) =>
      el({ tag: "span", rect: BOX, ...opts, attrs: { id, ...opts.attrs } });
    const hiddenOnly = span("hidden-only", {
      children: [el({ tag: "span", text: "x", rect: BOX, attrs: { "aria-hidden": "true" } })],
    });
    const logo = el({
      tag: "img",
      rect: BOX,
      attrs: { "id": "logo", "aria-labelledby": "empty" },
    }) as MockElement & Record<string, unknown>;
    Object.setPrototypeOf(logo, MockHTMLImageElement.prototype);
    logo.alt = "Logo";
    const input = (id: string, attrs: Record<string, string>, more: Record<string, string> = {}) =>
      inputEl({ type: "text", rect: BOX, attrs: { id, ...attrs }, ...more });
    const { tree } = run([
      // #1564: an icon-only target on a filled search field.
      input("filled", { "aria-labelledby": "empty" }, { placeholder: "Search", value: "abc" }),
      input("inert", { "aria-labelledby": "inert-label" }, { placeholder: "Search" }),
      input("hidden", { "aria-labelledby": "hidden-only" }, { placeholder: "Search" }),
      input("blank-aria", { "aria-label": "  " }, { placeholder: "Search" }),
      input("blank-aria-typed", { "aria-label": "  " }, { value: "abc" }),
      input("blank-aria-ids", { "aria-label": "  ", "aria-labelledby": "lab" }),
      el({
        tag: "button",
        rect: BOX,
        attrs: { "id": "blank-title", "aria-label": " ", "title": "T" },
      }),
      el({ tag: "button", text: "Go", rect: BOX, attrs: { "id": "go", "aria-label": "  " } }),
      logo,
      span("empty"),
      span("inert-label", { text: "Find", attrs: { inert: "" } }),
      hiddenOnly,
      span("lab", { text: "Lab" }),
    ]);
    const read = (id: string) => {
      const node = findById(tree, id)!;
      return { label: node.label, value: node.value };
    };
    expect(read("filled")).toEqual({ label: "Search", value: undefined });
    expect(read("inert")).toEqual({ label: "Search", value: undefined });
    expect(read("hidden")).toEqual({ label: "Search", value: undefined });
    expect(read("blank-aria")).toEqual({ label: "Search", value: undefined });
    expect(read("blank-aria-typed")).toEqual({ label: "abc", value: undefined });
    expect(read("blank-aria-ids")).toEqual({ label: "Lab", value: undefined });
    expect(read("blank-title")).toEqual({ label: "T", value: undefined });
    expect(read("go")).toEqual({ label: undefined, value: "Go" });
    expect(read("logo")).toEqual({ label: "Logo", value: undefined });
  });

  it("cases aria-labelledby text and ::before/::after strings by text-transform, as Chrome does", () => {
    const cased = (tag: string, kids: unknown[], style: Record<string, string>) => {
      const node = elementNode(tag, kids);
      Object.assign(node.__style as Record<string, string>, style);
      return node;
    };
    const upper = { textTransform: "uppercase" };
    const capital = { display: "inline", textTransform: "capitalize" };
    expect(labelledBy([cased("span", [text("save")], upper), text(" it")])).toBe("SAVE it");
    expect(labelledBy([text("SAVE It")], { display: "inline", textTransform: "lowercase" })).toBe(
      "save it"
    );
    // A nested "none" reads as authored, and full case mapping can lengthen text.
    expect(
      labelledBy(
        [text("ab "), cased("span", [text("cd")], { textTransform: "none" }), text(" straße")],
        { display: "inline", ...upper }
      )
    ).toBe("AB cd STRASSE");
    // ICU words, with the character before the text deciding its first.
    expect(labelledBy([text("hello wORLD foo-bar o'neil x_y 3d ßa élan")], capital)).toBe(
      "Hello WORLD Foo-Bar O'neil X_y 3d ßa Élan"
    );
    expect(labelledBy([text("he"), cased("b", [text("llo")], capital), text(" wo")], capital)).toBe(
      "Hello Wo"
    );
    expect(labelledBy([text("ab"), cased("span", [text("cd ef")], capital)])).toBe("abcd Ef");
    expect(labelledBy([text("a\u00a0b")], capital)).toBe("A B");
    // The element's lang, as its -webkit-locale; one that is no locale tag cases as none.
    const locale = (webkitLocale: string) =>
      labelledBy([text("istanbul")], { display: "inline", ...upper, webkitLocale });
    expect(locale('"tr"')).toBe("İSTANBUL");
    expect(locale('"not a tag"')).toBe("ISTANBUL");
    // Content under display:none has no layout to case it.
    expect(labelledBy([text("ab")], { display: "none", ...upper })).toBe("ab");
    const pseudo = (which: string, content: string) => {
      const node = elementNode("span", [text("b")]);
      node.__pseudo = { [which]: { display: "inline", visibility: "visible", content, ...upper } };
      return node;
    };
    expect(labelledBy([pseudo("::before", '"pre "')])).toBe("PRE b");
    expect(labelledBy([pseudo("::after", '" post"')])).toBe("b POST");
    expect(labelledBy([pseudo("::before", '"x" / "alt "')])).toBe("alt b");
  });

  it("stops reading an aria-labelledby target once its name is past the cut, naming it the same", () => {
    let reads = 0;
    const words = Array.from({ length: 1000 }, (_, i) => `w${i}`);
    const label = el({
      tag: "span",
      rect: BOX,
      attrs: { id: "lbl" },
      // Keeps the main walk off the target's own text, so only its name reads count.
      style: { visibility: "hidden" },
    }) as MockElement & Record<string, unknown>;
    label.childNodes = words.map((w) => ({
      nodeType: 3,
      get nodeValue() {
        reads++;
        return w;
      },
    }));
    // A spaced ::before is parted from the text only when the target's walk finishes.
    label.__pseudo = {
      "::before": { display: "inline-block", visibility: "visible", content: '"Head"' },
    };
    const button = el({
      tag: "button",
      rect: BOX,
      attrs: { "id": "btn", "aria-labelledby": "lbl" },
    });
    const { tree } = run([button, label]);
    expect(findById(tree, "btn")!.label).toBe(`Head ${words.join("")}`.slice(0, 200));
    // "Head" and w0..w68 make 201 non-whitespace characters.
    expect(reads).toBe(69);

    // Names read from aria-labels count too. A hidden target reads display:none children,
    // which the main walk skips.
    let labelReads = 0;
    const named = Array.from({ length: 1000 }, () => {
      const node = el({ tag: "span", rect: BOX, style: { display: "none" } });
      Object.defineProperty(node as unknown as Record<string, unknown>, "__attrs", {
        value: {
          get "aria-label"() {
            labelReads++;
            return "abcde";
          },
        },
      });
      return node;
    });
    const names = el({
      tag: "div",
      rect: BOX,
      attrs: { id: "names" },
      style: { visibility: "hidden" },
      children: named,
    }) as MockElement & Record<string, unknown>;
    names.childNodes = named;
    const other = el({
      tag: "button",
      rect: BOX,
      attrs: { "id": "b2", "aria-labelledby": "names" },
    });
    expect(findById(run([other, names]).tree, "b2")!.label).toBe(
      Array(1000).fill("abcde").join(" ").slice(0, 200)
    );
    expect(labelReads).toBe(41);
  });

  it("leaves an ordinary visible element unchanged", () => {
    const { tree } = run([el({ text: "NORMAL", rect: BOX })]);
    expect(valuesOf(tree)).toContain("NORMAL");
  });

  // ---- box-less wrapper over invisible-only content must not become a phantom node ----
  it("drops a box-less wrapper whose non-zero content frame comes only from an invisible child", () => {
    // The wrapper has no own text; its single element child is visibility:hidden (pruned).
    // A real Range over the wrapper is non-zero because the child still lays out (the mock
    // Range now models that), but that must NOT resurrect the wrapper as an empty node with
    // a real frame — it paints nothing.
    const { tree } = run([
      el({
        attrs: { id: "phantom-wrap" },
        style: { display: "contents" },
        rect: ZERO,
        children: [el({ text: "HIDDENKID", style: { visibility: "hidden" }, rect: BOX })],
      }),
    ]);
    expect(identifiersOf(tree)).not.toContain("phantom-wrap");
    expect(valuesOf(tree)).not.toContain("HIDDENKID");
  });

  it("keeps a box-less wrapper with own painting text even when it also has an invisible child", () => {
    // Own text paints, so the wrapper is real; the invisible child is just pruned.
    const { tree } = run([
      el({
        text: "REALTEXT",
        content: { x: 0, y: 40, w: 60, h: 12 },
        style: { display: "contents" },
        rect: ZERO,
        children: [el({ text: "HIDDENKID2", style: { visibility: "hidden" }, rect: BOX })],
      }),
    ]);
    expect(valuesOf(tree)).toContain("REALTEXT");
    expect(valuesOf(tree)).not.toContain("HIDDENKID2");
    // The wrapper's frame is its OWN text rect ({0,40,60,12} → 0.06 x 0.012),
    // NOT the union with the invisible child's still-laid-out box (BOX reaches
    // y=130, which would have made the frame ~0.09 tall and mis-placed the tap
    // point). selectNodeContents over the element would have picked up BOX; the
    // own-text-only measurement does not.
    const findByValue = (
      n: Record<string, unknown> | null,
      v: string
    ): Record<string, unknown> | null => {
      if (!n) return null;
      if (n.value === v) return n;
      for (const c of (n.children as Record<string, unknown>[]) ?? []) {
        const r = findByValue(c, v);
        if (r) return r;
      }
      return null;
    };
    const real = findByValue(tree as Record<string, unknown>, "REALTEXT");
    const f = real!.frame as { y: number; width: number; height: number };
    expect(f.width).toBeCloseTo(0.06, 5);
    expect(f.height).toBeCloseTo(0.012, 5);
  });

  it("keeps a box-less wrapper's SEMANTIC role instead of promoting it away", () => {
    // A display:contents <nav> (semantic role) with a single child and no
    // clickable/name/text/id of its own must NOT be promoted to its child —
    // that would silently drop the "nav" role. Only a plain <div> layer is
    // promoted (see "still promotes an anonymous box-less wrapper" above).
    const { tree } = run([
      el({
        tag: "nav",
        style: { display: "contents" },
        rect: ZERO,
        children: [el({ text: "NAVITEM", rect: BOX })],
      }),
    ]);
    expect(rolesOf(tree)).toContain("nav");
    expect(valuesOf(tree)).toContain("NAVITEM");
  });

  it("a large fully visibility:hidden subtree does not starve the node budget", () => {
    // A closed drawer/modal can be a large visibility:hidden subtree. Descending
    // into it (to catch a visibility:visible override) must not spend the node
    // budget on nodes that emit nothing, or genuinely visible content elsewhere
    // gets truncated. MAX_NODES is 5000; 5100 hidden nodes before a visible one
    // used to exhaust it.
    const hiddenKids: MockElement[] = [];
    for (let i = 0; i < 5100; i++) {
      hiddenKids.push(el({ text: "HK" + i, style: { visibility: "hidden" }, rect: BOX }));
    }
    const { tree, truncated } = run([
      el({ style: { display: "contents" }, rect: ZERO, children: hiddenKids }),
      el({ text: "VISIBLE_AFTER", rect: BOX }),
    ]);
    expect(truncated).toBe(false);
    expect(valuesOf(tree)).toContain("VISIBLE_AFTER");
    expect(valuesOf(tree)).not.toContain("HK0");
  });

  // ---- visibility:hidden inherits but a descendant can override it back to visible ----
  it("surfaces a visibility:visible descendant nested under a visibility:hidden ancestor", () => {
    const { tree } = run([
      el({
        style: { visibility: "hidden" },
        rect: { x: 0, y: 100, w: 200, h: 200 },
        children: [el({ text: "OVERRIDE", style: { visibility: "visible" }, rect: BOX })],
      }),
    ]);
    expect(valuesOf(tree)).toContain("OVERRIDE");
  });

  it("suppresses a visibility:hidden element's own text but keeps its visible child", () => {
    const { tree } = run([
      el({
        text: "HIDDENOWN",
        style: { visibility: "hidden" },
        rect: { x: 0, y: 100, w: 200, h: 200 },
        children: [el({ text: "VISIBLECHILD", style: { visibility: "visible" }, rect: BOX })],
      }),
    ]);
    expect(valuesOf(tree)).toContain("VISIBLECHILD");
    expect(valuesOf(tree)).not.toContain("HIDDENOWN");
  });

  it("prunes a fully visibility:hidden subtree with no visible descendant (no phantom)", () => {
    const { tree } = run([
      el({
        style: { visibility: "hidden" },
        rect: { x: 0, y: 100, w: 200, h: 200 },
        children: [el({ text: "ALLHIDDEN", style: { visibility: "hidden" }, rect: BOX })],
      }),
    ]);
    expect(valuesOf(tree)).not.toContain("ALLHIDDEN");
    // Only the html/body scaffold survives — no phantom node for the hidden subtree.
    expect(identifiersOf(tree)).toEqual([]);
  });

  // ---- promotion must not discard an identifier ----
  it("keeps a box-less wrapper's identifier instead of promoting it away", () => {
    const { tree } = run([
      el({
        attrs: { id: "keepme" },
        style: { display: "contents" },
        rect: ZERO,
        children: [el({ text: "INNER5", rect: BOX })],
      }),
    ]);
    expect(identifiersOf(tree)).toContain("keepme");
    expect(valuesOf(tree)).toContain("INNER5");
  });

  it("keeps a boxed structural div's identifier instead of collapsing it away", () => {
    const { tree } = run([
      el({
        attrs: { "data-testid": "structural" },
        rect: { x: 0, y: 100, w: 200, h: 200 },
        children: [el({ text: "INNER5C", rect: BOX })],
      }),
    ]);
    expect(identifiersOf(tree)).toContain("structural");
    expect(valuesOf(tree)).toContain("INNER5C");
  });

  it("still promotes an anonymous box-less wrapper (no identifier) to its single child", () => {
    const withWrap = run([
      el({
        style: { display: "contents" },
        rect: ZERO,
        children: [el({ text: "SOLO", rect: BOX })],
      }),
    ]);
    const withoutWrap = run([el({ text: "SOLO", rect: BOX })]);
    expect(valuesOf(withWrap.tree)).toContain("SOLO");
    // The wrapper adds no node — identical node count to the bare child.
    expect(countNodes(withWrap.tree)).toBe(countNodes(withoutWrap.tree));
    expect(identifiersOf(withWrap.tree)).toEqual([]);
  });

  // ---- box-less node framing: unionFrame across multiple children (emitted, not promoted) ----
  it("frames an emitted box-less multi-child wrapper by the union of its children (unionFrame)", () => {
    const { tree } = run([
      el({
        attrs: { role: "button", id: "unioned" }, // clickable + named -> emitted, not promoted
        style: { display: "contents" },
        rect: ZERO,
        children: [
          el({ text: "A", rect: { x: 100, y: 100, w: 100, h: 20 } }),
          el({ text: "B", rect: { x: 300, y: 400, w: 100, h: 20 } }),
        ],
      }),
    ]);
    const node = findById(tree, "unioned");
    expect(node).toBeTruthy();
    expect((node!.children as unknown[]).length).toBe(2);
    const f = node!.frame as { x: number; y: number; width: number; height: number };
    // union of (100,100,100,20) and (300,400,100,20): x=100 y=100 right=400 bottom=420
    expect(f.x).toBeCloseTo(0.1, 6);
    expect(f.y).toBeCloseTo(0.1, 6);
    expect(f.width).toBeCloseTo(0.3, 6); // (400-100)/1000
    expect(f.height).toBeCloseTo(0.32, 6); // (420-100)/1000
  });

  it("frames a promoted box-less single-child node by the child's own rect", () => {
    const { tree } = run([
      el({
        style: { display: "contents" },
        rect: ZERO,
        children: [el({ text: "SOLO2", rect: BOX })],
      }),
    ]);
    const node = findById(tree, "");
    // The promoted node is the child itself; find it by value and check its frame == BOX.
    const child = (function find(
      n: Record<string, unknown> | null
    ): Record<string, unknown> | null {
      if (!n) return null;
      if (n.value === "SOLO2") return n;
      for (const c of (n.children as Record<string, unknown>[]) ?? []) {
        const r = find(c);
        if (r) return r;
      }
      return null;
    })(tree as Record<string, unknown>);
    expect(child).toBeTruthy();
    const f = child!.frame as { x: number; y: number; width: number; height: number };
    expect(f.x).toBeCloseTo(BOX.x / W, 6);
    expect(f.y).toBeCloseTo(BOX.y / H, 6);
    expect(f.width).toBeCloseTo(BOX.w / W, 6);
    expect(f.height).toBeCloseTo(BOX.h / H, 6);
    expect(node).toBeNull(); // sanity: no node literally identified by "" exists
  });

  // ---- shadow DOM + iframe piercing (previously uncovered) ----
  it("pierces an open shadow root and surfaces its content", () => {
    const { tree } = run([
      el({ tag: "my-widget", rect: BOX, shadow: [el({ text: "SHADOWTEXT", rect: BOX })] }),
    ]);
    expect(valuesOf(tree)).toContain("SHADOWTEXT");
  });

  it("reads a <br> between own text nodes as a space", () => {
    const div = el({ rect: BOX, attrs: { id: "nl" } }) as MockElement & Record<string, unknown>;
    const br = Object.assign(el({ tag: "br", rect: ZERO }), { nodeType: 1 });
    div.childNodes = [{ nodeType: 3, nodeValue: "alpha" }, br, { nodeType: 3, nodeValue: "beta" }];
    const { tree } = run([div]);
    expect(findById(tree, "nl")!.value).toBe("alpha beta");
  });

  it("skips a comment child between own text nodes", () => {
    // Element.prototype getters throw on a Comment, which would abort the whole walk.
    const div = el({ rect: BOX, attrs: { id: "nl" } }) as MockElement & Record<string, unknown>;
    div.childNodes = [
      { nodeType: 3, nodeValue: "alpha" },
      { nodeType: 8, nodeValue: " note " },
      { nodeType: 3, nodeValue: "beta" },
    ];
    const { tree } = run([div]);
    expect(findById(tree, "nl")!.value).toBe("alphabeta");
  });

  it("reads a non-HTML br element as nothing, since it renders inline", () => {
    // An SVG, MathML or null-namespace <br>, or createElementNS(XHTML, "BR") (localName
    // "BR"), is not a line break even though its tagName lowercases to "br".
    for (const [localName, namespaceURI] of [
      ["br", "http://www.w3.org/2000/svg"],
      ["br", "http://www.w3.org/1998/Math/MathML"],
      ["br", null],
      ["BR", "http://www.w3.org/1999/xhtml"],
    ]) {
      const div = el({ rect: BOX, attrs: { id: "nl" } }) as MockElement & Record<string, unknown>;
      const br = Object.assign(el({ tag: "br", rect: ZERO }), {
        nodeType: 1,
        localName,
        namespaceURI,
      });
      div.childNodes = [
        { nodeType: 3, nodeValue: "alpha" },
        br,
        { nodeType: 3, nodeValue: "beta" },
      ];
      const { tree } = run([div]);
      expect(findById(tree, "nl")!.value).toBe("alphabeta");
    }
  });

  it("reads a display:none <br> as nothing, since the words around it stay joined", () => {
    const div = el({ rect: BOX, attrs: { id: "nl" } }) as MockElement & Record<string, unknown>;
    const br = Object.assign(el({ tag: "br", rect: ZERO, style: { display: "none" } }), {
      nodeType: 1,
    });
    div.childNodes = [{ nodeType: 3, nodeValue: "alpha" }, br, { nodeType: 3, nodeValue: "beta" }];
    const { tree } = run([div]);
    expect(findById(tree, "nl")!.value).toBe("alphabeta");
  });

  // ---- a password input's typed value must never become its label ----
  it("never reads a password input's typed value as its accessible name", () => {
    // A placeholder-less password input (floating/uncontrolled-label pattern)
    // with a typed value: the aria/placeholder/title fallbacks are all empty,
    // and the value fallback must be skipped — otherwise the plaintext secret
    // becomes node.label and reaches every describe consumer verbatim.
    const { tree } = run([
      inputEl({ type: "password", value: "hunter2", attrs: { id: "pw" }, rect: BOX }),
    ]);
    const pw = findById(tree, "pw");
    expect(pw).toBeTruthy();
    expect(pw!.password).toBe(true);
    expect(pw!.label).toBeUndefined();
    expect(JSON.stringify(tree)).not.toContain("hunter2");
  });

  it("still reads a non-password input's value as its accessible name", () => {
    const { tree } = run([
      inputEl({ type: "text", value: "typed text", attrs: { id: "txt" }, rect: BOX }),
    ]);
    expect(findById(tree, "txt")!.label).toBe("typed text");
  });

  // ---- input focus (the flow type directive's focus wait reads this) ----
  it("marks the document's activeElement as focused, excluding the body", () => {
    const focusedInput = el({ tag: "input", attrs: { id: "focused-input" }, rect: BOX });
    const otherInput = el({
      tag: "input",
      attrs: { id: "other-input" },
      rect: { x: 0, y: 200, w: 200, h: 30 },
    });
    const body = el({
      tag: "body",
      attrs: { id: "the-body" },
      rect: { x: 0, y: 0, w: W, h: H },
      children: [focusedInput, otherInput],
    });
    // MockDocument defines no activeElement/body accessors, so the script's
    // protoGetter falls back to direct reads: a stub document with them is enough. The body being activeElement (the no-focus default) must NOT
    // mark it focused.
    const doc = { activeElement: focusedInput, body };
    for (const n of [focusedInput, otherInput, body]) {
      (n as unknown as Record<string, unknown>).ownerDocument = doc;
    }

    const { tree } = run([body]);
    expect(findById(tree, "focused-input")!.focused).toBe(true);
    expect(findById(tree, "other-input")!.focused).toBeUndefined();

    doc.activeElement = body;
    const { tree: unfocusedTree } = run([body]);
    expect(findById(unfocusedTree, "focused-input")!.focused).toBeUndefined();
    expect(findById(unfocusedTree, "the-body")!.focused).toBeUndefined();
  });

  it("never flags the host <iframe> that holds the focus of its subdocument", () => {
    // The outer document reports the host as its activeElement.
    const iframe = el({ tag: "iframe", attrs: { id: "the-iframe" }, rect: BOX });
    (iframe as unknown as Record<string, unknown>).ownerDocument = { activeElement: iframe };
    const { tree } = run([iframe]);
    expect(findById(tree, "the-iframe")!.focused).toBeUndefined();
  });

  // ---- a missing captured accessor must degrade, not abort the whole describe ----
  it("degrades instead of aborting when a captured prototype accessor is absent", () => {
    // scrollHeight is read only for overflow:auto/scroll nodes. Removing its prototype
    // accessor made the old `getOwnPropertyDescriptor(...).get` throw at script top and
    // abort the entire describe; protoGetter now falls back to a direct read.
    const saved = Object.getOwnPropertyDescriptor(MockElement.prototype, "scrollHeight");
    delete (MockElement.prototype as unknown as Record<string, unknown>).scrollHeight;
    try {
      let out: { tree: unknown } | undefined;
      expect(() => {
        out = run([el({ text: "STILLHERE", rect: BOX, style: { overflow: "auto" } })]);
      }).not.toThrow();
      expect(valuesOf(out!.tree)).toContain("STILLHERE");
    } finally {
      Object.defineProperty(MockElement.prototype, "scrollHeight", saved!);
    }
  });
});

// Frame in mock px (W = H = 1000), rounded so float noise never decides an assertion.
function pxFrame(
  tree: unknown,
  id: string,
  key: "frame" | "clipBounds" = "frame"
): { x: number; y: number; w: number; h: number } {
  const node = findById(tree, id);
  if (!node) throw new Error(`no node identified ${id}`);
  const f = node[key] as { x: number; y: number; width: number; height: number };
  const r = (v: number) => Math.round(v * 1e3 * 1e3) / 1e3;
  return { x: r(f.x), y: r(f.y), w: r(f.width), h: r(f.height) };
}

// A 300x100 scroll container at the origin with a 1px border and a 15px scrollbar:
// its padding box (the clip edge) is x 1..286, y 1..99.
function scroller(children: MockElement[], opts: Opts = {}): MockElement {
  return el({
    attrs: { id: "sc" },
    rect: { x: 0, y: 0, w: 300, h: 100 },
    client: { left: 1, top: 1, width: 285, height: 98 },
    offset: { width: 300, height: 100 },
    scrollSize: { width: 285, height: 400 },
    ...opts,
    style: { overflow: "auto", ...opts.style },
    children,
  });
}

const row = (id: string, rect: Rect, style: Record<string, string> = {}) =>
  el({ attrs: { id, onclick: "" }, text: id, rect, style });

describe("DESCRIBE_DOM_SCRIPT overflow clipping", () => {
  it("frames rows by what their scroll container shows: whole, cut at the clip edge, or none", () => {
    const { tree } = run([
      scroller([
        row("in", { x: 1, y: 1, w: 285, h: 40 }),
        row("part", { x: 1, y: 81, w: 285, h: 40 }),
        row("out", { x: 1, y: 121, w: 285, h: 40 }),
      ]),
    ]);
    expect(pxFrame(tree, "in")).toEqual({ x: 1, y: 1, w: 285, h: 40 });
    expect(pxFrame(tree, "part")).toEqual({ x: 1, y: 81, w: 285, h: 18 });
    expect(pxFrame(tree, "out").h).toBe(0);
    // A cut row carries the clip window along the axis it is cut on.
    expect(findById(tree, "in")!.clipBounds).toBeUndefined();
    expect(findById(tree, "out")!.clipBounds).toBeUndefined();
    expect(pxFrame(tree, "part", "clipBounds")).toEqual({ x: 0, y: 1, w: 1000, h: 98 });
    // The container's own frame is its border box, not its clip.
    expect(pxFrame(tree, "sc")).toEqual({ x: 0, y: 0, w: 300, h: 100 });
  });

  it("clips, anchors and follows slots on a page whose script replaced window.Map and window.Set", () => {
    // A classic page script's \`var Map = ...\` replaces the global property itself.
    const page = () => {
      const slot = el({ tag: "slot", rect: ZERO, style: { display: "contents" } });
      const slottedOut = row("slot-out", { x: 1, y: 261, w: 200, h: 40 });
      (slottedOut as Record<string, unknown>).assignedSlot = slot;
      const shadowScroller = el({
        rect: { x: 1, y: 201, w: 200, h: 50 },
        client: { left: 0, top: 0, width: 200, height: 50 },
        style: { overflow: "auto" },
        children: [slot],
      });
      (slot as Record<string, unknown>).parentNode = shadowScroller;
      return [
        scroller([row("cut", { x: 1, y: 81, w: 285, h: 40 })], {
          painted: { x: 0, y: 0, w: 300, h: 100 },
        }),
        el({
          tag: "x-host",
          rect: { x: 1, y: 201, w: 200, h: 50 },
          children: [slottedOut],
          shadow: [shadowScroller],
        }),
        row("gone", { x: 1, y: 400, w: 50, h: 20 }, { display: "none" }),
      ];
    };
    const builtin = run(page()).tree;
    // Immutable.Map's set returns a new map, leaving the receiver empty.
    class PersistentMap {
      get() {
        return undefined;
      }
      has() {
        return false;
      }
      set() {
        return new PersistentMap();
      }
    }
    class ArgMap extends Map {
      constructor(entries: { length: number }) {
        super();
        void entries.length;
      }
    }
    // Keys every element by the same string.
    class StringKeyMap extends Map {
      get(k: unknown) {
        return super.get(String(k));
      }
      has(k: unknown) {
        return super.has(String(k));
      }
      set(k: unknown, v: unknown) {
        return super.set(String(k), v);
      }
    }
    class NoGetMap extends Map {
      get() {
        return undefined;
      }
    }
    class NoHasMap extends Map {
      has() {
        return false;
      }
    }
    for (const globals of [
      { Map: { tiles: [] }, Set: class {} },
      { Map: class {} },
      { Map: PersistentMap },
      { Map: ArgMap },
      { Map: StringKeyMap },
      { Map: NoGetMap },
      { Map: NoHasMap },
    ]) {
      const replaced = run(page(), undefined, {}, "CSS1Compat", globals).tree;
      expect(replaced).toEqual(builtin);
    }
    expect(pxFrame(builtin, "cut")).toEqual({ x: 1, y: 81, w: 285, h: 18 });
    expect(findById(builtin, "cut")!.clipAnchors).toBeDefined();
    expect(pxFrame(builtin, "slot-out").h).toBe(0);
    expect(findById(builtin, "gone")).toBeNull();
  });

  it("describes a page whose own globals take the DOM interfaces' names", () => {
    const typed = <T extends object>(node: MockElement, C: new () => T, fields: object) =>
      Object.assign(Object.setPrototypeOf(node, C.prototype), fields) as MockElement;
    // A light child of a shadowless custom element, past its scroller's clip, is
    // hit-tested there.
    const cut = { x: 1, y: 81, w: 285, h: 40 };
    const page = (painted?: Rect) => [
      scroller([
        el({
          tag: "app-row",
          rect: ZERO,
          style: { display: "contents" },
          children: [el({ attrs: { id: "row", onclick: "" }, text: "row", rect: cut, painted })],
        }),
      ]),
      inputEl({ attrs: { id: "in" }, rect: BOX, placeholder: "Search" }),
      inputEl({ attrs: { id: "pw" }, rect: BOX, type: "password", value: "secret" }),
      typed(el({ tag: "textarea", attrs: { id: "ta" }, rect: BOX }), MockHTMLTextAreaElement, {
        placeholder: "Notes",
      }),
      typed(el({ tag: "img", attrs: { id: "im" }, rect: BOX }), MockHTMLImageElement, {
        alt: "Logo",
      }),
      el({ tag: "button", attrs: { "id": "sb", "aria-labelledby": "sl" }, rect: BOX }),
      Object.assign(el({ tag: "span", attrs: { id: "sl" }, style: { display: "inline" } }), {
        childNodes: [
          typed(
            el({ tag: "slot", text: "fb", style: { display: "contents" } }),
            MockHTMLSlotElement,
            {
              __assigned: [{ nodeType: 3, nodeValue: "slotted" }],
            }
          ),
        ],
      }),
      el({
        outerSvg: true,
        tag: "svg",
        rect: { x: 0, y: 200, w: 150, h: 90 },
        style: { display: "inline", overflow: "hidden", paddingRight: "20px" },
        children: [row("padding", { x: 135, y: 230, w: 10, h: 10 })],
      }),
    ];
    for (const painted of [undefined, cut]) {
      const builtin = run(page(painted)).tree;
      expect(findById(builtin, "in")!.label).toBe("Search");
      expect(findById(builtin, "ta")!.label).toBe("Notes");
      expect(findById(builtin, "im")!.label).toBe("Logo");
      expect(findById(builtin, "sb")!.label).toBe("slotted");
      expect(findById(builtin, "pw")!.password).toBe(true);
      expect(pxFrame(builtin, "padding").w).toBe(0);
      expect(pxFrame(builtin, "row")).toEqual(painted ? cut : { x: 1, y: 81, w: 285, h: 18 });
      for (const name of Object.keys(builtins)) {
        for (const value of [function () {}, class {}, { tiles: [] }, 5]) {
          const replaced = run(page(painted), undefined, {}, "CSS1Compat", { [name]: value }).tree;
          expect(replaced, `${name} = ${String(value)}`).toEqual(builtin);
        }
      }
    }
  });

  it("anchors a cut where a wheel reaches a scroller moving it in the cutter, farthest from the element", () => {
    // A pane spanning the whole screen height cuts the row at the screen's bottom.
    const pane = (kids: MockElement[], painted?: Rect) =>
      scroller(kids, {
        rect: { x: 0, y: 0, w: 300, h: H },
        client: { left: 0, top: 0, width: 285, height: H },
        offset: { width: 300, height: H },
        scrollSize: { width: 285, height: 2 * H },
        painted,
      });
    const cutRow = (painted?: Rect) =>
      el({ attrs: { id: "cut" }, rect: { x: 1, y: 950, w: 285, h: 100 }, painted });
    const PANE = { x: 0, y: 0, w: 300, h: H };
    const plain = run([pane([cutRow()], PANE)]).tree;
    expect(pxFrame(plain, "cut", "clipBounds")).toEqual({ x: 0, y: 0, w: W, h: H });
    expect(findById(plain, "cut")!.clipAnchors).toEqual({ y: { x: 0.0285, y: 0.1 } });
    const above = el({ attrs: { id: "cut" }, rect: { x: 1, y: -50, w: 285, h: 100 } });
    expect(findById(run([pane([above], PANE)]).tree, "cut")!.clipAnchors).toEqual({
      y: { x: 0.0285, y: 0.9 },
    });
    // Of nested cutters, the innermost's window first: a wheel on the outer one
    // carries the inner window along with the row.
    const list = el({
      rect: { x: 0, y: 500, w: 285, h: 400 },
      client: { left: 0, top: 0, width: 285, height: 400 },
      offset: { width: 285, height: 400 },
      scrollSize: { width: 285, height: 800 },
      style: { overflow: "auto" },
      painted: { x: 0, y: 500, w: 285, h: 400 },
      children: [el({ attrs: { id: "cut" }, rect: { x: 1, y: 850, w: 285, h: 200 } })],
    });
    expect(findById(run([pane([list], PANE)]).tree, "cut")!.clipAnchors).toEqual({
      y: { x: 0.0285, y: 0.54 },
    });
    // A fixed bar over the pane's upper part: the wheel there scrolls the page.
    const bar = el({
      rect: { x: 0, y: 0, w: 300, h: 300 },
      painted: { x: 0, y: 0, w: 300, h: 300 },
      style: { position: "fixed" },
    });
    const barred = run([pane([cutRow()], PANE), bar]).tree;
    expect(findById(barred, "cut")!.clipAnchors).toEqual({ y: { x: 0.0285, y: 0.5 } });
    // A frame's own document may take the wheel, though its element sits in the pane.
    const TOP = { x: 0, y: 0, w: 300, h: 300 };
    const frame = el({ tag: "iframe", rect: TOP, painted: TOP });
    const framed = run([pane([frame, cutRow()], PANE)]).tree;
    expect(findById(framed, "cut")!.clipAnchors).toEqual({ y: { x: 0.0285, y: 0.5 } });
    // A scroller between the cutter and the row carries the row as it scrolls.
    const inner = el({
      rect: { x: 0, y: 0, w: 285, h: 2 * H },
      client: { left: 0, top: 0, width: 285, height: 2 * H },
      offset: { width: 285, height: 2 * H },
      scrollSize: { width: 285, height: 4 * H },
      style: { overflow: "auto" },
      painted: PANE,
      children: [cutRow()],
    });
    const carried = run([pane([inner])]).tree;
    expect(findById(carried, "cut")!.clipAnchors).toEqual({ y: { x: 0.0285, y: 0.1 } });
    // Else the row's visible centre: the cover's box spans the row, though it paints
    // (a clip-path) only above it.
    const cover = el({
      rect: { x: 0, y: 0, w: 300, h: H },
      painted: { x: 0, y: 0, w: 300, h: 950 },
      style: { position: "fixed" },
    });
    const covered = run([pane([cutRow({ x: 1, y: 950, w: 285, h: 50 })], PANE), cover]).tree;
    expect(findById(covered, "cut")!.clipAnchors).toEqual({ y: { x: 0.143, y: 0.975 } });
    // Where no wheel is seen to reach one, the cut window's centre across the row.
    const fallback = { y: { x: 0.143, y: 0.5 } };
    // The row scrolls itself, so a wheel on it moves the row's content instead.
    const own = el({
      attrs: { id: "cut" },
      rect: { x: 1, y: 950, w: 285, h: 100 },
      client: { left: 0, top: 0, width: 285, height: 100 },
      scrollSize: { width: 285, height: 400 },
      style: { overflow: "auto" },
      painted: { x: 1, y: 950, w: 285, h: 50 },
    });
    const self = run([pane([own], { x: 0, y: 940, w: 300, h: 60 })]).tree;
    expect(findById(self, "cut")!.clipAnchors).toEqual(fallback);
    const unseen = run([pane([cutRow()])]).tree;
    expect(pxFrame(unseen, "cut", "clipBounds")).toEqual({ x: 0, y: 0, w: W, h: H });
    expect(findById(unseen, "cut")!.clipAnchors).toEqual(fallback);
  });

  it("anchors a cut in a strip beside the box every grid point lands on", () => {
    const LIST = { x: 0, y: 0, w: 300, h: 200 };
    const list = (kids: MockElement[]) =>
      scroller(kids, {
        rect: LIST,
        client: { left: 0, top: 0, width: 300, height: 200 },
        offset: { width: 300, height: 200 },
        scrollSize: { width: 300, height: 600 },
        painted: LIST,
      });
    // A carousel keeping the wheel fills the list but for a header strip above it, both
    // in a content container.
    const header = el({
      rect: { x: 0, y: 0, w: 300, h: 10 },
      painted: { x: 0, y: 0, w: 300, h: 10 },
    });
    const carousel = el({
      attrs: { id: "cut" },
      rect: { x: 0, y: 10, w: 300, h: 400 },
      client: { left: 0, top: 0, width: 300, height: 400 },
      offset: { width: 300, height: 400 },
      scrollSize: { width: 300, height: 400 },
      style: { overflowX: "hidden", overflowY: "auto", overscrollBehaviorY: "contain" },
      painted: { x: 0, y: 10, w: 300, h: 190 },
    });
    const content = el({ rect: { x: 0, y: 0, w: 300, h: 410 }, children: [header, carousel] });
    expect(findById(run([list([content])]).tree, "cut")!.clipAnchors).toEqual({
      y: { x: 0.15, y: 0.001 },
    });
    // A fixed overlay, its content inset in it, leaves a strip of the list at its right.
    const row = el({
      attrs: { id: "cut" },
      rect: { x: 0, y: 150, w: 300, h: 100 },
      painted: { x: 0, y: 150, w: 300, h: 50 },
    });
    const OVERLAY = { x: 0, y: 0, w: 290, h: 200 };
    const INSET = { x: 4, y: 4, w: 282, h: 192 };
    const overlay = el({
      rect: OVERLAY,
      painted: OVERLAY,
      style: { position: "fixed" },
      children: [el({ attrs: { id: "sheet" }, rect: INSET, painted: INSET })],
    });
    expect(findById(run([list([row]), overlay]).tree, "cut")!.clipAnchors).toEqual({
      y: { x: 0.295, y: 0.02 },
    });
  });

  it("keeps a strip's probe point where elementsFromPoint and a pixel-snapped wheel agree", () => {
    const thin = (LIST: Rect, COVER: Rect, row: Rect) => {
      const list = scroller([el({ attrs: { id: "cut" }, rect: row })], {
        rect: LIST,
        client: { left: 0, top: 0, width: LIST.w, height: LIST.h },
        offset: { width: LIST.w, height: LIST.h },
        scrollSize: { width: LIST.w, height: 3 * LIST.h },
        painted: LIST,
      });
      const cover = el({ rect: COVER, painted: COVER, style: { position: "fixed" } });
      return (
        findById(run([list, cover]).tree, "cut")!.clipAnchors as { y: { x: number; y: number } }
      ).y;
    };
    // A cover leaves 1.6px of the list above it: half a pixel past the strip's start.
    const near = thin(
      { x: 0, y: 50.7, w: 300, h: 949.3 },
      { x: 0, y: 52.3, w: 300, h: 947.7 },
      { x: 0, y: 950, w: 300, h: 100 }
    );
    expect(near.x).toBe(0.15);
    expect(near.y * H).toBeCloseTo(51.2, 9);
    // Below it: a pixel short of the strip's end.
    const far = thin(
      { x: 0, y: 0, w: 300, h: 949.3 },
      { x: 0, y: 0, w: 300, h: 947.7 },
      { x: 0, y: 900, w: 300, h: 100 }
    );
    expect(far.y * H).toBeCloseTo(948.3, 9);
    // A strip under a pixel is not probed: the cut window's centre across the row.
    const sliver = thin(
      { x: 0, y: 0, w: 300, h: 949.3 },
      { x: 0, y: 0, w: 300, h: 948.5 },
      { x: 0, y: 900, w: 300, h: 100 }
    );
    expect(sliver.x).toBe(0.15);
    expect(sliver.y * H).toBeCloseTo(949.3 / 2, 9);
  });

  describe("refining a cutter's window past the grid", () => {
    const LIST = { x: 0, y: 0, w: 300, h: 200 };
    // A list whose row is hidden under the boxes, so only a strip's probe can anchor it.
    const list = (kids: MockElement[] = [], painted: Rect | null = LIST) =>
      scroller([el({ attrs: { id: "cut" }, rect: { x: 0, y: 150, w: 300, h: 100 } }), ...kids], {
        rect: LIST,
        client: { left: 0, top: 0, width: 300, height: 200 },
        offset: { width: 300, height: 200 },
        scrollSize: { width: 300, height: 600 },
        painted: painted ?? undefined,
      });
    const fixed = (x: number, y: number, w: number, h: number, opts: Opts = {}) =>
      el({ rect: { x, y, w, h }, painted: { x, y, w, h }, ...opts, style: { position: "fixed" } });
    const anchorOf = (nodes: MockElement[]) => findById(run(nodes).tree, "cut")!.clipAnchors;
    // The cut window's centre across the row.
    const FALLBACK = { y: { x: 0.15, y: 0.1 } };

    it("refines for three rounds past the grid, and no more", () => {
      // Each round's strip is covered but for a strip beside it.
      const rings = [fixed(0, 10, 300, 190), fixed(0, 0, 280, 10), fixed(285, 0, 15, 10)];
      expect(anchorOf([list(), ...rings])).toEqual({ y: { x: 0.2825, y: 0.001 } });
      expect(anchorOf([list(), ...rings, fixed(280, 0, 3, 10)])).toEqual(FALLBACK);
    });

    it("spends at most 24 probes past the grid, and refines every part a box leaves", () => {
      // The grid lands on three boxes, leaving three strips; each round covers every
      // strip but for a part beside it, and the last part open is the 24th probe's.
      const boxes = [
        fixed(0, 10, 300, 85),
        fixed(0, 95, 280, 10),
        fixed(0, 105, 300, 85),
        fixed(0, 0, 280, 10),
        fixed(285, 95, 15, 10),
        fixed(0, 190, 280, 10),
        fixed(285, 0, 15, 10),
        fixed(280, 95, 5, 10),
        fixed(285, 190, 15, 10),
        fixed(280, 0, 5, 10),
        fixed(280, 193, 5, 7),
      ];
      expect(anchorOf([list(), ...boxes])).toEqual({ y: { x: 0.2825, y: 0.191 } });
      expect(anchorOf([list(), ...boxes, fixed(280, 190, 5, 3)])).toEqual(FALLBACK);
    });

    it("probes each point once across the cuts under one cutter", () => {
      const probes: string[] = [];
      const hitTest = MockDocument.prototype.elementsFromPoint;
      MockDocument.prototype.elementsFromPoint = function (x, y) {
        probes.push(x + "," + y);
        return hitTest.call(this, x, y);
      };
      try {
        const second = el({ attrs: { id: "cut2" }, rect: { x: 0, y: 160, w: 300, h: 100 } });
        run([list([second]), fixed(0, 0, 300, 200)]);
      } finally {
        MockDocument.prototype.elementsFromPoint = hitTest;
      }
      expect(probes.length).toBeGreaterThan(9);
      expect(new Set(probes).size).toBe(probes.length);
    });

    it("refines only the parts where a probe landed on a box", () => {
      // The grid lands on a cover leaving a strip either side. The left strip's probes
      // land on nothing; the right one's on a box spanning both strips' tops, which
      // would leave a part of the left strip whose probe reaches the list.
      const span = el({
        rect: { x: 0, y: 0, w: 300, h: 100 },
        painted: { x: 280, y: 0, w: 20, h: 100 },
        style: { position: "fixed" },
      });
      const bit = el({
        rect: { x: 5, y: 105, w: 10, h: 10 },
        painted: { x: 5, y: 105, w: 10, h: 10 },
      });
      expect(anchorOf([list([bit], null), fixed(20, 0, 260, 200), span])).toEqual(FALLBACK);
    });

    it("probes each axis apart at a point", () => {
      // A list scrolling both ways cuts the card on both axes. Over its top, a carousel
      // keeps a vertical wheel (overscroll-behavior-y) but passes a horizontal one on.
      const carousel = el({
        rect: { x: 0, y: 0, w: 300, h: 170 },
        client: { left: 0, top: 0, width: 300, height: 170 },
        offset: { width: 300, height: 170 },
        scrollSize: { width: 900, height: 170 },
        style: { overflowX: "hidden", overflowY: "auto", overscrollBehaviorY: "contain" },
        painted: { x: 0, y: 0, w: 300, h: 170 },
      });
      const card = el({
        attrs: { id: "cut" },
        rect: { x: 250, y: 180, w: 100, h: 100 },
        painted: { x: 250, y: 180, w: 50, h: 20 },
      });
      const both = scroller(
        [el({ rect: { x: 0, y: 0, w: 700, h: 700 }, painted: LIST, children: [carousel, card] })],
        {
          rect: LIST,
          client: { left: 0, top: 0, width: 300, height: 200 },
          offset: { width: 300, height: 200 },
          scrollSize: { width: 700, height: 700 },
          painted: LIST,
        }
      );
      expect(anchorOf([both])).toEqual({ x: { x: 0.03, y: 0.02 }, y: { x: 0.03, y: 0.18 } });
    });

    it("carves each side of a box the grid lands on", () => {
      expect(anchorOf([list(), fixed(10, 0, 290, 200)])).toEqual({ y: { x: 0.005, y: 0.02 } });
      expect(anchorOf([list(), fixed(0, 0, 300, 190)])).toEqual({ y: { x: 0.15, y: 0.199 } });
    });

    it("carves the box of what the wheel lands on, short of what it scrolls elsewhere", () => {
      const STRIP = { y: { x: 0.295, y: 0.02 } };
      // A frame keeps the wheel.
      const FRAME = { x: 0, y: 0, w: 290, h: 200 };
      const frame = el({ tag: "iframe", rect: FRAME, painted: FRAME });
      expect(anchorOf([list(), frame])).toEqual(STRIP);
      // A panel scrolling on its own, in a wrapper that hit-tests through (pointer-events:
      // none) over the whole list: the box stops at the panel.
      const panel = el({
        rect: { x: 0, y: 0, w: 290, h: 200 },
        client: { left: 0, top: 0, width: 290, height: 200 },
        offset: { width: 290, height: 200 },
        scrollSize: { width: 290, height: 600 },
        style: { overflow: "auto" },
        painted: { x: 0, y: 0, w: 290, h: 200 },
      });
      const wrapper = el({ rect: LIST, style: { position: "fixed" }, children: [panel] });
      expect(anchorOf([list(), wrapper])).toEqual(STRIP);
      // A box overflowing its small parent: the parent's box does not hold the point.
      const spill = el({
        rect: { x: 0, y: 0, w: 290, h: 200 },
        painted: { x: 0, y: 0, w: 290, h: 200 },
        style: { position: "absolute" },
      });
      expect(
        anchorOf([list(), fixed(0, 0, 10, 10, { painted: undefined, children: [spill] })])
      ).toEqual(STRIP);
    });
  });

  it("anchors a horizontal cut farthest from the element along x", () => {
    const strip = { x: 0, y: 400, w: W, h: 200 };
    const { tree } = run([
      scroller([el({ attrs: { id: "card" }, rect: { x: 950, y: 400, w: 200, h: 50 } })], {
        rect: strip,
        client: { left: 0, top: 0, width: W, height: 200 },
        offset: { width: W, height: 200 },
        scrollSize: { width: 3 * W, height: 200 },
        painted: strip,
      }),
    ]);
    expect(findById(tree, "card")!.clipAnchors).toEqual({ x: { x: 0.1, y: 0.42 } });
  });

  it("anchors a cut by a scroller in an open shadow tree, which the document hit-tests as its host", () => {
    const area = { x: 0, y: 0, w: 300, h: 100 };
    const { tree } = run([
      el({
        tag: "x-content",
        rect: area,
        painted: area,
        shadow: [scroller([row("cut", { x: 1, y: 81, w: 285, h: 40 })], { painted: area })],
      }),
    ]);
    expect(findById(tree, "cut")!.clipAnchors).toEqual({ y: { x: 0.0295, y: 0.0108 } });
  });

  it("anchors through a cross-axis scroller unless its overscroll-behavior keeps the wheel", () => {
    // A horizontal carousel over the top of a vertical list that cuts the row.
    const list = (overscroll: string, carousel: Opts = {}) =>
      el({
        rect: { x: 0, y: 0, w: 300, h: 200 },
        client: { left: 0, top: 0, width: 300, height: 200 },
        offset: { width: 300, height: 200 },
        scrollSize: { width: 300, height: 600 },
        style: { overflow: "auto" },
        painted: { x: 0, y: 0, w: 300, h: 200 },
        children: [
          el({
            rect: { x: 0, y: 0, w: 300, h: 180 },
            client: { left: 0, top: 0, width: 300, height: 180 },
            offset: { width: 300, height: 180 },
            scrollSize: { width: 600, height: 180 },
            style: { overflow: "auto", overscrollBehaviorY: overscroll },
            painted: { x: 0, y: 0, w: 300, h: 180 },
            ...carousel,
          }),
          el({
            attrs: { id: "cut" },
            rect: { x: 0, y: 180, w: 300, h: 60 },
            painted: { x: 0, y: 180, w: 300, h: 20 },
          }),
        ],
      });
    const anchorFor = (overscroll: string, carousel?: Opts) =>
      findById(run([list(overscroll, carousel)]).tree, "cut")!.clipAnchors;
    expect(anchorFor("auto")).toEqual({ y: { x: 0.03, y: 0.02 } });
    expect(anchorFor("contain")).toEqual({ y: { x: 0.03, y: 0.18 } });
    expect(anchorFor("none")).toEqual({ y: { x: 0.03, y: 0.18 } });
    // A scroll container that scrolls along neither axis keeps the wheel just the same.
    const still = (overflowX: string) => ({
      scrollSize: { width: 300, height: 180 },
      style: { overflowX, overflowY: "auto", overscrollBehaviorY: "contain" },
    });
    expect(anchorFor("contain", still("hidden"))).toEqual({ y: { x: 0.03, y: 0.18 } });
    expect(anchorFor("contain", still("auto"))).toEqual({ y: { x: 0.03, y: 0.18 } });
    // overflow: clip makes no scroll container.
    const clipped = { style: { overflow: "clip", overscrollBehaviorY: "contain" } };
    expect(anchorFor("contain", clipped)).toEqual({ y: { x: 0.03, y: 0.02 } });
  });

  it("anchors no point whose wheel scrolls a scroller holding the cutter", () => {
    // An overlay in the outer pane covers the list's upper part: a wheel there
    // scrolls the pane, carrying the list and the row together.
    const list = el({
      rect: { x: 0, y: 0, w: 300, h: 200 },
      client: { left: 0, top: 0, width: 300, height: 200 },
      offset: { width: 300, height: 200 },
      scrollSize: { width: 300, height: 600 },
      style: { overflow: "auto" },
      painted: { x: 0, y: 0, w: 300, h: 200 },
      children: [
        el({
          attrs: { id: "cut" },
          rect: { x: 0, y: 180, w: 300, h: 60 },
          painted: { x: 0, y: 180, w: 300, h: 20 },
        }),
      ],
    });
    const overlay = el({
      rect: { x: 0, y: 0, w: 300, h: 150 },
      painted: { x: 0, y: 0, w: 300, h: 150 },
    });
    const pane = el({
      rect: { x: 0, y: 0, w: 400, h: H },
      client: { left: 0, top: 0, width: 400, height: H },
      offset: { width: 400, height: H },
      scrollSize: { width: 400, height: 3 * H },
      style: { overflow: "auto" },
      painted: { x: 0, y: 0, w: 400, h: H },
      children: [list, overlay],
    });
    expect(findById(run([pane]).tree, "cut")!.clipAnchors).toEqual({ y: { x: 0.03, y: 0.18 } });
  });

  it("falls back to the cut window's centre along x for a horizontal cut no wheel is seen to reach", () => {
    const strip = { x: 0, y: 400, w: W, h: 200 };
    const { tree } = run([
      scroller([el({ attrs: { id: "card" }, rect: { x: 950, y: 400, w: 200, h: 50 } })], {
        rect: strip,
        client: { left: 0, top: 0, width: W, height: 200 },
        offset: { width: W, height: 200 },
        scrollSize: { width: 3 * W, height: 200 },
      }),
    ]);
    expect(findById(tree, "card")!.clipAnchors).toEqual({ x: { x: 0.5, y: 0.425 } });
  });

  it("keeps a fallback anchor on screen for a cutter that runs past either side of it", () => {
    // Carousels hanging 300px off the left and the right edge, each cutting its card.
    const carousel = (x: number, card: Rect) =>
      scroller([el({ attrs: { id: "card" }, rect: card })], {
        rect: { x, y: 400, w: 400, h: 100 },
        client: { left: 0, top: 0, width: 400, height: 100 },
        offset: { width: 400, height: 100 },
        scrollSize: { width: 1200, height: 100 },
      });
    const anchorOf = (c: MockElement) => findById(run([c]).tree, "card")!.clipAnchors;
    expect(anchorOf(carousel(-300, { x: 50, y: 400, w: 200, h: 50 }))).toEqual({
      x: { x: 0.05, y: 0.425 },
    });
    expect(anchorOf(carousel(900, { x: 850, y: 400, w: 200, h: 50 }))).toEqual({
      x: { x: 0.95, y: 0.425 },
    });
    // And lists hanging off the top and the bottom edge.
    const list = (y: number, card: Rect) =>
      scroller([el({ attrs: { id: "card" }, rect: card })], {
        rect: { x: 0, y, w: 300, h: 400 },
        client: { left: 0, top: 0, width: 300, height: 400 },
        offset: { width: 300, height: 400 },
        scrollSize: { width: 300, height: 1200 },
      });
    expect(anchorOf(list(-300, { x: 0, y: 50, w: 300, h: 200 }))).toEqual({
      y: { x: 0.15, y: 0.05 },
    });
    expect(anchorOf(list(900, { x: 0, y: 850, w: 300, h: 200 }))).toEqual({
      y: { x: 0.15, y: 0.95 },
    });
  });

  it("tries only on-screen points of a cutter whose window runs past the viewport", () => {
    // The pane starts 1000px above the screen and cuts the row at the screen's bottom.
    const tall = { x: 0, y: -H, w: 300, h: 2 * H };
    const { tree } = run([
      scroller([el({ attrs: { id: "cut" }, rect: { x: 1, y: 950, w: 285, h: 100 } })], {
        rect: tall,
        client: { left: 0, top: 0, width: 300, height: 2 * H },
        offset: { width: 300, height: 2 * H },
        scrollSize: { width: 300, height: 4 * H },
        painted: tall,
      }),
    ]);
    expect(findById(tree, "cut")!.clipAnchors).toEqual({ y: { x: 0.03, y: 0.1 } });
  });

  it("reports clipBounds for a box-less element by what it spans under its scrollers", () => {
    const contents = (id: string, children: MockElement[], text?: string) =>
      el({
        tag: "a",
        attrs: { id, href: "#" },
        rect: ZERO,
        style: { display: "contents" },
        text,
        content: text ? { x: 1, y: 85, w: 200, h: 20 } : undefined,
        children,
      });
    const { tree } = run([
      scroller([
        contents("kid", [el({ rect: { x: 1, y: -19, w: 285, h: 40 } })]),
        contents("text", [], "text"),
      ]),
    ]);
    const window = { x: 0, y: 1, w: 1000, h: 98 };
    expect(pxFrame(tree, "kid")).toEqual({ x: 1, y: 1, w: 285, h: 20 });
    expect(pxFrame(tree, "kid", "clipBounds")).toEqual(window);
    expect(findById(tree, "kid")!.clipAnchors!).toHaveProperty("y");
    expect(pxFrame(tree, "text", "clipBounds")).toEqual(window);
    // An absolute child takes the outer scroller's clips, so the inner one does not cut it.
    const escaping = run([
      scroller(
        [
          scroller(
            [
              contents("abs", [
                el({ rect: { x: 1, y: 10, w: 200, h: 20 } }),
                el({ rect: { x: 1, y: 60, w: 200, h: 20 }, style: { position: "absolute" } }),
              ]),
            ],
            {
              attrs: { id: "inner" },
              rect: { x: 0, y: 0, w: 300, h: 50 },
              client: { left: 1, top: 1, width: 285, height: 48 },
              offset: { width: 300, height: 50 },
            }
          ),
        ],
        {
          rect: { x: 0, y: 0, w: 300, h: 200 },
          client: { left: 1, top: 1, width: 285, height: 198 },
          offset: { width: 300, height: 200 },
          style: { position: "relative" },
        }
      ),
    ]).tree;
    expect(findById(escaping, "abs")!.clipBounds).toBeUndefined();
  });

  it.each([
    { edge: "top", cutter: { x: 10, y: -19, w: 100, h: 40 }, axis: "y" },
    { edge: "bottom", cutter: { x: 10, y: 80, w: 100, h: 40 }, axis: "y" },
    { edge: "left", cutter: { x: -40, y: 30, w: 100, h: 20 }, axis: "x" },
    { edge: "right", cutter: { x: 250, y: 30, w: 100, h: 20 }, axis: "x" },
  ])("cuts a box-less element whose first or second child crosses the $edge edge", (c) => {
    const inside = { x: 10, y: 30, w: 100, h: 20 };
    const item = (rects: Rect[]) =>
      findById(
        run([
          scroller(
            [
              el({
                tag: "li",
                attrs: { id: "item" },
                rect: ZERO,
                style: { display: "contents" },
                children: rects.map((rect, i) => row(`r${i}`, rect)),
              }),
            ],
            { scrollSize: { width: 600, height: 400 } }
          ),
        ]).tree,
        "item"
      )!;
    const window =
      c.axis === "y"
        ? { x: 0, y: 0.001, width: 1, height: 0.098 }
        : { x: 0.001, y: 0, width: 0.285, height: 1 };
    for (const rects of [
      [c.cutter, inside],
      [inside, c.cutter],
    ]) {
      const cut = item(rects);
      expect(cut.clipBounds).toEqual(window);
      expect(Object.keys(cut.clipAnchors as object)).toEqual([c.axis]);
    }
    expect(item([inside, inside]).clipBounds).toBeUndefined();
  });

  it("reports clipBounds only where a scroll container cuts by more than a pixel", () => {
    const tree = (
      style: Record<string, string>,
      rect: Rect,
      scrollSize = { width: 400, height: 400 }
    ) => run([scroller([row("r", rect)], { style, scrollSize })]).tree;
    const PART = { x: 1, y: 81, w: 285, h: 40 };
    // A scroller with no overflow along an axis has nothing to scroll there.
    expect(
      findById(tree({}, { x: -40, y: 1, w: 100, h: 20 }, { width: 285, height: 400 }), "r")!
        .clipBounds
    ).toBeUndefined();
    expect(findById(tree({}, PART, { width: 400, height: 98 }), "r")!.clipBounds).toBeUndefined();
    // overflow: hidden or clip and paint containment cut for good: no gesture uncuts them.
    const fixedClips: Record<string, string>[] = [
      { overflow: "hidden" },
      { overflow: "clip" },
      { overflow: "visible", contain: "paint" },
    ];
    for (const style of fixedClips) {
      const t = tree(style, PART);
      expect(pxFrame(t, "r").h, JSON.stringify(style)).toBe(18);
      expect(findById(t, "r")!.clipBounds, JSON.stringify(style)).toBeUndefined();
    }
    // A pixel or less is the rounding of the integer client size.
    expect(findById(tree({}, { x: 1, y: 59.5, w: 285, h: 40 }), "r")!.clipBounds).toBeUndefined();
    expect(pxFrame(tree({}, { x: 1, y: 60.5, w: 285, h: 40 }), "r", "clipBounds")).toEqual({
      x: 0,
      y: 1,
      w: 1000,
      h: 98,
    });
    expect(findById(tree({}, { x: 1, y: 1, w: 285.5, h: 20 }), "r")!.clipBounds).toBeUndefined();
    expect(pxFrame(tree({}, { x: 1, y: 1, w: 286.5, h: 20 }), "r", "clipBounds")).toEqual({
      x: 1,
      y: 0,
      w: 285,
      h: 1000,
    });
    expect(findById(tree({}, { x: 1, y: 0.5, w: 285, h: 20 }), "r")!.clipBounds).toBeUndefined();
    expect(findById(tree({}, { x: 0.5, y: 1, w: 285, h: 20 }), "r")!.clipBounds).toBeUndefined();
    expect(pxFrame(tree({}, { x: 1, y: -2, w: 285, h: 20 }), "r", "clipBounds")).toEqual({
      x: 0,
      y: 1,
      w: 1000,
      h: 98,
    });
    expect(pxFrame(tree({}, { x: -2, y: 1, w: 285, h: 20 }), "r", "clipBounds")).toEqual({
      x: 1,
      y: 0,
      w: 285,
      h: 1000,
    });
    // Either edge of either axis, and overflow: scroll as well as auto.
    const window = { x: 0, y: 1, w: 1000, h: 98 };
    expect(pxFrame(tree({}, { x: 1, y: -19, w: 285, h: 40 }), "r", "clipBounds")).toEqual(window);
    expect(pxFrame(tree({ overflow: "scroll" }, PART), "r", "clipBounds")).toEqual(window);
    expect(pxFrame(tree({}, { x: -40, y: 1, w: 100, h: 20 }), "r", "clipBounds")).toEqual({
      x: 1,
      y: 0,
      w: 285,
      h: 1000,
    });
    // Each axis by its own overflow.
    const mixed = { overflowX: "hidden", overflowY: "auto" };
    expect(findById(tree(mixed, { x: 1, y: 1, w: 400, h: 20 }), "r")!.clipBounds).toBeUndefined();
    expect(findById(tree(mixed, { x: -40, y: 1, w: 100, h: 20 }), "r")!.clipBounds).toBeUndefined();
    const across = { overflowX: "scroll", overflowY: "hidden" };
    expect(
      findById(tree(across, { x: 1, y: -19, w: 285, h: 40 }), "r")!.clipBounds
    ).toBeUndefined();
    expect(pxFrame(tree(across, { x: -40, y: 1, w: 100, h: 20 }), "r", "clipBounds")).toEqual({
      x: 1,
      y: 0,
      w: 285,
      h: 1000,
    });
    expect(pxFrame(tree(mixed, { x: 1, y: 81, w: 400, h: 40 }), "r", "clipBounds")).toEqual({
      x: 0,
      y: 1,
      w: 1000,
      h: 98,
    });
  });

  it("reports the window the scroll containers cutting the element leave, not one holding it", () => {
    // The inner list's window runs 50-150; the outer one's stops at 99.
    const nested = (rect: Rect) =>
      run([
        scroller([
          el({
            rect: { x: 1, y: 50, w: 200, h: 100 },
            client: { left: 0, top: 0, width: 200, height: 100 },
            offset: { width: 200, height: 100 },
            scrollSize: { width: 200, height: 400 },
            style: { overflow: "auto" },
            children: [row("r", rect)],
          }),
        ]),
      ]).tree;
    expect(pxFrame(nested({ x: 1, y: 40, w: 200, h: 130 }), "r", "clipBounds")).toEqual({
      x: 0,
      y: 50,
      w: 1000,
      h: 49,
    });
    expect(pxFrame(nested({ x: 1, y: 80, w: 200, h: 40 }), "r", "clipBounds")).toEqual({
      x: 0,
      y: 1,
      w: 1000,
      h: 98,
    });
    // Cut by the inner list alone: only the part of its window above the outer's edge.
    expect(pxFrame(nested({ x: 1, y: 30, w: 200, h: 40 }), "r", "clipBounds")).toEqual({
      x: 0,
      y: 50,
      w: 1000,
      h: 49,
    });
    // Across: a carousel whose window runs 150-350 in a list clipping at 286.
    const carousel = run([
      scroller([
        el({
          rect: { x: 150, y: 5, w: 200, h: 90 },
          client: { left: 0, top: 0, width: 200, height: 90 },
          offset: { width: 200, height: 90 },
          scrollSize: { width: 800, height: 90 },
          style: { overflow: "auto" },
          children: [row("r", { x: 130, y: 10, w: 50, h: 40 })],
        }),
      ]),
    ]).tree;
    expect(pxFrame(carousel, "r", "clipBounds")).toEqual({ x: 150, y: 0, w: 136, h: 1000 });
    // An inner window that starts before the outer's (at 50, the outer's at 101) shows
    // only from the outer's edge.
    const shifted = (outer: Opts, inner: Rect, scrollSize: Opts["scrollSize"], rect: Rect) =>
      run([
        scroller(
          [
            el({
              rect: inner,
              client: { left: 0, top: 0, width: inner.w, height: inner.h },
              offset: { width: inner.w, height: inner.h },
              scrollSize,
              style: { overflow: "auto" },
              children: [row("r", rect)],
            }),
          ],
          outer
        ),
      ]).tree;
    const below = shifted(
      { rect: { x: 0, y: 100, w: 300, h: 100 } },
      { x: 1, y: 50, w: 200, h: 100 },
      { width: 200, height: 400 },
      { x: 1, y: 130, w: 200, h: 40 }
    );
    expect(pxFrame(below, "r", "clipBounds")).toEqual({ x: 0, y: 101, w: 1000, h: 49 });
    const right = shifted(
      { rect: { x: 100, y: 0, w: 300, h: 100 }, scrollSize: { width: 285, height: 98 } },
      { x: 50, y: 5, w: 200, h: 90 },
      { width: 800, height: 90 },
      { x: 230, y: 10, w: 50, h: 40 }
    );
    expect(pxFrame(right, "r", "clipBounds")).toEqual({ x: 101, y: 0, w: 149, h: 1000 });
  });

  it("reports the scroll container's window, not a fixed clip's inside it", () => {
    const card = (rect: Rect, child: MockElement) =>
      el({
        rect,
        client: { left: 0, top: 0, width: rect.w, height: rect.h },
        offset: { width: rect.w, height: rect.h },
        style: { overflow: "hidden" },
        children: [child],
      });
    const scrolled = run([
      scroller([card({ x: 1, y: 50, w: 285, h: 100 }, row("r", { x: 1, y: 80, w: 285, h: 30 }))]),
    ]).tree;
    expect(pxFrame(scrolled, "r", "clipBounds")).toEqual({ x: 0, y: 1, w: 1000, h: 98 });
    const carded = run([
      scroller([card({ x: 1, y: 10, w: 285, h: 50 }, row("r", { x: 1, y: 40, w: 285, h: 40 }))]),
    ]).tree;
    expect(pxFrame(carded, "r").h).toBe(20);
    expect(findById(carded, "r")!.clipBounds).toBeUndefined();
  });

  it("clips by the padding box, so a row under the scrollbar is cut there", () => {
    const { tree } = run([
      scroller([row("wide", { x: 1, y: 1, w: 400, h: 20 })], {
        scrollSize: { width: 400, height: 400 },
      }),
    ]);
    expect(pxFrame(tree, "wide")).toEqual({ x: 1, y: 1, w: 285, h: 20 });
    expect(pxFrame(tree, "wide", "clipBounds")).toEqual({ x: 1, y: 0, w: 285, h: 1000 });
  });

  it("intersects nested clips", () => {
    const { tree } = run([
      scroller([
        el({
          attrs: { id: "inner" },
          rect: { x: 1, y: 50, w: 200, h: 100 },
          client: { left: 0, top: 0, width: 200, height: 100 },
          style: { overflow: "auto" },
          children: [
            row("inner-in", { x: 1, y: 60, w: 200, h: 20 }),
            row("inner-out", { x: 1, y: 110, w: 200, h: 20 }),
          ],
        }),
      ]),
    ]);
    expect(pxFrame(tree, "inner")).toEqual({ x: 1, y: 50, w: 200, h: 49 });
    expect(pxFrame(tree, "inner-in")).toEqual({ x: 1, y: 60, w: 200, h: 20 });
    // Inside the inner scroller's box, but below the outer one's clip edge.
    expect(pxFrame(tree, "inner-out").h).toBe(0);
  });

  it("cuts a row scrolled past the top edge there", () => {
    const { tree } = run([scroller([row("above", { x: 1, y: -30, w: 285, h: 40 })])]);
    expect(pxFrame(tree, "above")).toEqual({ x: 1, y: 1, w: 285, h: 9 });
  });

  it("scales each axis of the padding box by the clipper's own scale", () => {
    // Rendered at 2x by 0.5x: the padding box spans x 2..572, y 0.5..49.5.
    const { tree } = run([
      scroller(
        [row("upper", { x: 2, y: 0, w: 100, h: 10 }), row("lower", { x: 2, y: 40, w: 600, h: 20 })],
        {
          rect: { x: 0, y: 0, w: 600, h: 50 },
          client: { left: 1, top: 1, width: 285, height: 98 },
          offset: { width: 300, height: 100 },
          style: { overflow: "hidden", transform: "matrix(2, 0, 0, 0.5, 0, 0)" },
        }
      ),
    ]);
    expect(pxFrame(tree, "upper")).toEqual({ x: 2, y: 0.5, w: 100, h: 9.5 });
    expect(pxFrame(tree, "lower")).toEqual({ x: 2, y: 40, w: 570, h: 9.5 });
  });

  it("clips shadow-root content by its host's clip", () => {
    const { tree } = run([
      scroller([], {
        shadow: [
          row("shadow-in", { x: 1, y: 1, w: 285, h: 40 }),
          row("shadow-out", { x: 1, y: 121, w: 285, h: 40 }),
        ],
      }),
    ]);
    expect(pxFrame(tree, "shadow-in")).toEqual({ x: 1, y: 1, w: 285, h: 40 });
    expect(pxFrame(tree, "shadow-out").h).toBe(0);
  });

  // A host in a 300x100 overflow:hidden card whose shadow root wraps a <slot> in
  // `wrapper`; `light` is assigned to that slot.
  const slotted = (wrapper: Opts, light: MockElement[]) => {
    const slot = el({ tag: "slot", rect: ZERO, style: { display: "contents" } });
    for (const n of light) (n as Record<string, unknown>).assignedSlot = slot;
    const shadowWrapper = el({ ...wrapper, children: [slot] });
    (slot as Record<string, unknown>).parentNode = shadowWrapper;
    return run([
      scroller(
        [
          el({
            tag: "x-host",
            rect: { x: 1, y: 1, w: 285, h: 20 },
            children: light,
            shadow: [shadowWrapper],
          }),
        ],
        { style: { overflow: "hidden" } }
      ),
    ]).tree;
  };

  it("clips slotted content where its slot sits: escaping with a fixed wrapper", () => {
    const tree = slotted({ rect: { x: 10, y: 500, w: 80, h: 20 }, style: { position: "fixed" } }, [
      row("slotted", { x: 10, y: 500, w: 80, h: 20 }),
    ]);
    expect(pxFrame(tree, "slotted")).toEqual({ x: 10, y: 500, w: 80, h: 20 });
  });

  it("clips slotted content where its slot sits: inside a shadow scroller", () => {
    const tree = slotted(
      {
        rect: { x: 1, y: 1, w: 200, h: 50 },
        client: { left: 0, top: 0, width: 200, height: 50 },
        style: { overflow: "auto" },
      },
      [
        row("slot-in", { x: 1, y: 1, w: 200, h: 40 }),
        row("slot-out", { x: 1, y: 61, w: 200, h: 40 }),
      ]
    );
    expect(pxFrame(tree, "slot-in")).toEqual({ x: 1, y: 1, w: 200, h: 40 });
    expect(pxFrame(tree, "slot-out").h).toBe(0);
  });

  it("keeps slotted content whose slot lies past the depth cap under its host's clips", () => {
    let deep = el({ tag: "slot", rect: ZERO, style: { display: "contents" } });
    const slot = deep;
    for (let i = 0; i < 70; i++) {
      const parent = el({ rect: { x: 1, y: 1, w: 285, h: 20 }, children: [deep] });
      (deep as Record<string, unknown>).parentNode = parent;
      deep = parent;
    }
    const kept = row("kept", { x: 1, y: 1, w: 200, h: 20 });
    const cut = row("cut", { x: 1, y: 150, w: 200, h: 20 });
    for (const n of [kept, cut]) (n as Record<string, unknown>).assignedSlot = slot;
    const { tree } = run([
      scroller(
        [
          el({
            tag: "x-host",
            rect: { x: 1, y: 1, w: 285, h: 20 },
            children: [kept, cut],
            shadow: [deep],
          }),
        ],
        { style: { overflow: "hidden" } }
      ),
    ]);
    expect(pxFrame(tree, "kept")).toEqual({ x: 1, y: 1, w: 200, h: 20 });
    expect(pxFrame(tree, "cut").h).toBe(0);
  });

  it("drops slotted content whose slot is pruned", () => {
    const tree = slotted({ rect: { x: 1, y: 1, w: 200, h: 50 }, style: { opacity: "0" } }, [
      row("unpainted", { x: 1, y: 1, w: 200, h: 40 }),
    ]);
    expect(findById(tree, "unpainted")).toBeNull();
  });

  it("frames content a closed shadow root paints outside its host's clip", () => {
    // A custom element without an open shadow root: its light child either paints
    // where a closed root's slot sits (here a fixed popup) or in the host itself.
    const card = (painted?: Rect) =>
      run([
        scroller(
          [
            el({
              tag: "x-pop",
              rect: { x: 1, y: 1, w: 285, h: 20 },
              children: [
                el({ attrs: { id: "popped" }, rect: { x: 400, y: 400, w: 120, h: 40 }, painted }),
              ],
            }),
          ],
          { style: { overflow: "hidden" } }
        ),
      ]).tree;
    const box = { x: 400, y: 400, w: 120, h: 40 };
    expect(pxFrame(card(box), "popped")).toEqual(box);
    expect(pxFrame(card(), "popped").h).toBe(0);
  });

  it.each([
    ...[
      "article",
      "aside",
      "blockquote",
      "body",
      "div",
      "footer",
      "h1",
      "h3",
      "h6",
      "header",
      "main",
      "nav",
      "p",
      "section",
      "span",
    ].map((tag) => ({ tag, svg: false, framed: true })),
    // Unlisted names, some holding a listed one.
    ...["ul", "pre", "picture", "template", "caption", "h7", "hgroup"].map((tag) => ({
      tag,
      svg: false,
      framed: false,
    })),
    { tag: "font-face", svg: true, framed: false },
  ])("frames a <$tag> (svg: $svg) host's light child by where it hit-tests: $framed", (c) => {
    // attachShadow accepts custom elements and a fixed list of HTML elements, nothing in
    // SVG among them; a closed root on one slots the child into a fixed popup.
    const box = { x: 400, y: 400, w: 120, h: 40 };
    const { tree } = run([
      scroller(
        [
          el({
            tag: c.tag,
            svg: c.svg,
            rect: { x: 1, y: 1, w: 285, h: 20 },
            children: [el({ attrs: { id: "popped" }, rect: box, painted: box })],
          }),
        ],
        { style: { overflow: "hidden" } }
      ),
    ]);
    expect(pxFrame(tree, "popped").h).toBe(c.framed ? 40 : 0);
  });

  it("reads a clipper's style once however many light children of a custom element it holds", () => {
    const reads = (step: number, top = 1) => {
      const rows = Array.from({ length: 20 }, (_, i) =>
        row(`r${i}`, { x: 1, y: top + i * step, w: 285, h: step })
      );
      const list = el({
        tag: "app-list",
        rect: { x: 1, y: top, w: 285, h: 20 * step },
        children: rows,
      });
      const sc = scroller([list]) as MockElement & Record<string, unknown>;
      const style = sc.__style;
      let n = 0;
      Object.defineProperty(sc, "__style", { get: () => (n++, style) });
      run([sc]);
      return n;
    };
    // Once for its own walk, once for the clips its overflowing rows' hit tests cross.
    expect(reads(8)).toBe(2);
    // Rows within the clip, or out of view, have no point outside it to hit-test.
    expect(reads(4)).toBe(1);
    expect(reads(8, H)).toBe(1);
  });

  it("reads each ancestor's style a bounded number of times however many hit tests list it", () => {
    // Full-viewport wrappers, which every point probed past the scroller hits.
    const reads = (rowCount: number) => {
      const rows = Array.from({ length: rowCount }, (_, i) =>
        row(`r${i}`, { x: 1, y: 101 + i * 8, w: 285, h: 8 })
      );
      let n = 0;
      let inner: MockElement = scroller(rows);
      for (let i = 0; i < 20; i++) {
        inner = el({
          rect: { x: 0, y: 0, w: W, h: H },
          painted: { x: 0, y: 0, w: W, h: H },
          children: [inner],
        });
        const counted = inner as MockElement & Record<string, unknown>;
        const style = counted.__style;
        Object.defineProperty(counted, "__style", { get: () => (n++, style) });
      }
      const { tree } = run([inner]);
      for (let i = 0; i < rowCount; i++) expect(pxFrame(tree, `r${i}`).h).toBe(0);
      return n;
    };
    // Twice per wrapper: its own walk, and the clips the rows' hit tests cross.
    expect(reads(1)).toBe(40);
    expect(reads(30)).toBe(40);
  });

  it("clips a custom element's light child that hit-tests only across its clipper's border", () => {
    // A 12px-bordered clipper: the row overflows its padding box (y 12..112) to 127,
    // and Chrome hit-tests the overflow up to the border box's bottom (124).
    const host = () =>
      el({
        tag: "app-row",
        rect: ZERO,
        style: { display: "contents" },
        children: [
          el({
            attrs: { id: "row" },
            rect: { x: 12, y: 62, w: 300, h: 65 },
            painted: { x: 12, y: 62, w: 300, h: 62 },
          }),
        ],
      });
    const bordered = { x: 0, y: 0, w: 324, h: 124 };
    const padding = { left: 12, top: 12, width: 300, height: 100 };
    const scrolled = run([
      scroller([host()], {
        rect: bordered,
        client: padding,
        offset: { width: 324, height: 124 },
        scrollSize: { width: 300, height: 400 },
      }),
    ]).tree;
    expect(pxFrame(scrolled, "row")).toEqual({ x: 12, y: 62, w: 300, h: 50 });
    expect(findById(scrolled, "row")!.clipBounds).toBeDefined();
    const contained = run([
      el({ rect: bordered, client: padding, style: { contain: "paint" }, children: [host()] }),
    ]).tree;
    expect(pxFrame(contained, "row")).toEqual({ x: 12, y: 62, w: 300, h: 50 });
  });

  it.each([
    {
      edge: "left",
      rect: { x: 97, y: 120, w: 65, h: 40 },
      painted: { x: 100, y: 120, w: 62, h: 40 },
      clipped: { x: 112, y: 120, w: 50, h: 40 },
    },
    {
      edge: "top",
      rect: { x: 120, y: 97, w: 40, h: 65 },
      painted: { x: 120, y: 100, w: 40, h: 62 },
      clipped: { x: 120, y: 112, w: 40, h: 50 },
    },
    {
      edge: "right",
      rect: { x: 362, y: 120, w: 65, h: 40 },
      painted: { x: 362, y: 120, w: 62, h: 40 },
      clipped: { x: 362, y: 120, w: 50, h: 40 },
    },
    {
      edge: "bottom",
      rect: { x: 120, y: 162, w: 40, h: 65 },
      painted: { x: 120, y: 162, w: 40, h: 62 },
      clipped: { x: 120, y: 162, w: 40, h: 50 },
    },
  ])("clips a light child that hit-tests across its clipper's $edge border", (c) => {
    // A 12px border around the padding box x 112..412, y 112..212.
    const { tree } = run([
      el({
        rect: { x: 100, y: 100, w: 324, h: 124 },
        client: { left: 12, top: 12, width: 300, height: 100 },
        style: { contain: "paint" },
        children: [
          el({
            tag: "app-row",
            rect: ZERO,
            style: { display: "contents" },
            children: [el({ attrs: { id: "row" }, rect: c.rect, painted: c.painted })],
          }),
        ],
      }),
    ]);
    expect(pxFrame(tree, "row")).toEqual(c.clipped);
  });

  it.each([
    { edge: "left", rect: { x: 20, y: 120, w: 60, h: 40 } },
    { edge: "top", rect: { x: 120, y: 20, w: 40, h: 60 } },
    { edge: "right", rect: { x: 450, y: 120, w: 60, h: 40 } },
    { edge: "bottom", rect: { x: 120, y: 250, w: 40, h: 60 } },
  ])("frames a light child a closed root paints past only its clipper's $edge edge", (c) => {
    // The clipper's border box is x 100..424, y 100..224.
    const { tree } = run([
      el({
        rect: { x: 100, y: 100, w: 324, h: 124 },
        client: { left: 12, top: 12, width: 300, height: 100 },
        style: { contain: "paint" },
        children: [
          el({
            tag: "app-row",
            rect: ZERO,
            style: { display: "contents" },
            children: [el({ attrs: { id: "row" }, rect: c.rect, painted: c.rect })],
          }),
        ],
      }),
    ]);
    expect(pxFrame(tree, "row")).toEqual(c.rect);
  });

  it("clips rows in an open shadow root that hit-test only across their scroller's border", () => {
    // The host scrolls with a 4px border: its padding box is y 4..124, its border box
    // y 0..128, and Chrome hit-tests the rows scrolled past the padding box up to the
    // border box. The rows sit in a plain <div>, which could host a closed root.
    const rows = [
      el({
        attrs: { id: "s1" },
        rect: { x: 4, y: -24, w: 285, h: 51 },
        painted: { x: 4, y: 0, w: 285, h: 27 },
      }),
      el({
        attrs: { id: "s3" },
        rect: { x: 4, y: 78, w: 285, h: 51 },
        painted: { x: 4, y: 78, w: 285, h: 50 },
      }),
    ];
    const { tree } = run([
      el({
        tag: "x-list",
        rect: { x: 0, y: 0, w: 308, h: 128 },
        client: { left: 4, top: 4, width: 285, height: 120 },
        offset: { width: 308, height: 128 },
        scrollSize: { width: 285, height: 153 },
        style: { overflow: "auto" },
        shadow: [el({ rect: { x: 4, y: -24, w: 285, h: 153 }, children: rows })],
      }),
    ]);
    expect(pxFrame(tree, "s1")).toEqual({ x: 4, y: 4, w: 285, h: 23 });
    expect(pxFrame(tree, "s3")).toEqual({ x: 4, y: 78, w: 285, h: 46 });
    for (const id of ["s1", "s3"]) {
      expect(findById(tree, id)!.clipBounds).toBeDefined();
      expect(findById(tree, id)!.clipAnchors).toBeDefined();
    }
  });

  it("clips a list that an open shadow tree's fixed popup, or a child slotted into it, overlaps", () => {
    // Chrome hits the popup below the scroller, at y 150..210, as its host, and a light
    // child slotted into it as that child; neither is the list's own painting.
    const box = { x: 100, y: 150, w: 150, h: 60 };
    const page = (slotted: boolean) => {
      const item = el({ attrs: { id: "item" }, rect: box, painted: box });
      const slot = el({ tag: "slot", rect: ZERO, style: { display: "contents" } });
      const menu = el({
        rect: box,
        painted: slotted ? undefined : box,
        style: { position: "fixed" },
        children: [slot],
      });
      const dd = el({
        tag: "x-dd",
        rect: { x: 1, y: 60, w: 285, h: 20 },
        shadow: [menu],
        children: slotted ? [item] : [],
      });
      if (slotted) (item as unknown as Record<string, unknown>).assignedSlot = slot;
      return run([
        scroller([
          el({
            attrs: { id: "list" },
            rect: { x: 1, y: 1, w: 285, h: 280 },
            children: [dd, row("hidden", { x: 1, y: 200, w: 100, h: 30 })],
          }),
        ]),
      ]).tree;
    };
    for (const slotted of [false, true]) {
      const tree = page(slotted);
      expect(pxFrame(tree, "list")).toEqual({ x: 1, y: 1, w: 285, h: 98 });
      expect(pxFrame(tree, "hidden").h).toBe(0);
    }
    expect(pxFrame(page(true), "item")).toEqual(box);
  });

  it("clips a list whose two open shadow trees' fixed popups overlap outside it", () => {
    // Each shadow root lists the other's host for its popup, as the document does.
    const box = { x: 100, y: 150, w: 150, h: 60 };
    const dd = () =>
      el({
        tag: "x-dd",
        rect: { x: 1, y: 60, w: 285, h: 20 },
        shadow: [el({ rect: box, painted: box, style: { position: "fixed" } })],
      });
    const { tree } = run([
      scroller([
        el({
          attrs: { id: "list" },
          rect: { x: 1, y: 1, w: 285, h: 280 },
          children: [dd(), dd(), row("hidden", { x: 1, y: 200, w: 100, h: 30 })],
        }),
      ]),
    ]);
    expect(pxFrame(tree, "list")).toEqual({ x: 1, y: 1, w: 285, h: 98 });
    expect(pxFrame(tree, "hidden").h).toBe(0);
  });

  it("frames a closed root's slotted open-shadow host by where its own box hit-tests", () => {
    // Its shadow tree paints only a corner of it, away from the point the walker probes.
    const box = { x: 400, y: 400, w: 200, h: 60 };
    const corner = { x: 400, y: 400, w: 30, h: 20 };
    const { tree } = run([
      scroller(
        [
          el({
            rect: { x: 1, y: 1, w: 285, h: 20 },
            children: [
              el({
                tag: "x-btn",
                attrs: { id: "popped" },
                rect: box,
                painted: box,
                shadow: [el({ tag: "button", rect: corner, painted: corner })],
              }),
            ],
          }),
        ],
        { style: { overflow: "hidden" } }
      ),
    ]);
    expect(pxFrame(tree, "popped")).toEqual(box);
  });

  it("frames closed-root popup content by where its descendants or a shadow tree hit-test", () => {
    const box = { x: 400, y: 400, w: 120, h: 40 };
    const popup = (child: MockElement) =>
      scroller([el({ tag: "x-pop", rect: { x: 1, y: 1, w: 285, h: 20 }, children: [child] })], {
        style: { overflow: "hidden" },
      });
    // A wrapper that hit-testing skips (pointer-events: none) around a button it hits.
    const wrapped = run([
      popup(
        el({
          rect: box,
          children: [el({ attrs: { id: "inner" }, rect: box, painted: box })],
        })
      ),
    ]).tree;
    expect(pxFrame(wrapped, "inner")).toEqual(box);
    // A <ul> cannot host a shadow root, so only its hit item shows where it paints.
    const listed = run([
      popup(
        el({
          tag: "ul",
          attrs: { id: "list" },
          rect: box,
          children: [el({ tag: "li", rect: box, children: [el({ rect: box, painted: box })] })],
        })
      ),
    ]).tree;
    expect(pxFrame(listed, "list")).toEqual(box);
    // The popup's host inside another component's open shadow tree.
    const nested = run([
      el({
        tag: "x-app",
        rect: { x: 0, y: 0, w: 300, h: 100 },
        shadow: [popup(el({ attrs: { id: "nested" }, rect: box, painted: box }))],
      }),
    ]).tree;
    expect(pxFrame(nested, "nested")).toEqual(box);
    // A fixed descendant paints by its own containing block, not by the child's slot.
    const bar = { x: 1, y: 120, w: 285, h: 60 };
    const nav = el({ rect: bar, painted: bar, style: { position: "fixed" } });
    const feed = el({
      attrs: { id: "feed" },
      rect: { x: 1, y: 1, w: 285, h: 200 },
      children: [nav],
    });
    (nav as unknown as Record<string, unknown>).parentNode = feed;
    const fixed = run([popup(feed)]).tree;
    expect(pxFrame(fixed, "feed")).toEqual({ x: 1, y: 1, w: 285, h: 98 });
    (nav as unknown as Record<string, unknown>).__style = { position: "absolute" };
    expect(pxFrame(run([popup(feed)]).tree, "feed")).toEqual({ x: 1, y: 1, w: 285, h: 98 });
  });

  it("keeps clipping a custom element's child the page hit-tests only within a pixel of the clip", () => {
    // The real clip edge is up to a pixel past the one integer client sizes give
    // (x 286), so Chrome hits the list there; its overflowing row is clipped.
    const list = { x: 1, y: 1, w: 285.5, h: 98 };
    const { tree } = run([
      scroller([
        el({
          tag: "x-list",
          rect: list,
          children: [
            el({
              rect: list,
              painted: list,
              children: [row("hidden", { x: 1, y: 200, w: 285, h: 40 })],
            }),
          ],
        }),
      ]),
    ]);
    expect(pxFrame(tree, "hidden").h).toBe(0);
  });

  it("clips an absolute box only when the clipper is its containing block or inside it", () => {
    const below = { x: 10, y: 150, w: 80, h: 20 };
    const card = (clipperStyle: Record<string, string>, between: MockElement[] = []) =>
      run([
        el({
          style: { position: "relative" },
          rect: { x: 0, y: 0, w: 400, h: 400 },
          children: [
            scroller(between.length ? between : [row("abs", below, { position: "absolute" })], {
              style: { overflow: "hidden", ...clipperStyle },
            }),
          ],
        }),
      ]).tree;
    // Containing block is the outer relative div: escapes the clip (a popover).
    expect(pxFrame(card({}), "abs")).toEqual({ x: 10, y: 150, w: 80, h: 20 });
    // The clipper itself is positioned, so it contains and clips the box.
    expect(pxFrame(card({ position: "relative" }), "abs").h).toBe(0);
    expect(pxFrame(card({ position: "sticky" }), "abs").h).toBe(0);
    // A positioned wrapper inside the clipper contains it, so the clip applies.
    const wrapped = card({}, [
      el({
        style: { position: "relative" },
        rect: { x: 1, y: 1, w: 285, h: 20 },
        children: [row("abs", below, { position: "absolute" })],
      }),
    ]);
    expect(pxFrame(wrapped, "abs").h).toBe(0);
  });

  it("lets a fixed box escape every clip unless a clipping ancestor contains it", () => {
    const fixed = () => row("fixed", { x: 10, y: 500, w: 80, h: 20 }, { position: "fixed" });
    const escaped = run([scroller([fixed()], { style: { overflow: "hidden" } })]).tree;
    expect(pxFrame(escaped, "fixed")).toEqual({ x: 10, y: 500, w: 80, h: 20 });
    const containingBlocks: Record<string, string>[] = [
      { transform: "matrix(1, 0, 0, 1, 0, 0)" },
      { translate: "1px" },
      { rotate: "1deg" },
      { scale: "1.5" },
      { perspective: "100px" },
      { filter: "blur(1px)" },
      { backdropFilter: "blur(1px)" },
      { contain: "layout" },
      { contentVisibility: "auto" },
      { transformStyle: "preserve-3d" },
      { willChange: "transform" },
      { willChange: "translate" },
      { willChange: "rotate" },
      { willChange: "scale" },
      { willChange: "perspective" },
      { willChange: "contain" },
      { willChange: "filter" },
      { willChange: "backdrop-filter" },
      { willChange: "transform-style" },
      // Computed will-change keeps the author's case and the -webkit- aliases.
      { willChange: "TRANSFORM" },
      { willChange: "-webkit-transform" },
      { willChange: "Backdrop-Filter" },
    ];
    for (const style of containingBlocks) {
      const contained = run([scroller([fixed()], { style: { overflow: "hidden", ...style } })]);
      expect(pxFrame(contained.tree, "fixed").h, JSON.stringify(style)).toBe(0);
    }
    const hinted = (willChange: string) =>
      pxFrame(
        run([scroller([fixed()], { style: { overflow: "hidden", willChange } })]).tree,
        "fixed"
      );
    expect(hinted("opacity, contain").h).toBe(0);
    for (const willChange of ["contain-intrinsic-size", "transform-origin", "perspective-origin"]) {
      expect(hinted(willChange), willChange).toEqual({ x: 10, y: 500, w: 80, h: 20 });
    }
  });

  it("ignores transforms on inline boxes and containment on them and on table rows", () => {
    const fixedFrame = (style: Record<string, string>) =>
      pxFrame(
        run([
          scroller(
            [
              el({
                rect: { x: 1, y: 1, w: 50, h: 20 },
                style,
                children: [row("fixed", { x: 10, y: 500, w: 80, h: 20 }, { position: "fixed" })],
              }),
            ],
            { style: { overflow: "hidden" } }
          ),
        ]).tree,
        "fixed"
      );
    const escapes: Record<string, string>[] = [
      ...["inline", "ruby", "ruby-text", "inline list-item"].flatMap(
        (display): Record<string, string>[] => [
          { display, transform: "matrix(1, 0, 0, 1, 0, 0)" },
          { display, willChange: "transform" },
          { display, contain: "paint" },
        ]
      ),
      { display: "table-row", contain: "layout" },
    ];
    for (const style of escapes) {
      expect(fixedFrame(style), JSON.stringify(style)).toEqual({ x: 10, y: 500, w: 80, h: 20 });
    }
    const contained: Record<string, string>[] = [
      { display: "inline", filter: "blur(1px)" },
      { display: "table-row", transform: "matrix(1, 0, 0, 1, 0, 0)" },
    ];
    for (const style of contained) {
      expect(fixedFrame(style).h, JSON.stringify(style)).toBe(0);
    }
  });

  it("lets a top-layer box and its content escape a clip that contains fixed boxes", () => {
    for (const [topLayer, position] of [
      [":modal", "fixed"],
      [":popover-open", "fixed"],
      [":popover-open", "absolute"],
      [":fullscreen", "fixed"],
    ]) {
      const { tree } = run([
        scroller(
          [
            el({
              topLayer,
              attrs: { id: "dialog" },
              rect: { x: 400, y: 400, w: 200, h: 100 },
              style: { position },
              children: [row("confirm", { x: 420, y: 420, w: 80, h: 20 })],
            }),
          ],
          { style: { overflow: "hidden", transform: "matrix(1, 0, 0, 1, 0, 0)" } }
        ),
      ]);
      expect(pxFrame(tree, "dialog"), topLayer).toEqual({ x: 400, y: 400, w: 200, h: 100 });
      expect(pxFrame(tree, "confirm"), topLayer).toEqual({ x: 420, y: 420, w: 80, h: 20 });
    }
  });

  it("lets an open select's picker content escape its clips, but not its leading <button>", () => {
    const BELOW = (y: number) => ({ x: 1, y, w: 80, h: 20 });
    const select = (open: boolean, children: MockElement[]) =>
      el({
        tag: "select",
        topLayer: open ? ":open" : undefined,
        rect: { x: 1, y: 60, w: 80, h: 25 },
        style: { display: "inline-block" },
        children,
      });
    const btn = (id: string, y: number) => el({ tag: "button", attrs: { id }, rect: BELOW(y) });
    const opt = (id: string, y: number) => el({ tag: "option", attrs: { id }, rect: BELOW(y) });
    const { tree } = run([
      scroller([
        select(true, [btn("lead", 150), opt("opt", 170), btn("late", 190)]),
        select(true, [opt("first", 210)]),
        select(false, [opt("closed", 230)]),
        el({ tag: "details", topLayer: ":open", children: [opt("disclosed", 250)] }),
      ]),
    ]);
    expect(pxFrame(tree, "lead").h).toBe(0);
    expect(pxFrame(tree, "opt")).toEqual(BELOW(170));
    expect(pxFrame(tree, "late")).toEqual(BELOW(190));
    expect(pxFrame(tree, "first")).toEqual(BELOW(210));
    expect(pxFrame(tree, "closed").h).toBe(0);
    expect(pxFrame(tree, "disclosed").h).toBe(0);
  });

  it("extends an overflow: clip or contain: paint edge by overflow-clip-margin", () => {
    const BELOW = { x: 1, y: 100, w: 100, h: 40 };
    const margin = (style: Record<string, string>, opts: Opts = {}, near = BELOW) =>
      pxFrame(
        run([
          scroller([row("near", near)], {
            client: { left: 1, top: 1, width: 298, height: 98 },
            ...opts,
            style,
          }),
        ]).tree,
        "near"
      );
    // Padding box bottom 99, so the clip edge sits at 129; right 299, so 329.
    expect(margin({ overflow: "clip", overflowClipMargin: "30px" }).h).toBe(29);
    expect(
      margin({ overflow: "clip", overflowClipMargin: "30px" }, {}, { x: 290, y: 10, w: 60, h: 20 })
        .w
    ).toBe(39);
    expect(margin({ overflow: "visible", contain: "paint", overflowClipMargin: "30px" }).h).toBe(
      29
    );
    // From the content box (inset by 10px padding) or the border box (1px border).
    expect(
      margin({ overflow: "clip", overflowClipMargin: "content-box 30px", paddingBottom: "10px" }).h
    ).toBe(19);
    expect(
      margin({ overflow: "clip", overflowClipMargin: "border-box 30px", borderBottomWidth: "1px" })
        .h
    ).toBe(30);
    // Scaled with the clipper: at 2x the padding box ends at 48 and the clip at 108.
    expect(
      margin(
        { overflow: "clip", overflowClipMargin: "30px" },
        {
          rect: { x: 0, y: 0, w: 600, h: 50 },
          client: { left: 1, top: 1, width: 298, height: 23 },
          offset: { width: 300, height: 25 },
        }
      ).h
    ).toBe(8);
    // overflow: hidden ignores the margin, and so does a clip on one axis only.
    expect(margin({ overflow: "hidden", overflowClipMargin: "30px" }).h).toBe(0);
    expect(margin({ overflow: "hidden", contain: "paint", overflowClipMargin: "30px" }).h).toBe(0);
    expect(
      margin(
        { overflowX: "clip", overflowY: "visible", overflowClipMargin: "30px" },
        {},
        { x: 290, y: 10, w: 60, h: 20 }
      ).w
    ).toBe(9);
    // The left and top edges move out too: the padding box starts at 101, the clip at 71.
    expect(
      margin(
        { overflow: "clip", overflowClipMargin: "30px" },
        { rect: { x: 100, y: 100, w: 300, h: 100 }, offset: { width: 300, height: 100 } },
        { x: 60, y: 60, w: 20, h: 20 }
      )
    ).toEqual({ x: 71, y: 71, w: 9, h: 9 });
    // Each edge scales by its own axis: 1x across (clip at 70), 2x down (clip at 40).
    expect(
      margin(
        { overflow: "clip", overflowClipMargin: "30px" },
        {
          rect: { x: 100, y: 100, w: 300, h: 200 },
          client: { left: 0, top: 0, width: 300, height: 100 },
          offset: { width: 300, height: 100 },
        },
        { x: 60, y: 30, w: 20, h: 20 }
      )
    ).toEqual({ x: 70, y: 40, w: 10, h: 10 });
  });

  it("clips only the axes whose overflow is not visible", () => {
    const { tree } = run([
      scroller(
        [
          row("below", { x: 1, y: 150, w: 100, h: 20 }),
          row("right", { x: 400, y: 10, w: 50, h: 20 }),
        ],
        { style: { overflowX: "clip", overflowY: "visible" } }
      ),
    ]);
    expect(pxFrame(tree, "below")).toEqual({ x: 1, y: 150, w: 100, h: 20 });
    expect(pxFrame(tree, "right").w).toBe(0);
  });

  it("clips under paint containment with overflow visible", () => {
    const contained: Record<string, string>[] = [
      { contain: "paint" },
      { contain: "strict" },
      { contain: "content" },
      { contentVisibility: "auto" },
      { contentVisibility: "hidden" },
    ];
    for (const style of contained) {
      const { tree } = run([
        scroller(
          [
            row("out", { x: 1, y: 150, w: 100, h: 20 }),
            row("right", { x: 400, y: 10, w: 50, h: 20 }),
          ],
          { style: { overflow: "visible", ...style } }
        ),
      ]);
      expect(pxFrame(tree, "out").h, JSON.stringify(style)).toBe(0);
      expect(pxFrame(tree, "right").w, JSON.stringify(style)).toBe(0);
    }
  });

  it("ignores overflow where Chromium does not apply it", () => {
    for (const display of [
      "inline",
      "contents",
      "table-row",
      "table-row-group",
      "table-header-group",
      "table-footer-group",
    ]) {
      const { tree } = run([
        scroller([row("out", { x: 1, y: 150, w: 100, h: 20 })], {
          style: { overflow: "hidden", display },
        }),
      ]);
      expect(pxFrame(tree, "out"), display).toEqual({ x: 1, y: 150, w: 100, h: 20 });
    }
  });

  it("does not treat the body's overflow as a clip (it belongs to the viewport)", () => {
    const body = el({
      tag: "body",
      rect: { x: 0, y: 0, w: W, h: 50 },
      client: { left: 0, top: 0, width: W, height: 50 },
      style: { overflow: "hidden" },
    });
    const { tree } = run([row("far", { x: 0, y: 900, w: 100, h: 20 })], body);
    expect(pxFrame(tree, "far")).toEqual({ x: 0, y: 900, w: 100, h: 20 });
  });

  it("leaves an XHTML body's overflow to the viewport, its tagName being lowercase", () => {
    const body = el({
      tag: "body",
      rect: { x: 0, y: 0, w: W, h: 50 },
      client: { left: 0, top: 0, width: W, height: 50 },
      style: { overflow: "hidden" },
    }) as MockElement & Record<string, unknown>;
    body.tagName = "body";
    const { tree } = run([row("far", { x: 0, y: 900, w: 100, h: 20 })], body);
    expect(pxFrame(tree, "far")).toEqual({ x: 0, y: 900, w: 100, h: 20 });
  });

  it("treats the body's overflow as a clip once the root's overflow is set", () => {
    const body = el({
      tag: "body",
      rect: { x: 0, y: 0, w: W, h: 50 },
      client: { left: 0, top: 0, width: W, height: 50 },
      style: { overflow: "auto" },
    });
    const { tree } = run([row("far", { x: 0, y: 900, w: 100, h: 20 })], body, {
      overflow: "hidden",
    });
    expect(pxFrame(tree, "far").h).toBe(0);
  });

  it("treats the body's overflow as a clip once either axis of the root's overflow is set", () => {
    const rootStyles: Record<string, string>[] = [{ overflowX: "clip" }, { overflowY: "clip" }];
    for (const rootStyle of rootStyles) {
      const body = el({
        tag: "body",
        rect: { x: 0, y: 0, w: W, h: 50 },
        client: { left: 0, top: 0, width: W, height: 50 },
        style: { overflow: "hidden" },
      });
      const { tree } = run([row("far", { x: 0, y: 900, w: 100, h: 20 })], body, rootStyle);
      expect(pxFrame(tree, "far").h, JSON.stringify(rootStyle)).toBe(0);
    }
  });

  it("treats the body's overflow as a clip once the root or the body has containment", () => {
    const cases: [Record<string, string>, Record<string, string>][] = [
      [{ contain: "paint" }, {}],
      [{ contain: "layout" }, {}],
      [{ contain: "style" }, {}],
      [{}, { contain: "layout" }],
    ];
    for (const [bodyStyle, rootStyle] of cases) {
      const body = el({
        tag: "body",
        rect: { x: 0, y: 0, w: W, h: 50 },
        client: { left: 0, top: 0, width: W, height: 50 },
        style: { overflow: "hidden", ...bodyStyle },
      });
      const { tree } = run([row("far", { x: 0, y: 900, w: 100, h: 20 })], body, rootStyle);
      expect(pxFrame(tree, "far").h, JSON.stringify([bodyStyle, rootStyle])).toBe(0);
    }
  });

  it("clips by a quirks-mode body's own box, not the viewport-sized client box it reports", () => {
    const scrolling = el({
      tag: "body",
      rect: { x: 0, y: 0, w: W, h: 100 },
      client: { left: 0, top: 0, width: W, height: H },
      style: { overflow: "hidden", borderTopWidth: "10px", borderBottomWidth: "10px" },
    });
    const { tree } = run(
      [row("below", { x: 0, y: 300, w: 100, h: 20 }), row("edge", { x: 0, y: 5, w: 100, h: 90 })],
      scrolling,
      { overflow: "auto" },
      "BackCompat"
    );
    expect(pxFrame(tree, "below").h).toBe(0);
    expect(pxFrame(tree, "edge")).toEqual({ x: 0, y: 10, w: 100, h: 80 });
    // Scrolled 1500px into a 3000px body, whose client box reports the viewport.
    const clippers: Record<string, string>[] = [{ overflow: "clip" }, { contain: "paint" }];
    for (const style of clippers) {
      const body = el({
        tag: "body",
        rect: { x: 0, y: -1500, w: W, h: 3000 },
        client: { left: 0, top: 0, width: W, height: H },
        style,
      });
      const { tree } = run(
        [row("deep", { x: 0, y: 100, w: 100, h: 20 })],
        body,
        { overflowY: "scroll" },
        "BackCompat"
      );
      expect(pxFrame(tree, "deep"), JSON.stringify(style)).toEqual({ x: 0, y: 100, w: 100, h: 20 });
    }
  });

  it("does not clip a fieldset's rendered legend by the fieldset's overflow", () => {
    const legend = (id: string, y: number, style: Record<string, string> = {}) =>
      el({
        tag: "legend",
        attrs: { id },
        rect: { x: 20, y, w: 60, h: 10 },
        offset: { width: 60, height: 10 },
        style,
      });
    const rendered = legend("rendered", 3);
    (rendered as Record<string, unknown>).children = [
      row("pinned", { x: 20, y: 500, w: 60, h: 10 }, { position: "fixed" }),
    ];
    const { tree } = run([
      scroller(
        [
          el({
            tag: "fieldset",
            rect: { x: 0, y: 0, w: 300, h: 100 },
            client: { left: 16, top: 16, width: 268, height: 68 },
            offset: { width: 300, height: 100 },
            style: { overflow: "hidden", position: "relative" },
            children: [
              el({ tag: "input", attrs: { type: "hidden" }, style: { display: "none" } }),
              legend("floated", 2, { cssFloat: "left" }),
              legend("placed", 2, { position: "absolute" }),
              rendered,
              legend("second", 4),
              row("content", { x: 20, y: 5, w: 60, h: 10 }),
            ],
          }),
        ],
        { style: { overflow: "hidden" } }
      ),
    ]);
    expect(pxFrame(tree, "rendered")).toEqual({ x: 20, y: 3, w: 60, h: 10 });
    // A fixed box in the legend escapes the clips that do not contain it.
    expect(pxFrame(tree, "pinned")).toEqual({ x: 20, y: 500, w: 60, h: 10 });
    for (const id of ["floated", "placed", "second", "content"]) {
      expect(pxFrame(tree, id).h, id).toBe(0);
    }
  });

  it("takes the first legend in a fieldset's flat tree, through display:contents boxes, as rendered", () => {
    // Laid out over the fieldset's 2px border, as a rendered legend is.
    const legend = () =>
      el({
        tag: "legend",
        attrs: { id: "legend" },
        rect: { x: 20, y: 0, w: 60, h: 30 },
        offset: { width: 60, height: 30, left: 18, top: -2 },
      });
    const fieldset = (children: MockElement[]) =>
      el({
        tag: "fieldset",
        rect: { x: 0, y: 0, w: 300, h: 100 },
        client: { left: 2, top: 2, width: 296, height: 96 },
        offset: { width: 300, height: 100 },
        style: { overflow: "hidden", borderTopWidth: "2px" },
        children,
      });
    const contents = (opts: Opts) => el({ rect: ZERO, style: { display: "contents" }, ...opts });
    const slotted = (before: unknown[]) => {
      const light = [legend(), row("content", { x: 20, y: 20, w: 60, h: 40 })];
      const slot = el({ tag: "slot", rect: ZERO, style: { display: "contents" } });
      Object.setPrototypeOf(slot, MockHTMLSlotElement.prototype);
      (slot as Record<string, unknown>).__assigned = [...before, ...light];
      for (const n of light) (n as Record<string, unknown>).assignedSlot = slot;
      return el({ tag: "x-host", rect: ZERO, children: light, shadow: [fieldset([slot])] });
    };
    const fixtures: [string, () => MockElement][] = [
      ["slotted", () => slotted([])],
      // Chrome's getComputedStyle throws on the text node.
      ["slotted after text", () => slotted([{ nodeType: 3, nodeValue: "Some slotted text" }])],
      [
        "wrapped",
        () => {
          const lg = legend();
          const f = fieldset([
            contents({ children: [lg] }),
            row("content", { x: 20, y: 20, w: 60, h: 40 }),
          ]);
          (lg as Record<string, unknown>).__offsetParent = f;
          return f;
        },
      ],
      // A display:contents fieldset has no rendered legend of its own.
      [
        "in a display:contents fieldset",
        () =>
          fieldset([
            contents({ tag: "fieldset", children: [legend()] }),
            row("content", { x: 20, y: 20, w: 60, h: 40 }),
          ]),
      ],
      [
        "in a shadow tree",
        () =>
          fieldset([
            contents({ tag: "x-host", shadow: [legend()] }),
            row("content", { x: 20, y: 20, w: 60, h: 40 }),
          ]),
      ],
    ];
    for (const [why, page] of fixtures) {
      const { tree } = run([page()]);
      expect(pxFrame(tree, "legend"), why).toEqual({ x: 20, y: 0, w: 60, h: 30 });
      expect(pxFrame(tree, "content"), why).toEqual({ x: 20, y: 30, w: 60, h: 30 });
    }
  });

  it("takes a legend a closed root may slot as rendered only where layout put it over the border", () => {
    // A 300x100 fieldset with 2px borders, at offset (50, 100) in its offsetParent. A
    // rendered legend clips "content" to start past it; a flow legend leaves it whole.
    type Case = {
      why: string;
      wm?: string;
      fs?: Record<string, string>;
      at: { left: number; top: number };
      ls?: Record<string, string>;
      parent?: "fieldset" | "shared" | "other" | "none";
      rendered: boolean;
    };
    const legendRect: Record<string, Rect> = {
      "horizontal-tb": { x: 20, y: 0, w: 60, h: 30 },
      "vertical-rl": { x: 270, y: 20, w: 30, h: 60 },
      "vertical-lr": { x: 0, y: 20, w: 30, h: 60 },
    };
    const content: Record<string, [Rect, Rect]> = {
      "horizontal-tb": [
        { x: 20, y: 10, w: 60, h: 50 },
        { x: 20, y: 30, w: 60, h: 30 },
      ],
      "vertical-rl": [
        { x: 200, y: 20, w: 90, h: 40 },
        { x: 200, y: 20, w: 70, h: 40 },
      ],
      "vertical-lr": [
        { x: 10, y: 20, w: 90, h: 40 },
        { x: 30, y: 20, w: 70, h: 40 },
      ],
    };
    const rl = "vertical-rl";
    const lr = "vertical-lr";
    const cases: Case[] = [
      { why: "over the border", at: { left: 18, top: -2 }, rendered: true },
      { why: "at the padding edge", at: { left: 18, top: 0 }, rendered: false },
      {
        why: "in the padding",
        fs: { paddingTop: "4px" },
        at: { left: 18, top: 3 },
        rendered: true,
      },
      {
        why: "past the padding",
        fs: { paddingTop: "4px" },
        at: { left: 18, top: 4 },
        rendered: false,
      },
      {
        why: "moved down by a relative offset",
        ls: { position: "relative", top: "10px", left: "0px" },
        at: { left: 18, top: 8 },
        rendered: true,
      },
      { why: "beside the fieldset", parent: "shared", at: { left: 68, top: 100 }, rendered: true },
      { why: "inside it, beside", parent: "shared", at: { left: 68, top: 102 }, rendered: false },
      { why: "in another box", parent: "other", at: { left: 18, top: -2 }, rendered: false },
      // Neither the legend nor a fixed fieldset has an offsetParent.
      { why: "in no box", parent: "none", at: { left: 18, top: -2 }, rendered: false },
      { why: "rl over the border", wm: rl, at: { left: 268, top: 18 }, rendered: true },
      { why: "rl at the padding edge", wm: rl, at: { left: 266, top: 18 }, rendered: false },
      {
        why: "rl in the padding",
        wm: rl,
        fs: { paddingRight: "4px" },
        at: { left: 263, top: 18 },
        rendered: true,
      },
      { why: "lr over the border", wm: lr, at: { left: -2, top: 18 }, rendered: true },
      { why: "lr at the padding edge", wm: lr, at: { left: 0, top: 18 }, rendered: false },
      {
        why: "lr in the padding",
        wm: lr,
        fs: { paddingLeft: "4px" },
        at: { left: 3, top: 18 },
        rendered: true,
      },
      {
        why: "lr moved by a relative offset",
        wm: lr,
        ls: { position: "relative", top: "0px", left: "10px" },
        at: { left: 8, top: 18 },
        rendered: true,
      },
      {
        why: "lr beside the fieldset",
        wm: lr,
        parent: "shared",
        at: { left: 50, top: 118 },
        rendered: true,
      },
      {
        why: "lr inside it, beside",
        wm: lr,
        parent: "shared",
        at: { left: 52, top: 118 },
        rendered: false,
      },
    ];
    for (const c of cases) {
      const wm = c.wm ?? "horizontal-tb";
      const rect = legendRect[wm];
      const legend = el({
        tag: "legend",
        attrs: { id: "legend" },
        rect,
        offset: { width: rect.w, height: rect.h, ...c.at },
        style: c.ls,
      });
      const fieldset = el({
        tag: "fieldset",
        rect: { x: 0, y: 0, w: 300, h: 100 },
        client: { left: 2, top: 2, width: 296, height: 96 },
        offset: { width: 300, height: 100, left: 50, top: 100 },
        style: {
          overflow: "hidden",
          writingMode: wm,
          borderTopWidth: "2px",
          borderRightWidth: "2px",
          borderLeftWidth: "2px",
          ...c.fs,
        },
        // The <div> may host a closed root, which the walker cannot see.
        children: [
          el({ rect: ZERO, style: { display: "contents" }, children: [legend] }),
          row("content", content[wm][0]),
        ],
      });
      const shared = el();
      (fieldset as Record<string, unknown>).__offsetParent = c.parent === "none" ? null : shared;
      (legend as Record<string, unknown>).__offsetParent = {
        fieldset,
        shared,
        other: el(),
        none: null,
      }[c.parent ?? "fieldset"];
      const { tree } = run([fieldset]);
      expect(pxFrame(tree, "content"), c.why).toEqual(content[wm][c.rendered ? 1 : 0]);
    }
    // Still under a box that may host a closed root, past an open root.
    const legend = el({
      tag: "legend",
      attrs: { id: "legend" },
      rect: legendRect["horizontal-tb"],
      offset: { width: 60, height: 30, left: 18, top: 0 },
    });
    const fieldset = el({
      tag: "fieldset",
      rect: { x: 0, y: 0, w: 300, h: 100 },
      client: { left: 2, top: 2, width: 296, height: 96 },
      offset: { width: 300, height: 100 },
      style: { overflow: "hidden", borderTopWidth: "2px" },
      children: [
        el({
          rect: ZERO,
          style: { display: "contents" },
          children: [
            el({ tag: "x-host", rect: ZERO, style: { display: "contents" }, shadow: [legend] }),
          ],
        }),
        row("content", content["horizontal-tb"][0]),
      ],
    });
    (legend as Record<string, unknown>).__offsetParent = fieldset;
    expect(pxFrame(run([fieldset]).tree, "content")).toEqual(content["horizontal-tb"][0]);
  });

  it("clips a fieldset's content by overflow where its rendered legend's margin box ends", () => {
    // Each fieldset renders at 2x (a 150x120 layout box); "under" spans x 20..280, y 50..150.
    const pad = { left: 0, top: 0, width: 150, height: 120 };
    const sides = { marginLeft: "3px", marginRight: "5px" };
    // A relative offset moves where the legend paints (here 8 or 20px), not the clip edge.
    // The legend's layout box is half its rect.
    const shiftX = { ...sides, position: "relative", left: "4px" };
    const shiftY = { position: "relative", top: "10px", marginBottom: "6px" };
    const cases: [Record<string, string>, Rect, Record<string, string>, typeof pad, Rect][] = [
      [
        { overflow: "auto" },
        { x: 0, y: 20, w: 300, h: 80 },
        shiftY,
        pad,
        { x: 20, y: 92, w: 260, h: 58 },
      ],
      // A border wider than the legend keeps the padding box edge.
      [
        { overflow: "auto", borderTopWidth: "40px" },
        { x: 0, y: 0, w: 300, h: 40 },
        { marginBottom: "6px" },
        { ...pad, top: 40, height: 80 },
        { x: 20, y: 80, w: 260, h: 70 },
      ],
      // Paint containment clips at the padding box, legend or not.
      [
        { contain: "paint" },
        { x: 0, y: 0, w: 300, h: 80 },
        { marginBottom: "6px" },
        pad,
        { x: 20, y: 50, w: 260, h: 100 },
      ],
      // A vertical fieldset's legend sits at its block start: the right for -rl, the left for -lr.
      [
        { overflow: "auto", writingMode: "vertical-rl" },
        { x: 248, y: 0, w: 60, h: 240 },
        shiftX,
        pad,
        { x: 20, y: 50, w: 214, h: 100 },
      ],
      [
        { overflow: "auto", writingMode: "vertical-rl" },
        { x: 240, y: 0, w: 60, h: 240 },
        sides,
        { ...pad, width: 100 },
        { x: 20, y: 50, w: 180, h: 100 },
      ],
      [
        { overflow: "auto", writingMode: "sideways-lr" },
        { x: 8, y: 0, w: 60, h: 240 },
        shiftX,
        pad,
        { x: 70, y: 50, w: 210, h: 100 },
      ],
      [
        { overflow: "auto", writingMode: "sideways-lr" },
        { x: 0, y: 0, w: 60, h: 240 },
        sides,
        { ...pad, left: 50, width: 100 },
        { x: 100, y: 50, w: 180, h: 100 },
      ],
      [
        { contain: "paint", writingMode: "vertical-rl" },
        { x: 240, y: 0, w: 60, h: 240 },
        sides,
        pad,
        { x: 20, y: 50, w: 260, h: 100 },
      ],
    ];
    for (const [style, legendRect, legendStyle, client, want] of cases) {
      const { tree } = run([
        el({
          tag: "fieldset",
          rect: { x: 0, y: 0, w: 300, h: 240 },
          client,
          offset: { width: 150, height: 120 },
          style,
          children: [
            el({
              tag: "legend",
              rect: legendRect,
              offset: { width: legendRect.w / 2, height: legendRect.h / 2 },
              style: legendStyle,
            }),
            row("under", { x: 20, y: 50, w: 260, h: 100 }),
          ],
        }),
      ]);
      expect(pxFrame(tree, "under"), JSON.stringify([style, legendStyle, client])).toEqual(want);
    }
  });

  it("clips a fixed legend like the fieldset's other content: it is not the rendered legend", () => {
    const legend = (id: string, style: Record<string, string> = {}) =>
      el({
        tag: "legend",
        attrs: { id },
        rect: { x: 20, y: 3, w: 60, h: 10 },
        offset: { width: 60, height: 10 },
        style,
      });
    const { tree } = run([
      el({
        tag: "fieldset",
        rect: { x: 0, y: 0, w: 300, h: 100 },
        client: { left: 16, top: 16, width: 268, height: 68 },
        offset: { width: 300, height: 100 },
        style: { overflow: "hidden", transform: "matrix(1, 0, 0, 1, 0, 0)" },
        children: [legend("fixed", { position: "fixed" }), legend("rendered")],
      }),
    ]);
    expect(pxFrame(tree, "fixed").h).toBe(0);
    expect(pxFrame(tree, "rendered")).toEqual({ x: 20, y: 3, w: 60, h: 10 });
  });

  it("clips a fieldset's content where layout puts its legend, not where the legend paints", () => {
    // "under" spans x 5..295, y 5..235; each legend's layout margin box ends 40 from its side,
    // and it paints 30 further in.
    const legendAt = (
      writingMode: string,
      rect: Rect,
      legendStyle: Record<string, string>,
      border: Record<string, string> = {},
      client = { left: 0, top: 0, width: 300, height: 240 }
    ) =>
      pxFrame(
        run([
          el({
            tag: "fieldset",
            rect: { x: 0, y: 0, w: 300, h: 240 },
            client,
            offset: { width: 300, height: 240 },
            style: { overflow: "hidden", writingMode, ...border },
            children: [
              el({
                tag: "legend",
                rect,
                offset: { width: Math.min(rect.w, 40), height: Math.min(rect.h, 40) },
                style: legendStyle,
              }),
              row("under", { x: 5, y: 5, w: 290, h: 230 }),
            ],
          }),
        ]).tree,
        "under"
      );
    const top = { x: 0, y: 30, w: 300, h: 40 };
    const right = { x: 230, y: 0, w: 40, h: 240 };
    const left = { x: 30, y: 0, w: 40, h: 240 };
    for (const legendStyle of <Record<string, string>[]>[
      { position: "static", top: "30px", left: "30px" },
      { position: "relative", top: "30px", left: "-30px" },
      { position: "sticky", top: "70px", right: "70px", left: "70px" },
      { transform: "matrix(1, 0, 0, 1, 30, 30)" },
    ]) {
      const why = JSON.stringify(legendStyle);
      expect(legendAt("horizontal-tb", top, legendStyle), why).toEqual({
        x: 5,
        y: 40,
        w: 290,
        h: 195,
      });
      expect(legendAt("vertical-rl", right, legendStyle), why).toEqual({
        x: 5,
        y: 5,
        w: 255,
        h: 230,
      });
      expect(legendAt("vertical-lr", left, legendStyle), why).toEqual({
        x: 40,
        y: 5,
        w: 255,
        h: 230,
      });
    }
    // A border thicker than the legend centres it, so a margin can end past the border.
    const thick = (side: string) => ({ ["border" + side + "Width"]: "60px" });
    const margin = { marginBottom: "35px", marginLeft: "35px", marginRight: "35px" };
    const inside = (l: number, t: number) => ({ left: l, top: t, width: 240, height: 180 });
    expect(legendAt("horizontal-tb", top, margin, thick("Top"), inside(0, 60)).y).toBe(85);
    expect(legendAt("vertical-rl", right, margin, thick("Right"), inside(0, 0)).w).toBe(210);
    expect(legendAt("vertical-lr", left, margin, thick("Left"), inside(60, 0)).x).toBe(85);
  });

  it("scales a fieldset's legend margins along the axis each one lies on", () => {
    // Rendered 3x wide and 1x tall: a 100x240 layout box drawn 300x240.
    const clipped = (writingMode: string, rect: Rect) =>
      pxFrame(
        run([
          el({
            tag: "fieldset",
            rect: { x: 0, y: 0, w: 300, h: 240 },
            client: { left: 0, top: 0, width: 100, height: 240 },
            offset: { width: 100, height: 240 },
            style: { overflow: "hidden", writingMode },
            children: [
              el({
                tag: "legend",
                rect,
                offset: { width: rect.w / 3, height: rect.h },
                style: { marginBottom: "10px", marginLeft: "5px", marginRight: "7px" },
              }),
              row("under", { x: 5, y: 5, w: 290, h: 230 }),
            ],
          }),
        ]).tree,
        "under"
      );
    expect(clipped("horizontal-tb", { x: 0, y: 0, w: 300, h: 40 })).toEqual({
      x: 5,
      y: 50,
      w: 290,
      h: 185,
    });
    for (const wm of ["vertical-rl", "sideways-rl"]) {
      expect(clipped(wm, { x: 240, y: 0, w: 60, h: 240 }), wm).toEqual({
        x: 5,
        y: 5,
        w: 220,
        h: 230,
      });
    }
    for (const wm of ["vertical-lr", "sideways-lr"]) {
      expect(clipped(wm, { x: 0, y: 0, w: 60, h: 240 }), wm).toEqual({
        x: 81,
        y: 5,
        w: 214,
        h: 230,
      });
    }
  });

  it("takes as a fieldset's rendered legend only a <legend> that generates a box", () => {
    const fieldset = (children: MockElement[], tag = "fieldset") =>
      run([
        el({
          tag,
          rect: { x: 0, y: 0, w: 300, h: 240 },
          client: { left: 0, top: 0, width: 300, height: 240 },
          offset: { width: 300, height: 240 },
          style: { overflow: "hidden" },
          children: [...children, row("under", { x: 20, y: 50, w: 260, h: 100 })],
        }),
      ]).tree;
    const boxless = (display: string, children: MockElement[] = []) =>
      el({
        tag: "legend",
        rect: { x: 0, y: 0, w: 0, h: 0 },
        style: { display, marginBottom: "300px" },
        children,
      });
    const rendered = el({
      tag: "legend",
      rect: { x: 0, y: 0, w: 60, h: 80 },
      offset: { width: 60, height: 80 },
    });
    for (const display of ["none", "contents"]) {
      expect(pxFrame(fieldset([boxless(display)]), "under"), display).toEqual({
        x: 20,
        y: 50,
        w: 260,
        h: 100,
      });
      expect(pxFrame(fieldset([boxless(display), rendered]), "under"), display).toEqual({
        x: 20,
        y: 80,
        w: 260,
        h: 70,
      });
    }
    // A display:contents legend's content is the fieldset's content, which its overflow clips.
    const outside = row("outside", { x: 20, y: 250, w: 60, h: 10 });
    expect(pxFrame(fieldset([boxless("contents", [outside])]), "outside").h).toBe(0);
    // Only a <legend> child is a legend, and only a fieldset's.
    const box = (tag: string) =>
      el({ tag, rect: { x: 0, y: 0, w: 60, h: 80 }, offset: { width: 60, height: 80 } });
    const unclipped = { x: 20, y: 50, w: 260, h: 100 };
    expect(pxFrame(fieldset([box("div")]), "under")).toEqual(unclipped);
    expect(pxFrame(fieldset([box("legend")], "div"), "under")).toEqual(unclipped);
  });

  it("scales the padding box by the clipper's transform", () => {
    // Rendered at 2x: border box 600x200 on screen for a 300x100 layout box.
    const { tree } = run([
      scroller([row("lower", { x: 2, y: 150, w: 400, h: 40 })], {
        rect: { x: 0, y: 0, w: 600, h: 200 },
        client: { left: 1, top: 1, width: 298, height: 98 },
        offset: { width: 300, height: 100 },
        style: { overflow: "hidden", transform: "matrix(2, 0, 0, 2, 0, 0)" },
      }),
    ]);
    expect(pxFrame(tree, "lower")).toEqual({ x: 2, y: 150, w: 400, h: 40 });
  });

  it("reports a scroll container's content window as its clipFrame", () => {
    const { tree } = run([scroller([], { scrollSize: { width: 285, height: 400 } })]);
    const sc = findById(tree, "sc")!;
    expect(sc.scrollable).toBe(true);
    const f = sc.clipFrame as { x: number; y: number; width: number; height: number };
    expect([f.x, f.y, f.width, f.height].map((v) => Math.round(v * 1e6) / 1e3)).toEqual([
      1, 1, 285, 98,
    ]);
  });

  it("clips to an outer <svg>'s content box", () => {
    const { tree } = run([
      el({
        outerSvg: true,
        tag: "svg",
        rect: { x: 0, y: 0, w: 150, h: 90 },
        style: {
          display: "inline",
          overflow: "hidden",
          paddingLeft: "20px",
          paddingTop: "20px",
          paddingRight: "20px",
          paddingBottom: "20px",
          borderLeftWidth: "5px",
          borderTopWidth: "5px",
          borderRightWidth: "5px",
          borderBottomWidth: "5px",
        },
        children: [
          row("drawn", { x: 30, y: 30, w: 10, h: 10 }),
          row("padding", { x: 130, y: 30, w: 10, h: 10 }),
        ],
      }),
    ]);
    expect(pxFrame(tree, "drawn")).toEqual({ x: 30, y: 30, w: 10, h: 10 });
    expect(pxFrame(tree, "padding").w).toBe(0);
  });

  it("scales an outer <svg>'s content-box inset by its transform", () => {
    // Laid out 100x40 plus 25px of border and padding a side, rendered at 2x.
    const { tree } = run([
      el({
        outerSvg: true,
        tag: "svg",
        rect: { x: 0, y: 0, w: 300, h: 180 },
        style: {
          overflow: "hidden",
          width: "100px",
          height: "40px",
          paddingLeft: "20px",
          paddingTop: "20px",
          paddingRight: "20px",
          paddingBottom: "20px",
          borderLeftWidth: "5px",
          borderTopWidth: "5px",
          borderRightWidth: "5px",
          borderBottomWidth: "5px",
        },
        children: [row("edge", { x: 240, y: 60, w: 20, h: 10 })],
      }),
    ]);
    expect(pxFrame(tree, "edge")).toEqual({ x: 240, y: 60, w: 10, h: 10 });
  });

  it("scales an outer <svg>'s inset by its border-box size under box-sizing: border-box", () => {
    // Laid out 150x90 border box with 25px of border and padding a side, rendered at 2x.
    const { tree } = run([
      el({
        outerSvg: true,
        tag: "svg",
        rect: { x: 0, y: 0, w: 300, h: 180 },
        style: {
          overflow: "hidden",
          boxSizing: "border-box",
          width: "150px",
          height: "90px",
          paddingLeft: "20px",
          paddingTop: "20px",
          paddingRight: "20px",
          paddingBottom: "20px",
          borderLeftWidth: "5px",
          borderTopWidth: "5px",
          borderRightWidth: "5px",
          borderBottomWidth: "5px",
        },
        children: [row("edge", { x: 240, y: 60, w: 20, h: 10 })],
      }),
    ]);
    expect(pxFrame(tree, "edge")).toEqual({ x: 240, y: 60, w: 10, h: 10 });
  });

  it("measures an outer <svg>'s clip margin from its content box", () => {
    const { tree } = run([
      el({
        outerSvg: true,
        tag: "svg",
        rect: { x: 0, y: 0, w: 150, h: 90 },
        style: {
          overflow: "clip",
          overflowClipMargin: "content-box",
          width: "100px",
          height: "40px",
          paddingLeft: "20px",
          paddingTop: "20px",
          paddingRight: "20px",
          paddingBottom: "20px",
          borderLeftWidth: "5px",
          borderTopWidth: "5px",
          borderRightWidth: "5px",
          borderBottomWidth: "5px",
        },
        children: [row("edge", { x: 120, y: 30, w: 10, h: 10 })],
      }),
    ]);
    expect(pxFrame(tree, "edge")).toEqual({ x: 120, y: 30, w: 5, h: 10 });
  });

  it("clips to a <foreignObject>'s rect", () => {
    // SVG tag names keep their case.
    const fo = el({
      svg: true,
      tag: "foreignObject",
      rect: { x: 0, y: 0, w: 300, h: 100 },
      style: { display: "inline", overflow: "hidden" },
      children: [
        row("in", { x: 10, y: 10, w: 100, h: 20 }),
        row("out", { x: 10, y: 150, w: 100, h: 20 }),
        row("fixed", { x: 10, y: 200, w: 100, h: 20 }, { position: "fixed" }),
        row("abs", { x: 10, y: 260, w: 100, h: 20 }, { position: "absolute" }),
      ],
    });
    (fo as Record<string, unknown>).tagName = "foreignObject";
    const { tree } = run([fo]);
    expect(pxFrame(tree, "in")).toEqual({ x: 10, y: 10, w: 100, h: 20 });
    // It is the containing block of its positioned content too.
    for (const id of ["out", "fixed", "abs"]) expect(pxFrame(tree, id).h, id).toBe(0);
  });

  it("clips to a nested <svg>'s viewport, not its rect (the content's bbox)", () => {
    const { tree } = run([
      el({
        svg: true,
        tag: "svg",
        rect: { x: 0, y: 0, w: 300, h: 200 },
        style: { display: "inline", overflow: "hidden" },
        children: [
          el({
            tag: "svg",
            // The parent's screen CTM maps (x, y) to (2x + 0.5y + 5, 0.5x + y + 5), so the
            // viewport's corners span x 30..130, y 20..80.
            nestedSvg: {
              viewport: { x: 10, y: 10, w: 40, h: 40 },
              ctm: [2, 0.5, 0.5, 1, 5, 5],
            },
            rect: { x: 30, y: 20, w: 130, h: 80 },
            style: { display: "inline", overflow: "hidden" },
            children: [
              row("svin", { x: 30, y: 20, w: 20, h: 20 }),
              row("svedge", { x: 120, y: 70, w: 20, h: 20 }),
              row("svout", { x: 140, y: 20, w: 20, h: 20 }),
            ],
          }),
        ],
      }),
    ]);
    expect(pxFrame(tree, "svin")).toEqual({ x: 30, y: 20, w: 20, h: 20 });
    expect(pxFrame(tree, "svedge")).toEqual({ x: 120, y: 70, w: 10, h: 10 });
    expect(pxFrame(tree, "svout").w).toBe(0);
  });

  it("maps a non-square nested <svg> viewport by its own width and height", () => {
    const { tree } = run([
      el({
        svg: true,
        tag: "svg",
        rect: { x: 0, y: 0, w: 300, h: 200 },
        style: { display: "inline", overflow: "hidden" },
        children: [
          el({
            tag: "svg",
            nestedSvg: { viewport: { x: 0, y: 0, w: 100, h: 20 }, ctm: [1, 0, 0, 1, 0, 0] },
            rect: { x: 0, y: 0, w: 100, h: 20 },
            style: { display: "inline", overflow: "hidden" },
            children: [row("wide", { x: 50, y: 5, w: 20, h: 10 })],
          }),
        ],
      }),
    ]);
    expect(pxFrame(tree, "wide")).toEqual({ x: 50, y: 5, w: 20, h: 10 });
  });

  it("moves a nested <svg>'s viewport by its own transform about its origin", () => {
    const nested = (style: Record<string, string>, r: Rect) =>
      run([
        el({
          svg: true,
          tag: "svg",
          rect: { x: 0, y: 0, w: 400, h: 400 },
          style: { display: "inline", overflow: "hidden" },
          children: [
            el({
              tag: "svg",
              nestedSvg: { viewport: { x: 100, y: 100, w: 100, h: 60 }, ctm: [1, 0, 0, 1, 0, 0] },
              rect: r,
              style: { display: "inline", overflow: "hidden", ...style },
              children: [row("moved", r)],
            }),
          ],
        }),
      ]).tree;
    // translate(150, 50): the viewport spans x 250..350, y 150..210.
    const shifted = { x: 260, y: 160, w: 80, h: 40 };
    expect(pxFrame(nested({ transform: "matrix(1, 0, 0, 1, 150, 50)" }, shifted), "moved")).toEqual(
      shifted
    );
    // scale(2) about the viewport's centre: it spans x 50..250, y 70..190.
    const grown = { x: 60, y: 80, w: 20, h: 10 };
    expect(
      pxFrame(
        nested({ transform: "matrix(2, 0, 0, 2, 0, 0)", transformOrigin: "150px 130px" }, grown),
        "moved"
      )
    ).toEqual(grown);
    // A 3D transform computes to matrix3d: translate3d(150px, 50px, 1px), then
    // translateZ(1px) scale(2).
    const translated3d = "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 150, 50, 1, 1)";
    expect(pxFrame(nested({ transform: translated3d }, shifted), "moved")).toEqual(shifted);
    const scaled3d = "matrix3d(2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1)";
    expect(
      pxFrame(nested({ transform: scaled3d, transformOrigin: "150px 130px" }, grown), "moved")
    ).toEqual(grown);
    // The individual properties, which the computed transform leaves out.
    expect(pxFrame(nested({ translate: "150px 50px" }, shifted), "moved")).toEqual(shifted);
    expect(pxFrame(nested({ scale: "2", transformOrigin: "150px 130px" }, grown), "moved")).toEqual(
      grown
    );
    // rotate(90deg) about the viewport's centre: it spans x 120..180, y 80..180.
    const turned = { x: 125, y: 85, w: 50, h: 90 };
    expect(
      pxFrame(nested({ rotate: "90deg", transformOrigin: "150px 130px" }, turned), "moved")
    ).toEqual(turned);
  });

  it("clips everything under an HTML clipper whose padding box is empty", () => {
    const { tree } = run([
      scroller([row("squeezed", { x: 0, y: 10, w: 100, h: 20 })], {
        rect: { x: 0, y: 0, w: 2, h: 100 },
        client: { left: 1, top: 1, width: 0, height: 98 },
        offset: { width: 2, height: 100 },
        style: { overflow: "hidden" },
      }),
    ]);
    expect(pxFrame(tree, "squeezed").w).toBe(0);
  });

  it("frames a box-less wrapper by its visible children only", () => {
    const { tree } = run([
      scroller([
        el({
          attrs: { role: "button", id: "wrap" },
          style: { display: "contents" },
          rect: ZERO,
          children: [
            row("shown", { x: 1, y: 10, w: 100, h: 20 }),
            row("gone", { x: 1, y: 300, w: 100, h: 20 }),
            row("beside", { x: 400, y: 10, w: 100, h: 20 }),
          ],
        }),
      ]),
    ]);
    expect(pxFrame(tree, "wrap")).toEqual({ x: 1, y: 10, w: 100, h: 20 });
  });

  it("clips a box-less element's own text", () => {
    const { tree } = run([
      scroller([
        el({
          attrs: { id: "contents-text" },
          style: { display: "contents" },
          text: "far text",
          rect: ZERO,
          content: { x: 1, y: 150, w: 60, h: 15 },
        }),
      ]),
    ]);
    expect(pxFrame(tree, "contents-text").h).toBe(0);
  });

  it("frames nothing inside content-visibility: hidden, which paints none of it", () => {
    const panel = (contentVisibility: string) =>
      el({
        rect: { x: 0, y: 0, w: 300, h: 100 },
        client: { left: 0, top: 0, width: 300, height: 100 },
        offset: { width: 300, height: 100 },
        style: { contentVisibility },
        children: [
          row("in", { x: 1, y: 1, w: 100, h: 20 }),
          row("fixed", { x: 10, y: 500, w: 80, h: 20 }, { position: "fixed" }),
        ],
      });
    const hidden = run([panel("hidden")]).tree;
    expect(pxFrame(hidden, "in").h).toBe(0);
    expect(pxFrame(hidden, "fixed").h).toBe(0);
    expect(pxFrame(run([panel("auto")]).tree, "in")).toEqual({ x: 1, y: 1, w: 100, h: 20 });
  });

  it("keeps the content of a zero-area box whose overflow Chromium ignores", () => {
    // A scroll-locked body whose content is all fixed, and an inline link round an icon.
    const body = el({
      tag: "body",
      rect: { x: 0, y: 0, w: W, h: 0 },
      style: { overflow: "hidden" },
    });
    const locked = run([row("save", { x: 10, y: 10, w: 80, h: 20 }, { position: "fixed" })], body);
    expect(pxFrame(locked.tree, "save")).toEqual({ x: 10, y: 10, w: 80, h: 20 });
    for (const display of ["inline", "ruby", "ruby-text", "inline list-item"]) {
      const link = el({
        tag: "a",
        rect: { x: 0, y: 0, w: 0, h: 0 },
        style: { display, overflow: "hidden" },
        children: [row("icon", { x: 10, y: 10, w: 20, h: 20 }, { position: "absolute" })],
      });
      expect(pxFrame(run([link]).tree, "icon"), display).toEqual({ x: 10, y: 10, w: 20, h: 20 });
    }
    // A block that clips its overflow still hides its content.
    const block = el({
      rect: { x: 0, y: 0, w: 0, h: 0 },
      style: { overflow: "hidden" },
      children: [row("gone", { x: 10, y: 10, w: 20, h: 20 }, { position: "absolute" })],
    });
    expect(findById(run([block]).tree, "gone")).toBeNull();
  });

  it("ignores position on a box-less element: its text is in flow, it contains nothing", () => {
    const { tree } = run([
      el({
        style: { position: "relative" },
        rect: { x: 0, y: 0, w: 400, h: 400 },
        children: [
          scroller(
            [
              el({
                attrs: { id: "contents-text" },
                style: { display: "contents", position: "absolute" },
                text: "far text",
                rect: ZERO,
                content: { x: 1, y: 150, w: 60, h: 15 },
              }),
              el({
                style: { display: "contents", position: "relative" },
                rect: ZERO,
                children: [row("abs", { x: 10, y: 150, w: 80, h: 20 }, { position: "absolute" })],
              }),
            ],
            { style: { overflow: "hidden" } }
          ),
        ],
      }),
    ]);
    expect(pxFrame(tree, "contents-text").h).toBe(0);
    expect(pxFrame(tree, "abs")).toEqual({ x: 10, y: 150, w: 80, h: 20 });
  });
});

describe("DESCRIBE_DOM_SCRIPT wheel anchors", () => {
  it("hit-tests a document whose elementsFromPoint a named element shadows", () => {
    const list = () => [
      scroller([row("part", { x: 1, y: 81, w: 285, h: 40 })], {
        painted: { x: 0, y: 0, w: 300, h: 100 },
      }),
    ];
    const plain = findById(run(list()).tree, "part")!.clipAnchors;
    expect(plain).toHaveProperty("y");
    // Read once run() has built the document: an <img name="elementsFromPoint"> takes
    // the name, while Document.prototype keeps the method.
    const page = {
      get Document() {
        const doc = (globalThis as Record<string, unknown>).document as Record<string, unknown>;
        doc.elementsFromPoint = el({ tag: "img" });
        return function Document() {};
      },
    };
    const clobbered = run(list(), undefined, {}, "CSS1Compat", page).tree;
    expect(findById(clobbered, "part")!.clipAnchors).toEqual(plain);
  });

  it("anchors a cut only where the clips above its innermost cutter leave that cutter showing", () => {
    // An outer pane holds a 100px clipper over a list that cuts the button; the pane's
    // next child shows below the clipper, where a wheel scrolls only the pane.
    const nested = (overflow: string) =>
      el({
        rect: { x: 0, y: 0, w: 300, h: 400 },
        client: { left: 0, top: 0, width: 300, height: 400 },
        offset: { width: 300, height: 400 },
        scrollSize: { width: 300, height: 700 },
        style: { overflow: "auto" },
        painted: { x: 0, y: 0, w: 300, h: 400 },
        children: [
          el({
            rect: { x: 0, y: 0, w: 300, h: 100 },
            client: { left: 0, top: 0, width: 300, height: 100 },
            offset: { width: 300, height: 100 },
            scrollSize: { width: 300, height: 300 },
            style: { overflow },
            painted: { x: 0, y: 0, w: 300, h: 100 },
            children: [
              el({
                rect: { x: 0, y: 0, w: 300, h: 300 },
                client: { left: 0, top: 0, width: 300, height: 300 },
                offset: { width: 300, height: 300 },
                scrollSize: { width: 300, height: 520 },
                style: { overflow: "auto" },
                painted: { x: 0, y: 0, w: 300, h: 100 },
                children: [
                  el({
                    attrs: { id: "cut" },
                    rect: { x: 0, y: -20, w: 300, h: 500 },
                    painted: { x: 0, y: 0, w: 300, h: 100 },
                  }),
                ],
              }),
            ],
          }),
          el({ rect: { x: 0, y: 100, w: 300, h: 600 }, painted: { x: 0, y: 100, w: 300, h: 300 } }),
        ],
      });
    for (const overflow of ["auto", "hidden"]) {
      expect(findById(run([nested(overflow)]).tree, "cut")!.clipAnchors).toEqual({
        y: { x: 0.03, y: 0.01 },
      });
    }
  });

  it("follows a wheel's path through slots and out of shadow roots to the cutter", () => {
    const area = { x: 0, y: 0, w: 300, h: 100 };
    const list = (kids: MockElement[], opts: Opts = {}) =>
      el({
        rect: area,
        client: { left: 0, top: 0, width: 300, height: 100 },
        offset: { width: 300, height: 100 },
        scrollSize: { width: 300, height: 400 },
        style: { overflow: "auto" },
        children: kids,
        ...opts,
      });
    const tall = { x: 0, y: -20, w: 300, h: 200 };
    const anchorOf = (kids: MockElement[]) => findById(run(kids).tree, "cut")!.clipAnchors;
    const top = { y: { x: 0.03, y: 0.01 } };
    // A light child slotted into a shadow tree's scroller, painted over all of it.
    const slot = el({ tag: "slot", rect: ZERO, style: { display: "contents" } });
    const slotted = el({ attrs: { id: "cut" }, rect: tall, painted: area });
    (slotted as Record<string, unknown>).assignedSlot = slot;
    const withSlot = el({
      tag: "x-feed",
      rect: area,
      painted: area,
      children: [slotted],
      shadow: [list([slot])],
    });
    expect(anchorOf([withSlot])).toEqual(top);
    // Shadow content of a row that a light scroller cuts.
    const row = el({
      tag: "x-row",
      attrs: { id: "cut" },
      rect: tall,
      painted: area,
      shadow: [el({ rect: tall, painted: area })],
    });
    expect(anchorOf([list([row], { painted: area })])).toEqual(top);
    // A host whose shadow tree paints nothing at the point: the host takes the wheel.
    const badge = el({
      tag: "x-badge",
      rect: { x: 0, y: 0, w: 300, h: 50 },
      painted: { x: 0, y: 0, w: 300, h: 50 },
      shadow: [el({ rect: { x: 0, y: 0, w: 10, h: 10 }, painted: { x: 0, y: 0, w: 10, h: 10 } })],
    });
    const cut = el({
      attrs: { id: "cut" },
      rect: { x: 0, y: 60, w: 300, h: 80 },
      painted: { x: 0, y: 60, w: 300, h: 40 },
    });
    expect(anchorOf([list([badge, cut], { painted: area })])).toEqual(top);
  });

  it("anchors a horizontal cut through a cross-axis scroller unless its overscroll-behavior-x keeps the wheel", () => {
    // A vertical list over the left of a horizontal strip that cuts the card.
    const anchorFor = (overscroll: Record<string, string>) =>
      findById(
        run([
          el({
            rect: { x: 0, y: 0, w: 200, h: 300 },
            client: { left: 0, top: 0, width: 200, height: 300 },
            offset: { width: 200, height: 300 },
            scrollSize: { width: 600, height: 300 },
            style: { overflow: "auto" },
            painted: { x: 0, y: 0, w: 200, h: 300 },
            children: [
              el({
                rect: { x: 0, y: 0, w: 180, h: 300 },
                client: { left: 0, top: 0, width: 180, height: 300 },
                offset: { width: 180, height: 300 },
                scrollSize: { width: 180, height: 900 },
                style: { overflow: "auto", ...overscroll },
                painted: { x: 0, y: 0, w: 180, h: 300 },
              }),
              el({
                attrs: { id: "cut" },
                rect: { x: 180, y: 0, w: 60, h: 300 },
                painted: { x: 180, y: 0, w: 20, h: 300 },
              }),
            ],
          }),
        ]).tree,
        "cut"
      )!.clipAnchors;
    expect(anchorFor({ overscrollBehaviorY: "contain" })).toEqual({ x: { x: 0.02, y: 0.03 } });
    expect(anchorFor({ overscrollBehaviorX: "contain" })).toEqual({ x: { x: 0.18, y: 0.03 } });
  });
});

describe("DESCRIBE_DOM_SCRIPT clips across shadow trees and ignored overflow", () => {
  it.each([
    { edge: "left", list: { x: 0.5, y: 1, w: 285.5, h: 98 } },
    { edge: "top", list: { x: 1, y: 0.5, w: 285, h: 98.5 } },
    { edge: "right", list: { x: 1, y: 1, w: 285.5, h: 98 } },
    { edge: "bottom", list: { x: 1, y: 1, w: 285, h: 98.5 } },
  ])(
    "keeps clipping a closed host's child the page hit-tests within a pixel past the $edge clip edge of a scroller outside its shadow tree",
    ({ list }) => {
      const { tree } = run([
        scroller([
          el({
            tag: "x-app",
            rect: { x: 1, y: 1, w: 285, h: 98 },
            shadow: [
              el({
                tag: "x-list",
                rect: list,
                children: [
                  el({
                    rect: list,
                    painted: list,
                    children: [row("hidden", { x: 1, y: 200, w: 285, h: 40 })],
                  }),
                ],
              }),
            ],
          }),
        ]),
      ]);
      expect(pxFrame(tree, "hidden").h).toBe(0);
    }
  );

  it("measures a closed host's child against clippers' borders only where their overflow applies", () => {
    // An inline span with overflow: hidden, which Chromium ignores, fills the padding box
    // of a 12px-bordered clipper; the row is hit-tested across the clipper's top border.
    const { tree } = run([
      el({
        rect: { x: 100, y: 100, w: 324, h: 124 },
        client: { left: 12, top: 12, width: 300, height: 100 },
        style: { contain: "paint" },
        children: [
          el({
            tag: "span",
            rect: { x: 112, y: 112, w: 300, h: 100 },
            style: { display: "inline", overflow: "hidden" },
            children: [
              el({
                tag: "app-row",
                rect: ZERO,
                style: { display: "contents" },
                children: [
                  el({
                    attrs: { id: "row" },
                    rect: { x: 120, y: 97, w: 40, h: 65 },
                    painted: { x: 120, y: 100, w: 40, h: 62 },
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    ]);
    expect(pxFrame(tree, "row")).toEqual({ x: 120, y: 112, w: 40, h: 50 });
  });

  it("gives a scrollable body, whose overflow scrolls the viewport, no clipFrame", () => {
    const body = el({
      tag: "body",
      attrs: { id: "page" },
      rect: { x: 0, y: 0, w: W, h: H },
      client: { left: 0, top: 0, width: W, height: H },
      offset: { width: W, height: H },
      scrollSize: { width: W, height: 3 * H },
      style: { overflow: "auto" },
    });
    const page = findById(run([row("a", BOX)], body).tree, "page")!;
    expect(page.scrollable).toBe(true);
    expect(page.clipFrame).toBeUndefined();
  });
});
