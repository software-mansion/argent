import { describe, it, expect } from "vitest";
import {
  buildTextTree,
  type RawEntry,
  type RawResult,
} from "../../src/tools/debugger/debugger-component-tree";

function entry(
  id: number,
  name: string,
  parentIdx: number,
  rect: RawEntry["rect"] = null,
  extra: Partial<Pick<RawEntry, "testID" | "accLabel" | "text">> = {}
): RawEntry {
  return { id, name, rect, parentIdx, ...extra };
}

const SCREEN = { screenW: 400, screenH: 800 };

describe("buildTextTree — same-name dedup (B fix)", () => {
  it("collapses 2-deep same-name chain", () => {
    const rect = { x: 0, y: 62, w: 400, h: 738 };
    const data: RawResult = {
      ...SCREEN,
      components: [
        entry(0, "ScrollView", -1, rect),
        entry(1, "ScrollView", 0, rect),
        entry(2, "Text", 1, { x: 50, y: 100, w: 300, h: 30 }, { text: "Hello" }),
      ],
    };
    const result = buildTextTree(data, { onScreenOnly: true });
    const scrollViewCount = (result.match(/ScrollView/g) || []).length;
    expect(scrollViewCount).toBe(1);
    expect(result).toContain('Text "Hello"');
  });

  it("collapses 3-deep same-name chain (the bug fix)", () => {
    const rect = { x: 0, y: 62, w: 400, h: 738 };
    const data: RawResult = {
      ...SCREEN,
      components: [
        entry(0, "ScrollView", -1, rect),
        entry(1, "ScrollView", 0, rect),
        entry(2, "ScrollView", 1, rect),
        entry(3, "Text", 2, { x: 50, y: 100, w: 300, h: 30 }, { text: "Content" }),
      ],
    };
    const result = buildTextTree(data, { onScreenOnly: true });
    const scrollViewCount = (result.match(/ScrollView/g) || []).length;
    expect(scrollViewCount).toBe(1);
    expect(result).toContain('Text "Content"');
  });

  it("collapses different-name content-free child with same rect", () => {
    const rect = { x: 0, y: 62, w: 400, h: 738 };
    const data: RawResult = {
      ...SCREEN,
      components: [
        entry(0, "Wrapper", -1, rect),
        entry(1, "ScrollView", 0, rect),
        entry(2, "Text", 1, { x: 50, y: 100, w: 300, h: 30 }, { text: "Hi" }),
      ],
    };
    const result = buildTextTree(data, { onScreenOnly: true });
    // ScrollView is content-free (no text/testID/accLabel) and overlaps parent → collapsed
    expect(result).not.toContain("ScrollView");
    // Child text gets reparented to Wrapper
    expect(result).toContain("Wrapper");
    expect(result).toContain('Text "Hi"');
  });

  it("keeps different-name child with same rect when it has testID", () => {
    const rect = { x: 0, y: 62, w: 400, h: 738 };
    const data: RawResult = {
      ...SCREEN,
      components: [
        entry(0, "Wrapper", -1, rect),
        entry(1, "ScrollView", 0, rect, { testID: "myScroll" }),
        entry(2, "Text", 1, { x: 50, y: 100, w: 300, h: 30 }, { text: "Hi" }),
      ],
    };
    const result = buildTextTree(data, { onScreenOnly: true });
    expect(result).toContain("ScrollView");
  });
});

describe("buildTextTree — onScreenOnly (C)", () => {
  it("removes off-screen components when onScreenOnly=true", () => {
    const data: RawResult = {
      ...SCREEN,
      components: [
        entry(0, "Header", -1, { x: 0, y: 0, w: 400, h: 50 }, { text: "Title" }),
        entry(1, "Footer", -1, { x: 0, y: 2000, w: 400, h: 50 }, { text: "Bottom" }),
      ],
    };
    const result = buildTextTree(data, { onScreenOnly: true });
    expect(result).toContain("Header");
    expect(result).not.toContain("Footer");
  });

  it("keeps off-screen components when onScreenOnly=false", () => {
    const data: RawResult = {
      ...SCREEN,
      components: [
        entry(0, "Header", -1, { x: 0, y: 0, w: 400, h: 50 }, { text: "Title" }),
        entry(1, "Footer", -1, { x: 0, y: 2000, w: 400, h: 50 }, { text: "Bottom" }),
      ],
    };
    const result = buildTextTree(data, { onScreenOnly: false });
    expect(result).toContain("Header");
    expect(result).toContain("Footer");
  });
});

describe("buildTextTree — maxNodes with wrapper-chain collapsing (D)", () => {
  it("renders full tree when maxNodes is not set", () => {
    const data: RawResult = {
      ...SCREEN,
      components: [
        entry(0, "Root", -1, { x: 0, y: 0, w: 400, h: 800 }),
        entry(1, "Wrapper1", 0, { x: 0, y: 0, w: 400, h: 700 }),
        entry(2, "Wrapper2", 1, { x: 0, y: 0, w: 400, h: 600 }),
        entry(3, "Wrapper3", 2, { x: 0, y: 0, w: 400, h: 500 }),
        entry(4, "Leaf", 3, { x: 50, y: 100, w: 300, h: 30 }, { text: "Hello" }),
      ],
    };
    const result = buildTextTree(data, { onScreenOnly: false });
    expect(result).toContain("Wrapper1");
    expect(result).toContain("Wrapper2");
    expect(result).toContain("Wrapper3");
    expect(result).not.toContain("via");
  });

  it("collapses single-child wrapper chains when maxNodes is exceeded", () => {
    const data: RawResult = {
      ...SCREEN,
      components: [
        entry(0, "Root", -1, { x: 0, y: 0, w: 400, h: 800 }),
        entry(1, "Wrapper1", 0, { x: 0, y: 0, w: 400, h: 700 }),
        entry(2, "Wrapper2", 1, { x: 0, y: 0, w: 400, h: 600 }),
        entry(3, "Wrapper3", 2, { x: 0, y: 0, w: 400, h: 500 }),
        entry(4, "Wrapper4", 3, { x: 0, y: 0, w: 400, h: 400 }),
        entry(5, "Leaf", 4, { x: 50, y: 100, w: 300, h: 30 }, { text: "Hello" }),
      ],
    };
    const result = buildTextTree(data, { onScreenOnly: false, maxNodes: 3 });
    expect(result).toContain("via");
    expect(result).toContain('Leaf "Hello"');
    expect(result).toContain("wrapper node");
    expect(result).toContain("collapsed");
  });

  it("does NOT collapse branching nodes", () => {
    const data: RawResult = {
      ...SCREEN,
      components: [
        entry(0, "Root", -1, { x: 0, y: 0, w: 400, h: 800 }),
        entry(1, "Left", 0, { x: 0, y: 0, w: 200, h: 400 }, { text: "A" }),
        entry(2, "Right", 0, { x: 200, y: 0, w: 200, h: 400 }, { text: "B" }),
      ],
    };
    const result = buildTextTree(data, { onScreenOnly: false, maxNodes: 2 });
    // Root has 2 children — not a wrapper chain, so nothing to collapse
    expect(result).not.toContain("via");
    expect(result).toContain("Left");
    expect(result).toContain("Right");
  });

  it("does NOT collapse nodes with text/testID/accLabel", () => {
    const data: RawResult = {
      ...SCREEN,
      components: [
        entry(0, "Root", -1, { x: 0, y: 0, w: 400, h: 800 }),
        entry(1, "LabeledWrapper", 0, { x: 0, y: 0, w: 400, h: 700 }, { text: "Important" }),
        entry(2, "Leaf", 1, { x: 50, y: 100, w: 300, h: 30 }, { text: "Content" }),
      ],
    };
    const result = buildTextTree(data, { onScreenOnly: false, maxNodes: 1 });
    // LabeledWrapper has text so it's not a wrapper — no collapsing
    expect(result).not.toContain("via");
    expect(result).toContain("LabeledWrapper");
  });
});

describe("buildTextTree — full-screen wrapper collapse", () => {
  it("removes full-screen wrappers without content", () => {
    const data: RawResult = {
      ...SCREEN,
      components: [
        entry(0, "FullScreenWrap", -1, { x: 0, y: 0, w: 400, h: 800 }),
        entry(1, "Button", 0, { x: 100, y: 300, w: 200, h: 50 }, { text: "Click" }),
      ],
    };
    const result = buildTextTree(data, { onScreenOnly: true });
    expect(result).not.toContain("FullScreenWrap");
    expect(result).toContain('Button "Click"');
  });

  it("keeps full-screen wrapper with testID", () => {
    const data: RawResult = {
      ...SCREEN,
      components: [
        entry(0, "Screen", -1, { x: 0, y: 0, w: 400, h: 800 }, { testID: "main-screen" }),
        entry(1, "Button", 0, { x: 100, y: 300, w: 200, h: 50 }, { text: "Click" }),
      ],
    };
    const result = buildTextTree(data, { onScreenOnly: true });
    expect(result).toContain("Screen [testID=main-screen]");
  });
});

describe("buildTextTree — same-testID chain collapse", () => {
  it("keeps only topmost component with a given testID", () => {
    const data: RawResult = {
      ...SCREEN,
      components: [
        entry(0, "Outer", -1, { x: 10, y: 10, w: 380, h: 100 }, { testID: "field" }),
        entry(1, "Inner", 0, { x: 10, y: 10, w: 380, h: 100 }, { testID: "field" }),
        entry(2, "Text", 1, { x: 20, y: 20, w: 200, h: 30 }, { text: "Hello" }),
      ],
    };
    const result = buildTextTree(data, { onScreenOnly: true });
    expect(result).toContain("Outer [testID=field]");
    expect(result).not.toContain("Inner");
  });
});

describe("buildTextTree — includeSkipped summary", () => {
  it("appends filtered summary section with TS-side stats", () => {
    const rect = { x: 0, y: 62, w: 400, h: 738 };
    const data: RawResult = {
      ...SCREEN,
      components: [
        entry(0, "ScrollView", -1, rect),
        entry(1, "ScrollView", 0, rect),
        entry(2, "Text", 1, { x: 50, y: 100, w: 300, h: 30 }, { text: "Hello" }),
      ],
    };
    const result = buildTextTree(data, { onScreenOnly: true, includeSkipped: true });
    expect(result).toContain("--- Filtered ---");
    expect(result).toContain("TS-side removed:");
    expect(result).toContain("Same-name dedup:");
    expect(result).toContain("ScrollView");
  });

  it("includes JS-side skipped counts when provided", () => {
    const data: RawResult = {
      ...SCREEN,
      totalFibers: 547,
      skippedCounts: { View: 120, RCTView: 80 },
      components: [
        entry(0, "MainScreen", -1, { x: 0, y: 0, w: 400, h: 700 }),
        entry(1, "Text", 0, { x: 50, y: 100, w: 300, h: 30 }, { text: "Hello" }),
      ],
    };
    const result = buildTextTree(data, { onScreenOnly: true, includeSkipped: true });
    expect(result).toContain("--- Filtered ---");
    expect(result).toContain("Total fibers walked: 547");
    expect(result).toContain("JS-side skipped: 200");
    expect(result).toContain("View: 120");
    expect(result).toContain("RCTView: 80");
  });

  it("omits summary section when includeSkipped is false", () => {
    const data: RawResult = {
      ...SCREEN,
      components: [
        entry(0, "Root", -1, { x: 0, y: 0, w: 400, h: 700 }),
        entry(1, "Text", 0, { x: 50, y: 100, w: 300, h: 30 }, { text: "Hi" }),
      ],
    };
    const result = buildTextTree(data, { onScreenOnly: true });
    expect(result).not.toContain("--- Filtered ---");
  });

  it("reports multiple filter passes in summary", () => {
    const data: RawResult = {
      ...SCREEN,
      totalFibers: 100,
      skippedCounts: { View: 50 },
      components: [
        entry(0, "Outer", -1, { x: 10, y: 10, w: 380, h: 100 }, { testID: "field" }),
        entry(1, "Inner", 0, { x: 10, y: 10, w: 380, h: 100 }, { testID: "field" }),
        entry(2, "FullWrap", -1, { x: 0, y: 0, w: 400, h: 800 }),
        entry(3, "OffScreen", -1, { x: 0, y: 5000, w: 100, h: 50 }, { text: "Far away" }),
        entry(4, "Text", 0, { x: 20, y: 20, w: 200, h: 30 }, { text: "Hello" }),
      ],
    };
    const result = buildTextTree(data, { onScreenOnly: true, includeSkipped: true });
    expect(result).toContain("Same-testID chain:");
    expect(result).toContain("Full-screen wrapper:");
    expect(result).toContain("Off-screen:");
  });
});
