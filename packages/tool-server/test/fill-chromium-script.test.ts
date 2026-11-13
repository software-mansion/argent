import { describe, expect, it } from "vitest";
import { buildChromiumFillScript } from "../src/tools/fill/chromium";

/**
 * Runs the real page script against a hand-built document. The mock carries
 * only what the script reads: the focused element (through an open shadow
 * root or a frame), its kind, `select()`, the document selection and
 * `execCommand`, which stores line breaks as LF outside an input and fires
 * `input` through the window's capture listeners, `createElementNS` for a
 * detached input that applies the HTML value sanitization of number and email
 * inputs and for a detached link that parses its href, the window's native
 * value setters and Event, and the computed overflow of an element.
 */

// Captured before a test shadows the page's URL global.
const NativeURL = URL;

interface Page {
  doc: any;
  win: any;
  events: string[];
}

interface PageOptions {
  /** `execCommand` answers false and changes nothing, as for a focused field hidden by `display: none`. */
  noEdit?: boolean;
  /** The page puts the old content back a task later, as a rich-text editor does. */
  restore?: boolean;
  /** The browser changes inserted text, as Chromium punycodes an email input's domain. */
  rewrite?: (text: string) => string;
  /** The edit's `input` never reaches fill's listener, as when an earlier window capture listener of the page stops it. */
  hideInput?: boolean;
}

/** HTML value sanitization for the input types the script probes. */
function sanitize(type: string, multiple: boolean, value: string): string {
  if (type === "number") return /^-?(\d+(\.\d+)?|\.\d+)([eE][-+]?\d+)?$/.test(value) ? value : "";
  if (type === "email") {
    const trim = (v: string) => v.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
    return multiple ? value.split(",").map(trim).join(",") : trim(value);
  }
  return value;
}

function makePage(options: PageOptions = {}): Page {
  const events: string[] = [];
  const valueAccessor = {
    get(this: any) {
      return this._value;
    },
    set(this: any, v: string) {
      this._value = v;
    },
    configurable: true,
  };
  class HTMLInputElement {}
  class HTMLTextAreaElement {}
  Object.defineProperty(HTMLInputElement.prototype, "value", valueAccessor);
  Object.defineProperty(HTMLTextAreaElement.prototype, "value", valueAccessor);
  class Event {
    constructor(readonly type: string) {}
  }
  // Only capture listeners: a listener on the field can stop the bubble phase.
  const listeners = new Set<() => void>();
  const win = {
    HTMLInputElement,
    HTMLTextAreaElement,
    Event,
    listeners,
    getComputedStyle: (el: { overflow?: string }) => ({
      overflowX: el.overflow ?? "visible",
      overflowY: el.overflow ?? "visible",
    }),
    addEventListener: (type: string, fn: () => void, capture?: boolean) =>
      type === "input" && capture === true && listeners.add(fn),
    removeEventListener: (type: string, fn: () => void, capture?: boolean) =>
      type === "input" && capture === true && listeners.delete(fn),
  };
  const body: any = { tagName: "BODY", isContentEditable: false, parentElement: null };
  const doc: any = {
    body,
    documentElement: { tagName: "HTML" },
    defaultView: win,
    activeElement: body,
    selected: null as unknown,
    // A test sets `caret` to place the selection: anchorNode, anchorOffset, focusNode, focusOffset.
    caret: {},
    getSelection: () => ({
      anchorNode: null,
      focusNode: null,
      ...doc.caret,
      removeAllRanges: () => (doc.selected = null),
      addRange: (range: { node: unknown }) => (doc.selected = range.node),
    }),
    // Any other namespace makes a plain element, which has no sanitization.
    createElementNS: (ns: string, name: string) => {
      if (name === "a") {
        let href = "";
        const parse = () => {
          try {
            return new NativeURL(href);
          } catch {
            return null;
          }
        };
        return {
          get href() {
            return parse()?.href ?? href;
          },
          set href(v: string) {
            href = v;
          },
          get hostname() {
            return parse()?.hostname ?? "";
          },
        };
      }
      const probe = { type: "text", multiple: false, sanitized: "" };
      if (ns !== "http://www.w3.org/1999/xhtml") return probe;
      return Object.defineProperty(probe, "value", {
        get: () => probe.sanitized,
        set: (v: string) => (probe.sanitized = sanitize(probe.type, probe.multiple, v)),
      });
    },
    // As in an HTML document; a test of another document type replaces it.
    createElement: (name: string) => doc.createElementNS("http://www.w3.org/1999/xhtml", name),
    createRange: () => ({
      node: null as unknown,
      selectNodeContents(node: unknown) {
        this.node = node;
      },
    }),
    execCommand(command: string, _ui: boolean, value?: string) {
      if (options.noEdit) return false;
      const el = doc.selected;
      if (!el) return false;
      const key = "_value" in el ? "_value" : "innerText";
      const before = el[key];
      if (command === "insertText") {
        const text = options.rewrite ? options.rewrite(value!) : value!;
        el[key] = el.tagName === "INPUT" ? text : text.replace(/\r\n?/g, "\n");
      } else if (command === "delete") el[key] = "";
      else return false;
      if (!options.hideInput) for (const listener of win.listeners) listener();
      if (options.restore) setTimeout(() => (el[key] = before), 0);
      return true;
    },
  };
  return { doc, win, events };
}

function control(page: Page, tag: "INPUT" | "TEXTAREA", props: Record<string, unknown> = {}) {
  const proto =
    tag === "INPUT" ? page.win.HTMLInputElement.prototype : page.win.HTMLTextAreaElement.prototype;
  const el = Object.create(proto);
  Object.assign(el, {
    tagName: tag,
    type: tag === "INPUT" ? "text" : "textarea",
    _value: "old value",
    disabled: false,
    readOnly: false,
    isContentEditable: false,
    parentElement: page.doc.body,
    ownerDocument: page.doc,
    select() {
      page.doc.selected = el;
    },
    dispatchEvent(event: { type: string }) {
      page.events.push(event.type);
      return true;
    },
    ...props,
  });
  return el;
}

function editable(page: Page, props: Record<string, unknown> = {}) {
  return {
    tagName: "DIV",
    isContentEditable: true,
    hasAttribute: () => false,
    innerText: "old text",
    parentElement: page.doc.body,
    ownerDocument: page.doc,
    getRootNode: () => page.doc,
    ...props,
  };
}

async function runScript(
  page: Page,
  text: string,
  pageGlobals: Record<string, unknown> = {}
): Promise<any> {
  // The script reads the page's globals, as Runtime.evaluate runs it.
  const g = globalThis as Record<string, unknown>;
  const names = ["document", "window", ...Object.keys(pageGlobals)];
  const saved = Object.fromEntries(names.map((k) => [k, g[k]]));
  Object.assign(g, { document: page.doc, window: page.win }, pageGlobals);
  try {
    return await (0, eval)(buildChromiumFillScript(text));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete g[k];
      else g[k] = v;
    }
  }
}

const EMAIL = { type: "email" };
const EMAILS = { type: "email", multiple: true };

describe("fill page script", () => {
  it("replaces an input's value through the page's own insert command", async () => {
    const page = makePage();
    const input = control(page, "INPUT");
    page.doc.activeElement = input;
    await expect(runScript(page, "hello")).resolves.toEqual({
      status: "ok",
      verified: true,
    });
    expect(input._value).toBe("hello");
    // execCommand fires the page's events itself; nothing synthetic was sent.
    expect(page.events).toEqual([]);
  });

  it("clears with an empty text", async () => {
    const page = makePage();
    const input = control(page, "TEXTAREA");
    page.doc.activeElement = input;
    await expect(runScript(page, "")).resolves.toEqual({ status: "ok", verified: true });
    expect(input._value).toBe("");
  });

  it("carries quotes, newlines and non-ASCII through intact", async () => {
    const page = makePage();
    const input = control(page, "TEXTAREA");
    page.doc.activeElement = input;
    const text = 'a "quoted"\nZażółć 😀 你好 </script>';
    const answer = await runScript(page, text);
    expect(answer).toMatchObject({ status: "ok", verified: true });
    expect(input._value).toBe(text);
  });

  it("descends into an open shadow root", async () => {
    const page = makePage();
    const input = control(page, "INPUT");
    page.doc.activeElement = { tagName: "MY-FIELD", shadowRoot: { activeElement: input } };
    await expect(runScript(page, "x")).resolves.toMatchObject({ status: "ok", verified: true });
    expect(input._value).toBe("x");
  });

  it("uses the native value setter and fires input and change when the command edits nothing", async () => {
    const page = makePage({ noEdit: true });
    const input = control(page, "INPUT", { type: "number" });
    page.doc.activeElement = input;
    await expect(runScript(page, "42")).resolves.toEqual({
      status: "ok",
      verified: true,
    });
    expect(input._value).toBe("42");
    expect(page.events).toEqual(["input", "change"]);
  });

  it("keeps the browser's rewrite of the edit instead of forcing the text", async () => {
    const page = makePage({ rewrite: (t) => t.toUpperCase() });
    const input = control(page, "INPUT");
    page.doc.activeElement = input;
    await expect(runScript(page, "new")).resolves.toEqual({ status: "ok", verified: false });
    expect(input._value).toBe("NEW");
    expect(page.events).toEqual([]);
  });

  it("keeps the browser's rewrite when it equals the old text, as on a retry", async () => {
    const page = makePage({ rewrite: (t) => t.toUpperCase() });
    const input = control(page, "INPUT", { _value: "NEW" });
    page.doc.activeElement = input;
    await expect(runScript(page, "new")).resolves.toEqual({ status: "ok", verified: false });
    expect(input._value).toBe("NEW");
    expect(page.events).toEqual([]);
    expect(page.win.listeners.size).toBe(0);
  });

  // What Chrome stores for each, read from a focused input after insertText.
  it.each([
    ["an IDN address", EMAIL, "a@bücher.de", "a@xn--bcher-kva.de"],
    ["an uppercase IDN domain", EMAIL, "a@BÜCHER.de", "a@xn--bcher-kva.de"],
    ["ß, as ss", EMAIL, "a@straße.de", "a@strasse.de"],
    ["a capital sharp s", EMAIL, "a@ẞü.de", "a@xn--ss-yka.de"],
    ["a final sigma", EMAIL, "a@ς.gr", "a@xn--4xa.gr"],
    ["a zero-width joiner", EMAIL, "a@a\u200dü.de", "a@xn--a-eha.de"],
    ["a zero-width non-joiner", EMAIL, "a@b\u200cc.de", "a@bc.de"],
    ["a numeric last label", EMAIL, "a@ü.123", "a@xn--tda.123"],
    ["a one-digit last label", EMAIL, "a@ü.1", "a@xn--tda.1"],
    ["two IDN addresses", EMAILS, "a@bücher.de,b@ąę.pl", "a@xn--bcher-kva.de,b@xn--2da4b.pl"],
    ["an IDN address after an uppercase ASCII one", EMAILS, "A@B.CO,c@ü.de", "A@B.CO,c@xn--tda.de"],
    [
      "an IDN address after one Chrome keeps as typed",
      EMAILS,
      "Ü@ü.de,a@ü.de",
      "Ü@ü.de,a@xn--tda.de",
    ],
  ])(
    "verifies an email input that stores the domain of %s in ASCII, without forcing the text",
    async (_n, props, text, stored) => {
      const page = makePage({ rewrite: () => stored });
      const input = control(page, "INPUT", props);
      page.doc.activeElement = input;
      await expect(runScript(page, text)).resolves.toEqual({ status: "ok", verified: true });
      expect(input._value).toBe(stored);
      expect(page.events).toEqual([]);
    }
  );

  it("verifies an IDN address on a page whose own URL global replaces the builtin", async () => {
    const page = makePage({ rewrite: () => "a@xn--bcher-kva.de" });
    const input = control(page, "INPUT", EMAIL);
    page.doc.activeElement = input;
    await expect(
      runScript(page, "a@bücher.de", { URL: "http://localhost:3000/api" })
    ).resolves.toEqual({
      status: "ok",
      verified: true,
    });
  });

  it.each([
    ["a text input holding an IDN domain in ASCII", { type: "text" }, "a@ü.de", "a@xn--tda.de"],
    ["an email input holding another domain", EMAIL, "a@ü.de", "a@xn--zz.de"],
    ["an email input holding another local part", EMAIL, "a@ü.de", "b@xn--tda.de"],
    ["an email input holding an ASCII domain lowercased", EMAIL, "a@B.CO", "a@b.co"],
    ["an email input holding a text without @ in ASCII", EMAIL, "ü", "xn--tda"],
    ["a single email input holding one of two addresses", EMAIL, "a@ü.de,b@ü.de", "a@xn--tda.de"],
    [
      "a multiple email input holding one of two addresses",
      EMAILS,
      "a@ü.de,b@ü.de",
      "a@xn--tda.de",
    ],
    [
      "a single email input holding each comma-separated part of a domain in ASCII",
      EMAIL,
      "a@ü,b.de",
      "a@xn--tda,b.de",
    ],
  ])("does not verify %s", async (_n, props, text, stored) => {
    const page = makePage({ rewrite: () => stored });
    const input = control(page, "INPUT", props);
    page.doc.activeElement = input;
    await expect(runScript(page, text)).resolves.toEqual({ status: "ok", verified: false });
    expect(input._value).toBe(stored);
    expect(page.events).toEqual([]);
  });

  it("keeps a rewrite whose input event the page stopped before fill saw it", async () => {
    const page = makePage({ rewrite: (t) => t.toUpperCase(), hideInput: true });
    const input = control(page, "INPUT");
    page.doc.activeElement = input;
    await expect(runScript(page, "new")).resolves.toEqual({ status: "ok", verified: false });
    expect(input._value).toBe("NEW");
    expect(page.events).toEqual([]);
  });

  it("falls back to the value setter in a document without editing commands, as SVG", async () => {
    const page = makePage();
    page.doc.execCommand = () => {
      throw new Error("execCommand is only supported on HTML documents");
    };
    const input = control(page, "INPUT");
    page.doc.activeElement = input;
    await expect(runScript(page, "new")).resolves.toEqual({ status: "ok", verified: true });
    expect(input._value).toBe("new");
    expect(page.events).toEqual(["input", "change"]);
    expect(page.win.listeners.size).toBe(0);
  });

  it("refuses a number input's invalid text in a document without editing commands, as SVG", async () => {
    const page = makePage();
    page.doc.execCommand = () => {
      throw new Error("execCommand is only supported on HTML documents");
    };
    // An SVG document's createElement makes an element in no namespace.
    page.doc.createElement = () => page.doc.createElementNS(null, "input");
    const input = control(page, "INPUT", { type: "number", _value: "42" });
    page.doc.activeElement = input;
    await expect(runScript(page, "abc")).resolves.toEqual({
      status: "unsupported",
      detail: "a number input holds only a valid number",
    });
    expect(input._value).toBe("42");
  });

  it("listens in a frame's own window, keeping its rewrite on a retry", async () => {
    const page = makePage();
    const frame = makePage({ rewrite: (t) => t.toUpperCase() });
    const input = control(frame, "INPUT", { _value: "NEW" });
    frame.doc.activeElement = input;
    page.doc.activeElement = {
      tagName: "IFRAME",
      contentWindow: frame.win,
      contentDocument: frame.doc,
    };
    await expect(runScript(page, "new")).resolves.toEqual({ status: "ok", verified: false });
    expect(input._value).toBe("NEW");
    expect(frame.events).toEqual([]);
  });

  it.each([
    ["an input", "INPUT", "text", "abcdef"],
    ["a textarea", "TEXTAREA", "textarea", "abcdef"],
    ["a search input", "INPUT", "search", "abcd"],
    ["a url input", "INPUT", "url", "abcd"],
    ["a tel input", "INPUT", "tel", "abcd"],
    ["an email input", "INPUT", "email", "a@bc"],
    ["a password input, in UTF-16 units", "INPUT", "password", "😀😀"],
  ] as const)(
    "refuses text over the maxlength of %s without touching it",
    async (_n, tag, type, text) => {
      const page = makePage();
      const field = control(page, tag, { type, maxLength: 3 });
      page.doc.activeElement = field;
      await expect(runScript(page, text)).resolves.toEqual({
        status: "unsupported",
        detail: "the text is longer than its maxlength of 3",
      });
      expect(field._value).toBe("old value");
      expect(page.doc.selected).toBeNull();
    }
  );

  it("refuses any text in a field with a maxlength of 0", async () => {
    const page = makePage();
    const input = control(page, "INPUT", { maxLength: 0, _value: "" });
    page.doc.activeElement = input;
    await expect(runScript(page, "a")).resolves.toEqual({
      status: "unsupported",
      detail: "the text is longer than its maxlength of 0",
    });
    expect(input._value).toBe("");
  });

  it("counts each CRLF in a textarea as the one line break it stores", async () => {
    const page = makePage();
    const area = control(page, "TEXTAREA", { maxLength: 5 });
    page.doc.activeElement = area;
    await expect(runScript(page, "a\r\nb\r\nc")).resolves.toEqual({ status: "ok", verified: true });
    expect(area._value).toBe("a\nb\nc");
    area._value = "old value";
    await expect(runScript(page, "ab\r\ncde")).resolves.toEqual({
      status: "unsupported",
      detail: "the text is longer than its maxlength of 5",
    });
    expect(area._value).toBe("old value");
  });

  it.each([
    ["text up to the maxlength", { maxLength: 3 }, "abc"],
    ["a number input, which ignores maxlength", { type: "number", maxLength: 2 }, "123"],
    ["an unlimited field", { maxLength: -1 }, "abcdef"],
  ])("fills %s", async (_n, props, text) => {
    const page = makePage();
    const input = control(page, "INPUT", props);
    page.doc.activeElement = input;
    await expect(runScript(page, text)).resolves.toEqual({ status: "ok", verified: true });
    expect(input._value).toBe(text);
  });

  const NUMBER = { type: "number" };
  const NOT_A_NUMBER = "a number input holds only a valid number";
  const SPACED = "an email input drops the whitespace around an address";

  it.each([
    ["a number input", "abc", NUMBER, NOT_A_NUMBER],
    ["a number input", "+5", NUMBER, NOT_A_NUMBER],
    ["an email input", " a@b.co ", EMAIL, SPACED],
    ["a multiple email input", "a@b.co, c@d.co", EMAILS, SPACED],
  ])("refuses %s given %j, without touching it", async (_n, text, props, detail) => {
    const page = makePage();
    const input = control(page, "INPUT", { ...props, _value: "42" });
    page.doc.activeElement = input;
    await expect(runScript(page, text)).resolves.toEqual({ status: "unsupported", detail });
    expect(input._value).toBe("42");
    expect(page.doc.selected).toBeNull();
  });

  it.each([
    ["a number input", "1e3", NUMBER],
    ["a number input", "", NUMBER],
    ["an email input", "a@b.co", EMAIL],
    ["a multiple email input", "a@b.co,c@d.co", EMAILS],
    ["a single email input", "a@b.co, c@d.co", EMAIL],
  ])("fills %s with %j", async (_n, text, props) => {
    const page = makePage();
    const input = control(page, "INPUT", { ...props, _value: "42" });
    page.doc.activeElement = input;
    await expect(runScript(page, text)).resolves.toEqual({ status: "ok", verified: true });
    expect(input._value).toBe(text);
  });

  it.each(["IFRAME", "FRAME", "OBJECT"])("descends into a same-origin %s", async (tagName) => {
    const page = makePage();
    const input = control(page, "INPUT");
    page.doc.activeElement = {
      tagName,
      contentWindow: {},
      contentDocument: { activeElement: input },
    };
    await expect(runScript(page, "x")).resolves.toEqual({ status: "ok", verified: true });
    expect(input._value).toBe("x");
  });

  it.each(["IFRAME", "OBJECT"])(
    "refuses focus in a cross-origin %s, whose document it cannot read",
    async (tagName) => {
      const page = makePage();
      page.doc.activeElement = { tagName, contentWindow: {}, contentDocument: null };
      await expect(runScript(page, "x")).resolves.toEqual({
        status: "unsupported",
        detail: "focus is in a cross-origin frame, which fill cannot reach",
      });
    }
  );

  // What document.activeElement is for focus inside a closed shadow root: the host.
  const closedHost = (tagName: string, props: Record<string, unknown> = {}) => ({
    tagName,
    isContentEditable: false,
    hasAttribute: (name: string) => name in ((props.attributes as object) ?? {}),
    scrollHeight: 20,
    clientHeight: 20,
    scrollWidth: 100,
    clientWidth: 100,
    getRootNode: () => (globalThis as any).document,
    ...props,
  });
  const CLOSED = {
    status: "unsupported",
    detail: "focus is in a closed shadow root, which fill cannot reach",
  };

  // Every element attachShadow takes, as a custom element or a listed built-in.
  it.each([
    "MY-FIELD",
    ..."ARTICLE ASIDE BLOCKQUOTE DIV FOOTER H1 H2 H3 H4 H5 H6 HEADER MAIN NAV P SECTION SPAN".split(
      " "
    ),
  ])("refuses focus in a closed shadow root of a %s, which it cannot read", async (tagName) => {
    const page = makePage();
    page.doc.activeElement = closedHost(tagName);
    await expect(runScript(page, "x")).resolves.toEqual(CLOSED);
  });

  it.each(["A", "LI", "SUMMARY", "TABLE", "svg"])(
    "answers no_focus for a focused %s, which attachShadow refuses",
    async (tagName) => {
      const page = makePage();
      page.doc.activeElement = closedHost(tagName);
      await expect(runScript(page, "x")).resolves.toEqual({ status: "no_focus" });
    }
  );

  it.each([
    ["a tabindex", { attributes: { tabindex: "0" } }],
    ["scrolling down", { scrollHeight: 500, overflow: "auto" }],
    ["scrolling sideways", { scrollWidth: 500, overflow: "scroll" }],
  ])("answers no_focus for a host that %s makes focusable itself", async (_n, props) => {
    const page = makePage();
    page.doc.activeElement = closedHost("MY-FIELD", props);
    await expect(runScript(page, "x")).resolves.toEqual({ status: "no_focus" });
  });

  it.each(["visible", "hidden", "clip"])(
    "refuses focus in a closed shadow root of a host overflowing with overflow %s, which no user scrolls",
    async (overflow) => {
      const page = makePage();
      page.doc.activeElement = closedHost("MY-FIELD", {
        scrollHeight: 500,
        scrollWidth: 500,
        overflow,
      });
      await expect(runScript(page, "x")).resolves.toEqual(CLOSED);
    }
  );

  it("refuses focus in a closed shadow root of a host inside an editor, leaving the editor as it was", async () => {
    const page = makePage();
    const editor = editable(page);
    page.doc.activeElement = closedHost("X-CHIP", {
      isContentEditable: true,
      parentElement: editor,
    });
    await expect(runScript(page, "x")).resolves.toEqual(CLOSED);
    expect(editor.innerText).toBe("old text");
    expect(page.doc.selected).toBeNull();
  });

  it("fills a tab stop inside an editor, which can hold focus itself", async () => {
    const page = makePage();
    const child = editable(page, {
      parentElement: editable(page),
      hasAttribute: (name: string) => name === "tabindex",
    });
    page.doc.activeElement = child;
    await expect(runScript(page, "x")).resolves.toEqual({ status: "ok", verified: true });
    expect(child.innerText).toBe("x");
  });

  // A host that can hold focus itself, second in its parent, with the selection placed at `at`.
  const selfFocusableHost = (
    page: Page,
    at: (
      host: any,
      parent: any
    ) => [anchorNode: unknown, anchorOffset: number, focusNode?: unknown, focusOffset?: number],
    props: Record<string, unknown> = {}
  ) => {
    const parent: any = { childNodes: [{}], getRootNode: () => page.doc };
    const host: any = closedHost("MY-FIELD", {
      attributes: { tabindex: "-1" },
      parentNode: parent,
      ...props,
    });
    parent.childNodes.push(host);
    const [anchorNode, anchorOffset, focusNode = anchorNode, focusOffset = anchorOffset] = at(
      host,
      parent
    );
    page.doc.caret = { anchorNode, anchorOffset, focusNode, focusOffset };
    page.doc.activeElement = host;
    return host;
  };
  const beforeHost = (_host: any, parent: any): [unknown, number] => [parent, 1];

  // How the browser shows a selection inside a closed shadow root: collapsed before its host.
  it.each([
    ["a tabindex", {}],
    ["scrolling", { attributes: {}, scrollHeight: 500, overflow: "auto" }],
  ])(
    "refuses focus in a closed shadow root of a host that %s makes focusable, whose selection sits there",
    async (_n, props) => {
      const page = makePage();
      selfFocusableHost(page, beforeHost, props);
      await expect(runScript(page, "x")).resolves.toEqual(CLOSED);
    }
  );

  it("refuses focus in a closed shadow root of an editing host, leaving its text as it was", async () => {
    const page = makePage();
    const host = selfFocusableHost(page, beforeHost, {
      attributes: {},
      isContentEditable: true,
      parentElement: page.doc.body,
      innerText: "old text",
    });
    await expect(runScript(page, "x")).resolves.toEqual(CLOSED);
    expect(host.innerText).toBe("old text");
    expect(page.doc.selected).toBeNull();
  });

  it.each([
    ["its closed shadow root", (host: any) => ({ getRootNode: () => ({ host }) })],
    [
      "a shadow root nested in it",
      (host: any) => ({ getRootNode: () => ({ host: { getRootNode: () => ({ host }) } }) }),
    ],
  ])(
    "refuses focus in a closed shadow root whose page set the selection in %s",
    async (_n, node) => {
      const page = makePage();
      selfFocusableHost(page, (host) => [node(host), 1]);
      await expect(runScript(page, "x")).resolves.toEqual(CLOSED);
    }
  );

  it("reads the selection of the host's own tree, a shadow root showing a closed one as before the host", async () => {
    const page = makePage();
    const parent: any = { childNodes: [{}] };
    // The document shows the selection before the open host the shadow root belongs to.
    page.doc.caret = {
      anchorNode: page.doc.body,
      anchorOffset: 0,
      focusNode: page.doc.body,
      focusOffset: 0,
    };
    const root = {
      host: {},
      getRootNode: () => page.doc,
      getSelection: () => ({
        anchorNode: parent,
        anchorOffset: 1,
        focusNode: parent,
        focusOffset: 1,
      }),
    };
    const host = closedHost("MY-FIELD", {
      attributes: { tabindex: "0" },
      parentNode: parent,
      getRootNode: () => root,
    });
    parent.childNodes.push(host);
    page.doc.activeElement = { tagName: "X-OUTER", shadowRoot: { activeElement: host } };
    await expect(runScript(page, "x")).resolves.toEqual(CLOSED);
  });

  it.each([
    ["after the host", (_h: any, parent: any): [unknown, number] => [parent, 2]],
    [
      "reaching out of the host",
      (_h: any, parent: any): [unknown, number, unknown, number] => [parent, 1, parent, 0],
    ],
    [
      "in an unrelated shadow root",
      (): [unknown, number] => [
        { getRootNode: () => ({ host: { getRootNode: () => (globalThis as any).document } }) },
        0,
      ],
    ],
    ["nowhere", (): [unknown, number] => [null, 0]],
  ])("answers no_focus for a host focused itself with the selection %s", async (_n, at) => {
    const page = makePage();
    selfFocusableHost(page, at);
    await expect(runScript(page, "x")).resolves.toEqual({ status: "no_focus" });
  });

  it("answers no_focus for an open shadow root's host focused itself with the selection in its shadow root", async () => {
    const page = makePage();
    selfFocusableHost(page, beforeHost, { shadowRoot: { activeElement: null } });
    await expect(runScript(page, "x")).resolves.toEqual({ status: "no_focus" });
  });

  it("refuses focus in an <embed>, whose document it cannot read", async () => {
    const page = makePage();
    page.doc.activeElement = { tagName: "EMBED" };
    await expect(runScript(page, "x")).resolves.toEqual({
      status: "unsupported",
      detail: "focus is in an <embed>, which fill cannot reach",
    });
  });

  it.each([
    ["a textarea", (page: Page) => control(page, "TEXTAREA"), "_value"],
    ["a contenteditable", (page: Page) => editable(page), "innerText"],
  ] as const)("verifies %s that stores a CR or CRLF as LF", async (_n, make, key) => {
    const page = makePage();
    const field = make(page);
    page.doc.activeElement = field;
    await expect(runScript(page, "a\r\nb\rc")).resolves.toEqual({ status: "ok", verified: true });
    expect(field[key]).toBe("a\nb\nc");
  });

  it("clears a number input that shows text it cannot parse", async () => {
    const page = makePage();
    const validity = { badInput: true };
    const input = control(page, "INPUT", { type: "number", _value: "", validity });
    page.doc.activeElement = input;
    const execCommand = page.doc.execCommand;
    page.doc.execCommand = (...args: [string, boolean, string?]) => {
      if (args[0] === "delete") validity.badInput = false;
      return execCommand(...args);
    };
    await expect(runScript(page, "")).resolves.toEqual({ status: "ok", verified: true });
    expect(validity.badInput).toBe(false);
  });

  it("does not verify a number input that still shows text it cannot parse", async () => {
    const page = makePage();
    const input = control(page, "INPUT", {
      type: "number",
      _value: "",
      validity: { badInput: true },
    });
    page.doc.activeElement = input;
    await expect(runScript(page, "")).resolves.toEqual({ status: "ok", verified: false });
  });

  it("answers no_focus for an <object> that shows an image, which has no document", async () => {
    const page = makePage();
    page.doc.activeElement = { tagName: "OBJECT", contentWindow: null, contentDocument: null };
    await expect(runScript(page, "x")).resolves.toEqual({ status: "no_focus" });
  });

  it("sets a contenteditable's text", async () => {
    const page = makePage();
    const div = editable(page);
    page.doc.activeElement = div;
    await expect(runScript(page, "rich")).resolves.toEqual({
      status: "ok",
      verified: true,
    });
    expect(div.innerText).toBe("rich");
  });

  it("reports an editor that restores its content as not verified", async () => {
    const page = makePage({ restore: true });
    page.doc.activeElement = editable(page);
    await expect(runScript(page, "new")).resolves.toMatchObject({
      status: "ok",
      verified: false,
    });
  });

  it.each(["date", "time", "month", "week", "datetime-local"])(
    "refuses a %s input without touching it",
    async (type) => {
      const page = makePage();
      const input = control(page, "INPUT", { type });
      page.doc.activeElement = input;
      await expect(runScript(page, "x")).resolves.toMatchObject({ status: "unsupported" });
      expect(input._value).toBe("old value");
    }
  );

  it("refuses a newline for an <input>, without touching it, and takes it in a textarea", async () => {
    const page = makePage();
    const input = control(page, "INPUT");
    page.doc.activeElement = input;
    await expect(runScript(page, "a\nb")).resolves.toMatchObject({ status: "unsupported" });
    expect(input._value).toBe("old value");

    const area = control(page, "TEXTAREA");
    page.doc.activeElement = area;
    await expect(runScript(page, "a\nb")).resolves.toMatchObject({ status: "ok", verified: true });
  });

  it.each([
    ["disabled", { disabled: true }],
    ["read-only", { readOnly: true }],
  ])("refuses a %s input", async (_name, props) => {
    const page = makePage();
    page.doc.activeElement = control(page, "INPUT", props);
    await expect(runScript(page, "x")).resolves.toMatchObject({ status: "unsupported" });
  });

  it("refuses a document that is editable as a whole", async () => {
    const page = makePage();
    page.doc.body.isContentEditable = true;
    // A tab stop, which can hold focus itself.
    page.doc.activeElement = editable(page, {
      hasAttribute: (name: string) => name === "tabindex",
    });
    await expect(runScript(page, "x")).resolves.toMatchObject({ status: "unsupported" });
  });

  it.each([
    ["the body", (page: Page) => page.doc.body],
    ["a button", () => ({ tagName: "BUTTON", isContentEditable: false })],
    ["a checkbox", (page: Page) => control(page, "INPUT", { type: "checkbox" })],
    ["nothing", () => null],
  ])("answers no_focus when %s has focus", async (_name, focused) => {
    const page = makePage();
    page.doc.activeElement = focused(page);
    await expect(runScript(page, "x")).resolves.toEqual({ status: "no_focus" });
  });

  it("answers an error, without detail, when the page throws", async () => {
    const page = makePage();
    const input = control(page, "INPUT");
    input.select = () => {
      throw new Error("boom");
    };
    page.doc.getSelection = () => {
      throw new Error("old value leaks here");
    };
    page.doc.activeElement = editable(page);
    await expect(runScript(page, "x")).resolves.toEqual({ status: "error" });
  });

  it("answers an error for a contenteditable in a document without editing commands", async () => {
    const page = makePage();
    page.doc.execCommand = () => {
      throw new Error("execCommand is only supported on HTML documents");
    };
    const div = editable(page);
    page.doc.activeElement = div;
    await expect(runScript(page, "x")).resolves.toEqual({ status: "error" });
    expect(page.win.listeners.size).toBe(0);
  });

  it("answers no text for a password input", async () => {
    const page = makePage();
    const input = control(page, "INPUT", { type: "password", _value: "previous-secret" });
    page.doc.activeElement = input;
    const answer = await runScript(page, "next-secret");
    expect(answer).toEqual({ status: "ok", verified: true });
    expect(JSON.stringify(answer)).not.toContain("secret");
  });
});
