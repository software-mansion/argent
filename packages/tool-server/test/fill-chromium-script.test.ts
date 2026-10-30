import { describe, expect, it } from "vitest";
import { buildChromiumFillScript } from "../src/tools/fill/chromium";

/**
 * Runs the real page script against a hand-built document. The mock carries
 * only what the script reads: the focused element (through an open shadow
 * root or a frame), its kind, `select()`, the document selection and
 * `execCommand`, which stores line breaks as LF outside an input and fires
 * `input` through the window's capture listeners, `createElement` for a
 * detached input that applies the HTML value sanitization of number and email
 * inputs, and the window's native value setters and Event.
 */

interface Page {
  doc: any;
  win: any;
  events: string[];
}

interface PageOptions {
  /** `execCommand` answers false and changes nothing, as a page that cancels it. */
  refuseCommands?: boolean;
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
    getSelection: () => ({
      removeAllRanges: () => (doc.selected = null),
      addRange: (range: { node: unknown }) => (doc.selected = range.node),
    }),
    createElement: () => {
      const probe = { type: "text", multiple: false, sanitized: "" };
      return Object.defineProperty(probe, "value", {
        get: () => probe.sanitized,
        set: (v: string) => (probe.sanitized = sanitize(probe.type, probe.multiple, v)),
      });
    },
    createRange: () => ({
      node: null as unknown,
      selectNodeContents(node: unknown) {
        this.node = node;
      },
    }),
    execCommand(command: string, _ui: boolean, value?: string) {
      if (options.refuseCommands) return false;
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
    innerText: "old text",
    parentElement: page.doc.body,
    ownerDocument: page.doc,
    ...props,
  };
}

async function runScript(page: Page, text: string): Promise<any> {
  // The script reads the page's globals, as Runtime.evaluate runs it.
  const g = globalThis as Record<string, unknown>;
  const saved = { document: g.document, window: g.window };
  g.document = page.doc;
  g.window = page.win;
  try {
    return await (0, eval)(buildChromiumFillScript(text));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete g[k];
      else g[k] = v;
    }
  }
}

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

  it("uses the native value setter and fires input and change when the page refuses the command", async () => {
    const page = makePage({ refuseCommands: true });
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
    const page = makePage({ rewrite: (t) => t.replace("ąę", "xn--2da4b") });
    const input = control(page, "INPUT", { type: "email" });
    page.doc.activeElement = input;
    await expect(runScript(page, "a@ąę.pl")).resolves.toEqual({ status: "ok", verified: false });
    expect(input._value).toBe("a@xn--2da4b.pl");
    expect(page.events).toEqual([]);
  });

  it("keeps the browser's rewrite when it equals the old text, as on a retry", async () => {
    const page = makePage({ rewrite: (t) => t.replace("ąę", "xn--2da4b") });
    const input = control(page, "INPUT", { type: "email", _value: "a@xn--2da4b.pl" });
    page.doc.activeElement = input;
    await expect(runScript(page, "a@ąę.pl")).resolves.toEqual({ status: "ok", verified: false });
    expect(input._value).toBe("a@xn--2da4b.pl");
    expect(page.events).toEqual([]);
    expect(page.win.listeners.size).toBe(0);
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
  const EMAIL = { type: "email" };
  const EMAILS = { type: "email", multiple: true };
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
    page.doc.activeElement = editable(page);
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
