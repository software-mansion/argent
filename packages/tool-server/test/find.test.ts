import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AXServiceApi, AXDescribeResponse } from "../src/blueprints/ax-service";
import type { AndroidDevtoolsApi } from "../src/blueprints/android-devtools";
import type { ChromiumCdpApi } from "../src/blueprints/chromium-cdp";
import { createFindTool, findMatches, locatorField } from "../src/tools/find";
import type { DescribeNode } from "../src/tools/describe/contract";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";

const IOS_UDID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const ANDROID_SERIAL = "emulator-5554";
const CHROMIUM_ID = "chromium-cdp-9222";

// ── Mocks (mirror await-ui-element.test.ts, plus an invokeTool spy) ───────────

function makeSequencedAXService(
  responses: AXDescribeResponse[],
  opts: { degraded?: boolean } = {}
): { api: AXServiceApi; calls: () => number } {
  let i = 0;
  const api: AXServiceApi = {
    degraded: opts.degraded ?? false,
    describe: async () => responses[Math.min(i++, responses.length - 1)]!,
    alertCheck: async () => false,
    ping: async () => true,
  };
  return { api, calls: () => i };
}

function axResponse(elements: AXDescribeResponse["elements"]): AXDescribeResponse {
  return { alertVisible: false, screenFrame: { width: 440, height: 956 }, elements };
}

type SubInvocation = { toolId: string; args: Record<string, unknown> };

// Registry mock that serves the iOS AX / Android devtools services AND records
// the gesture-tap / keyboard sub-tool invocations `find` dispatches, returning
// canned results for each.
function makeMockRegistry(opts: { ax?: AXServiceApi; android?: AndroidDevtoolsApi } = {}) {
  const invocations: SubInvocation[] = [];
  const registry = {
    resolveService: vi.fn(async (urn: string) => {
      if (urn.startsWith("AXService:")) {
        if (!opts.ax) throw new Error("no AX service configured");
        return opts.ax;
      }
      if (urn.startsWith("AndroidDevtools:")) {
        if (!opts.android) throw new Error("no Android devtools configured");
        return opts.android;
      }
      throw new Error(`unexpected service: ${urn}`);
    }),
    invokeTool: vi.fn(async (toolId: string, args: Record<string, unknown>) => {
      invocations.push({ toolId, args });
      if (toolId === "gesture-tap") return { tapped: true, timestampMs: 1234 };
      if (toolId === "keyboard") {
        if (typeof args.key === "string") return { typed: args.key, keys: 1 };
        const text = typeof args.text === "string" ? args.text : "";
        return { typed: text, keys: text.length };
      }
      return {};
    }),
  } as any;
  return { registry, invocations };
}

function makeChromiumApi(treeJson: unknown): ChromiumCdpApi {
  return {
    refreshViewport: async () => ({ width: 1024, height: 768 }),
    getViewport: () => ({ width: 1024, height: 768 }),
    cdp: {
      send: async (method: string) => {
        if (method === "Runtime.evaluate") {
          return { result: { value: JSON.stringify({ tree: treeJson, truncated: false }) } };
        }
        return {};
      },
    },
  } as unknown as ChromiumCdpApi;
}

// A Chromium api whose evaluate always throws — the fetch-failure case.
function makeFailingChromiumApi(): ChromiumCdpApi {
  return {
    refreshViewport: async () => ({ width: 1024, height: 768 }),
    getViewport: () => ({ width: 1024, height: 768 }),
    cdp: {
      send: async () => {
        throw new Error("renderer detached");
      },
    },
  } as unknown as ChromiumCdpApi;
}

const FRAME = { x: 0.1, y: 0.4, width: 0.8, height: 0.05 };
const CENTER = { x: FRAME.x + FRAME.width / 2, y: FRAME.y + FRAME.height / 2 };

// ── Pure locator matching (hand-built trees, no platform adapter) ────────────

describe("find — locator matching", () => {
  const node = (over: Partial<DescribeNode>): DescribeNode => ({
    role: "AXStaticText",
    frame: FRAME,
    children: [],
    ...over,
  });
  const tree = (children: DescribeNode[]): DescribeNode => ({
    role: "AXGroup",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children,
  });

  it("matches by label / value / role / id independently", () => {
    const n = node({
      label: "Sign In",
      value: "v-text",
      identifier: "login-btn",
      role: "AXButton",
    });
    expect(locatorField(n, "label", "sign")).toBe("label");
    expect(locatorField(n, "value", "v-text")).toBe("value");
    expect(locatorField(n, "role", "button")).toBe("role");
    expect(locatorField(n, "id", "login")).toBe("id");
    // label-only locator must NOT match on the value/role/id
    expect(locatorField(n, "label", "login-btn")).toBeNull();
    expect(locatorField(n, "value", "Sign In")).toBeNull();
  });

  it("is case-insensitive substring", () => {
    expect(locatorField(node({ label: "Continue" }), "label", "TINU")).toBe("label");
  });

  it("`text` matches label OR value, preferring label", () => {
    expect(locatorField(node({ label: "Status", value: "Done" }), "text", "done")).toBe("value");
    expect(locatorField(node({ label: "Done", value: "x" }), "text", "done")).toBe("label");
  });

  it("`any` spans label/value/id but NOT role", () => {
    expect(locatorField(node({ identifier: "submit" }), "any", "submit")).toBe("id");
    expect(locatorField(node({ value: "hello" }), "any", "hello")).toBe("value");
    // role is deliberately excluded from `any`
    expect(locatorField(node({ role: "AXButton" }), "any", "button")).toBeNull();
    expect(locatorField(node({ role: "AXButton" }), "role", "button")).toBe("role");
  });

  it("findMatches collects every match but never the synthetic root", () => {
    const t = tree([node({ role: "AXGroup", label: "inner" }), node({ label: "leaf" })]);
    expect(findMatches(t, "role", "AXGroup")).toHaveLength(1); // only the inner AXGroup child
    expect(findMatches(t, "any", "nomatch")).toHaveLength(0);
  });
});

// ── Tool execution ───────────────────────────────────────────────────────────

describe("find tool", () => {
  beforeEach(() => {
    __resetDepCacheForTests();
    __primeDepCacheForTests(["xcrun", "adb"]);
  });

  const iosTool = (ax: AXServiceApi) => {
    const { registry, invocations } = makeMockRegistry({ ax });
    return { tool: createFindTool(registry), invocations, registry };
  };
  const keyboardCalls = (inv: SubInvocation[]) => inv.filter((i) => i.toolId === "keyboard");
  const backspaces = (inv: SubInvocation[]) => inv.filter((i) => i.args.key === "backspace");

  it("exposes the find id", () => {
    expect(createFindTool(makeMockRegistry().registry).id).toBe("find");
  });

  // ── tap ──
  it("taps the matched element's centre via gesture-tap", async () => {
    const { api } = makeSequencedAXService([
      axResponse([{ label: "Sign In", frame: FRAME, traits: ["button"] }]),
    ]);
    const { tool, invocations } = iosTool(api);

    const result = await tool.execute(
      {},
      { udid: IOS_UDID, query: "Sign In", by: "text", action: "tap", index: 0 }
    );

    expect(result.found).toBe(true);
    expect(result.actionResult).toMatchObject({ kind: "tap", tapped: true });
    const tap = invocations.find((i) => i.toolId === "gesture-tap")!;
    expect(tap.args).toMatchObject({ udid: IOS_UDID, x: CENTER.x, y: CENTER.y });
  });

  it("defaults action to tap and by to any", async () => {
    const { api } = makeSequencedAXService([
      axResponse([{ label: "Hello World", frame: FRAME, traits: [] }]),
    ]);
    const { tool, invocations } = iosTool(api);
    const params = tool.zodSchema!.parse({ udid: IOS_UDID, query: "hello" });
    const result = await tool.execute({}, params as never);
    expect(result.action).toBe("tap");
    expect(result.by).toBe("any");
    expect(invocations.some((i) => i.toolId === "gesture-tap")).toBe(true);
  });

  // ── focus ──
  it("`focus` taps the match centre and reports kind:focus", async () => {
    const { api } = makeSequencedAXService([
      axResponse([{ label: "Email", frame: FRAME, traits: ["textfield"] }]),
    ]);
    const { tool, invocations } = iosTool(api);
    const result = await tool.execute(
      {},
      { udid: IOS_UDID, query: "Email", by: "label", action: "focus", index: 0 }
    );
    expect(result.found).toBe(true);
    expect(result.actionResult).toMatchObject({ kind: "focus", focused: true });
    const tap = invocations.find((i) => i.toolId === "gesture-tap")!;
    expect(tap.args).toMatchObject({ x: CENTER.x, y: CENTER.y });
    expect(keyboardCalls(invocations)).toHaveLength(0);
  });

  // ── index / ambiguity ──
  it("acts on the index-th match in reading order, reports matchCount and an ambiguity note", async () => {
    const top = { label: "Item", frame: { x: 0.1, y: 0.2, width: 0.5, height: 0.05 }, traits: [] };
    const bottom = {
      label: "Item",
      frame: { x: 0.1, y: 0.8, width: 0.5, height: 0.05 },
      traits: [],
    };
    const { api } = makeSequencedAXService([axResponse([bottom, top])]);
    const { tool, invocations } = iosTool(api);

    const result = await tool.execute(
      {},
      { udid: IOS_UDID, query: "Item", by: "label", action: "tap", index: 1 }
    );

    expect(result.matchCount).toBe(2);
    expect(result.found).toBe(true);
    expect(result.note).toMatch(/2 elements matched.*acted on index 1/i);
    const tap = invocations.find((i) => i.toolId === "gesture-tap")!;
    expect(tap.args.y).toBeCloseTo(0.8 + 0.05 / 2); // index 1 = the lower one
  });

  it("read-only multi-match note says `selected`, not `acted on`", async () => {
    const a = { label: "Row", frame: { x: 0.1, y: 0.2, width: 0.5, height: 0.05 }, traits: [] };
    const b = { label: "Row", frame: { x: 0.1, y: 0.5, width: 0.5, height: 0.05 }, traits: [] };
    const { api } = makeSequencedAXService([axResponse([a, b])]);
    const { tool } = iosTool(api);
    const result = await tool.execute(
      {},
      { udid: IOS_UDID, query: "Row", by: "label", action: "get-text", index: 0 }
    );
    expect(result.note).toMatch(/selected index 0/i);
    expect(result.note).not.toMatch(/acted on/i);
  });

  it("returns found:false with an out-of-range note when index exceeds matches", async () => {
    const { api } = makeSequencedAXService([
      axResponse([{ label: "Only", frame: FRAME, traits: [] }]),
    ]);
    const { tool, invocations } = iosTool(api);

    const result = await tool.execute(
      {},
      { udid: IOS_UDID, query: "Only", by: "label", action: "tap", index: 3 }
    );

    expect(result.found).toBe(false);
    expect(result.note).toMatch(/out of range/i);
    expect(invocations.some((i) => i.toolId === "gesture-tap")).toBe(false);
  });

  // ── zero-area / not actionable (Chromium mock returns the tree verbatim) ──
  it("does not tap a match with a zero-area frame", async () => {
    const tree = {
      role: "html",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        {
          role: "button",
          label: "Ghost",
          frame: { x: 0.1, y: 0.4, width: 0, height: 0 },
          children: [],
        },
      ],
    };
    const { registry, invocations } = makeMockRegistry({});
    const tool = createFindTool(registry);

    const result = await tool.execute(
      { chromium: makeChromiumApi(tree) },
      { udid: CHROMIUM_ID, query: "Ghost", by: "label", action: "tap", index: 0 }
    );

    expect(result.found).toBe(false);
    expect(result.matchCount).toBe(0); // no actionable (visible) matches
    expect(result.note).toMatch(/none is visible|zero-area/i);
    expect(invocations.some((i) => i.toolId === "gesture-tap")).toBe(false);
  });

  // ── exists (single-shot) ──
  it("`exists` reports presence in a single check (no polling)", async () => {
    const { api, calls } = makeSequencedAXService([
      axResponse([{ label: "Present", frame: FRAME, traits: [] }]),
    ]);
    const { tool } = iosTool(api);
    const found = await tool.execute(
      {},
      { udid: IOS_UDID, query: "Present", by: "label", action: "exists", index: 0 }
    );
    expect(found.found).toBe(true);
    expect(found.actionResult).toBeUndefined();
    expect(found.match?.label).toBe("Present");
    expect(calls()).toBe(1);
  });

  it("`exists` is true even for a zero-area (not-visible) match", async () => {
    const tree = {
      role: "html",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        {
          role: "div",
          label: "Hidden",
          frame: { x: 0.1, y: 0.4, width: 0, height: 0 },
          children: [],
        },
      ],
    };
    const { registry } = makeMockRegistry({});
    const tool = createFindTool(registry);
    const result = await tool.execute(
      { chromium: makeChromiumApi(tree) },
      { udid: CHROMIUM_ID, query: "Hidden", by: "label", action: "exists", index: 0 }
    );
    expect(result.found).toBe(true);
  });

  it("`exists` returns found:false for a missing element", async () => {
    const { api } = makeSequencedAXService([axResponse([])]);
    const { tool } = iosTool(api);
    const result = await tool.execute(
      {},
      { udid: IOS_UDID, query: "Nope", by: "label", action: "exists", index: 0 }
    );
    expect(result.found).toBe(false);
    expect(result.matchCount).toBe(0);
  });

  // ── wait (polls) ──
  it("`wait` polls until the element becomes visible", async () => {
    const { api, calls } = makeSequencedAXService([
      axResponse([]),
      axResponse([{ label: "Loaded", frame: FRAME, traits: [] }]),
    ]);
    const { tool } = iosTool(api);
    const result = await tool.execute(
      {},
      {
        udid: IOS_UDID,
        query: "Loaded",
        by: "label",
        action: "wait",
        index: 0,
        timeoutMs: 2000,
        pollIntervalMs: 10,
      }
    );
    expect(result.found).toBe(true);
    expect(result.actionResult).toBeUndefined();
    expect(calls()).toBeGreaterThan(1);
  });

  it("`wait` times out with a note when the element never appears", async () => {
    const { api } = makeSequencedAXService([axResponse([])]);
    const { tool } = iosTool(api);
    const result = await tool.execute(
      {},
      {
        udid: IOS_UDID,
        query: "Never",
        by: "label",
        action: "wait",
        index: 0,
        timeoutMs: 30,
        pollIntervalMs: 10,
      }
    );
    expect(result.found).toBe(false);
    expect(result.note).toMatch(/no element matched/i);
    expect(result.elapsed).toBeGreaterThanOrEqual(30);
  });

  it("polls before acting when timeoutMs is set on a tap", async () => {
    const { api, calls } = makeSequencedAXService([
      axResponse([]),
      axResponse([{ label: "Appears", frame: FRAME, traits: ["button"] }]),
    ]);
    const { tool, invocations } = iosTool(api);
    const result = await tool.execute(
      {},
      {
        udid: IOS_UDID,
        query: "Appears",
        by: "label",
        action: "tap",
        index: 0,
        timeoutMs: 2000,
        pollIntervalMs: 10,
      }
    );
    expect(result.found).toBe(true);
    expect(calls()).toBeGreaterThan(1);
    expect(invocations.some((i) => i.toolId === "gesture-tap")).toBe(true);
  });

  // ── type ──
  it("`type` focuses (centre) then types the text", async () => {
    const { api } = makeSequencedAXService([
      axResponse([{ label: "Email", frame: FRAME, traits: ["textfield"] }]),
    ]);
    const { tool, invocations } = iosTool(api);
    const result = await tool.execute(
      {},
      { udid: IOS_UDID, query: "Email", by: "label", action: "type", text: "hi", index: 0 }
    );
    expect(result.found).toBe(true);
    expect(result.actionResult).toMatchObject({ kind: "type", typed: "hi" });
    expect(invocations.map((i) => i.toolId)).toEqual(["gesture-tap", "keyboard"]);
    // focus tap is the centre, NOT a trailing-edge bias
    expect(invocations[0]!.args).toMatchObject({ x: CENTER.x, y: CENTER.y });
    expect(backspaces(invocations)).toHaveLength(0);
  });

  // ── fill ──
  it("`fill` focuses (centre), clears the field's text length + buffer, then types", async () => {
    const { api } = makeSequencedAXService([
      axResponse([{ label: "Field", value: "abcd", frame: FRAME, traits: ["textfield"] }]),
    ]);
    const { tool, invocations } = iosTool(api);
    const result = await tool.execute(
      {},
      { udid: IOS_UDID, query: "Field", by: "label", action: "fill", text: "new", index: 0 }
    );
    expect(result.found).toBe(true);
    // clear length = max(label "Field"=5, value "abcd"=4) + CLEAR_BUFFER 2
    expect(backspaces(invocations)).toHaveLength(5 + 2);
    expect(result.actionResult).toMatchObject({ kind: "fill", typed: "new", clearedChars: 7 });
    expect(invocations[0]!.toolId).toBe("gesture-tap");
    expect(invocations[0]!.args).toMatchObject({ x: CENTER.x, y: CENTER.y }); // centre focus
    expect(invocations.at(-1)).toMatchObject({ toolId: "keyboard", args: { text: "new" } });
  });

  it("`fill` clears text carried in `label` when `value` is unset (Android bare EditText)", async () => {
    // An Android EditText WITHOUT a content-desc surfaces its typed text as
    // `label` with `value` unset. Sizing the clear from `value` alone would send
    // only CLEAR_BUFFER backspaces and type the new text on top of the leftover
    // (filling "old@example.com" with "new@x.io" → "old@example.cnew@x.io").
    // max(value,label) sizes it from `label` here — reliable on Android.
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<hierarchy rotation="0">` +
      `<node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">` +
      `<node text="old@example.com" class="android.widget.EditText" clickable="true" focusable="true" bounds="[50,300][1030,400]" />` +
      `</node>` +
      `</hierarchy>`;
    const android: AndroidDevtoolsApi = {
      getHierarchy: async () => ({ xml }),
      getScreenSize: async () => ({ width: 1080, height: 2400, rotation: 0 }),
    } as unknown as AndroidDevtoolsApi;
    const { registry, invocations } = makeMockRegistry({ android });
    const tool = createFindTool(registry);
    const result = await tool.execute(
      {},
      {
        udid: ANDROID_SERIAL,
        query: "old@example.com",
        by: "label",
        action: "fill",
        text: "new@x.io",
        index: 0,
      }
    );
    expect(result.found).toBe(true);
    expect(result.match).toMatchObject({ matchedField: "label", label: "old@example.com" });
    // 15 (label length) + CLEAR_BUFFER 2 — NOT the 2 the value-only path would send
    expect(backspaces(invocations)).toHaveLength(15 + 2);
    expect((result.actionResult as { clearedChars: number }).clearedChars).toBe(17);
    expect(result.note ?? "").not.toMatch(/capped/i);
    expect(invocations.at(-1)).toMatchObject({ toolId: "keyboard", args: { text: "new@x.io" } });
  });

  it("`fill` on Chromium clears to the cap and warns — the live text isn't in the a11y snapshot", async () => {
    // describeChromium.accessibleName prefers a static aria-label / placeholder
    // over el.value, and value (ownText) is always empty for a form control, so a
    // populated <input placeholder="Email"> is described as label="Email",
    // value=unset — the live content length is unknowable. Sizing from `label`
    // (5) would leave a longer value behind silently; instead we clear up to the
    // cap and flag it.
    const tree = {
      role: "textbox",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        {
          role: "textbox",
          label: "Email", // a placeholder, NOT the live value
          frame: { x: 0.1, y: 0.4, width: 0.8, height: 0.05 },
          children: [],
        },
      ],
    };
    const { registry, invocations } = makeMockRegistry({});
    const tool = createFindTool(registry);
    const result = await tool.execute(
      { chromium: makeChromiumApi(tree) },
      { udid: CHROMIUM_ID, query: "Email", by: "label", action: "fill", text: "new@x.io", index: 0 }
    );
    expect(result.found).toBe(true);
    // full MAX_CLEAR_CHARS clear, not the 7 that label="Email" (5)+buffer implies
    expect(backspaces(invocations)).toHaveLength(64);
    expect((result.actionResult as { clearedChars: number }).clearedChars).toBe(64);
    expect(result.note).toMatch(/chromium/i);
    expect(result.note).toMatch(/verify/i);
    expect(result.note ?? "").not.toMatch(/capped/i); // it's the unknown-length caveat, not the cap
    expect(invocations.at(-1)).toMatchObject({ toolId: "keyboard", args: { text: "new@x.io" } });
  });

  it("`fill` sizes from the field text, and only warns `capped` past MAX_CLEAR_CHARS chars", async () => {
    const fillIos = async (value: string) => {
      const svc = makeSequencedAXService([
        axResponse([{ label: "F", value, frame: FRAME, traits: ["textfield"] }]),
      ]);
      const t = iosTool(svc.api);
      const r = await t.tool.execute(
        {},
        { udid: IOS_UDID, query: "F", by: "label", action: "fill", text: "x", index: 0 }
      );
      return { backspaces: backspaces(t.invocations).length, note: r.note ?? "", result: r };
    };

    // short field → value.length + CLEAR_BUFFER, no cap warning
    const short = await fillIos("abcd");
    expect(short.backspaces).toBe(4 + 2);
    expect(short.note).not.toMatch(/capped/i);

    // exactly MAX_CLEAR_CHARS chars → the 64 backspaces fully clear it, so NO
    // spurious cap warning (the off-by-CLEAR_BUFFER boundary).
    const exact = await fillIos("a".repeat(64));
    expect(exact.backspaces).toBe(64);
    expect(exact.note).not.toMatch(/capped/i);

    // longer than the cap → genuinely may be incomplete → warn.
    const over = await fillIos("a".repeat(65));
    expect(over.backspaces).toBe(64);
    expect(over.note).toMatch(/capped/i);
  });

  it("`fill` warns on a masked password field with an unknown length", async () => {
    const tree = {
      role: "html",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        {
          role: "textbox",
          label: "Password",
          value: "",
          password: true,
          frame: { x: 0.1, y: 0.4, width: 0.8, height: 0.05 },
          children: [],
        },
      ],
    };
    const { registry } = makeMockRegistry({});
    const tool = createFindTool(registry);
    const result = await tool.execute(
      { chromium: makeChromiumApi(tree) },
      { udid: CHROMIUM_ID, query: "Password", by: "label", action: "fill", text: "pw", index: 0 }
    );
    expect(result.match?.flags?.password).toBe(true);
    expect(result.note).toMatch(/password/i);
  });

  // ── get-text / get-attrs ──
  it("`get-text` returns label + value, no device action", async () => {
    const { api } = makeSequencedAXService([
      axResponse([{ label: "Title", value: "Subtitle", frame: FRAME, traits: [] }]),
    ]);
    const { tool, invocations } = iosTool(api);
    const result = await tool.execute(
      {},
      { udid: IOS_UDID, query: "Title", by: "label", action: "get-text", index: 0 }
    );
    expect(result.actionResult).toMatchObject({ kind: "get-text", text: "Title Subtitle" });
    expect(invocations).toHaveLength(0);
  });

  it("`get-text` joins only the present fields (label only → no trailing space)", async () => {
    const { api } = makeSequencedAXService([
      axResponse([{ label: "JustLabel", frame: FRAME, traits: [] }]),
    ]);
    const { tool } = iosTool(api);
    const result = await tool.execute(
      {},
      { udid: IOS_UDID, query: "JustLabel", by: "label", action: "get-text", index: 0 }
    );
    expect((result.actionResult as { text: string }).text).toBe("JustLabel");
  });

  it("`get-attrs` returns the attributes in `match` (role, frame, tapPoint, matchedField), no actionResult", async () => {
    const { api } = makeSequencedAXService([
      axResponse([{ label: "Card", frame: FRAME, traits: ["button"] }]),
    ]);
    const { tool, invocations } = iosTool(api);
    const result = await tool.execute(
      {},
      { udid: IOS_UDID, query: "Card", by: "any", action: "get-attrs", index: 0 }
    );
    expect(result.actionResult).toBeUndefined();
    expect(result.match).toMatchObject({
      role: "AXButton",
      label: "Card",
      matchedField: "label",
      tapPoint: { x: CENTER.x, y: CENTER.y },
    });
    expect(invocations).toHaveLength(0);
  });

  // ── diagnostics / errors ──
  it("surfaces the degraded-AX restart hint on a not-found note", async () => {
    const { api } = makeSequencedAXService([axResponse([])], { degraded: true });
    const { tool } = iosTool(api);
    const result = await tool.execute(
      {},
      { udid: IOS_UDID, query: "Anything", by: "label", action: "tap", index: 0 }
    );
    expect(result.found).toBe(false);
    expect(result.note).toMatch(/boot-device|restart/i);
  });

  it("surfaces the degraded-AX hint on an `exists` not-found note too", async () => {
    const { api } = makeSequencedAXService([axResponse([])], { degraded: true });
    const { tool } = iosTool(api);
    const result = await tool.execute(
      {},
      { udid: IOS_UDID, query: "Anything", by: "label", action: "exists", index: 0 }
    );
    expect(result.found).toBe(false);
    expect(result.note).toMatch(/boot-device|restart/i);
  });

  it("surfaces a tree-fetch failure in the note (Chromium renderer detached)", async () => {
    const { registry } = makeMockRegistry({});
    const tool = createFindTool(registry);
    const result = await tool.execute(
      { chromium: makeFailingChromiumApi() },
      { udid: CHROMIUM_ID, query: "Continue", by: "text", action: "exists", index: 0 }
    );
    expect(result.found).toBe(false);
    expect(result.note).toMatch(/tree fetch failed/i);
    expect(result.note).toMatch(/renderer detached/);
  });

  // ── cancellation ──
  it("aborts promptly when the signal fires mid-wait", async () => {
    const { api } = makeSequencedAXService([axResponse([])]);
    const { tool } = iosTool(api);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const result = await tool.execute(
      {},
      {
        udid: IOS_UDID,
        query: "Nope",
        by: "label",
        action: "wait",
        index: 0,
        timeoutMs: 5000,
        pollIntervalMs: 10,
      },
      { signal: controller.signal } as never
    );
    expect(result.found).toBe(false);
    expect(result.note).toMatch(/cancel/i);
    expect(result.elapsed).toBeLessThan(2000);
  });

  it("aborts a `fill` during the focus settle, before any keystroke", async () => {
    const { api } = makeSequencedAXService([
      axResponse([{ label: "Field", value: "abc", frame: FRAME, traits: ["textfield"] }]),
    ]);
    const { tool, invocations } = iosTool(api);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20); // fires during the ~150ms iOS settle
    const result = await tool.execute(
      {},
      { udid: IOS_UDID, query: "Field", by: "label", action: "fill", text: "new", index: 0 },
      { signal: controller.signal } as never
    );
    expect(result.found).toBe(false);
    expect(result.note).toMatch(/cancel/i);
    // the focus tap may have fired, but no keystrokes (clear/type) ran
    expect(keyboardCalls(invocations)).toHaveLength(0);
  });

  it("aborts a `fill` when the signal fires mid-clear, before typing the text", async () => {
    // Abort after the first backspace (during the clear loop, past the focus
    // settle): find must bail before pushing `text` in and must not report success.
    const { api } = makeSequencedAXService([
      axResponse([{ label: "Field", value: "abcdef", frame: FRAME, traits: ["textfield"] }]),
    ]);
    const controller = new AbortController();
    const invocations: SubInvocation[] = [];
    const registry = {
      resolveService: async (urn: string) => {
        if (urn.startsWith("AXService:")) return api;
        throw new Error(`unexpected service: ${urn}`);
      },
      invokeTool: async (toolId: string, args: Record<string, unknown>) => {
        invocations.push({ toolId, args });
        if (toolId === "gesture-tap") return { tapped: true, timestampMs: 1 };
        if (toolId === "keyboard" && args.key === "backspace") {
          controller.abort(); // abort as soon as the clear loop sends a key
          return { typed: "backspace", keys: 1 };
        }
        if (toolId === "keyboard") {
          const text = typeof args.text === "string" ? args.text : "";
          return { typed: text, keys: text.length };
        }
        return {};
      },
    } as any;
    const tool = createFindTool(registry);

    const result = await tool.execute(
      {},
      { udid: IOS_UDID, query: "Field", by: "label", action: "fill", text: "new", index: 0 },
      { signal: controller.signal } as never
    );

    expect(result.found).toBe(false);
    expect(result.note).toMatch(/cancel/i);
    // the text was never typed (no keyboard call carrying `text`)
    expect(
      invocations.some((i) => i.toolId === "keyboard" && typeof i.args.text === "string")
    ).toBe(false);
  });

  // ── Android branch ──
  it("drives the Android devtools path and taps a node", async () => {
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<hierarchy rotation="0">` +
      `<node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">` +
      `<node text="Sign in" resource-id="com.demo:id/signin" class="android.widget.Button" clickable="true" bounds="[100,200][980,320]" />` +
      `</node>` +
      `</hierarchy>`;
    const android: AndroidDevtoolsApi = {
      getHierarchy: async () => ({ xml }),
      getScreenSize: async () => ({ width: 1080, height: 2400, rotation: 0 }),
    } as unknown as AndroidDevtoolsApi;
    const { registry, invocations } = makeMockRegistry({ android });
    const tool = createFindTool(registry);
    const result = await tool.execute(
      {},
      { udid: ANDROID_SERIAL, query: "Sign in", by: "text", action: "tap", index: 0 }
    );
    expect(result.found).toBe(true);
    expect(invocations.some((i) => i.toolId === "gesture-tap")).toBe(true);
  });

  // ── Chromium branch ──
  it("matches a DOM node and dispatches the tap on Chromium", async () => {
    const tree = {
      role: "html",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        {
          role: "button",
          label: "Continue",
          clickable: true,
          frame: { x: 0.4, y: 0.8, width: 0.2, height: 0.05 },
          children: [],
        },
      ],
    };
    const { registry, invocations } = makeMockRegistry({});
    const tool = createFindTool(registry);
    const result = await tool.execute(
      { chromium: makeChromiumApi(tree) },
      { udid: CHROMIUM_ID, query: "Continue", by: "text", action: "tap", index: 0 }
    );
    expect(result.found).toBe(true);
    const tap = invocations.find((i) => i.toolId === "gesture-tap")!;
    expect(tap.args.udid).toBe(CHROMIUM_ID);
    expect(tap.args.x as number).toBeCloseTo(0.5);
    expect(tap.args.y as number).toBeCloseTo(0.825);
  });

  // ── Schema ──
  describe("schema validation", () => {
    const schema = createFindTool(makeMockRegistry().registry).zodSchema!;

    it("requires udid and query", () => {
      expect(schema.safeParse({ query: "x" }).success).toBe(false);
      expect(schema.safeParse({ udid: IOS_UDID }).success).toBe(false);
    });

    it("rejects fill/type without text", () => {
      expect(schema.safeParse({ udid: IOS_UDID, query: "x", action: "fill" }).success).toBe(false);
      expect(schema.safeParse({ udid: IOS_UDID, query: "x", action: "type" }).success).toBe(false);
    });

    it("accepts fill/type with text and applies defaults", () => {
      const parsed = schema.parse({ udid: IOS_UDID, query: "x", action: "fill", text: "y" });
      expect(parsed.by).toBe("any");
      expect(parsed.index).toBe(0);
    });

    it("rejects an unknown action / by", () => {
      expect(schema.safeParse({ udid: IOS_UDID, query: "x", action: "swipe" }).success).toBe(false);
      expect(schema.safeParse({ udid: IOS_UDID, query: "x", by: "placeholder" }).success).toBe(
        false
      );
    });
  });
});
