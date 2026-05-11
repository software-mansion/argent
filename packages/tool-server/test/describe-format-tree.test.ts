import { describe, expect, it } from "vitest";
import { formatDescribeTree } from "../src/tools/describe/format-tree";
import type { DescribeNode } from "../src/tools/describe/contract";

function leaf(
  partial: Partial<DescribeNode> & { role: string; frame: DescribeNode["frame"] }
): DescribeNode {
  return { children: [], ...partial };
}

describe("formatDescribeTree", () => {
  it("renders a flat ax-service tree as zoned sections", () => {
    const root: DescribeNode = {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        leaf({
          role: "AXButton",
          label: "Messages",
          frame: { x: 0.04, y: 0.07, width: 0.11, height: 0.05 },
        }),
        leaf({
          role: "AXStaticText",
          label: "Today",
          frame: { x: 0.04, y: 0.24, width: 0.92, height: 0.02 },
        }),
        leaf({
          role: "AXButton",
          label: "add",
          frame: { x: 0.04, y: 0.55, width: 0.1, height: 0.05 },
        }),
        leaf({
          role: "AXImage",
          label: "Q",
          frame: { x: 0.01, y: 0.68, width: 0.1, height: 0.06 },
        }),
        leaf({
          role: "AXImage",
          label: "W",
          frame: { x: 0.11, y: 0.68, width: 0.1, height: 0.06 },
        }),
        leaf({
          role: "AXButton",
          label: "shift",
          frame: { x: 0.01, y: 0.8, width: 0.13, height: 0.06 },
        }),
        leaf({
          role: "AXButton",
          label: "Dictate",
          frame: { x: 0.81, y: 0.92, width: 0.17, height: 0.08 },
        }),
      ],
    };

    const out = formatDescribeTree(root, { source: "ax-service" });
    expect(out).toContain("Source: ax-service");
    expect(out).toContain("Mode: flat");
    expect(out).toContain("— Top bar —");
    expect(out).toContain('"Messages"');
    expect(out).toContain("— Body / content —");
    expect(out).toContain('"Today"');
    expect(out).toContain("— Composer / predictive / action bar —");
    expect(out).toContain('"add"');
    expect(out).toMatch(/Bottom row 1: letters/);
    expect(out).toMatch(/Bottom row 2: shift \+ letters \+ delete/);
    expect(out).toMatch(/Bottom row 3: globe \/ dictate/);
  });

  it("renders a nested uiautomator tree with depth indentation and flags", () => {
    const root: DescribeNode = {
      role: "Screen",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        {
          role: "ScrollView",
          frame: { x: 0, y: 0.1, width: 1, height: 0.8 },
          scrollable: true,
          children: [
            leaf({
              role: "Button",
              label: "Like",
              frame: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
              clickable: true,
            }),
            leaf({
              role: "WebView",
              label: "[web-view] About",
              frame: { x: 0, y: 0.4, width: 1, height: 0.4 },
            }),
          ],
        },
      ],
    };

    const out = formatDescribeTree(root, { source: "uiautomator" });
    expect(out).toContain("Mode: nested");
    expect(out).toMatch(/Screen\s+/);
    expect(out).toContain("ScrollView");
    expect(out).toMatch(/Button\s+"Like".*\[clickable\]/);
    expect(out).toContain("[web-view] About");
    const lines = out.split("\n");
    const buttonLine = lines.find((l) => l.includes('"Like"'))!;
    const scrollLine = lines.find((l) => l.includes("ScrollView"))!;
    // The button must be indented deeper than its parent ScrollView.
    expect(buttonLine.search(/\S/)).toBeGreaterThan(scrollLine.search(/\S/));
  });

  it("escapes embedded newlines so per-line alignment survives", () => {
    const root: DescribeNode = {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        leaf({
          role: "AXGroup",
          label: "Hello\nWorld",
          frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.1 },
        }),
      ],
    };
    const out = formatDescribeTree(root);
    expect(out).toContain('"Hello\\nWorld"');
    // Make sure the original \n didn't leak through.
    const lines = out.split("\n");
    const labelLines = lines.filter((l) => l.includes("Hello"));
    expect(labelLines).toHaveLength(1);
  });

  it("handles an empty tree without crashing", () => {
    const root: DescribeNode = {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [],
    };
    const out = formatDescribeTree(root);
    expect(out).toContain("Mode: flat");
    expect(out).toContain("ROOT  AXGroup");
  });
});
