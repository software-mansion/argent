import { beforeEach, describe, expect, it, vi } from "vitest";

// describeIos probes isTvOsSimulator, which shells `xcrun simctl list` (~100ms,
// uncached for an unknown UDID). Stub it so these tests stay deterministic and
// off the host's simulators — every iOS fixture here is a plain mobile device.
vi.mock("../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-devices")>()),
  isTvOsSimulator: vi.fn(async () => false),
}));

// `find` probes getAndroidRuntimeKind for an acting action to keep itself
// read-only on TV (and to fail closed on an indeterminate probe). Stub it to a
// plain "mobile" verdict so the Android acting tests don't shell adb; the
// Android-TV / indeterminate tests override it per-case.
//
// ALSO stub isAndroidTv: the Android *describe* path (`describeAndroid`) calls it
// directly to attach a TV hint, and its real implementation shells `adb`. Leaving
// it unmocked passes only where adb happens to be on PATH (a dev laptop) and
// fails on an adb-less CI runner (the tree never parses → found:false). Mocking
// both keeps every Android path adb-free regardless of the host.
vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  getAndroidRuntimeKind: vi.fn(async () => "mobile"),
  isAndroidTv: vi.fn(async () => false),
}));

import { isTvOsSimulator } from "../src/utils/ios-devices";
import { getAndroidRuntimeKind, isAndroidTv } from "../src/utils/adb";
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
// `fill` focuses at the field's bottom-trailing corner (95% across, 90% down),
// not its centre, so the clear's leftward backspaces start from the end of the
// text on the last line (handles multi-line fields, not just long single lines).
const TRAILING = { x: FRAME.x + FRAME.width * 0.95, y: FRAME.y + FRAME.height * 0.9 };

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
    // Reset call history AND implementation so a per-test TV override can't leak
    // into a later test — mockClear alone keeps the sticky implementation, which
    // would let a `mockResolvedValue("tv")` bleed into a following acting test.
    vi.mocked(isTvOsSimulator).mockReset();
    vi.mocked(isTvOsSimulator).mockResolvedValue(false);
    vi.mocked(getAndroidRuntimeKind).mockReset();
    vi.mocked(getAndroidRuntimeKind).mockResolvedValue("mobile");
    // isAndroidTv is used by the describe-android hint path (not find's guard);
    // keep it false so the Android tree fetch never shells adb on any host.
    vi.mocked(isAndroidTv).mockReset();
    vi.mocked(isAndroidTv).mockResolvedValue(false);
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

  it("`exists` reports the topmost VISIBLE match, not a zero-area ghost that sorts above it", async () => {
    // Two matches: a zero-area ghost at y=0.1 (sorts first in reading order) and a
    // real visible one lower at y=0.5. exists must report the VISIBLE match — the
    // element a subsequent tap would hit — not the ghost with its degenerate
    // tapPoint. (Every other exists test has ≤1 match, so the .filter(isVisible)
    // that picks the visible one was never exercised — T1.)
    const tree = {
      role: "html",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        {
          role: "button",
          label: "Submit",
          frame: { x: 0.1, y: 0.1, width: 0, height: 0 }, // zero-area ghost, sorts first
          children: [],
        },
        {
          role: "button",
          label: "Submit",
          frame: { x: 0.1, y: 0.5, width: 0.6, height: 0.05 }, // the real, visible one
          children: [],
        },
      ],
    };
    const { registry } = makeMockRegistry({});
    const tool = createFindTool(registry);
    const result = await tool.execute(
      { chromium: makeChromiumApi(tree) },
      { udid: CHROMIUM_ID, query: "Submit", by: "label", action: "exists", index: 0 }
    );
    expect(result.found).toBe(true);
    expect(result.matchCount).toBe(2); // both counted for a read-only presence check
    // Reported match is the visible one (y≈0.5), NOT the zero-area ghost (y≈0.1).
    expect(result.match!.frame.y).toBeCloseTo(0.5, 2);
    expect(result.match!.visible).toBe(true);
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
  it("`fill` focuses at the trailing edge, clears the field's text length + buffer, then types", async () => {
    const { api } = makeSequencedAXService([
      axResponse([{ label: "Field", value: "abcd", frame: FRAME, traits: ["textfield"] }]),
    ]);
    const { tool, invocations } = iosTool(api);
    const result = await tool.execute(
      {},
      { udid: IOS_UDID, query: "Field", by: "label", action: "fill", text: "new", index: 0 }
    );
    expect(result.found).toBe(true);
    // clear length = the live text length (value "abcd"=4) + CLEAR_BUFFER 2. The
    // static placeholder label "Field" is NOT counted now that `value` is present.
    expect(backspaces(invocations)).toHaveLength(4 + 2);
    expect(result.actionResult).toMatchObject({ kind: "fill", typed: "new", backspacesSent: 6 });
    expect(invocations[0]!.toolId).toBe("gesture-tap");
    // focus is biased to the bottom-trailing corner so the caret starts at the
    // end, NOT the centre where a mid-text caret could strand right-hand residue.
    expect(invocations[0]!.args).toMatchObject({ x: TRAILING.x, y: TRAILING.y });
    expect(invocations[0]!.args.x as number).toBeGreaterThan(CENTER.x);
    expect(invocations[0]!.args.y as number).toBeGreaterThan(CENTER.y);
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
    expect((result.actionResult as { backspacesSent: number }).backspacesSent).toBe(17);
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
    expect((result.actionResult as { backspacesSent: number }).backspacesSent).toBe(64);
    expect(result.note).toMatch(/chromium/i);
    expect(result.note).toMatch(/verify/i);
    expect(result.note ?? "").not.toMatch(/capped/i); // it's the unknown-length caveat, not the cap
    expect(invocations.at(-1)).toMatchObject({ toolId: "keyboard", args: { text: "new@x.io" } });
  });

  it("`fill` on a Chromium contenteditable clears to the cap despite a non-empty (undercounted) value", async () => {
    // A contenteditable is described with `value` = its DIRECT text nodes only —
    // text nested in inline children (a <b>, a mention span) is excluded, so a
    // populated field reports a non-empty but UNDERCOUNTED value. Sizing the
    // clear from that undercount would delete only the leading chars and leave
    // the rest for the new text to be typed on top of. On Chromium the length is
    // never trusted: clear to the cap and warn regardless of a non-empty value.
    const tree = {
      role: "textbox",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        {
          role: "textbox",
          value: "abc", // direct text only; real content ("abc<b>…</b>") is far longer
          frame: { x: 0.1, y: 0.4, width: 0.8, height: 0.05 },
          children: [],
        },
      ],
    };
    const { registry, invocations } = makeMockRegistry({});
    const tool = createFindTool(registry);
    const result = await tool.execute(
      { chromium: makeChromiumApi(tree) },
      { udid: CHROMIUM_ID, query: "abc", by: "value", action: "fill", text: "ZZZ", index: 0 }
    );
    expect(result.found).toBe(true);
    // NOT the 3+buffer the undercounted value="abc" would imply — full cap clear.
    expect(backspaces(invocations)).toHaveLength(64);
    expect((result.actionResult as { backspacesSent: number }).backspacesSent).toBe(64);
    expect(result.note).toMatch(/chromium/i);
    expect(result.note).toMatch(/verify/i);
    // The caveat warns about BOTH directions, not just leftover text: a fixed-count
    // clear on an inner block of a multi-block editor can backspace past the block's
    // start and delete into the PRECEDING block. Guards commit b473a39c's direction.
    expect(result.note).toMatch(/preceding block/i);
    expect(invocations.at(-1)).toMatchObject({ toolId: "keyboard", args: { text: "ZZZ" } });
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

  it("`fill` clears the enclosing editable region, not the demoted inner proxy (H1)", async () => {
    // The iOS search-bar shape that reproduced the "abcd" → "WxyzAbcd" bug: a wide
    // AXGroup that actually carries the value ("abcd") wraps a narrow inner
    // AXTextField proxy (no value). Both match "Search". For a tapping action the
    // container is demoted, so index 0 = the narrow proxy. fill must still focus +
    // size the clear against the WIDE region: trusting the proxy's frame parks the
    // caret at the field's far left (backspaces delete nothing, new text prepends).
    const group = {
      label: "Search",
      value: "abcd",
      frame: { x: 0.1, y: 0.4, width: 0.761, height: 0.05 },
      traits: [],
    };
    const proxy = {
      label: "Search",
      frame: { x: 0.11, y: 0.41, width: 0.051, height: 0.03 },
      traits: ["searchField"],
    };
    const { api } = makeSequencedAXService([axResponse([group, proxy])]);
    const { tool, invocations } = iosTool(api);
    const result = await tool.execute(
      {},
      { udid: IOS_UDID, query: "Search", by: "label", action: "fill", text: "wxyz", index: 0 }
    );
    expect(result.found).toBe(true);
    expect(result.matchCount).toBe(2);
    // index 0 is the demoted-past inner proxy (narrow frame ≈ 0.051 wide).
    expect(result.match!.frame.width).toBeCloseTo(0.051, 3);
    // …but the focus tap lands on the WIDE region's trailing edge (x ≈ 0.82), well
    // to the right of the proxy's own trailing edge (≈ 0.16) — this is the fix.
    const focusTap = invocations.find((i) => i.toolId === "gesture-tap")!;
    expect(focusTap.args.x as number).toBeCloseTo(0.1 + 0.761 * 0.95, 2);
    expect(focusTap.args.x as number).toBeGreaterThan(0.5);
    // The clear is sized from the WIDE region's value ("abcd"=4) + CLEAR_BUFFER,
    // NOT the proxy's placeholder label ("Search"=6 → the old 8-backspace path).
    expect(backspaces(invocations)).toHaveLength(4 + 2);
    expect(invocations.at(-1)).toMatchObject({ toolId: "keyboard", args: { text: "wxyz" } });
  });

  it("`fill` on an empty field backspaces only the buffer, not the placeholder label (L3)", async () => {
    // An empty iOS field exposes value="" with the placeholder in `label`
    // ("Search"). Sizing from the label would send 6+buffer phantom backspaces
    // (each a keyboard round-trip); preferring the present `value` sizes it to the
    // real (zero) length, so only the CLEAR_BUFFER backspaces are sent.
    const { api } = makeSequencedAXService([
      axResponse([{ label: "Search", value: "", frame: FRAME, traits: ["searchField"] }]),
    ]);
    const { tool, invocations } = iosTool(api);
    const result = await tool.execute(
      {},
      { udid: IOS_UDID, query: "Search", by: "label", action: "fill", text: "hi", index: 0 }
    );
    expect(result.found).toBe(true);
    // 0 (empty value) + CLEAR_BUFFER 2 — NOT 6 (label) + 2 the placeholder implies.
    expect(backspaces(invocations)).toHaveLength(2);
    expect(result.note ?? "").not.toMatch(/capped|incomplete/i);
    expect(invocations.at(-1)).toMatchObject({ toolId: "keyboard", args: { text: "hi" } });
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
    // A degraded AX tree is untrustworthy, so an empty one is a BLIND read, not a
    // confirmed absence — exists flags presenceUnknown (M1).
    expect(result.presenceUnknown).toBe(true);
  });

  it("`exists` reports presenceUnknown (not a confirmed absence) when the tree is unreadable", async () => {
    // An unreadable screen (Chromium renderer detached, never a usable tree) must
    // not read as "confirmed absent": exists surfaces presenceUnknown so a caller
    // can tell "couldn't check" from "checked and it's gone".
    const { registry } = makeMockRegistry({});
    const tool = createFindTool(registry);
    const result = await tool.execute(
      { chromium: makeFailingChromiumApi() },
      { udid: CHROMIUM_ID, query: "Continue", by: "text", action: "exists", index: 0 }
    );
    expect(result.found).toBe(false);
    expect(result.presenceUnknown).toBe(true);
    expect(result.note).toMatch(/presence unknown|could not be read/i);
    expect(result.note).toMatch(/renderer detached/);
  });

  it("`exists` does NOT set presenceUnknown for a genuine absence (tree read, no match)", async () => {
    const { api } = makeSequencedAXService([axResponse([])]);
    const { tool } = iosTool(api);
    const result = await tool.execute(
      {},
      { udid: IOS_UDID, query: "Nope", by: "label", action: "exists", index: 0 }
    );
    expect(result.found).toBe(false);
    expect(result.presenceUnknown).toBeUndefined();
    expect(result.note).toMatch(/no element matched/i);
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
    // The element WAS located and the focus tap fired, so a mid-action cancel is
    // reported as found:true with an accurate note (not "nothing happened").
    expect(result.found).toBe(true);
    expect(result.match).toBeDefined();
    expect(result.note).toMatch(/cancel/i);
    expect(result.note).toMatch(/not yet modified/i);
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

    // The element was located and the field was partially cleared before the
    // cancel, so the result reports found:true and says the field may be
    // partially cleared — not "cancelled before the element was located".
    expect(result.found).toBe(true);
    expect(result.match).toBeDefined();
    expect(result.note).toMatch(/cancel/i);
    expect(result.note).toMatch(/partially cleared/i);
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

  // ── M1: container-vs-child on a tapping action ──
  it("taps the inner input, not the enclosing container that folds its text (Android)", async () => {
    // A clickable card with no own label borrows its descendants' text into its
    // content-desc ("Server / localhost"), so both the card AND the EditText match
    // "localhost". The card sorts first in reading order (smaller y) and encloses
    // the input — a plain reading-order pick would tap the card's centre (the M1
    // bug). For a tapping action `find` demotes the enclosing container, so the
    // default index 0 lands on the inner input.
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<hierarchy rotation="0">` +
      `<node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">` +
      `<node class="android.widget.LinearLayout" clickable="true" bounds="[40,600][1040,900]">` +
      `<node text="Server" class="android.widget.TextView" bounds="[60,620][400,680]" />` +
      `<node text="localhost" class="android.widget.EditText" clickable="true" focusable="true" bounds="[60,760][1000,860]" />` +
      `</node>` +
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
      { udid: ANDROID_SERIAL, query: "localhost", by: "any", action: "tap", index: 0 }
    );
    expect(result.found).toBe(true);
    expect(result.matchCount).toBe(2); // both the card and the input match
    // Chosen = the inner input (narrower frame), NOT the enclosing card.
    expect(result.match!.frame.width).toBeCloseTo(940 / 1080, 2);
    const tap = invocations.find((i) => i.toolId === "gesture-tap")!;
    // input centre y ≈ 0.3375, NOT the card centre y ≈ 0.3125
    expect(tap.args.y as number).toBeCloseTo(0.3375, 2);
    expect(tap.args.y as number).not.toBeCloseTo(0.3125, 2);
    // The ambiguity note explains a tapping action demotes the enclosing
    // container below the matches it wraps (so index 0 is the inner input).
    expect(result.note).toMatch(/enclosing container ranks after/i);
  });

  it("keeps plain reading order for a read-only action (no container demotion)", async () => {
    // get-text is read-only: the enclosing container is NOT demoted, so index 0 is
    // the topmost-in-reading-order match (the card), proving demotion is scoped to
    // tapping actions.
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<hierarchy rotation="0">` +
      `<node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">` +
      `<node class="android.widget.LinearLayout" clickable="true" bounds="[40,600][1040,900]">` +
      `<node text="localhost" class="android.widget.EditText" clickable="true" focusable="true" bounds="[60,760][1000,860]" />` +
      `</node>` +
      `</node>` +
      `</hierarchy>`;
    const android: AndroidDevtoolsApi = {
      getHierarchy: async () => ({ xml }),
      getScreenSize: async () => ({ width: 1080, height: 2400, rotation: 0 }),
    } as unknown as AndroidDevtoolsApi;
    const { registry } = makeMockRegistry({ android });
    const tool = createFindTool(registry);
    const result = await tool.execute(
      {},
      { udid: ANDROID_SERIAL, query: "localhost", by: "any", action: "get-text", index: 0 }
    );
    expect(result.matchCount).toBe(2);
    // Card is topmost (y ≈ 0.25) → index 0 is the card (wider frame), not the input.
    expect(result.match!.frame.width).toBeCloseTo(1000 / 1080, 2);
    expect(result.note).toMatch(/topmost in reading order/i);
  });

  // ── M2: find is read-only on a TV target ──
  it("rejects an acting action on a tvOS target without mutating anything", async () => {
    vi.mocked(isTvOsSimulator).mockResolvedValueOnce(true);
    const { api } = makeSequencedAXService([
      axResponse([{ label: "Field", value: "abc", frame: FRAME, traits: ["textfield"] }]),
    ]);
    const { tool, invocations } = iosTool(api);
    const result = await tool.execute(
      {},
      { udid: IOS_UDID, query: "Field", by: "label", action: "fill", text: "new", index: 0 }
    );
    expect(result.found).toBe(false);
    expect(result.matchCount).toBe(0);
    expect(result.note).toMatch(/read-only on TV|tv-remote/i);
    // Nothing was tapped or typed — the field is never focused or backspaced.
    expect(invocations).toHaveLength(0);
    expect(isTvOsSimulator).toHaveBeenCalledTimes(1);
  });

  it("allows a read-only action on a tvOS target (not rejected; returns a valid absent answer)", async () => {
    // Symmetric with the Android-TV read-only test below: a read-only find never
    // drives the D-pad, so it is NOT rejected on tvOS — only the acting actions
    // are (the acting gate is `TAPPING_ACTIONS.has(action) && isTvOs`). The tvOS
    // verdict is resolved UNCONDITIONALLY (find/index.ts:469), so this guards the
    // read-only branch that the acting-reject test can't.
    //
    // Unlike Android TV (uiautomator serves a real tree), tvOS find goes through
    // describeIos, whose iOS accessibility service does NOT serve the tvOS focus
    // tree — it short-circuits to an EMPTY tree plus a TVOS_HINT pointing at
    // `describe` + `tv-remote`. So a read-only find on tvOS resolves to a valid
    // "not present" answer (found:false), never found:true. What matters here is
    // that it is a normal read result carrying that hint — NOT the acting-on-TV
    // rejection, and NOT a blind-read presenceUnknown (the empty tree WAS read).
    vi.mocked(isTvOsSimulator).mockResolvedValueOnce(true);
    // The AX response is irrelevant — describeIos short-circuits tvOS before the
    // ax-service is even resolved — but iosTool needs some api.
    const { api } = makeSequencedAXService([
      axResponse([{ label: "Now Playing", frame: FRAME, traits: [] }]),
    ]);
    const { tool, invocations } = iosTool(api);
    const result = await tool.execute(
      {},
      { udid: IOS_UDID, query: "Now Playing", by: "text", action: "exists", index: 0 }
    );
    // A valid read result, not an acting-on-TV rejection: exists ran the tvOS
    // describe path. The tree came back EMPTY but flagged (TVOS_HINT) — the AX
    // service can't serve the tvOS focus tree — so this is a BLIND read, not a
    // confirmed absence: exists must surface presenceUnknown so a caller doesn't
    // read "couldn't see the screen" as "the element is gone" (M1).
    expect(result.found).toBe(false);
    expect(result.matchCount).toBe(0);
    expect(result.presenceUnknown).toBe(true);
    // Crucially: NOT rejected as an unsupported acting-on-TV action.
    expect(result.note ?? "").not.toMatch(/read-only on TV|cannot `?exists`? on a TV/i);
    // The note carries the tvOS hint, proving the tvOS describe path ran and the
    // verdict was threaded through (rather than the normal AX path or a rejection).
    expect(result.note).toMatch(/Apple TV|tvOS|tv-remote/i);
    expect(invocations).toHaveLength(0); // no device effect for a read
    expect(isTvOsSimulator).toHaveBeenCalledTimes(1); // the tvOS verdict was resolved
  });

  it("rejects an acting action on an Android TV target without mutating anything", async () => {
    vi.mocked(getAndroidRuntimeKind).mockResolvedValueOnce("tv");
    const { registry, invocations } = makeMockRegistry({});
    const tool = createFindTool(registry);
    const result = await tool.execute(
      {},
      { udid: ANDROID_SERIAL, query: "Sign in", by: "text", action: "tap", index: 0 }
    );
    expect(result.found).toBe(false);
    expect(result.note).toMatch(/TV/);
    expect(result.note).toMatch(/tv-remote/i);
    expect(invocations).toHaveLength(0);
    expect(getAndroidRuntimeKind).toHaveBeenCalledTimes(1);
  });

  it("fails closed: rejects an acting action when the Android form factor can't be determined", async () => {
    // Mid-boot / offline: getAndroidRuntimeKind returns undefined. We can't prove
    // the target is a mobile device, so an acting find must NOT fire a blind
    // coordinate tap (which would no-op on a TV and be reported as tapped:true) —
    // it fails closed exactly like a confirmed TV target (L2).
    vi.mocked(getAndroidRuntimeKind).mockResolvedValueOnce(undefined);
    const { registry, invocations } = makeMockRegistry({});
    const tool = createFindTool(registry);
    const result = await tool.execute(
      {},
      { udid: ANDROID_SERIAL, query: "Sign in", by: "text", action: "tap", index: 0 }
    );
    expect(result.found).toBe(false);
    expect(result.matchCount).toBe(0);
    expect(result.note).toMatch(/tv-remote/i);
    expect(invocations).toHaveLength(0); // nothing tapped
    expect(getAndroidRuntimeKind).toHaveBeenCalledTimes(1);
  });

  it("allows a read-only action on an Android TV target (find is read-only, not blocked, on TV)", async () => {
    // A read-only find never touches the D-pad, so it is NOT rejected on TV — only
    // the acting actions are. get-text works on a TV target as on a phone. Even if
    // the form-factor probe WOULD say "tv", a read-only find never calls it (the
    // acting-guard short-circuits on the action), so no adb round-trip is paid.
    vi.mocked(getAndroidRuntimeKind).mockResolvedValueOnce("tv");
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<hierarchy rotation="0">` +
      `<node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">` +
      `<node text="Now Playing" class="android.widget.TextView" bounds="[60,300][900,380]" />` +
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
      { udid: ANDROID_SERIAL, query: "Now Playing", by: "text", action: "get-text", index: 0 }
    );
    expect(result.found).toBe(true);
    expect(result.actionResult).toMatchObject({ kind: "get-text", text: "Now Playing" });
    // A read-only action is never rejected as an unsupported TV action.
    expect(result.note ?? "").not.toMatch(/read-only on TV|cannot .*get-text/i);
    expect(invocations).toHaveLength(0); // no device effect for a read
    // Read-only never probes the form factor, so the "tv" override was never read.
    expect(getAndroidRuntimeKind).not.toHaveBeenCalled();
    // No manual restore needed: beforeEach resets the mock implementation (T4).
  });

  // ── T3: the tvOS verdict is resolved ONCE, before the poll clock ──
  it("resolves the tvOS verdict once across a polling wait, not per fetch", async () => {
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
    expect(calls()).toBeGreaterThan(1); // several fetches …
    expect(isTvOsSimulator).toHaveBeenCalledTimes(1); // … but one tvOS probe
  });

  // ── T1: discovery-loop non-happy paths (slow / hung / aborted fetch) ──
  const hangingAX = (): AXServiceApi => ({
    degraded: false,
    describe: () => new Promise<never>(() => {}), // never resolves
    alertCheck: async () => false,
    ping: async () => true,
  });

  it("bounds a single hung fetch to the wait budget instead of blocking forever", async () => {
    const { tool } = iosTool(hangingAX());
    const startedAt = Date.now();
    const result = await tool.execute(
      {},
      {
        udid: IOS_UDID,
        query: "Nope",
        by: "label",
        action: "wait",
        index: 0,
        timeoutMs: 80,
        pollIntervalMs: 10,
      }
    );
    expect(result.found).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(result.note).toMatch(/did not complete within/i);
  });

  it("a final fetch straddling the deadline still yields the tree-based note, not a fetch failure", async () => {
    // First poll returns a usable (empty) tree; later polls hang. The loop must
    // give up at the deadline and, because it already read the screen, report the
    // normal "no element matched" — NOT "did not complete" (reserved for never
    // having read the screen at all).
    let i = 0;
    const api: AXServiceApi = {
      degraded: false,
      describe: () => (i++ === 0 ? Promise.resolve(axResponse([])) : new Promise<never>(() => {})),
      alertCheck: async () => false,
      ping: async () => true,
    };
    const { tool } = iosTool(api);
    const result = await tool.execute(
      {},
      {
        udid: IOS_UDID,
        query: "Nope",
        by: "label",
        action: "wait",
        index: 0,
        timeoutMs: 120,
        pollIntervalMs: 30,
      }
    );
    expect(result.found).toBe(false);
    expect(result.note).toMatch(/no element matched/i);
    expect(result.note ?? "").not.toMatch(/did not complete/i);
  });

  it("aborts promptly while a fetch is in flight (settleWithin's aborted branch)", async () => {
    // The fetch never resolves, so the abort is observed by settleWithin mid-fetch
    // — not by sleepOrAbort between polls (the existing abort test covers that).
    const { tool } = iosTool(hangingAX());
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
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

  // ── T2: the poll-sleep is clamped to the deadline ──
  it("clamps the poll sleep to the deadline so a large pollIntervalMs can't overshoot timeoutMs", async () => {
    // Element never appears; pollIntervalMs (1000) dwarfs timeoutMs (100). Without
    // the clamp the first sleep would run the full 1000ms past the single second
    // poll. With the clamp, elapsed lands just past the 100ms deadline.
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
        timeoutMs: 100,
        pollIntervalMs: 1000,
      }
    );
    expect(result.found).toBe(false);
    expect(result.elapsed).toBeGreaterThanOrEqual(100);
    expect(result.elapsed).toBeLessThan(600);
  });

  // ── T4: `type` bails on a mid-settle abort before entering text ──
  it("aborts a `type` during the focus settle, before any keystroke", async () => {
    const { api } = makeSequencedAXService([
      axResponse([{ label: "Email", frame: FRAME, traits: ["textfield"] }]),
    ]);
    const { tool, invocations } = iosTool(api);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20); // fires during the ~150ms iOS settle
    const result = await tool.execute(
      {},
      { udid: IOS_UDID, query: "Email", by: "label", action: "type", text: "hi", index: 0 },
      { signal: controller.signal } as never
    );
    // Located and focus-tapped, then cancelled before typing: found:true with an
    // accurate note, and crucially NO text entered.
    expect(result.found).toBe(true);
    expect(result.match).toBeDefined();
    expect(result.note).toMatch(/cancel/i);
    expect(result.note).toMatch(/no text was entered/i);
    expect(keyboardCalls(invocations)).toHaveLength(0);
  });

  // ── T5: matchCount counts all matches for reads, visible-only for taps ──
  it("counts zero-area matches for read-only actions but not for tapping ones", async () => {
    const mixedTree = {
      role: "html",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        {
          role: "div",
          label: "Row",
          frame: { x: 0.1, y: 0.2, width: 0.5, height: 0.05 },
          children: [],
        },
        { role: "div", label: "Row", frame: { x: 0.1, y: 0.4, width: 0, height: 0 }, children: [] },
      ],
    };
    const read = createFindTool(makeMockRegistry({}).registry);
    const readResult = await read.execute(
      { chromium: makeChromiumApi(mixedTree) },
      { udid: CHROMIUM_ID, query: "Row", by: "label", action: "get-text", index: 0 }
    );
    // get-text pool = ALL matches (the zero-area one included) → 2
    expect(readResult.matchCount).toBe(2);
    expect((readResult.actionResult as { text: string }).text).toBe("Row");

    const tapTool = createFindTool(makeMockRegistry({}).registry);
    const tapResult = await tapTool.execute(
      { chromium: makeChromiumApi(mixedTree) },
      { udid: CHROMIUM_ID, query: "Row", by: "label", action: "tap", index: 0 }
    );
    // tap pool = VISIBLE matches only → 1 (the zero-area one is excluded)
    expect(tapResult.matchCount).toBe(1);
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
