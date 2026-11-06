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
 * whatever transform-like property a fixture sets), client{Left,Top,Width,Height} and
 * offset{Width,Height} (padding-box clipping), children,
 * childNodes (text, and <br> / comment nodes), localName/namespaceURI,
 * getAttribute/hasAttribute, open shadowRoot, iframe contentDocument,
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
// tree order on top. A shadow root's own tree is separate, so the document never
// returns a shadow tree's nodes.
function paintedAt(nodes: unknown[], x: number, y: number): unknown[] {
  const hits: unknown[] = [];
  const visit = (n: Record<string, unknown>) => {
    const p = n.__painted as Rect | undefined;
    if (p && x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h) hits.push(n);
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
  offset?: { width: number; height: number }; // untransformed border-box size
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
  iframeDoc?: MockElement; // <iframe> contentDocument.documentElement (same-origin pierce)
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
    // Like Chrome's, it hit-tests the host and its ancestors below its own tree's nodes.
    const hostChain = () => {
      const chain: unknown[] = [];
      for (let n: unknown = node; n instanceof MockElement;) {
        chain.push(n);
        n = (n as Record<string, unknown>).__parentNode;
      }
      return chain;
    };
    let hitTests = 0;
    const shadowRoot = {
      nodeType: 11,
      host: node,
      children: opts.shadow,
      elementsFromPoint: (x: number, y: number) => {
        // A script hit-testing one point over and over would otherwise hang the suite.
        if (++hitTests > 10_000) throw new Error("hit-tested a shadow root without end");
        return [...paintedAt(opts.shadow!, x, y), ...hostChain()];
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
  // A same-origin <iframe> exposes contentDocument.documentElement (read directly, not via
  // a prototype getter). Only meaningful when tag === "iframe".
  if (opts.iframeDoc) {
    (node as Record<string, unknown>).contentDocument = { documentElement: opts.iframeDoc };
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
    Node: g.Node,
    Element: g.Element,
    HTMLInputElement: g.HTMLInputElement,
    HTMLTextAreaElement: g.HTMLTextAreaElement,
    HTMLImageElement: g.HTMLImageElement,
    HTMLElement: g.HTMLElement,
    SVGSVGElement: g.SVGSVGElement,
  };
  g.window = {
    innerWidth: W,
    innerHeight: H,
    // Like Chrome's, it rejects a non-element (a document, text or comment node).
    getComputedStyle: (e: Record<string, unknown>) => {
      if (!(e instanceof MockElement)) throw new TypeError("parameter 1 is not of type 'Element'");
      return e.__style;
    },
  };
  g.document = {
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
    elementsFromPoint: (x: number, y: number) => paintedAt([root], x, y),
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
  };
  (body as Record<string, unknown>).ownerDocument = g.document;
  root.parentNode = g.document;
  g.Node = MockNode;
  g.Element = MockElement;
  g.HTMLInputElement = MockHTMLInputElement;
  g.HTMLTextAreaElement = MockHTMLTextAreaElement;
  g.HTMLImageElement = MockHTMLImageElement;
  g.HTMLElement = MockHTMLElement;
  g.SVGSVGElement = MockSVGSVGElement;
  Object.assign(g, pageGlobals);
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
      child("script", "var q = 1"),
      child("style", ".z{}"),
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
  const labelledBy = (kids: unknown[], style: Record<string, string> = { display: "inline" }) => {
    const label = el({ tag: "span", rect: BOX, attrs: { id: "lbl" }, style }) as MockElement &
      Record<string, unknown>;
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

  it("pierces a same-origin iframe's contentDocument", () => {
    const innerDoc = el({
      tag: "html",
      rect: { x: 0, y: 0, w: W, h: H },
      children: [
        el({
          tag: "body",
          rect: { x: 0, y: 0, w: W, h: H },
          children: [el({ text: "IFRAMETEXT", rect: BOX })],
        }),
      ],
    });
    const { tree } = run([
      el({ tag: "iframe", rect: { x: 0, y: 0, w: 500, h: 500 }, iframeDoc: innerDoc }),
    ]);
    expect(valuesOf(tree)).toContain("IFRAMETEXT");
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
    // The mock defines no Document constructor, so the script's protoGetter
    // falls back to direct reads: a stub document with activeElement/body is
    // enough. The body being activeElement (the no-focus default) must NOT
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

  it("flags a focused input inside a same-origin iframe once — never its host <iframe>", () => {
    // Focus inside a subdocument makes BOTH activeElements point at it: the
    // inner document's is the input, the outer document's is the host iframe
    // element. Only the inner element carries the flag; flagging the host too
    // would double-report the focus.
    const innerInput = el({ tag: "input", attrs: { id: "iframe-input" }, rect: BOX });
    const innerBody = el({
      tag: "body",
      rect: { x: 0, y: 0, w: 500, h: 500 },
      children: [innerInput],
    });
    const innerHtml = el({
      tag: "html",
      rect: { x: 0, y: 0, w: 500, h: 500 },
      children: [innerBody],
    });
    const innerDoc = { documentElement: innerHtml, activeElement: innerInput, body: innerBody };
    for (const n of [innerHtml, innerBody, innerInput]) {
      (n as unknown as Record<string, unknown>).ownerDocument = innerDoc;
    }
    const iframe = el({
      tag: "iframe",
      attrs: { id: "the-iframe" },
      rect: { x: 0, y: 0, w: 500, h: 500 },
    });
    (iframe as unknown as Record<string, unknown>).contentDocument = innerDoc;
    // The outer document reports the host iframe as ITS activeElement.
    const outerDoc = { activeElement: iframe, body: null };
    (iframe as unknown as Record<string, unknown>).ownerDocument = outerDoc;

    const { tree } = run([iframe]);
    expect(findById(tree, "iframe-input")!.focused).toBe(true);
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
    // Else the row's visible centre.
    const cover = el({
      rect: { x: 0, y: 0, w: 300, h: 950 },
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

  it("clips a row cut inside a same-origin iframe but gives it no top-document wheel anchor", () => {
    const area = { x: 0, y: 0, w: 300, h: 100 };
    const innerHtml = el({
      tag: "html",
      rect: { x: 0, y: 0, w: W, h: H },
      children: [
        el({
          tag: "body",
          rect: { x: 0, y: 0, w: W, h: H },
          children: [scroller([row("cut", { x: 1, y: 81, w: 285, h: 40 })], { painted: area })],
        }),
      ],
    });
    const innerDoc = { documentElement: innerHtml, compatMode: "CSS1Compat", body: null };
    const own = (n: Record<string, unknown>) => {
      n.ownerDocument = innerDoc;
      for (const k of (n.__children as Record<string, unknown>[]) ?? []) own(k);
    };
    own(innerHtml as unknown as Record<string, unknown>);
    const { tree } = run([el({ tag: "iframe", rect: area, painted: area, iframeDoc: innerHtml })]);
    expect(pxFrame(tree, "cut")).toEqual({ x: 1, y: 81, w: 285, h: 18 });
    expect(findById(tree, "cut")!.clipBounds).toBeDefined();
    expect(findById(tree, "cut")!.clipAnchors).toBeUndefined();
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
      { display: "inline", transform: "matrix(1, 0, 0, 1, 0, 0)" },
      { display: "inline", willChange: "transform" },
      { display: "inline", contain: "paint" },
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
      el({ tag: "legend", attrs: { id }, rect: { x: 20, y, w: 60, h: 10 }, style });
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

  it("clips a fieldset's content by overflow where its rendered legend's margin box ends", () => {
    // Each fieldset renders at 2x (a 150x120 layout box); "under" spans x 20..280, y 50..150.
    const pad = { left: 0, top: 0, width: 150, height: 120 };
    const sides = { marginLeft: "3px", marginRight: "5px" };
    // A relative offset moves where the legend paints (here 8 or 20px), not the clip edge.
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
        { overflow: "auto" },
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
            el({ tag: "legend", rect: legendRect, style: legendStyle }),
            row("under", { x: 20, y: 50, w: 260, h: 100 }),
          ],
        }),
      ]);
      expect(pxFrame(tree, "under"), JSON.stringify([style, legendStyle, client])).toEqual(want);
    }
  });

  it("clips a fixed legend like the fieldset's other content: it is not the rendered legend", () => {
    const legend = (id: string, style: Record<string, string> = {}) =>
      el({ tag: "legend", attrs: { id }, rect: { x: 20, y: 3, w: 60, h: 10 }, style });
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
    const link = el({
      tag: "a",
      rect: { x: 0, y: 0, w: 0, h: 0 },
      style: { display: "inline", overflow: "hidden" },
      children: [row("icon", { x: 10, y: 10, w: 20, h: 20 }, { position: "absolute" })],
    });
    expect(pxFrame(run([link]).tree, "icon")).toEqual({ x: 10, y: 10, w: 20, h: 20 });
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
