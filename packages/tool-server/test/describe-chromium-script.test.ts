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
 * getComputedStyle (display / visibility / opacity / overflow{,X,Y}), children,
 * childNodes (text), getAttribute/hasAttribute, open shadowRoot, iframe contentDocument,
 * and a Range whose rect unions the element's own painted content with the still-laid-out
 * boxes of its descendants (everything but display:none) — so it reproduces the real
 * behaviour where a box-less wrapper's Range is non-zero purely from a visibility:hidden /
 * opacity:0 child, and returns zero only when an ancestor transform collapses the paint.
 */

const W = 1000;
const H = 1000;

class MockNode {}
class MockElement extends MockNode {}
class MockHTMLInputElement extends MockElement {}
class MockHTMLTextAreaElement extends MockElement {}
class MockHTMLImageElement extends MockElement {}

// The script reads childNodes / tagName / children through the native prototype getter
// (Object.getOwnPropertyDescriptor(proto, prop).get.call(el)) so a DOM-clobbering <form>
// can't shadow them. Mirror that here: expose each as a prototype accessor backed by a
// field, so a test can shadow the *public* property (see `clobberStructural`) while the
// prototype getter still returns the real value — exactly the real [LegacyOverrideBuiltins]
// behaviour the fix relies on. childNodes lives on Node.prototype, tagName/children on
// Element.prototype, matching where the script captures each getter.
function defineNative(proto: object, prop: string, field: string): void {
  Object.defineProperty(proto, prop, {
    get(this: Record<string, unknown>) {
      return this[field];
    },
    set(this: Record<string, unknown>, v: unknown) {
      this[field] = v;
    },
    configurable: true,
  });
}
defineNative(MockNode.prototype, "childNodes", "__childNodes");
defineNative(MockNode.prototype, "textContent", "__textContent");
defineNative(MockElement.prototype, "tagName", "__tagName");
defineNative(MockElement.prototype, "children", "__children");
defineNative(MockElement.prototype, "shadowRoot", "__shadowRoot");
// Scroll-dimension getters live on Element.prototype too; the script captures their
// descriptor up front (so they must exist) and only reads them for overflow:auto/scroll.
defineNative(MockElement.prototype, "scrollHeight", "__scrollHeight");
defineNative(MockElement.prototype, "clientHeight", "__clientHeight");
defineNative(MockElement.prototype, "scrollWidth", "__scrollWidth");
defineNative(MockElement.prototype, "clientWidth", "__clientWidth");
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
elementProto.getBoundingClientRect = function (this: Record<string, unknown>) {
  const r = this.__rect as Rect;
  return { left: r.x, top: r.y, right: r.x + r.w, bottom: r.y + r.h, width: r.w, height: r.h };
};

type Rect = { x: number; y: number; w: number; h: number };
type Opts = {
  tag?: string;
  text?: string;
  rect?: Rect;
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
  const node = new MockElement() as MockElement & Record<string, unknown>;
  const rect = opts.rect ?? { x: 0, y: 0, w: 100, h: 20 };
  node.tagName = (opts.tag ?? "div").toUpperCase();
  // Backing fields read by the Element.prototype getAttribute/hasAttribute/
  // getBoundingClientRect methods defined above (the script reads them via the prototype).
  node.__attrs = opts.attrs ?? {};
  node.__rect = rect;
  node.children = opts.children ?? [];
  // The text node carries the element's own painted-text rect (`content`) so a Range
  // over just this text node measures the own-text extent — matching the real browser,
  // where selectNodeContents(textNode) spans the text and NOT sibling element boxes.
  node.childNodes = opts.text
    ? [{ nodeType: 3, nodeValue: opts.text, __content: opts.content ?? null }]
    : [];
  // An open shadow root is a DocumentFragment exposing `.children`; the walker reads
  // `getShadowRoot.call(el)` then iterates `shadow.children`. null unless a fixture sets it.
  node.shadowRoot = opts.shadow ? ({ children: opts.shadow } as unknown) : null;
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
    for (const m of [
      "getAttribute",
      "hasAttribute",
      "getBoundingClientRect",
      "shadowRoot",
      "textContent",
    ]) {
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
  };
  const s = { ...baseStyle, ...(opts.style ?? {}) };
  if (opts.style?.overflow && !opts.style.overflowX) s.overflowX = opts.style.overflow;
  if (opts.style?.overflow && !opts.style.overflowY) s.overflowY = opts.style.overflow;
  (node as Record<string, unknown>).__style = s;
  return node;
}

function run(rootChildren: MockElement[]): { tree: unknown; truncated: boolean } {
  const root = el({ tag: "html", rect: { x: 0, y: 0, w: W, h: H } }) as MockElement &
    Record<string, unknown>;
  root.children = [el({ tag: "body", rect: { x: 0, y: 0, w: W, h: H }, children: rootChildren })];

  const g = globalThis as Record<string, unknown>;
  const saved = {
    window: g.window,
    document: g.document,
    Node: g.Node,
    Element: g.Element,
    HTMLInputElement: g.HTMLInputElement,
    HTMLTextAreaElement: g.HTMLTextAreaElement,
    HTMLImageElement: g.HTMLImageElement,
  };
  g.window = {
    innerWidth: W,
    innerHeight: H,
    getComputedStyle: (e: Record<string, unknown>) => e.__style,
  };
  g.document = {
    documentElement: root,
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
  };
  g.Node = MockNode;
  g.Element = MockElement;
  g.HTMLInputElement = MockHTMLInputElement;
  g.HTMLTextAreaElement = MockHTMLTextAreaElement;
  g.HTMLImageElement = MockHTMLImageElement;
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

  it("does not crash on an aria-labelledby target whose form clobbers textContent", () => {
    // accessibleName resolves aria-labelledby via getElementById, then reads textContent.
    // A <form id="lbl"> with a control named "textContent" shadows the inherited getter,
    // so a direct read returns the control and crashes (.trim on a non-string). The fix
    // routes through Node.prototype.textContent.
    const labelForm = el({
      tag: "form",
      attrs: { id: "lbl" },
      rect: { x: 0, y: 200, w: 200, h: 20 },
      children: [
        el({
          tag: "input",
          attrs: { id: "tc", name: "textContent" },
          rect: { x: 0, y: 200, w: 100, h: 20 },
        }),
      ],
      clobberAccessors: true,
    }) as MockElement & Record<string, unknown>;
    labelForm.__textContent = "Real Label";
    const labelled = el({
      tag: "div",
      attrs: { "aria-labelledby": "lbl" },
      rect: BOX,
      children: [el({ text: "BODY", rect: BOX })],
    });
    let result: { tree: unknown } | undefined;
    expect(() => {
      result = run([labelled, labelForm]);
    }).not.toThrow();
    // The label resolves via the prototype textContent despite the clobber.
    expect(JSON.stringify(result!.tree)).toContain("Real Label");
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

  // ---- input focus (the flow type directive's focus wait reads this) ----
  it("marks the document's activeElement as focused, excluding the body", () => {
    const focusedInput = el({ tag: "input", attrs: { id: "focused-input" }, rect: BOX });
    const otherInput = el({
      tag: "input",
      attrs: { id: "other-input" },
      rect: { x: 0, y: 200, w: 200, h: 30 },
    });
    const body = el({ tag: "body", attrs: { id: "the-body" }, rect: { x: 0, y: 0, w: W, h: H } });
    // The mock defines no Document constructor, so the script's protoGetter
    // falls back to direct reads: a stub document with activeElement/body is
    // enough. The body being activeElement (the no-focus default) must NOT
    // mark it focused.
    const doc = { activeElement: focusedInput, body };
    for (const n of [focusedInput, otherInput, body]) {
      (n as unknown as Record<string, unknown>).ownerDocument = doc;
    }
    body.children = [focusedInput, otherInput];

    const { tree } = run([body]);
    expect(findById(tree, "focused-input")!.focused).toBe(true);
    expect(findById(tree, "other-input")!.focused).toBeUndefined();

    doc.activeElement = body;
    const { tree: unfocusedTree } = run([body]);
    expect(findById(unfocusedTree, "focused-input")!.focused).toBeUndefined();
    expect(findById(unfocusedTree, "the-body")!.focused).toBeUndefined();
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
