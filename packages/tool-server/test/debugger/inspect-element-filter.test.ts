import { describe, it, expect, vi } from "vitest";
import {
  filterInspectItems,
  debuggerInspectElementTool,
  type InspectItem,
} from "../../src/tools/debugger/debugger-inspect-element";

function item(
  name: string,
  source: InspectItem["source"] = null,
  code: string | null = null
): InspectItem {
  return { name, source, code };
}

const src = (file: string, line: number) => ({ file, line, column: 0 });

describe("filterInspectItems — AnimatedComponent dedup", () => {
  it("removes AnimatedComponent(X) following X", () => {
    const items = [item("View", src("a.tsx", 1)), item("AnimatedComponent(View)")];
    const result = filterInspectItems(items);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("View");
  });

  it("removes Animated(X) following X", () => {
    const items = [item("ScrollView", src("a.tsx", 1)), item("Animated(ScrollView)")];
    const result = filterInspectItems(items);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("ScrollView");
  });

  it("removes AnimatedComponent(X) via skip filter even when not preceded by X", () => {
    const items = [item("Text", src("a.tsx", 1)), item("AnimatedComponent(View)")];
    const result = filterInspectItems(items);
    // AnimatedComponent(View) is sourceless + isHardSkip → removed by skip filter
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Text");
  });
});

describe("filterInspectItems — source-aware skip filter (Pass 1)", () => {
  it("removes sourceless View", () => {
    const items = [
      item("Button", src("btn.tsx", 10)),
      item("View"),
      item("FormWrapper", src("form.tsx", 5)),
    ];
    const result = filterInspectItems(items);
    expect(result.map((i) => i.name)).toEqual(["Button", "FormWrapper"]);
  });

  it("keeps View at index 0 (leaf — always preserved)", () => {
    const items = [item("View"), item("Button", src("btn.tsx", 10))];
    const result = filterInspectItems(items);
    expect(result[0].name).toBe("View");
    expect(result).toHaveLength(2);
  });

  it("removes sourceless ScrollViewContext", () => {
    const items = [
      item("Button", src("btn.tsx", 10)),
      item("ScrollViewContext"),
      item("Page", src("page.tsx", 1)),
    ];
    const result = filterInspectItems(items);
    expect(result.map((i) => i.name)).toEqual(["Button", "Page"]);
  });

  it("keeps skip-name items that HAVE source", () => {
    const items = [
      item("Pressable", src("pressable.tsx", 42)),
      item("StaticContainer", src("nav.tsx", 10)),
    ];
    const result = filterInspectItems(items);
    expect(result).toHaveLength(2);
  });

  it("removes sourceless *Provider suffix items", () => {
    const items = [
      item("Button", src("btn.tsx", 10)),
      item("AuthProvider"),
      item("ThemeProvider"),
      item("Page", src("page.tsx", 1)),
    ];
    const result = filterInspectItems(items);
    expect(result.map((i) => i.name)).toEqual(["Button", "Page"]);
  });

  it("removes sourceless With*(X) HOC wrappers", () => {
    const items = [item("Button", src("btn.tsx", 10)), item("WithNavigationFallback(Button)")];
    const result = filterInspectItems(items);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Button");
  });

  it("keeps With*(X) HOC wrappers with source", () => {
    const items = [
      item("Button", src("btn.tsx", 10)),
      item("WithNavigationFallback(Button)", src("form.tsx", 143)),
    ];
    const result = filterInspectItems(items);
    expect(result).toHaveLength(2);
  });
});

describe("filterInspectItems — same-source dedup (Pass 2)", () => {
  it("collapses consecutive items with same file:line", () => {
    const items = [
      item("ProviderA", src("ComposeProviders.tsx", 11)),
      item("ProviderB", src("ComposeProviders.tsx", 11)),
      item("ProviderC", src("ComposeProviders.tsx", 11)),
      item("App", src("App.tsx", 1)),
    ];
    const result = filterInspectItems(items);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("ProviderA");
    expect(result[1].name).toBe("App");
  });

  it("does NOT collapse items at different lines in same file", () => {
    const items = [
      item("ComponentA", src("page.tsx", 10)),
      item("ComponentB", src("page.tsx", 20)),
    ];
    const result = filterInspectItems(items);
    expect(result).toHaveLength(2);
  });

  it("does NOT collapse non-consecutive items with same source", () => {
    const items = [
      item("A", src("x.tsx", 5)),
      item("B", src("y.tsx", 10)),
      item("C", src("x.tsx", 5)),
    ];
    const result = filterInspectItems(items);
    expect(result).toHaveLength(3);
  });
});

describe("filterInspectItems — anonymous View pruning (Pass 3)", () => {
  it("removes sourceless View at non-leaf positions", () => {
    const items = [
      item("Text", src("text.tsx", 1)),
      item("View"),
      item("View"),
      item("Page", src("page.tsx", 10)),
    ];
    const result = filterInspectItems(items);
    expect(result.map((i) => i.name)).toEqual(["Text", "Page"]);
  });

  it("keeps View at index 0 (leaf element)", () => {
    const items = [item("View"), item("Button", src("btn.tsx", 10)), item("View")];
    const result = filterInspectItems(items);
    expect(result[0].name).toBe("View");
    expect(result).toHaveLength(2);
  });

  it("keeps View with source", () => {
    const items = [
      item("Text", src("text.tsx", 1)),
      item("View", src("form.tsx", 72)),
      item("Page", src("page.tsx", 10)),
    ];
    const result = filterInspectItems(items);
    expect(result).toHaveLength(3);
  });
});

describe("filterInspectItems — combined scenario (Expensify-like)", () => {
  it("produces expected output for realistic hierarchy", () => {
    const items: InspectItem[] = [
      item("View"), // [0] leaf — keep
      item("Pressable", src("BaseGenericPressable.tsx", 177)), // keep (has src)
      item("GenericPressable", src("index.native.tsx", 7)), // keep
      item("NativeGenericPressable", src("PressableWithFeedback.tsx", 74)), // keep
      item("View"), // sourceless View — remove
      item("View", src("OpacityView.tsx", 59)), // keep (has src)
      item("OpacityView", src("PressableWithFeedback.tsx", 66)), // keep
      item("PressableWithFeedback", src("index.tsx", 475)), // keep
      item("Button"), // no-src, not in skip — keep at leaf? No, not leaf. "Button" is not in skip set? Wait...
      // Actually "Button" is NOT in SKIP, so it passes through. But it has no source.
      // The skip filter only removes shouldSkip names. "Button" is not shouldSkip.
      item("ScrollViewContext"), // sourceless + in SKIP — remove
      item("ScrollView"), // sourceless + in SKIP... wait, ScrollView is NOT in SKIP set
      item("ScrollView", src("ScrollView.tsx", 35)), // keep
      item("SignInPage", src("SignInPage.tsx", 358)), // keep
    ];
    const result = filterInspectItems(items);
    const names = result.map((i) => i.name);

    expect(names).toContain("View"); // leaf at index 0
    expect(names).toContain("Pressable"); // has source
    expect(names).toContain("SignInPage");
    expect(names).not.toContain("ScrollViewContext"); // sourceless SKIP
  });
});

describe("filterInspectItems — includeSkipped=true", () => {
  it("annotates animated-dedup items instead of removing them", () => {
    const items = [item("View", src("a.tsx", 1)), item("AnimatedComponent(View)")];
    const result = filterInspectItems(items, true);
    expect(result).toHaveLength(2);
    expect(result[1].skipped).toBe(true);
    expect(result[1].skipReason).toBe("animated-dedup");
  });

  it("annotates skip-rule:no-source items", () => {
    const items = [
      item("Button", src("btn.tsx", 10)),
      item("ScrollViewContext"),
      item("Page", src("page.tsx", 1)),
    ];
    const result = filterInspectItems(items, true);
    expect(result).toHaveLength(3);
    const skipped = result.find((i) => i.name === "ScrollViewContext");
    expect(skipped?.skipped).toBe(true);
    expect(skipped?.skipReason).toBe("skip-rule:no-source");
  });

  it("annotates same-source-dedup items", () => {
    const items = [
      item("ProviderA", src("ComposeProviders.tsx", 11)),
      item("ProviderB", src("ComposeProviders.tsx", 11)),
      item("App", src("App.tsx", 1)),
    ];
    const result = filterInspectItems(items, true);
    expect(result).toHaveLength(3);
    expect(result[1].skipped).toBe(true);
    expect(result[1].skipReason).toBe("same-source-dedup");
  });

  it("annotates sourceless View as skip-rule (View is in SKIP set)", () => {
    const items = [
      item("Text", src("text.tsx", 1)),
      item("View"),
      item("Page", src("page.tsx", 10)),
    ];
    const result = filterInspectItems(items, true);
    expect(result).toHaveLength(3);
    const skipped = result.find((i) => i.name === "View");
    expect(skipped?.skipped).toBe(true);
    expect(skipped?.skipReason).toBe("skip-rule:no-source");
  });

  it("preserves leaf View at index 0 without annotation", () => {
    const items = [item("View"), item("Button", src("btn.tsx", 10))];
    const result = filterInspectItems(items, true);
    expect(result[0].skipped).toBeUndefined();
    expect(result[0].name).toBe("View");
  });

  it("all items present with includeSkipped — nothing dropped", () => {
    const items = [
      item("View"),
      item("Pressable", src("p.tsx", 1)),
      item("AnimatedComponent(Pressable)"),
      item("ThemeProvider"),
      item("View"),
      item("Page", src("page.tsx", 10)),
    ];
    const result = filterInspectItems(items, true);
    expect(result).toHaveLength(items.length);
    const skippedCount = result.filter((i) => i.skipped).length;
    expect(skippedCount).toBeGreaterThan(0);
  });
});

type RawFrame = {
  fn: string;
  file: string;
  line: number;
  col: number;
  original?: boolean;
};

/**
 * Builds a minimal fake JsRuntimeDebuggerApi that exercises the real
 * `execute` resolution path without a live CDP connection. `symbolicate`
 * returns whatever `symbolicateImpl` yields so we can simulate a failed
 * symbolication (null) and assert the raw-frame fallback.
 */
function fakeServices(
  rawItems: Array<{ name: string; frame: RawFrame | null }>,
  symbolicateImpl: () => Promise<InspectItem["source"]>
) {
  const symbolicate = vi.fn(symbolicateImpl);
  const readSourceFragment = vi.fn(async () => "  >  1 | code");
  return {
    services: {
      debugger: {
        deviceName: "iPhone 16",
        appName: "MyApp",
        logicalDeviceId: "device-1",
        cdp: {
          evaluateWithBinding: vi.fn(async () => ({ items: rawItems })),
        },
        sourceResolver: { symbolicate, readSourceFragment },
      },
    } as unknown as Record<string, unknown>,
    symbolicate,
    readSourceFragment,
  };
}

const params = {
  port: 8081,
  device_id: "device-1",
  x: 100,
  y: 200,
  contextLines: 3,
  resolveSourceMaps: true,
  maxItems: 35,
  includeSkipped: false,
};

describe("debuggerInspectElementTool — raw fallback when symbolication fails", () => {
  it("retains the raw bundled frame location when symbolicate returns null", async () => {
    const { services, readSourceFragment } = fakeServices(
      [{ name: "Screen", frame: { fn: "Screen", file: "http://localhost:8081/index.bundle", line: 4321, col: 17, original: false } }],
      async () => null // symbolication failed / echoed bundle URL
    );

    const result = await debuggerInspectElementTool.execute(services, params);
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].name).toBe("Screen");
    // Raw fallback mirrors the resolveSourceMaps:false shape: column <- frame.col
    expect(result.items[0].source).toEqual({
      file: "http://localhost:8081/index.bundle",
      line: 4321,
      column: 17,
    });
    // No source file was read because symbolication produced no mapped location.
    expect(result.items[0].code).toBeNull();
    expect(readSourceFragment).not.toHaveBeenCalled();
  });

  it("uses the mapped location when symbolicate succeeds", async () => {
    const mapped = { file: "app/screen.tsx", line: 12, column: 4 };
    const { services, readSourceFragment } = fakeServices(
      [{ name: "Screen", frame: { fn: "Screen", file: "http://localhost:8081/index.bundle", line: 4321, col: 17, original: false } }],
      async () => mapped
    );

    const result = await debuggerInspectElementTool.execute(services, params);
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);

    expect(result.items[0].source).toEqual(mapped);
    expect(result.items[0].code).toBe("  >  1 | code");
    expect(readSourceFragment).toHaveBeenCalledOnce();
  });
});
