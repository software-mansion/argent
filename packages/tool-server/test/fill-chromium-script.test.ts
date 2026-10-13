import { describe, expect, it } from "vitest";
import { buildChromiumFillScript } from "../src/tools/fill/chromium";

/**
 * Runs the real page script against a hand-built document. The mock carries
 * only what the script reads: the focused element (through an open shadow
 * root), its kind, `select()`, the document selection and `execCommand`, and
 * the window's native value setters and Event.
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
  const win = { HTMLInputElement, HTMLTextAreaElement, Event };
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
      if (command === "insertText") el[key] = value;
      else if (command === "delete") el[key] = "";
      else return false;
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
      length: 5,
    });
    expect(input._value).toBe("hello");
    // execCommand fires the page's events itself; nothing synthetic was sent.
    expect(page.events).toEqual([]);
  });

  it("clears with an empty text", async () => {
    const page = makePage();
    const input = control(page, "TEXTAREA");
    page.doc.activeElement = input;
    await expect(runScript(page, "")).resolves.toEqual({ status: "ok", verified: true, length: 0 });
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
      length: 2,
    });
    expect(input._value).toBe("42");
    expect(page.events).toEqual(["input", "change"]);
  });

  it("sets a contenteditable's text", async () => {
    const page = makePage();
    const div = editable(page);
    page.doc.activeElement = div;
    await expect(runScript(page, "rich")).resolves.toEqual({
      status: "ok",
      verified: true,
      length: 4,
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

  it("answers no text for a password input", async () => {
    const page = makePage();
    const input = control(page, "INPUT", { type: "password", _value: "previous-secret" });
    page.doc.activeElement = input;
    const answer = await runScript(page, "next-secret");
    expect(answer).toEqual({ status: "ok", verified: true, length: 11 });
    expect(JSON.stringify(answer)).not.toContain("secret");
  });
});
