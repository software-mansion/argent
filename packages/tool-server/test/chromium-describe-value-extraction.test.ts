import { describe, it, expect } from "vitest";

import { describeChromium } from "../src/tools/describe/platforms/chromium";
import type { ChromiumCdpApi } from "../src/blueprints/chromium-cdp";
import type { DescribeNode } from "../src/tools/describe/contract";

// find's Chromium `fill` clear rests on a load-bearing premise about the DOM
// walker (see find/index.ts): a form control's live `el.value` is NEVER surfaced
// — an <input> is described as label=placeholder with `value` empty — and a
// contenteditable reports ONLY its direct text nodes (an undercount that omits
// text nested in inline children). find.test.ts feeds a hand-built tree, so it
// asserts the *consequences* of that premise without ever exercising the walker
// that produces it: if describeChromium started exposing el.value, those tests
// would stay green while find's cap logic silently broke.
//
// This test runs the REAL in-page script — the exact `expression` describeChromium
// hands to Runtime.evaluate — against a minimal, faithful DOM stand-in, so the
// premise is verified against the actual walker. No jsdom/happy-dom dependency:
// the script's only free identifiers are `window`, `document`, and the HTML*/
// Element constructors, which we inject via `new Function`.

type Attrs = Record<string, string>;

class FakeEl {
  tagName: string;
  children: FakeEl[];
  // ownText walks childNodes and keeps only nodeType===3 (text) nodes, so a
  // contenteditable's direct text precedes its element children here, exactly as
  // "Hello <b>world</b>" lays out in the real DOM.
  childNodes: Array<FakeEl | { nodeType: number; nodeValue: string }>;
  shadowRoot: null = null;
  id: string;
  href?: string;
  value?: string;
  placeholder?: string;
  type?: string;
  alt?: string;
  title?: string;
  scrollHeight = 0;
  clientHeight = 0;
  scrollWidth = 0;
  clientWidth = 0;
  private attrs: Attrs;

  constructor(
    opts: {
      tag?: string;
      attrs?: Attrs;
      children?: FakeEl[];
      text?: string;
      id?: string;
      href?: string;
      value?: string;
      placeholder?: string;
      type?: string;
      alt?: string;
      title?: string;
    } = {}
  ) {
    this.tagName = (opts.tag ?? "div").toUpperCase();
    this.attrs = opts.attrs ?? {};
    this.children = opts.children ?? [];
    this.id = opts.id ?? "";
    if (opts.href !== undefined) this.href = opts.href;
    if (opts.value !== undefined) this.value = opts.value;
    if (opts.placeholder !== undefined) this.placeholder = opts.placeholder;
    if (opts.type !== undefined) this.type = opts.type;
    if (opts.alt !== undefined) this.alt = opts.alt;
    if (opts.title !== undefined) this.title = opts.title;
    this.childNodes = [
      ...(opts.text ? [{ nodeType: 3, nodeValue: opts.text }] : []),
      ...this.children,
    ];
  }
  getAttribute(name: string): string | null {
    return name in this.attrs ? this.attrs[name]! : null;
  }
  hasAttribute(name: string): boolean {
    return name in this.attrs;
  }
  // A non-zero rect keeps the walker's visibility check from pruning the node.
  getBoundingClientRect() {
    return { left: 10, top: 10, right: 110, bottom: 30, width: 100, height: 20 };
  }
}
// The script branches on `instanceof HTMLInputElement` etc.; subclassing lets us
// pass these constructors in as the corresponding globals.
class FakeInput extends FakeEl {}
class FakeTextArea extends FakeEl {}
class FakeImage extends FakeEl {}

// Run describeChromium end-to-end: its Runtime.evaluate `expression` (the real
// DESCRIBE_DOM_SCRIPT) is executed via `new Function` against the fake DOM.
async function walkDom(root: FakeEl): Promise<DescribeNode> {
  const win = {
    innerWidth: 1024,
    innerHeight: 768,
    getComputedStyle: () => ({
      visibility: "",
      display: "block",
      opacity: "",
      overflowY: "visible",
      overflowX: "visible",
    }),
  };
  const doc = { documentElement: root, getElementById: () => null };
  const api = {
    refreshViewport: async () => ({ width: win.innerWidth, height: win.innerHeight }),
    getViewport: () => ({ width: win.innerWidth, height: win.innerHeight }),
    cdp: {
      send: async (method: string, params?: { expression?: string }) => {
        if (method !== "Runtime.evaluate" || !params?.expression) return {};
        // Intentional: this test harness evaluates describeChromium's own page-eval
        // expression against injected fake DOM globals — the whole point is to run
        // that script string in-process. The input is our own constant, not
        // attacker-controlled, so the implied-eval rule doesn't apply here.
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const run = new Function(
          "window",
          "document",
          "HTMLInputElement",
          "HTMLTextAreaElement",
          "HTMLImageElement",
          "Element",
          `return (${params.expression});`
        );
        const value = run(win, doc, FakeInput, FakeTextArea, FakeImage, FakeEl) as string;
        return { result: { value } };
      },
    },
  } as unknown as ChromiumCdpApi;
  const { tree } = await describeChromium(api);
  return tree;
}

function findNode(
  node: DescribeNode,
  pred: (n: DescribeNode) => boolean
): DescribeNode | undefined {
  if (pred(node)) return node;
  for (const c of node.children ?? []) {
    const f = findNode(c, pred);
    if (f) return f;
  }
  return undefined;
}

describe("describeChromium — Chromium fill premise (value extraction)", () => {
  it("describes a populated <input> as label=placeholder with NO value", async () => {
    const input = new FakeInput({
      tag: "input",
      type: "email",
      placeholder: "Email",
      value: "typed@example.com", // the live value the walker must NOT surface
    });
    const tree = await walkDom(new FakeEl({ tag: "body", children: [input] }));

    const node = findNode(tree, (n) => n.label === "Email");
    expect(node).toBeDefined();
    // accessibleName prefers the placeholder; ownText (childNodes text) is empty
    // for a form control, so `value` is unset — the length is unknowable, which
    // is exactly why find's Chromium `fill` clears to the cap.
    expect(node!.value).toBeUndefined();
    expect(node!.value).not.toBe("typed@example.com");
  });

  it("describes a contenteditable with ONLY its direct text nodes (inline children undercounted)", async () => {
    // "Hello <b>world</b>" — "Hello " is a direct text node; "world" is nested in
    // an inline <b> child and must be excluded from the parent's value.
    const bold = new FakeEl({ tag: "b", text: "world" });
    const ce = new FakeEl({
      tag: "div",
      attrs: { contenteditable: "" },
      text: "Hello ",
      children: [bold],
    });
    const tree = await walkDom(new FakeEl({ tag: "body", children: [ce] }));

    // ownText collapses/trims whitespace, so "Hello " → "Hello".
    const node = findNode(tree, (n) => n.value === "Hello");
    expect(node).toBeDefined();
    // The undercount find must not trust: the real content is "Hello world" but
    // `value` reports only the 5-char direct text.
    expect(node!.value).toBe("Hello");
    expect(node!.value).not.toContain("world");
    // "world" surfaces on the nested child, never merged into the parent's value.
    expect(findNode(tree, (n) => n.value === "world")).toBeDefined();
  });
});
