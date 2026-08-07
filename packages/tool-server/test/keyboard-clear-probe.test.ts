import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import {
  clearedTargetProbe,
  focusedEditableProbe,
  type ClearedTarget,
  type FocusedEditable,
} from "../src/tools/keyboard/chromium-clear";

// The Chromium clear's two probes run as source strings inside the page, so the
// rest of the suite can only mock what they RETURN — every verdict they compute
// (which elements count as editable, the `isContentEditable` inheritance trap,
// the temporal input types, the parked handle, `badInput`, `isConnected`) is
// invisible to it, and a manual browser session is the only other evidence.
//
// They are pure expressions over a handful of DOM properties, so `node:vm` plus
// a hand-built `window`/`document` pins them exactly, with no new dependency.
// Every shape modelled here was checked against a real Chrome 150 first — an
// `<input>` inside a contenteditable really does report `isContentEditable`, a
// detached input really does keep `.value` while reporting `isConnected: false`,
// and a number input holding `1ee` really does report `value: ""` with
// `validity.badInput`.

const HANDLE = "__argentKeyboardClearTarget_test";

interface FakeEl {
  tagName: string;
  id?: string;
  type?: string;
  value?: string;
  textContent?: string;
  readOnly?: boolean;
  isContentEditable?: boolean;
  isConnected?: boolean;
  shadowRoot?: { activeElement: FakeEl | null } | null;
  contentDocument?: FakeDoc | null;
  validity?: { badInput: boolean };
  /** The element's own root — a Document or an open ShadowRoot. */
  getRootNode?: () => { activeElement: FakeEl | null } | null;
  /** The document the element lives in, for the frame-chain focus walk. */
  ownerDocument?: unknown;
}

interface FakeDoc {
  /** What the `Document.prototype` accessors report — the truthful answers. */
  __active: FakeEl | null;
  __body: FakeEl;
  __root: FakeEl;
  /** The document's own named getters, which a page can shadow. See below. */
  activeElement: FakeEl;
  body: FakeEl;
  documentElement: FakeEl;
}

/**
 * A document whose OWN `activeElement`, `body` and `documentElement` are decoys.
 *
 * Those named getters are `[LegacyOverrideBuiltIns]`, so `<form
 * name="activeElement">`, `<img name="body">` and `<form
 * name="documentElement">` each shadow the one they are named after — measured
 * on Chrome 148, where `document.body.tagName` becomes `"IMG"` while the
 * `Document.prototype` accessor still reports `BODY`. Modelling a decoy for all
 * three is what makes these tests discriminating: any read that bypasses the
 * prototype accessor picks up the decoy and produces a visibly wrong verdict, so
 * dropping one cannot ship green.
 */
function makeDoc(active: FakeEl | null): FakeDoc {
  const body: FakeEl = { tagName: "BODY" };
  const root: FakeEl = { tagName: "HTML" };
  return {
    __active: active,
    __body: body,
    __root: root,
    activeElement: { tagName: "FORM", id: "decoy" },
    body: { tagName: "IMG", id: "logo" },
    documentElement: { tagName: "FORM", id: "rootDecoy" },
  };
}

/** Run a probe against a fake page, returning the parsed verdict and the window. */
function runProbe(
  expression: string,
  doc: FakeDoc,
  seedWindow: Record<string, unknown> = {},
  platform = "MacIntel"
): { result: FocusedEditable & ClearedTarget; window: Record<string, unknown> } {
  // Not a spread: copying descriptors is the whole point of the refused-park
  // case, and `{...seed}` would turn a non-writable slot into a writable one.
  const window: Record<string, unknown> = Object.defineProperties(
    {},
    Object.getOwnPropertyDescriptors(seedWindow)
  );
  const sandbox = {
    window,
    document: doc,
    navigator: { platform },
    Document: { prototype: {} },
    Object,
    JSON,
    Math,
    RegExp,
    String,
  };
  for (const [name, backing] of [
    ["activeElement", "__active"],
    ["body", "__body"],
    ["documentElement", "__root"],
  ] as const) {
    Object.defineProperty(sandbox.Document.prototype, name, {
      get(this: FakeDoc) {
        return this[backing];
      },
      configurable: true,
    });
  }
  Object.assign(sandbox, { globalThis: sandbox });
  const raw = runInNewContext(expression, sandbox) as string;
  return { result: JSON.parse(raw), window };
}

const focused = (el: FakeEl | null, seed?: Record<string, unknown>, platform?: string) =>
  runProbe(focusedEditableProbe(HANDLE), makeDoc(el), seed, platform);

describe("chromium clear — focused-element probe", () => {
  it("reports a focused text input as editable and parks it", () => {
    const el: FakeEl = { tagName: "INPUT", id: "email", value: "hello123" };
    const { result, window } = focused(el);

    expect(result).toMatchObject({ verdict: "editable", label: "INPUT#email", parked: true });
    expect(window[HANDLE]).toBe(el);
  });

  it("reports nothing focused when the BODY holds focus", () => {
    // The realistic shape: a real Chrome reports `document.body` when nothing is
    // focused, never null. Feeding null instead would leave the body guard — the
    // one that actually fires in production — unpinned.
    const doc = makeDoc(null);
    doc.__active = doc.__body;
    expect(runProbe(focusedEditableProbe(HANDLE), doc).result.verdict).toBe("none");
  });

  it("reports nothing focused when the documentElement holds focus", () => {
    const doc = makeDoc(null);
    doc.__active = doc.__root;
    expect(runProbe(focusedEditableProbe(HANDLE), doc).result.verdict).toBe("none");
  });

  it("accepts a contenteditable BODY — the editor iframe shape", () => {
    // TinyMCE in its default iframe mode, CKEditor 4 classic and
    // `document.designMode = "on"` all make the BODY the editing host, which is
    // exactly what the iframe descent above exists to reach. Blink clears it
    // correctly, so the body sentinel must not swallow it into "nothing focused"
    // — that refusal tells the caller to focus the field it already focused.
    const doc = makeDoc(null);
    doc.__body = { tagName: "BODY", id: "tinymce", isContentEditable: true, textContent: "draft" };
    doc.__active = doc.__body;
    const { result, window } = runProbe(focusedEditableProbe(HANDLE), doc);
    expect(result).toMatchObject({ verdict: "editable", label: "BODY#tinymce", parked: true });
    expect(window[HANDLE]).toBe(doc.__body);
  });

  it("reads body/documentElement through the prototype, not the page's own getters", () => {
    // `<img name="body">` shadows `document.body`, so a direct read hands the
    // sentinel an IMG: a focused BODY then falls through to the non-text
    // refusal, whose advice ("use the element's own control") rules out the tap
    // that would actually fix it.
    const doc = makeDoc(null);
    doc.__active = doc.__body;
    expect(doc.body.tagName).toBe("IMG");
    expect(runProbe(focusedEditableProbe(HANDLE), doc).result).toEqual({
      verdict: "none",
      mac: true,
    });
  });

  it("reports nothing focused when there is no active element at all", () => {
    expect(focused(null).result.verdict).toBe("none");
  });

  it("refuses a button — a focused non-text element is not a clear target", () => {
    const { result, window } = focused({ tagName: "BUTTON", id: "go" });
    expect(result).toMatchObject({ verdict: "not-editable", label: "BUTTON#go" });
    expect(window[HANDLE]).toBeUndefined();
  });

  it.each(["checkbox", "radio", "file", "range", "color", "date", "time", "month", "week"])(
    "refuses <input type=%s>, which holds no editable text",
    (type) => {
      expect(focused({ tagName: "INPUT", id: "x", type, value: "" }).result.verdict).toBe(
        "not-editable"
      );
    }
  );

  it.each(["text", "search", "email", "password", "url", "tel", "number"])(
    "accepts <input type=%s>",
    (type) => {
      expect(focused({ tagName: "INPUT", id: "x", type, value: "abcd" }).result.verdict).toBe(
        "editable"
      );
    }
  );

  it("accepts a plain contenteditable element", () => {
    // The rich-text-editor case this module is largely written around. Both
    // "contenteditable" cases below take the form-control branch instead, so
    // without this the contenteditable branch has no coverage at all.
    const el: FakeEl = { tagName: "DIV", id: "rt", isContentEditable: true, textContent: "hi" };
    const { result, window } = focused(el);
    expect(result).toMatchObject({ verdict: "editable", label: "DIV#rt", parked: true });
    expect(window[HANDLE]).toBe(el);
  });

  it("refuses a readonly field rather than dispatching against it", () => {
    const { result } = focused({ tagName: "INPUT", id: "total", value: "42", readOnly: true });
    expect(result).toMatchObject({ verdict: "read-only", label: "INPUT#total" });
  });

  it("classifies a form control inside a contenteditable BY TAG, not by inheritance", () => {
    // `isContentEditable` is inherited, so an <input> inside an editing host
    // reports true. Taking that branch would read its textContent — always "" —
    // and a <textarea>'s textContent is its DEFAULT value, which never tracks
    // `value`. Both are still *editable*; the branch that matters is the one the
    // release probe uses to measure them (see its own tests below).
    expect(
      focused({
        tagName: "INPUT",
        id: "i",
        value: "typed",
        textContent: "",
        isContentEditable: true,
      }).result
    ).toMatchObject({ verdict: "editable", label: "INPUT#i" });
    expect(
      focused({
        tagName: "TEXTAREA",
        id: "ta",
        value: "live",
        textContent: "stale default",
        isContentEditable: true,
      }).result
    ).toMatchObject({ verdict: "editable", label: "TEXTAREA#ta" });
  });

  it("flags a password field so its length is never echoed back", () => {
    expect(
      focused({ tagName: "INPUT", id: "pw", type: "password", value: "s3cret" }).result.secret
    ).toBe(true);
    expect(focused({ tagName: "INPUT", id: "u", type: "text", value: "bob" }).result.secret).toBe(
      false
    );
  });

  it("descends into an open shadow root, and through nested ones", () => {
    const inner: FakeEl = { tagName: "INPUT", id: "inner", value: "abc" };
    expect(
      focused({ tagName: "MY-FIELD", id: "host", shadowRoot: { activeElement: inner } }).result
    ).toMatchObject({ verdict: "editable", label: "INPUT#inner" });

    const deep: FakeEl = { tagName: "INPUT", id: "deep", value: "abc" };
    const mid: FakeEl = { tagName: "MY-INNER", shadowRoot: { activeElement: deep } };
    expect(
      focused({ tagName: "MY-OUTER", shadowRoot: { activeElement: mid } }).result
    ).toMatchObject({ verdict: "editable", label: "INPUT#deep" });
  });

  it("descends into a same-origin iframe, and through nested ones", () => {
    const inner: FakeEl = { tagName: "TEXTAREA", id: "fi", value: "abcdef" };
    expect(
      focused({ tagName: "IFRAME", id: "f", contentDocument: makeDoc(inner) }).result
    ).toMatchObject({ verdict: "editable", label: "TEXTAREA#fi" });

    const deep: FakeEl = { tagName: "INPUT", id: "deepframe", value: "x" };
    const midDoc = makeDoc({ tagName: "IFRAME", id: "g", contentDocument: makeDoc(deep) });
    expect(focused({ tagName: "IFRAME", id: "f", contentDocument: midDoc }).result).toMatchObject({
      verdict: "editable",
      label: "INPUT#deepframe",
    });
  });

  it("reports a cross-origin iframe as unknown rather than guessing", () => {
    expect(focused({ tagName: "IFRAME", id: "f", contentDocument: null }).result.verdict).toBe(
      "unknown"
    );
  });

  it("refuses a custom element instead of assuming a closed shadow root", () => {
    // A closed root is indistinguishable from a plain focusable custom element
    // holding nothing editable. Treating the class as "can't tell" made the
    // chord no-op, leave a document-wide selection, and report success.
    const { result, window } = focused({ tagName: "X-THING", id: "z", shadowRoot: null });
    expect(result).toMatchObject({ verdict: "not-editable", label: "X-THING#z" });
    expect(window[HANDLE]).toBeUndefined();
  });

  it("caps the label, which is page-controlled and reaches an error message", () => {
    const { result } = focused({ tagName: "BUTTON", id: "x".repeat(500) });
    expect(result.label!.length).toBeLessThanOrEqual(60);
  });

  it("reports the RENDERER's platform so the chord matches the page", () => {
    // iPhone/iPad are in the test because an embedded renderer can report them
    // and Command is still the select-all chord there; without those arms the
    // page would silently get Ctrl.
    for (const platform of ["MacIntel", "iPhone", "iPad"]) {
      expect(focused({ tagName: "INPUT", value: "a" }, {}, platform).result.mac).toBe(true);
    }
    for (const platform of ["Win32", "Linux x86_64", "Android"]) {
      expect(focused({ tagName: "INPUT", value: "a" }, {}, platform).result.mac).toBe(false);
    }
  });

  it("still reports the platform when the page could not be read", () => {
    // The chord is dispatched even on the unreadable path, so it should still be
    // the native one — `mac` has to survive the failure that produced `unknown`.
    const el = { tagName: "INPUT", id: "x" } as FakeEl;
    Object.defineProperty(el, "type", {
      get() {
        throw new Error("hostile getter");
      },
    });
    expect(focused(el, {}, "MacIntel").result).toMatchObject({ verdict: "unknown", mac: true });
  });

  it("reports a park the page refused, so nothing is verified against a decoy", () => {
    // A page can pre-define the slot non-writable; the assignment then fails
    // silently (sloppy mode, no throw) and the release probe would read the
    // page's object instead of the field.
    const seed: Record<string, unknown> = {};
    Object.defineProperty(seed, HANDLE, {
      value: { tagName: "INPUT", value: "" },
      writable: false,
    });
    expect(focused({ tagName: "INPUT", id: "q", value: "hello123" }, seed).result.parked).toBe(
      false
    );
  });
});

describe("chromium clear — release probe", () => {
  const release = (seed: Record<string, unknown>) =>
    runProbe(clearedTargetProbe(HANDLE), makeDoc(null), seed);

  it("reports the parked element's remaining length and releases the slot", () => {
    const { result, window } = release({
      [HANDLE]: { tagName: "INPUT", value: "", isConnected: true },
    });
    expect(result).toMatchObject({ tracked: true, length: 0 });
    expect(window[HANDLE]).toBeUndefined();
  });

  it("reports residue when the field still holds its value", () => {
    expect(
      release({ [HANDLE]: { tagName: "INPUT", value: "hello123", isConnected: true } }).result
    ).toMatchObject({ tracked: true, length: 8 });
  });

  it("reports untracked when nothing was parked", () => {
    expect(release({}).result).toEqual({ tracked: false });
  });

  it("reports untracked for a node the page detached", () => {
    // A field replaced on edit (the React remount pattern) leaves the parked
    // node holding its old value forever while the live one really was cleared.
    expect(
      release({ [HANDLE]: { tagName: "INPUT", value: "hello123", isConnected: false } }).result
    ).toEqual({ tracked: false });
  });

  it("reads textContent for a contenteditable and value for a form control", () => {
    // The other half of the inheritance trap: a <textarea>'s textContent is its
    // DEFAULT value, so measuring that would report a cleared field as still full.
    expect(
      release({ [HANDLE]: { tagName: "DIV", textContent: "still here", isConnected: true } }).result
    ).toMatchObject({ tracked: true, length: 10 });
    expect(
      release({
        [HANDLE]: { tagName: "TEXTAREA", value: "ab", textContent: "stale", isConnected: true },
      }).result
    ).toMatchObject({ tracked: true, length: 2 });
  });

  it("still reports residue for a badInput number field reading empty", () => {
    // The box visibly holds what the user typed while `value` reads "", so a
    // length of 0 would let a cancelled clear verify as a success.
    const { result } = release({
      [HANDLE]: { tagName: "INPUT", value: "", isConnected: true, validity: { badInput: true } },
    });
    expect(result.length).toBeGreaterThan(0);
  });

  it("flags a password field so the failure message reports no count", () => {
    expect(
      release({
        [HANDLE]: { tagName: "INPUT", type: "password", value: "s3cret", isConnected: true },
      }).result.secret
    ).toBe(true);
  });

  it("reports whether the cleared element still holds focus", () => {
    // The text of a combined `{ clear, text }` is dispatched at the page, so it
    // lands wherever focus is AFTER the clear. A field that blurs once empty, or
    // an app that advances to the next input, therefore swallows the whole value
    // or appends it to a different field — both reported as a plain success
    // until this is read back. Scoped by `getRootNode()` so it is the right
    // question inside a shadow root and inside a sub-document too.
    const kept: FakeEl = { tagName: "INPUT", value: "", isConnected: true };
    kept.getRootNode = () => ({ activeElement: kept });
    expect(release({ [HANDLE]: kept }).result).toMatchObject({ tracked: true, focused: true });

    const blurred: FakeEl = { tagName: "INPUT", value: "", isConnected: true };
    blurred.getRootNode = () => ({ activeElement: { tagName: "BODY" } });
    expect(release({ [HANDLE]: blurred }).result).toMatchObject({ tracked: true, focused: false });
  });

  it("reports focus lost when the root cannot be read at all", () => {
    const hostile: FakeEl = { tagName: "INPUT", value: "", isConnected: true };
    hostile.getRootNode = () => {
      throw new Error("hostile getRootNode");
    };
    expect(release({ [HANDLE]: hostile }).result).toMatchObject({ tracked: true, focused: false });
  });

  it("reads activeElement through the prototype accessor, not the page's own", () => {
    // On an HTML document `activeElement` is declared on Document.prototype,
    // above the own HTMLDocument.prototype, and the document's own named getter
    // is `[LegacyOverrideBuiltIns]` — so `<iframe name="activeElement">` shadows
    // it. A read that stops at the immediate prototype finds nothing, falls back
    // to the shadowed property, and reports every successful clear as having
    // lost focus.
    const el: FakeEl = { tagName: "INPUT", value: "", isConnected: true };
    const decoy = { tagName: "IFRAME", id: "activeElementDecoy" };
    // Two prototype levels, the way HTMLDocument.prototype sits under
    // Document.prototype, with the accessor only on the upper one.
    const upper = {};
    Object.defineProperty(upper, "activeElement", { get: () => el, configurable: true });
    const root = Object.create(Object.create(upper)) as Record<string, unknown>;
    // The page's own shadowing property, which the accessor must win over.
    Object.defineProperty(root, "activeElement", { value: decoy, enumerable: true });
    el.getRootNode = () => root as unknown as { activeElement: FakeEl | null };
    expect(release({ [HANDLE]: el }).result).toMatchObject({ tracked: true, focused: true });
  });

  describe("focus across the frame chain", () => {
    // `Document.activeElement` falls back to that document's `body` whenever
    // nothing in the document holds focus, so for a `<body contenteditable>`
    // editing host — TinyMCE's default iframe mode, CKEditor 4 classic,
    // `designMode`, the shape the resolve probe goes out of its way to accept —
    // the local read is CONSTANT TRUE. Measured on Chrome 150: with focus moved
    // to a top-level input the probe still said `focused: true`, and a
    // `{ clear, text }` that emptied the editor and typed into the sidebar came
    // back as a clean replacement. Climbing out of every frame is what tells the
    // two apart.
    const editorInFrame = (parentActive: unknown) => {
      const el: FakeEl = {
        tagName: "BODY",
        isContentEditable: true,
        isConnected: true,
        textContent: "",
      };
      const frame = { tagName: "IFRAME" } as Record<string, unknown>;
      const parentDoc = { activeElement: parentActive === "self" ? frame : parentActive };
      // The editor document, whose own activeElement is its body either way.
      const editorDoc = { activeElement: el, defaultView: { frameElement: frame } };
      el.getRootNode = () => editorDoc as unknown as { activeElement: FakeEl | null };
      frame.getRootNode = () => parentDoc;
      return release({ [HANDLE]: el }).result;
    };

    it("keeps focus when the parent document still points at the frame", () => {
      expect(editorInFrame("self")).toMatchObject({ tracked: true, focused: true });
    });

    it("reports focus lost when the parent document points elsewhere", () => {
      expect(editorInFrame({ tagName: "INPUT", id: "sidebar" })).toMatchObject({
        tracked: true,
        focused: false,
      });
    });

    it("keeps focus for a frame nested in an open shadow root", () => {
      // The walk steps out through `getRootNode()`, not `ownerDocument`, because
      // `ownerDocument` is NOT retargeted: an <iframe> inside an open shadow
      // root reports the TOP document, while that document's `activeElement`
      // retargets to the shadow HOST. Comparing the two never matches, and a
      // field that never lost focus is reported as blurred — the caller is then
      // told "emptied, but it no longer holds focus", after the clear already
      // ran and with nothing typed.
      const el: FakeEl = { tagName: "INPUT", value: "", isConnected: true };
      const host = { tagName: "MY-WIDGET" } as Record<string, unknown>;
      const frame = { tagName: "IFRAME" } as Record<string, unknown>;
      // Top document retargets to the host, exactly as a browser does.
      const topDoc = { activeElement: host };
      // The shadow root, identified by `host`, holds the frame.
      const shadow = { activeElement: frame, host };
      const frameDoc = { activeElement: el, defaultView: { frameElement: frame } };

      el.getRootNode = () => frameDoc as unknown as { activeElement: FakeEl | null };
      frame.getRootNode = () => shadow;
      host.getRootNode = () => topDoc;
      // A real iframe has BOTH, and they disagree here — which is the whole
      // point: `ownerDocument` is not retargeted, so stepping up through it
      // lands on the top document, whose activeElement is the host, not the
      // frame. Modelling both is what makes this test able to tell the two
      // reads apart.
      frame.ownerDocument = topDoc;
      host.ownerDocument = topDoc;

      expect(release({ [HANDLE]: el }).result).toMatchObject({ tracked: true, focused: true });
    });

    it("leaves the local verdict alone when an ancestor is cross-origin", () => {
      // Per HTML, `frameElement` is NULL across origins — it does not throw, and
      // a document with no browsing context has no `defaultView` either. Both
      // are "can't tell", and inventing a focus loss there would fail clears
      // that work today.
      const el: FakeEl = { tagName: "BODY", isContentEditable: true, isConnected: true };
      el.getRootNode = () =>
        ({ activeElement: el, defaultView: { frameElement: null } }) as unknown as {
          activeElement: FakeEl | null;
        };
      expect(release({ [HANDLE]: el }).result).toMatchObject({ tracked: true, focused: true });

      const noView: FakeEl = { tagName: "BODY", isContentEditable: true, isConnected: true };
      noView.getRootNode = () => ({ activeElement: noView });
      expect(release({ [HANDLE]: noView }).result).toMatchObject({ tracked: true, focused: true });
    });
  });

  describe("residue a text measurement cannot see", () => {
    // On a non-form target the value read is `textContent`, so content carrying
    // no text node measures 0 and a clear that emptied nothing reports success.
    // Measured on Chrome 150 against two contenteditables cancelling the same
    // `beforeinput`: the one holding text was refused, the one holding a single
    // `<img>` returned `cleared: true` with the image untouched.
    // The stub really MATCHES the selector against a list of child tags, rather
    // than returning a fixed answer — the whole point of the count is WHICH tags
    // it treats as residue, and a stub that ignores the selector leaves that
    // unpinned. (Widening the production selector by `br,div,p,span` then turns
    // every successfully-cleared rich-text editor into a hard failure, since
    // `<p><br></p>` is Blink's, Quill's and TinyMCE's empty state.)
    const withChildren = (childTags: string[]) => {
      const el = {
        tagName: "DIV",
        textContent: "",
        isConnected: true,
        querySelectorAll: (sel: string) => {
          const wanted = sel.split(",").map((s) => s.trim().toLowerCase());
          return childTags.filter((tag) => wanted.includes(tag.toLowerCase()));
        },
      };
      return release({ [HANDLE]: el }).result;
    };

    it("counts embedded content left behind", () => {
      expect(withChildren(["img"])).toMatchObject({ tracked: true, length: 0, nodes: 1 });
      expect(withChildren(["video", "hr", "svg"])).toMatchObject({ tracked: true, nodes: 3 });
    });

    it("counts nothing for an editor that really is empty", () => {
      expect(withChildren([])).toMatchObject({ tracked: true, length: 0, nodes: 0 });
    });

    it("never counts the structural leftovers an emptied editor keeps", () => {
      // Blink leaves a `<br>`; Quill/Lexical/TinyMCE leave a wrapped one. None
      // of it is residue, and counting any of it would fail every clear that
      // actually worked.
      expect(withChildren(["br", "div", "p", "span", "font"])).toMatchObject({
        tracked: true,
        length: 0,
        nodes: 0,
      });
    });

    it("never asks a form control, whose value is the whole story", () => {
      // A <textarea>'s child nodes are its DEFAULT value and never track
      // `value`, so counting them would report a cleared field as still full.
      const el = {
        tagName: "TEXTAREA",
        value: "",
        isConnected: true,
        querySelectorAll: () => {
          throw new Error("must not be asked");
        },
      };
      expect(release({ [HANDLE]: el }).result).toMatchObject({
        tracked: true,
        length: 0,
        nodes: 0,
      });
    });
  });

  it("reports untracked rather than a bogus success when the read throws", () => {
    // Treating an unreadable element as empty would turn every such page into a
    // silent clear success.
    const el = { isConnected: true } as Record<string, unknown>;
    Object.defineProperty(el, "tagName", {
      get() {
        throw new Error("hostile getter");
      },
    });
    expect(release({ [HANDLE]: el }).result).toEqual({ tracked: false });
  });
});
