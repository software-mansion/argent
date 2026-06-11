import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseVegaPageSource,
  parseVegaXml,
} from "../src/tools/describe/platforms/vega/source-parser";
import { formatDescribeTree } from "../src/tools/describe/format-tree";
import type { DescribeNode } from "../src/tools/describe/contract";

const FIXTURE = readFileSync(join(__dirname, "fixtures", "vega-page-source.xml"), "utf8");

function flatten(node: DescribeNode): DescribeNode[] {
  return [node, ...node.children.flatMap(flatten)];
}
function byLabel(node: DescribeNode, label: string): DescribeNode | undefined {
  return flatten(node).find((n) => n.label === label);
}

describe("parseVegaXml", () => {
  it("skips <traits> subtrees (no phantom windows/actions leak in)", () => {
    const root = parseVegaXml(FIXTURE);
    expect(root).not.toBeNull();
    const tags = new Set<string>();
    (function walk(n: NonNullable<typeof root>) {
      tags.add(n.tag);
      n.children.forEach(walk);
    })(root!);
    // Only real UI element tags survive; trait-only tags must be gone.
    expect(tags.has("traits")).toBe(false);
    expect(tags.has("selectable")).toBe(false);
    expect(tags.has("focusable")).toBe(false);
    expect(tags.has("actions")).toBe(false);
    expect(tags.has("visibility")).toBe(false);
  });

  it("captures <text> element content", () => {
    const root = parseVegaXml(FIXTURE)!;
    const texts: string[] = [];
    (function walk(n: { tag: string; text: string; children: any[] }) {
      if (n.tag === "text" && n.text) texts.push(n.text);
      n.children.forEach(walk);
    })(root);
    expect(texts).toContain("Search");
    expect(texts).toContain("Home");
  });
});

describe("parseVegaPageSource", () => {
  const tree = parseVegaPageSource(FIXTURE);

  it("produces a Screen root with normalized [0,1] frames", () => {
    expect(tree.role).toBe("Screen");
    for (const n of flatten(tree)) {
      expect(n.frame.x).toBeGreaterThanOrEqual(0);
      expect(n.frame.y).toBeGreaterThanOrEqual(0);
      expect(n.frame.x + n.frame.width).toBeLessThanOrEqual(1.0001);
      expect(n.frame.y + n.frame.height).toBeLessThanOrEqual(1.0001);
    }
  });

  it("keeps role-bearing nodes and flattens structural containers", () => {
    const roles = new Set(flatten(tree).map((n) => n.role));
    expect(roles.has("button")).toBe(true);
    expect(roles.has("text")).toBe(true);
    expect(roles.has("image")).toBe(true);
    // No bare structural wrappers survive (we map unknowns to "view" and flatten
    // them — there should be none left as emitted nodes).
    expect(roles.has("view")).toBe(false);
  });

  it("labels text nodes from their <text> content", () => {
    const search = byLabel(tree, "Search");
    expect(search).toBeDefined();
    expect(search!.role).toBe("text");
  });

  it("marks interactive (focusable/selectable) nodes clickable", () => {
    const navButton = flatten(tree).find((n) => n.role === "button");
    expect(navButton?.clickable).toBe(true);
  });

  it("surfaces the highlighted item via [selected]", () => {
    const selected = flatten(tree).filter((n) => n.selected === true);
    expect(selected.length).toBeGreaterThan(0);
  });

  it("normalizes the nav-bar Search button frame against 1920x1080", () => {
    // <child x=67 y=23 width=177 height=74 role=button>
    const search = byLabel(tree, "Search")!; // the text node inside the button
    // its parent button has the 67/23 origin — find a button whose child is Search
    const searchButton = flatten(tree).find(
      (n) => n.role === "button" && n.children.some((c) => c.label === "Search")
    )!;
    expect(searchButton.frame.x).toBeCloseTo(67 / 1920, 4);
    expect(searchButton.frame.y).toBeCloseTo(23 / 1080, 4);
    expect(searchButton.frame.width).toBeCloseTo(177 / 1920, 4);
  });
});

describe("formatDescribeTree (vega-automation → nested)", () => {
  it("renders nested with focus/selected flags and a long description label", () => {
    const tree = parseVegaPageSource(FIXTURE);
    const text = formatDescribeTree(tree, { source: "vega-automation" });
    expect(text).toContain("Mode: nested");
    expect(text).toContain('"Search"');
    expect(text).toContain('"Home"');
    expect(text).toMatch(/\[[^\]]*selected[^\]]*\]/);
    // long synopsis text survived entity decoding (no raw &#x.. left)
    expect(text).not.toMatch(/&#x[0-9A-Fa-f]+;/);
  });
});

describe("parseVegaPageSource — robustness", () => {
  it("returns an empty Screen for structural-only / empty input", () => {
    const empty = parseVegaPageSource('<?xml version="1.0"?><root id="1"></root>');
    expect(empty.role).toBe("Screen");
    expect(empty.children).toEqual([]);
  });

  it("throws on unparseable input", () => {
    expect(() => parseVegaPageSource("not xml at all")).toThrow();
  });
});
