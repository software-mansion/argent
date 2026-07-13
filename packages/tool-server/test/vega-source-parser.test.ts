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

  it("surfaces the focused cursor via .focused (the D-pad navigation signal)", () => {
    // The shipped fixture has no focused="true" node, so assert against inline XML.
    const xml =
      '<?xml version="1.0"?><root id="1"><app appName="com.x">' +
      '<window x="0" y="0" width="1920" height="1080">' +
      '<child x="0" y="0" width="100" height="100" role="button" focusable="true" focused="true" test_id="1">' +
      "<text>Cursor</text></child></window></app></root>";
    const node = byLabel(parseVegaPageSource(xml), "Cursor");
    expect(node).toBeDefined();
    expect(node!.focused).toBe(true);
  });

  it("scopes to the foreground app and drops the Kepler launcher overlay", () => {
    const labels = flatten(tree)
      .map((n) => n.label)
      .filter(Boolean) as string[];
    // Foreground app content is present...
    expect(labels).toContain("Home");
    // ...but the launcher's own controls/text are excluded.
    expect(labels.some((l) => l.includes("Kepler Virtual Device is ready"))).toBe(false);
    expect(labels.some((l) => l.includes("Register this device"))).toBe(false);
  });

  it("reads boolean state flags case-insensitively (True / 1)", () => {
    const xml =
      '<?xml version="1.0"?><root id="1"><app appName="com.x">' +
      '<window x="0" y="0" width="1920" height="1080">' +
      '<child x="0" y="0" width="100" height="100" role="button" focusable="True" selected="1" test_id="9">' +
      "<text>Cased</text></child></window></app></root>";
    const node = byLabel(parseVegaPageSource(xml), "Cased")!;
    expect(node.clickable).toBe(true);
    expect(node.selected).toBe(true);
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

  it("renders the focused cursor as [focused] (with [selected] when both set)", () => {
    const xml =
      '<?xml version="1.0"?><root id="1"><app appName="com.x">' +
      '<window x="0" y="0" width="1920" height="1080">' +
      '<child x="0" y="0" width="100" height="100" role="button" focusable="true" focused="true" test_id="1">' +
      "<text>Cursor</text></child>" +
      '<child x="100" y="0" width="100" height="100" role="button" focusable="true" focused="true" selected="true" test_id="2">' +
      "<text>Both</text></child>" +
      "</window></app></root>";
    const text = formatDescribeTree(parseVegaPageSource(xml), { source: "vega-automation" });
    // Assert the rendered flag strings, not bare "[focused]" — the Vega header
    // mentions "[focused]"/"[selected]" verbatim, so those alone prove nothing.
    expect(text).toContain("[clickable,focused]");
    expect(text).toContain("[clickable,focused,selected]");
  });
});

// argent#474: a `WebView` embeds a nested `<app toolkitName="Chromium">` whose
// text lives in `<text>` *element* children (no `role`), unlike the native RN
// UIToolkit which tags text nodes `role="text"`. describe used to read only
// inline text, so the whole web DOM was judged unmeaningful and flattened away —
// the WebView collapsed to a single opaque node. These lock in the traversal.
describe("parseVegaPageSource — WebView (Chromium sub-app) traversal", () => {
  const WEBVIEW_FIXTURE = readFileSync(
    join(__dirname, "fixtures", "vega-webview-grid.xml"),
    "utf8"
  );
  const tree = parseVegaPageSource(WEBVIEW_FIXTURE);
  const labels = flatten(tree)
    .map((n) => n.label)
    .filter((l): l is string => Boolean(l));

  it("surfaces every WebView grid tile (not one opaque WebView node)", () => {
    // Exact labels, not substring: "Tile 1" is a substring of "Tile 10"/"Tile 11"
    // etc., so a `.includes("Tile 1")` check would pass even if tile 1 were
    // missing. Each collapsed tile leaf is labelled `${i}Tile ${i}` (e.g.
    // "10Tile 10"), so assert exact membership.
    for (let i = 1; i <= 12; i++) {
      expect(labels).toContain(`${i}Tile ${i}`);
    }
  });

  it("keeps the focused WebView root, the header role node, and its text", () => {
    const root = byLabel(tree, "Argent WebView Grid");
    expect(root).toBeDefined();
    expect(root!.focused).toBe(true);
    // The Chromium <header> survives as a role-bearing node...
    expect(flatten(tree).some((n) => n.role === "header")).toBe(true);
    // ...with its status text surfaced underneath it.
    expect(labels).toContain("Selected:");
  });

  it("normalizes WebView DOM frames against the 1920x1080 window", () => {
    // Tile 1 container: <child x=51 y=173 width=453 height=281>
    const tile1 = flatten(tree).find((n) => n.label === "1Tile 1")!;
    expect(tile1).toBeDefined();
    expect(tile1.frame.x).toBeCloseTo(51 / 1920, 3);
    expect(tile1.frame.y).toBeCloseTo(173 / 1080, 3);
    expect(tile1.frame.width).toBeCloseTo(453 / 1920, 3);
  });

  it("collapses the Chromium a11y tree's duplicated sub-spans", () => {
    // A tile container aggregates its text ("1Tile 1") and *also* nests the same
    // text as child spans ("1", "Tile 1"). The aggregate node is kept; the
    // redundant spans are absorbed so the tile is a single clean leaf.
    const tile1 = flatten(tree).find((n) => n.label === "1Tile 1")!;
    expect(tile1.children).toHaveLength(0);
  });

  it("keeps a distinct child span whose text is only a substring of the parent label", () => {
    // Regression: the collapse must not use raw substring containment. A "Play"
    // control nested in a "Playlist" container is a distinct element — "Play" is
    // a substring of "Playlist" but is NOT a sub-span that reconstructs it, so it
    // must survive. Only an exact sub-span reconstruction collapses.
    const xml =
      '<?xml version="1.0"?><root id="1"><app appName="com.x">' +
      '<window x="0" y="0" width="1920" height="1080">' +
      '<child x="0" y="0" width="300" height="80"><text>Playlist</text>' +
      '<child x="10" y="10" width="80" height="60"><text>Play</text></child>' +
      "</child></window></app></root>";
    const parsed = parseVegaPageSource(xml);
    const labels = flatten(parsed)
      .map((n) => n.label)
      .filter(Boolean);
    expect(labels).toContain("Play"); // must NOT be swallowed by "Playlist"
    expect(labels).toContain("Playlist");
  });

  it("collapses a tile's exact sub-spans into one leaf", () => {
    // The intended collapse: a tile aggregates "10Tile 10" and nests the exact
    // pieces "10" + "Tile 10" (no separator) — those reconstruct the aggregate,
    // so they are absorbed and the tile is a single clean leaf.
    const xml =
      '<?xml version="1.0"?><root id="1"><app appName="com.x">' +
      '<window x="0" y="0" width="1920" height="1080">' +
      '<child x="0" y="0" width="200" height="80"><text>10Tile 10</text>' +
      '<child x="0" y="0" width="40" height="80"><text>10</text></child>' +
      '<child x="40" y="0" width="160" height="80"><text>Tile 10</text></child>' +
      "</child></window></app></root>";
    const t10 = flatten(parseVegaPageSource(xml)).find((n) => n.label === "10Tile 10")!;
    expect(t10).toBeDefined();
    expect(t10.children).toHaveLength(0);
  });

  it("keeps distinct list rows that only aggregate on the container (separator survives)", () => {
    // A menu container whose accessible name joins its rows with spaces
    // ("Home Settings About") must NOT collapse the rows: "Home"+"Settings"+
    // "About" = "HomeSettingsAbout" != the spaced aggregate, so each row (with
    // its own distinct frame) is a real D-pad target and survives.
    const xml =
      '<?xml version="1.0"?><root id="1"><app appName="com.x">' +
      '<window x="0" y="0" width="1920" height="1080">' +
      '<child x="0" y="0" width="300" height="300"><text>Home Settings About</text>' +
      '<child x="0" y="0" width="300" height="100"><text>Home</text></child>' +
      '<child x="0" y="100" width="300" height="100"><text>Settings</text></child>' +
      '<child x="0" y="200" width="300" height="100"><text>About</text></child>' +
      "</child></window></app></root>";
    const parsed = parseVegaPageSource(xml);
    const labels = flatten(parsed)
      .map((n) => n.label)
      .filter(Boolean);
    for (const row of ["Home", "Settings", "About"]) {
      expect(labels).toContain(row);
    }
    // Their distinct y-frames are preserved (three separate rows).
    const ys = ["Home", "Settings", "About"].map(
      (r) => flatten(parsed).find((n) => n.label === r)!.frame.y
    );
    expect(new Set(ys).size).toBe(3);
  });

  it("keeps all children of a labelless structural container", () => {
    // The collapse only runs for a node with its own aggregated label; a
    // structural wrapper with no own text must pass every child through
    // untouched (the `role="header"` node in the real fixture relies on this).
    const xml =
      '<?xml version="1.0"?><root id="1"><app appName="com.x">' +
      '<window x="0" y="0" width="1920" height="1080">' +
      '<child x="0" y="0" width="300" height="200" role="header">' +
      '<child x="0" y="0" width="150" height="80"><text>Left</text></child>' +
      '<child x="150" y="0" width="150" height="80"><text>Right</text></child>' +
      "</child></window></app></root>";
    const parsed = parseVegaPageSource(xml);
    const header = flatten(parsed).find((n) => n.role === "header")!;
    expect(header.label).toBeUndefined();
    expect(header.children).toHaveLength(2);
  });

  it("does not drop a same-text span that is structural or interactive", () => {
    // A child whose text is contained in the parent's label is still kept when it
    // carries its own identity (a role / test_id / focus), so real controls that
    // happen to echo their container's text are never collapsed away.
    const xml =
      '<?xml version="1.0"?><root id="1"><app appName="com.x">' +
      '<window x="0" y="0" width="1920" height="1080">' +
      '<child x="0" y="0" width="200" height="80">' +
      "<text>Play now</text>" +
      '<child x="0" y="0" width="200" height="80" role="button" focusable="true" test_id="5">' +
      "<text>Play</text></child>" +
      "</child></window></app></root>";
    const parsed = parseVegaPageSource(xml);
    const play = flatten(parsed).find((n) => n.role === "button" && n.label === "Play");
    expect(play).toBeDefined();
    expect(play!.clickable).toBe(true);
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
