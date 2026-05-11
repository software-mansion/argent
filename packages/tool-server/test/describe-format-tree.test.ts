import { describe, expect, it } from "vitest";
import { formatDescribeTree } from "../src/tools/describe/format-tree";
import type { DescribeNode } from "../src/tools/describe/contract";

function leaf(
  partial: Partial<DescribeNode> & { role: string; frame: DescribeNode["frame"] }
): DescribeNode {
  return { children: [], ...partial };
}

function elementLines(out: string): string[] {
  return out.split("\n").filter((l) => /^ {2}\S/.test(l));
}

describe("formatDescribeTree", () => {
  it("renders flat ax-service children in reading order, one node per line", () => {
    const root: DescribeNode = {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        leaf({ role: "AXButton", label: "C", frame: { x: 0.30, y: 0.50, width: 0.1, height: 0.05 } }),
        leaf({ role: "AXButton", label: "A", frame: { x: 0.05, y: 0.05, width: 0.1, height: 0.05 } }),
        leaf({ role: "AXButton", label: "B", frame: { x: 0.20, y: 0.50, width: 0.1, height: 0.05 } }),
      ],
    };
    const out = formatDescribeTree(root, { source: "ax-service" });
    expect(out).toContain("Source: ax-service");
    expect(out).toContain("Mode: flat");
    const lines = elementLines(out);
    expect(lines).toHaveLength(3);
    // top-to-bottom, then left-to-right
    expect(lines[0]).toContain('"A"');
    expect(lines[1]).toContain('"B"');
    expect(lines[2]).toContain('"C"');
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
    expect(out).toContain("ScrollView");
    expect(out).toMatch(/Button\s+"Like".*\[clickable\]/);
    expect(out).toContain("[web-view] About");
    const lines = out.split("\n");
    const buttonLine = lines.find((l) => l.includes('"Like"'))!;
    const scrollLine = lines.find((l) => l.includes("ScrollView"))!;
    // child indented deeper than its parent
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
    const labelLines = out.split("\n").filter((l) => l.includes("Hello"));
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
    expect(elementLines(out)).toHaveLength(0);
  });
});
