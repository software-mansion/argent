import { afterEach, describe, expect, it } from "vitest";
import { DESCRIBE_DOM_SCRIPT } from "../src/tools/describe/platforms/chromium";
import { adaptChromiumTreeForFlows } from "../src/tools/flows/flow-chromium-tree";
import { assertText, evaluateCondition, findAll, selectorToNode } from "../src/utils/ui-tree-match";
import type { DescribeNode } from "../src/tools/describe/contract";

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
 * childNodes (text), getAttribute/hasAttribute, open shadowRoot,
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
// A real Document / ShadowRoot constructor, so the script's `activeElement`
// reads go through a PROTOTYPE accessor exactly as they do in a renderer. With
// a plain stub object protoGetter falls back to a direct property read, and the
// whole point of the focus hunk — that a DOM-clobbering <form> must not be able
// to answer "who is focused", and that an open shadow root answers for its own
// subtree — becomes unreachable from a test.
class MockDocument {}
class MockShadowRoot {}

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
// activeElement / body live on Document.prototype and ShadowRoot.prototype —
// where the script captures each, and where a clobbering own property can be
// laid over them.
defineNative(MockDocument.prototype, "activeElement", "__activeElement");
defineNative(MockDocument.prototype, "body", "__body");
// Brand-checked, like Blink's: calling ShadowRoot's accessor on anything that is
// not a ShadowRoot throws `Illegal invocation`. A stub that answered `undefined`
// instead cannot see a page that removed `Element.prototype.shadowRoot` and made
// the script's shadow read hand a form CONTROL to this getter.
Object.defineProperty(MockShadowRoot.prototype, "activeElement", {
  get(this: object): unknown {
    if (!(this instanceof MockShadowRoot)) throw new TypeError("Illegal invocation");
    return (this as Record<string, unknown>).__activeElement;
  },
  set(this: Record<string, unknown>, v: unknown) {
    this.__activeElement = v;
  },
  configurable: true,
});

/**
 * A Document the script's captured accessors work on. `activeElement`/`body`
 * are written to the backing fields, so a test can shadow the PUBLIC property
 * with a control element (a `<form name="activeElement">`) and still have the
 * prototype getter return the truth.
 */
function mockDoc(fields: {
  activeElement?: unknown;
  body?: unknown;
  documentElement?: unknown;
}): Record<string, unknown> {
  const doc = Object.create(MockDocument.prototype) as Record<string, unknown>;
  doc.__activeElement = fields.activeElement ?? null;
  doc.__body = fields.body ?? null;
  if (fields.documentElement !== undefined) doc.documentElement = fields.documentElement;
  return doc;
}

// ownerDocument: whatever a fixture assigned, else the document `run()` installs.
// Shadow content has an ownerDocument like any other node — only its ROOT differs.
Object.defineProperty(MockNode.prototype, "ownerDocument", {
  get(this: Record<string, unknown>) {
    return this.__ownerDocument ?? (globalThis as Record<string, unknown>).document;
  },
  set(this: Record<string, unknown>, v: unknown) {
    this.__ownerDocument = v;
  },
  configurable: true,
});

// getRootNode(): the containing open shadow root when there is one, else the
// element's document. The script prefers it over the document precisely because
// the two differ inside a shadow tree.
(MockElement.prototype as unknown as Record<string, unknown>).getRootNode = function (
  this: Record<string, unknown>
) {
  return this.__root ?? (globalThis as Record<string, unknown>).document;
};
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
// `contains` lives on Node.prototype in a renderer, and the walker reads it
// through the captured accessor to ask whether a subtree it is about to prune
// holds the caret. Light DOM only, like the real one: a shadow boundary is not
// crossed.
(MockNode.prototype as unknown as Record<string, unknown>).contains = function (
  this: Record<string, unknown>,
  other: unknown
): boolean {
  if (this === other) return true;
  for (const child of (this.children as MockElement[] | undefined) ?? []) {
    if ((child as unknown as { contains: (n: unknown) => boolean }).contains(other)) return true;
  }
  return false;
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
  shadowActive?: MockElement; // that shadow root's own activeElement
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
  // A real ShadowRoot instance, so the script's `activeElement` accessor and its
  // `instanceof ShadowRoot` root test both see what a renderer would. Everything
  // inside it reports the shadow root — not the document — as its root node.
  if (opts.shadow) {
    const sr = Object.create(MockShadowRoot.prototype) as Record<string, unknown>;
    sr.children = opts.shadow;
    sr.__activeElement = opts.shadowActive ?? null;
    const markRoot = (n: MockElement): void => {
      (n as unknown as Record<string, unknown>).__root = sr;
      for (const c of (n as unknown as { __children?: MockElement[] }).__children ?? []) {
        markRoot(c);
      }
    };
    for (const c of opts.shadow) markRoot(c);
    node.shadowRoot = sr as unknown;
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

// A <textarea> the script's `instanceof HTMLTextAreaElement` branches recognise.
// `text` is its markup DEFAULT (the child text node), `value` the live contents —
// the two diverge the moment anything types into the field, which is the whole
// point of the split.
function textareaEl(opts: Opts & { value?: string; placeholder?: string }) {
  const node = el({ ...opts, tag: "textarea" }) as MockElement & Record<string, unknown>;
  Object.setPrototypeOf(node, MockHTMLTextAreaElement.prototype);
  node.value = opts.value ?? "";
  if (opts.placeholder) node.placeholder = opts.placeholder;
  return node;
}

function run(
  rootChildren: MockElement[],
  /**
   * The page-level activeElement, and optionally a control element shadowing
   * the PUBLIC `document.activeElement` property (a `<form name="activeElement">`
   * — Document's named getter is [LegacyOverrideBuiltIns]). Elements built by
   * `el()` take the global document as their root node unless a shadow root
   * claims them, so this is what the light DOM's focus reads answer with.
   */
  focus?: { activeElement?: MockElement; clobberedBy?: MockElement },
  /**
   * Globals a hostile page can redefine before the script runs. `ShadowRoot`
   * is not always a constructor: a legacy Shadow-DOM polyfill can assign a
   * non-object to it, and the script reads `ShadowRoot.prototype` at top level.
   */
  globals?: { ShadowRoot?: unknown }
): { tree: unknown; truncated: boolean } {
  const root = el({ tag: "html", rect: { x: 0, y: 0, w: W, h: H } }) as MockElement &
    Record<string, unknown>;
  const bodyEl = el({ tag: "body", rect: { x: 0, y: 0, w: W, h: H }, children: rootChildren });
  root.children = [bodyEl];

  const g = globalThis as Record<string, unknown>;
  const saved = {
    window: g.window,
    document: g.document,
    Node: g.Node,
    Element: g.Element,
    HTMLInputElement: g.HTMLInputElement,
    HTMLTextAreaElement: g.HTMLTextAreaElement,
    HTMLImageElement: g.HTMLImageElement,
    Document: g.Document,
    ShadowRoot: g.ShadowRoot,
  };
  g.window = {
    innerWidth: W,
    innerHeight: H,
    getComputedStyle: (e: Record<string, unknown>) => e.__style,
  };
  const doc = mockDoc({ activeElement: focus?.activeElement ?? null, body: bodyEl });
  if (focus?.clobberedBy) {
    Object.defineProperty(doc, "activeElement", {
      value: focus.clobberedBy,
      configurable: true,
    });
  }
  g.document = Object.assign(doc, {
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
  });
  g.Node = MockNode;
  g.Element = MockElement;
  g.HTMLInputElement = MockHTMLInputElement;
  g.HTMLTextAreaElement = MockHTMLTextAreaElement;
  g.HTMLImageElement = MockHTMLImageElement;
  g.Document = MockDocument;
  g.ShadowRoot = globals && "ShadowRoot" in globals ? globals.ShadowRoot : MockShadowRoot;
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

/** Every node in the tree carrying the focus flag. */
function focusedNodes(tree: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  (function rec(n: Record<string, unknown> | null) {
    if (!n) return;
    if (n.focused === true) out.push(n);
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

describe("DESCRIBE_DOM_SCRIPT — a <textarea>'s own text is not its value", () => {
  it("never emits the markup default", () => {
    // `ownText` reads child text nodes, which for a <textarea> is its authored
    // DEFAULT and never tracks `el.value`. Once typing (or a keyboard clear)
    // makes them diverge, emitting the default makes the node read as holding
    // text the field lost — on Chrome 150 an `equals` assert on what the field
    // really contains failed with `its text was "final textarea-value"` on a
    // clear that had worked.
    const { tree } = run([
      textareaEl({
        text: "textarea-default",
        value: "final",
        attrs: { "aria-label": "Notes", "id": "ta" },
        rect: BOX,
      }),
    ]);
    expect(JSON.stringify(tree)).not.toContain("textarea-default");
    expect(findById(tree, "ta")!.value).toBeUndefined();
  });

  it("leaves a LABELLED textarea's contents out of the tree, exactly as an <input> does", () => {
    // A textarea has no own text, so what it HOLDS reaches the tree only
    // through `accessibleName`'s value fallback — which an aria-label or a
    // placeholder pre-empts. Emitting the value as node text instead exposed
    // the contents, but node text is what the page DISPLAYS: on Chrome 151 a
    // container `text` assert then passed on an unsent draft, `visible:` passed
    // on the composer itself, and a `tap` landed in a note whose draft matched
    // the button's label. See `asserting-field-values.md` for what to assert
    // instead.
    const { tree } = run([
      textareaEl({
        value: "initial content one",
        attrs: { "aria-label": "Notes", "id": "t1" },
        rect: BOX,
      }),
      textareaEl({
        value: "initial content two",
        placeholder: "Type here",
        attrs: { id: "t2" },
        rect: { x: 0, y: 200, w: 200, h: 30 },
      }),
    ]);
    expect(findById(tree, "t1")!.label).toBe("Notes");
    expect(findById(tree, "t1")!.value).toBeUndefined();
    expect(findById(tree, "t2")!.label).toBe("Type here");
    expect(findById(tree, "t2")!.value).toBeUndefined();
  });

  it("does not double-report an UNLABELLED textarea's contents", () => {
    // With no label of any kind the accessible name IS `el.value`, so the value
    // key is dropped as a duplicate — the same shape an <input> has.
    const { tree } = run([
      textareaEl({ value: "initial content three", attrs: { id: "t3" }, rect: BOX }),
    ]);
    expect(findById(tree, "t3")!.label).toBe("initial content three");
    expect(findById(tree, "t3")!.value).toBeUndefined();
  });

  it("reports a MULTI-LINE value once, and spelled as the field holds it", () => {
    // A <textarea> is the one field that can hold a newline or a run of spaces,
    // and its contents reach the tree as exactly one string — so that string is
    // the one the field HOLDS, raw, like an <input>'s. Normalizing it here made
    // the same typed text assertable back in an <input> and not in a
    // <textarea>, and emitting a normalized copy as node text alongside the raw
    // name reported the contents twice. The single-line case above sees
    // neither.
    const { tree } = run([
      textareaEl({ value: "line one\nline two", attrs: { id: "t4" }, rect: BOX }),
    ]);
    expect(findById(tree, "t4")!.label).toBe("line one\nline two");
    expect(findById(tree, "t4")!.value).toBeUndefined();
  });

  it("keeps the spaces an equals-assert was written against", () => {
    // `.trim()` on the value alone silently made `equals: "  hello  "` — which
    // matched at the base — stop matching, while the same value in an <input>
    // still did.
    const { tree } = run([textareaEl({ value: "  hello  ", attrs: { id: "t6" }, rect: BOX })]);
    expect(findById(tree, "t6")!.label).toBe("  hello  ");
  });

  it("caps a long value at 200 characters without duplicating it", () => {
    // `accessibleName` slices to 200. Emitting the value as node text as well
    // compared the UNSLICED text to the already-sliced name, so anything past
    // the cap differed BY THE SLICE ALONE and both keys were set — to the same
    // 200-character prefix, which `nodeText` then joined into the contents
    // reported twice. 201 characters is the first length that could see it.
    const { tree } = run([textareaEl({ value: "C".repeat(201), attrs: { id: "t5" }, rect: BOX })]);
    expect(findById(tree, "t5")!.label).toBe("C".repeat(200));
    expect(findById(tree, "t5")!.value).toBeUndefined();
  });

  it("still emits an ordinary element's own text as its value", () => {
    // The control: only <textarea> has this split between markup text and value.
    const { tree } = run([el({ tag: "p", text: "paragraph-text" })]);
    expect(JSON.stringify(tree)).toContain("paragraph-text");
  });
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
    const doc = mockDoc({ activeElement: focusedInput, body });
    for (const n of [focusedInput, otherInput, body]) {
      (n as unknown as Record<string, unknown>).ownerDocument = doc;
      (n as unknown as Record<string, unknown>).__root = doc;
    }

    const { tree } = run([body]);
    expect(findById(tree, "focused-input")!.focused).toBe(true);
    expect(findById(tree, "other-input")!.focused).toBeUndefined();

    // The body being activeElement is the no-focus default and must NOT flag it.
    doc.activeElement = body;
    const { tree: unfocusedTree } = run([body]);
    expect(findById(unfocusedTree, "focused-input")!.focused).toBeUndefined();
    expect(findById(unfocusedTree, "the-body")!.focused).toBeUndefined();
  });

  it("flags the element inside an open shadow root, never its host", () => {
    // `document.activeElement` is the HOST for focus inside an open shadow root
    // — the inner element is only ever reachable through the root's OWN
    // activeElement. Reading the document alone flagged a host that lays out a
    // whole screen, so `clear` was refused on every input under one; flagging
    // both would double-report. Measured in a live renderer: activeElement is
    // the host, inner.getRootNode().activeElement is the inner input.
    const shadowInput = el({ tag: "input", attrs: { id: "shadow-input" }, rect: BOX });
    const host = el({
      attrs: { id: "the-host" },
      rect: { x: 0, y: 0, w: 400, h: 400 },
      shadow: [shadowInput],
      shadowActive: shadowInput,
    });

    const { tree } = run([host], { activeElement: host });
    expect(findById(tree, "shadow-input")!.focused).toBe(true);
    expect(findById(tree, "the-host")!.focused).toBeUndefined();
  });

  it("survives a page that removed Element.prototype.shadowRoot", () => {
    // `protoGetter` falls back to a direct property read when the descriptor is
    // gone — this file's own documented threat model — so a `<form>` holding
    // `<input name="shadowRoot">` hands back the CONTROL element. Passing that
    // to the ShadowRoot accessor throws `Illegal invocation`, which aborted the
    // whole walk: verified live, describe answered CHROMIUM_DESCRIBE_FAILED for
    // the entire page and recovered when the descriptor was put back.
    const descriptor = Object.getOwnPropertyDescriptor(MockElement.prototype, "shadowRoot")!;
    Reflect.deleteProperty(MockElement.prototype, "shadowRoot");
    try {
      const form = el({ tag: "form", attrs: { id: "clobbering-form" }, rect: BOX }) as Record<
        string,
        unknown
      >;
      form.shadowRoot = el({ tag: "input", rect: BOX });
      const { tree } = run([form as unknown as MockElement]);
      // `.not.toBeNull()`, not `.toBeDefined()`: `findById` returns null on a
      // miss, which `toBeDefined()` accepts — so the assertion held whether or
      // not the form survived the walk.
      expect(findById(tree, "clobbering-form")).not.toBeNull();
    } finally {
      Object.defineProperty(MockElement.prototype, "shadowRoot", descriptor);
    }
  });

  it("keeps a focused element the walker would otherwise collapse away", () => {
    // The focus flag is computed BEFORE both collapse returns, and being the
    // caret's element keeps a node alive just as a name or an id does. A bare
    // `<div contenteditable><p>…</p></div>` — what Quill / ProseMirror / Lexical
    // render on a single-paragraph document — is a box-less single-child wrapper
    // with no id, role or own text, i.e. exactly the shape promotion drops.
    const para = el({ tag: "p", text: "draft the user is writing", rect: BOX });
    const editor = el({
      style: { display: "contents" },
      rect: ZERO,
      children: [para],
    });

    const { tree } = run([editor], { activeElement: editor });
    const focused = focusedNodes(tree);
    expect(focused).toHaveLength(1);
    expect(focused[0]!.role).toBe("div");
  });

  it("suppresses the host when the flag is NESTED inside its shadow subtree", () => {
    // `carriesFocus` recurses because the ordinary web-component shape puts the
    // focused control below the root's own children — `<my-editor>` → a wrapper
    // `<div>` → the `<input>`. A non-recursive check sees no flag among the
    // root's direct children, keeps the host flagged, and the tree then
    // double-reports host and inner: the flow's focus wait reads the host as an
    // ENCLOSING focused node and refuses the clear the inner element would have
    // confirmed. Both shadow fixtures beside this one put the activeElement one
    // level up, where the difference cannot show.
    const shadowInput = el({ tag: "input", attrs: { id: "nested-input" }, rect: BOX });
    // The wrapper carries an id, so the structural collapse cannot promote it
    // away. Without one it was an anonymous single-child box, the flag ended up
    // at depth 0 of the shadow results, and a NON-recursive `carriesFocus` read
    // it just as well — the fixture named the recursion without reaching it.
    const shadowWrapper = el({
      attrs: { id: "shadow-wrapper" },
      rect: { x: 0, y: 0, w: 400, h: 400 },
      children: [shadowInput],
    });
    const host = el({
      attrs: { id: "the-host" },
      rect: { x: 0, y: 0, w: 400, h: 400 },
      shadow: [shadowWrapper],
      shadowActive: shadowInput,
    });

    const { tree } = run([host], { activeElement: host });
    expect(findById(tree, "nested-input")!.focused).toBe(true);
    expect(findById(tree, "the-host")!.focused).toBeUndefined();
    expect(focusedNodes(tree)).toHaveLength(1);
  });

  it("keeps the HOST flagged when its shadow subtree never carried the flag out", () => {
    // Suppressing the host assumes the inner element will report the focus, and
    // that is an assumption rather than a guarantee: a collapsible or zero-area
    // activeElement means BOTH candidates vanish and the tree carries no focus
    // anywhere — which the flow's focus wait reads as "nothing was focused", the
    // one non-confirmed outcome it dispatches a destructive clear on. On Chrome
    // 151 that emptied a shadow composer's draft while the step passed on the
    // field it named.
    const hidden = el({ style: { display: "none" }, rect: ZERO });
    const host = el({
      attrs: { id: "the-host" },
      rect: { x: 0, y: 0, w: 400, h: 400 },
      shadow: [hidden],
      shadowActive: hidden,
    });

    const { tree } = run([host], { activeElement: host });
    expect(findById(tree, "the-host")!.focused).toBe(true);
  });

  it("keeps an INVISIBLE element that holds the caret, and its box", () => {
    // The field that is invisible by design is very often the one holding the
    // secret: the capture input under rendered OTP/PIN boxes, a
    // barcode-scanner sink, a styled file input. Pruning it before focus was
    // considered left the tree with no focus flag anywhere, which the flow's
    // focus wait reads as "nothing is focused" — the one non-confirmed outcome
    // it dispatches a destructive clear on. Measured on Chrome 151: an
    // opacity:0 capture input holding an OTP was emptied and rewritten with the
    // step reporting a pass, while the same page at opacity:1 refused.
    const capture = el({
      tag: "input",
      attrs: { id: "capture" },
      style: { opacity: "0" },
      rect: { x: 40, y: 40, w: 400, h: 60 },
    });

    const { tree } = run([capture], { activeElement: capture });
    const node = findById(tree, "capture")!;
    expect(node.focused).toBe(true);
    // Its real box, not a collapsed one — that box is where the keystrokes are
    // going, and every overlap test in the focus wait reads it.
    const frame = node.frame as { width: number; height: number };
    expect(frame.width).toBeCloseTo(400 / W, 6);
    expect(frame.height).toBeCloseTo(60 / H, 6);
  });

  it("keeps an invisible WRAPPER that contains the caret's element", () => {
    // The prune cuts the whole subtree, so the ancestor is where an
    // opacity:0 capture field is usually lost — the input itself is opaque and
    // the wrapper is what hides it.
    const inner = el({ tag: "input", attrs: { id: "inner" }, rect: { x: 0, y: 0, w: 200, h: 30 } });
    const wrapper = el({
      attrs: { id: "veil" },
      style: { opacity: "0" },
      rect: { x: 0, y: 0, w: 200, h: 30 },
      children: [inner],
    });

    const { tree } = run([wrapper], { activeElement: inner });
    expect(findById(tree, "inner")!.focused).toBe(true);
  });

  it("still prunes an invisible subtree when the caret is elsewhere", () => {
    // The carve-out is for the caret and nothing else. `document.body` is the
    // default activeElement when nothing is focused and it contains the whole
    // page, so treating it as a holder would resurrect every hidden subtree.
    const ghost = el({ attrs: { id: "ghost" }, style: { opacity: "0" }, rect: BOX });
    const real = el({
      attrs: { id: "real" },
      text: "visible",
      rect: { x: 0, y: 200, w: 200, h: 30 },
    });

    const { tree } = run([ghost, real]);
    expect(findById(tree, "ghost")).toBeNull();
    expect(findById(tree, "real")).not.toBeNull();
  });

  it("never resurrects a display:none subtree that claims the caret", () => {
    // An element in a display:none subtree cannot hold focus — the browser
    // blurs it — so a root naming one as its activeElement is describing a page
    // that cannot exist. Honouring the claim would undo a prune the walker has
    // always made.
    const gone = el({ attrs: { id: "gone" }, style: { display: "none" }, rect: BOX });

    const { tree } = run([gone], { activeElement: gone });
    expect(findById(tree, "gone")).toBeNull();
  });

  it("keeps a box-less focused element with no children and no own text", () => {
    // The zero-frame drop is the third sibling of the two structural collapses,
    // which both consult `focusedSelf`. Same class of drop, same consequence: a
    // focused node vanishing is the "nothing is focused" tree a destructive
    // clear goes through on.
    const empty = el({
      attrs: { id: "empty-editor" },
      style: { display: "contents" },
      rect: ZERO,
    });

    const { tree } = run([empty], { activeElement: empty });
    expect(findById(tree, "empty-editor")!.focused).toBe(true);
  });

  it("a <form name=activeElement> cannot decide which element reports focus", () => {
    // Document's named getter is [LegacyOverrideBuiltIns], so a form control
    // named `activeElement` shadows the property and a raw read hands back that
    // FORM. getRootNode() returns the Document for every light-DOM element, so
    // reading `root.activeElement` directly made the form the whole page's
    // answer: it was flagged, the input holding the caret was not, and every
    // clear inside such a form hard-stopped the flow blaming a focus trap.
    const emailInput = el({ tag: "input", attrs: { id: "email" }, rect: BOX });
    const form = el({
      tag: "form",
      attrs: { id: "signin" },
      rect: { x: 0, y: 90, w: 300, h: 100 },
      children: [emailInput],
    });

    const { tree } = run([form], { activeElement: emailInput, clobberedBy: form });
    expect(findById(tree, "email")!.focused).toBe(true);
    expect(findById(tree, "signin")!.focused).toBeUndefined();
  });

  it("leaves focus in a same-origin subdocument unreported, host <iframe> included", () => {
    // The iframe descent is dead in a real renderer, and the host exclusion is
    // what makes focus inside a subdocument invisible ENTIRELY rather than
    // double-reported. `walk` bails on `!(el instanceof Element)`, and the inner
    // `documentElement`'s constructor belongs to the INNER realm, so the check
    // is false for every subdocument. Verified live on Chrome 151: an
    // `<iframe srcdoc>` whose body holds a unique marker leaves no trace of the
    // marker, or of the inner input's id, in describe's output, and focusing
    // that inner input leaves the whole tree carrying NO focus flag.
    //
    // A single-realm mock cannot express that on its own — every element it
    // builds is an `Element` — so the inner documentElement is a foreign object
    // here, which is exactly what the guard rejects. That zero-focus tree is
    // the state `runType`'s residual comment reads as "unobservable", the one
    // non-confirmed outcome it dispatches a destructive clear on.
    const foreignHtml = { __realm: "inner" };
    const innerDoc = mockDoc({ documentElement: foreignHtml, activeElement: null, body: null });
    const iframe = el({
      tag: "iframe",
      attrs: { id: "the-iframe" },
      rect: { x: 0, y: 0, w: 500, h: 500 },
    });
    (iframe as unknown as Record<string, unknown>).contentDocument = innerDoc;
    // The outer document reports the host iframe as ITS activeElement, which is
    // what focus inside the subdocument looks like from outside.
    const outerDoc = mockDoc({ activeElement: iframe, body: null });
    (iframe as unknown as Record<string, unknown>).ownerDocument = outerDoc;
    (iframe as unknown as Record<string, unknown>).__root = outerDoc;

    const { tree } = run([iframe]);
    expect(findById(tree, "the-iframe")!.focused).toBeUndefined();
    expect(JSON.stringify(tree)).not.toContain("focused");
  });

  it("still reports focus when getRootNode answers with neither a root nor the document", () => {
    // ShadyDOM and webcomponents.js REPLACE Element.prototype.getRootNode, so
    // the captured accessor is never consulted and what comes back is neither a
    // ShadowRoot nor the element's own document. Answering "nothing is focused"
    // there dropped the flag from every node on the page — verified on Chrome
    // 151 — and a tree with no focus flag is what the type directive's focus
    // wait reads as "unobservable", the one non-confirmed outcome it dispatches
    // a destructive clear on.
    const input = inputEl({ attrs: { id: "email" }, value: "abc", rect: BOX });
    (input as unknown as Record<string, unknown>).__root = { __shady: true };

    const { tree } = run([input], { activeElement: input });
    expect(findById(tree, "email")!.focused).toBe(true);
  });

  it("describes the page even when ShadowRoot is not a constructor", () => {
    // `typeof ShadowRoot === "undefined"` does not cover a page assigning a
    // non-constructor (window.ShadowRoot = null is the shape a legacy polyfill
    // shim uses): `null.prototype` threw at script top, before a single node
    // was walked, and describe failed for the WHOLE page — reproduced against
    // Chrome 151, where the tool returned CHROMIUM_DESCRIBE_FAILED and no tree.
    const input = inputEl({ attrs: { id: "email" }, value: "abc", rect: BOX });
    let out: { tree: unknown } | undefined;
    expect(() => {
      out = run([input], { activeElement: input }, { ShadowRoot: null });
    }).not.toThrow();
    // …and the page is described in full, focus flag included.
    expect(findById(out!.tree, "email")!.focused).toBe(true);
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

// The walker's output is only half the question a flow asks. A field's contents
// reaching the tree at all decides three more things one layer down — whether
// they hoist onto a container, whether a page-wide `visible`/`hidden` check sees
// them, and whether they out-rank a real control for a `tap` — and none of those
// is visible in a single-node assertion on the walker. These run the real walker
// and then the real flow adapter and matcher over it, so a regression at either
// layer is caught here.
describe("a <textarea>'s contents through the flow tree", () => {
  const flowTree = (children: MockElement[]): DescribeNode =>
    adaptChromiumTreeForFlows(run(children).tree as DescribeNode);

  const composer = (value: string, attrs: Record<string, string> = {}) =>
    textareaEl({ value, placeholder: "Message", attrs, rect: { x: 0, y: 200, w: 400, h: 80 } });

  it("keeps a labelled composer's draft out of its container's text", () => {
    // An unidentified field does not shield, so anything it contributes hoists
    // into the nearest identified ancestor: a container `text` assert then
    // passed on an unsent draft with the message list empty, and a saved
    // regression test written that way can never go red.
    const tree = flowTree([
      el({
        attrs: { id: "chat" },
        rect: { x: 0, y: 100, w: 400, h: 200 },
        children: [
          el({ attrs: { id: "messages" }, rect: { x: 0, y: 100, w: 400, h: 40 } }),
          composer("hello team"),
        ],
      }),
    ]);
    const chat = findAll(tree, { identifier: "chat" })[0]!;
    expect(assertText(chat)).not.toContain("hello team");
  });

  it("lets an UNIDENTIFIED composer's draft INTO its container's text", () => {
    // The other half of the sentence, and the one the three tests around it
    // cannot show, because each gives its field a placeholder or an id: the
    // shield is the IDENTIFIER, not the fact that a field's contents are a
    // field's contents. With neither, the draft is the node's accessible name
    // and hoists like any other text. Reproduced live on Chrome 151 through
    // flow-execute — `text: { in: <chat>, contains: "unsent draft" }` passed
    // with the message list empty — which is why
    // `asserting-field-values.md` tells authors to give the field an id.
    const tree = flowTree([
      el({
        attrs: { id: "chat" },
        rect: { x: 0, y: 100, w: 400, h: 200 },
        children: [
          el({ attrs: { id: "messages" }, rect: { x: 0, y: 100, w: 400, h: 40 } }),
          textareaEl({ value: "hello team", rect: { x: 0, y: 200, w: 400, h: 80 } }),
        ],
      }),
    ]);
    const chat = findAll(tree, { identifier: "chat" })[0]!;
    expect(assertText(chat)).toContain("hello team");
  });

  it("lets an UNIDENTIFIED draft out-rank a real control for a tap", () => {
    // Same for the ranking: `shield` governs hoisting only, so an unidentified
    // field's value reaches `label` and the resolver's exact-field match beats
    // the button whose label merely contains the word. Reproduced live: the tap
    // landed in the note, not on the Save button.
    const tree = flowTree([
      textareaEl({ value: "Save", rect: { x: 0, y: 100, w: 400, h: 100 } }),
      el({
        tag: "button",
        attrs: { id: "save-btn" },
        text: "Save changes",
        rect: { x: 0, y: 220, w: 120, h: 30 },
      }),
    ]);
    // The resolver must MATCH, and match the draft: `?.identifier` alone reads
    // as undefined when nothing resolved at all, so it passed on a resolver
    // that found neither element.
    const picked = selectorToNode(tree, { text: "Save" });
    expect(picked).toBeTruthy();
    expect(picked!.identifier).toBeUndefined();
    expect(picked!.label).toBe("Save");
  });

  it("keeps a labelled composer's draft out of a page-wide visible check", () => {
    // `assert: { visible: X }` is the pattern `asserting-field-values.md`
    // prescribes for platforms that hide a field's contents — "assert the
    // CONSEQUENCE instead" — so it passing on the composer holding X undoes the
    // advice. It is also the same query as the clear-only proof's `hidden`.
    const tree = flowTree([
      composer("Alpha", { id: "composer" }),
      el({ attrs: { id: "note-list" }, rect: { x: 0, y: 300, w: 400, h: 40 } }),
    ]);
    expect(evaluateCondition("visible", undefined, findAll(tree, { text: "Alpha" }))).toBe(false);
  });

  it("does not let a draft out-rank a real control for a tap", () => {
    // `selectorToNode` scores an exact field match above a substring hit, and
    // that beats smallest-frame-wins — so a note whose draft was the word
    // "Save" took the tap on Chrome 151, and the button whose LABEL is the only
    // "Save" on the page did not.
    const tree = flowTree([
      textareaEl({
        value: "Save",
        placeholder: "Note",
        attrs: { id: "note" },
        rect: { x: 0, y: 100, w: 400, h: 100 },
      }),
      el({
        tag: "button",
        attrs: { id: "save-btn" },
        text: "Save changes",
        rect: { x: 0, y: 220, w: 120, h: 30 },
      }),
    ]);
    expect(selectorToNode(tree, { text: "Save" })?.identifier).toBe("save-btn");
  });

  it("still proves a clear landed on an UNLABELLED composer", () => {
    // The capability the exposure was added for, and the one that survives: with
    // no label of any kind the contents ARE the accessible name, so the old
    // value's absence is assertable — `hidden` is false while it is there and
    // true once the clear emptied it.
    const held = flowTree([
      textareaEl({
        value: "the old value",
        attrs: { id: "c" },
        rect: { x: 0, y: 100, w: 400, h: 80 },
      }),
    ]);
    const cleared = flowTree([
      textareaEl({ value: "", attrs: { id: "c" }, rect: { x: 0, y: 100, w: 400, h: 80 } }),
    ]);
    const seen = (t: DescribeNode) =>
      evaluateCondition("hidden", undefined, findAll(t, { text: "the old value" }));
    expect(seen(held)).toBe(false);
    expect(seen(cleared)).toBe(true);
  });

  it("spells a multi-line draft the way an <input> spells the same string", () => {
    // Normalizing only the textarea made the same typed text assertable back in
    // one element type and not the other.
    const tree = flowTree([
      textareaEl({ value: "line one\nline two", attrs: { id: "ta" }, rect: BOX }),
      inputEl({
        value: "line one\nline two",
        attrs: { id: "inp" },
        rect: { x: 0, y: 300, w: 200, h: 30 },
      }),
    ]);
    const ta = findAll(tree, { identifier: "ta" })[0]!;
    const inp = findAll(tree, { identifier: "inp" })[0]!;
    // Pin the string, not just the agreement: `toBe` between two empty labels
    // passes as `"" === ""` if BOTH regressed, which is the likelier failure —
    // one change to the shared normalizer moves them together.
    expect(assertText(ta)).toBe("line one\nline two");
    expect(assertText(ta)).toBe(assertText(inp));
  });
});
