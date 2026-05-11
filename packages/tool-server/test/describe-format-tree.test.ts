import { describe, expect, it } from "vitest";
import { formatDescribeTree } from "../src/tools/describe/format-tree";
import type { DescribeNode } from "../src/tools/describe/contract";

function leaf(
  partial: Partial<DescribeNode> & { role: string; frame: DescribeNode["frame"] }
): DescribeNode {
  return { children: [], ...partial };
}

function groupHeaders(out: string): string[] {
  return out.split("\n").filter((l) => /^— Group \d+ —$/.test(l));
}

function elementLineCount(out: string): number {
  return out.split("\n").filter((l) => /^ {2}AX|^ {2}\w/.test(l)).length;
}

describe("formatDescribeTree", () => {
  it("groups a vertically-stacked layout into one cluster per vertical band", () => {
    // Three bands separated by clear vertical gaps. Each band itself contains
    // a couple of elements that sit close together in y.
    const root: DescribeNode = {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        leaf({ role: "AXButton", label: "Top-A", frame: { x: 0.05, y: 0.05, width: 0.2, height: 0.04 } }),
        leaf({ role: "AXButton", label: "Top-B", frame: { x: 0.30, y: 0.05, width: 0.2, height: 0.04 } }),

        leaf({ role: "AXStaticText", label: "Mid-A", frame: { x: 0.05, y: 0.45, width: 0.4, height: 0.03 } }),
        leaf({ role: "AXStaticText", label: "Mid-B", frame: { x: 0.05, y: 0.50, width: 0.4, height: 0.03 } }),

        leaf({ role: "AXButton", label: "Bot-A", frame: { x: 0.05, y: 0.90, width: 0.2, height: 0.05 } }),
      ],
    };

    const out = formatDescribeTree(root, { source: "ax-service" });
    expect(out).toContain("Mode: flat");
    expect(groupHeaders(out)).toHaveLength(3);
    // Reading order: top band first, bottom band last.
    const topIdx = out.indexOf('"Top-A"');
    const midIdx = out.indexOf('"Mid-A"');
    const botIdx = out.indexOf('"Bot-A"');
    expect(topIdx).toBeLessThan(midIdx);
    expect(midIdx).toBeLessThan(botIdx);
  });

  it("applies the same gap rule on x as on y (horizontal layout is not special)", () => {
    // Three buttons in a horizontal row, all at the same y. Two are close
    // together; the third sits far across the screen. The cluster algorithm
    // should split exactly where the x-gap exceeds the threshold — same rule
    // it applies on the y-axis, with no orientation-specific exception.
    const root: DescribeNode = {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        leaf({ role: "AXButton", label: "L1", frame: { x: 0.05, y: 0.50, width: 0.1, height: 0.05 } }),
        leaf({ role: "AXButton", label: "L2", frame: { x: 0.18, y: 0.50, width: 0.1, height: 0.05 } }),
        leaf({ role: "AXButton", label: "R", frame: { x: 0.85, y: 0.50, width: 0.1, height: 0.05 } }),
      ],
    };

    const out = formatDescribeTree(root);
    // L1 and L2 (gap 0.03) stay in one group; R (gap 0.57 from L2) is its own.
    expect(groupHeaders(out)).toHaveLength(2);
    expect(elementLineCount(out)).toBe(3);
    expect(out.indexOf('"L1"')).toBeLessThan(out.indexOf('"L2"'));
    expect(out.indexOf('"L2"')).toBeLessThan(out.indexOf('"R"'));
  });

  it("splits a side-by-side layout into a left column and a right column", () => {
    // Sidebar on the left, content on the right, both spanning the same y
    // range. Within each column rows sit close together (gap < threshold) so
    // the column survives as one cluster; the wide horizontal gap between the
    // two columns is the only break.
    const root: DescribeNode = {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        leaf({ role: "AXButton", label: "Side1", frame: { x: 0.05, y: 0.10, width: 0.15, height: 0.05 } }),
        leaf({ role: "AXButton", label: "Side2", frame: { x: 0.05, y: 0.16, width: 0.15, height: 0.05 } }),
        leaf({ role: "AXButton", label: "Side3", frame: { x: 0.05, y: 0.22, width: 0.15, height: 0.05 } }),

        leaf({ role: "AXStaticText", label: "Body1", frame: { x: 0.55, y: 0.10, width: 0.4, height: 0.05 } }),
        leaf({ role: "AXStaticText", label: "Body2", frame: { x: 0.55, y: 0.16, width: 0.4, height: 0.05 } }),
        leaf({ role: "AXStaticText", label: "Body3", frame: { x: 0.55, y: 0.22, width: 0.4, height: 0.05 } }),
      ],
    };

    const out = formatDescribeTree(root);
    // The sidebar and the content area should land in different groups.
    expect(groupHeaders(out).length).toBeGreaterThanOrEqual(2);
    // Sidebar elements appear before content elements (same top y, smaller x).
    expect(out.indexOf('"Side1"')).toBeLessThan(out.indexOf('"Body1"'));
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
    // Child indented deeper than its parent.
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
