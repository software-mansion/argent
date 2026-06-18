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
    // Vega is remote-driven: the header frames coordinates as D-pad hints, not
    // tap targets — the iOS/Android tap formula must not appear.
    expect(text).toContain("remote-driven");
    expect(text).not.toContain("tap_x = frame.x");
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

  it("drops <traits> metadata without swallowing the following siblings", () => {
    // Real toolkit output is always well-formed (a real XML parser rejects
    // malformed input), so this asserts the real intent: the first child's
    // <traits> subtree is dropped and the sibling after it still parses.
    const xml =
      '<?xml version="1.0"?>' +
      '<root id="1"><window x="0" y="0" width="1920" height="1080">' +
      '<child x="10" y="10" width="50" height="50" role="button" focusable="true" test_id="1">' +
      "<text>First</text><traits><visibility/></traits></child>" +
      '<child x="70" y="10" width="50" height="50" role="button" focusable="true" test_id="2">' +
      "<text>Second</text></child>" +
      "</window></root>";
    const tree = parseVegaPageSource(xml);
    expect(byLabel(tree, "First")).toBeDefined();
    expect(byLabel(tree, "Second")).toBeDefined();
    // The <visibility> trait must not leak in as a UI node.
    expect(flatten(tree).some((n) => n.role === "visibility")).toBe(false);
  });

  it("normalizes frames against <window>, not a sized leaf that precedes it", () => {
    const xml =
      '<?xml version="1.0"?>' +
      '<root id="1"><app appName="x">' +
      '<icon x="0" y="0" width="48" height="48" role="image" test_id="9"/>' +
      '<window x="0" y="0" width="1920" height="1080">' +
      '<child x="960" y="540" width="192" height="108" role="button" focusable="true" test_id="2">' +
      "<text>Mid</text></child>" +
      "</window></app></root>";
    const tree = parseVegaPageSource(xml);
    const mid = byLabel(tree, "Mid")!;
    // Against the 1920×1080 window — not the 48×48 icon, which would clamp the
    // mid-screen button off-screen to ~{x:1, w:0}.
    expect(mid.frame.x).toBeCloseTo(960 / 1920, 3);
    expect(mid.frame.width).toBeCloseTo(192 / 1920, 3);
  });
});
