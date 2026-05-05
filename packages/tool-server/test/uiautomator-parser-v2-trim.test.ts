// Inline-XML coverage for the v2 interactables-only trim. Each trim rule
// has a dedicated case below — duplicate-wrapper collapse, password
// redaction, WebView opacity, descendant aggregation, scroll-clip, system
// chrome — so the suite stays runnable without an external dump fixture.
import { describe, it, expect } from "vitest";
import {
  parseUiAutomatorDump,
  parseUiAutomatorXml,
  parseUiAutomatorBounds,
} from "../src/utils/uiautomator-parser";
import { parseDescribeResult, type DescribeNode } from "../src/tools/describe/contract";

function flatten(tree: DescribeNode): DescribeNode[] {
  const out: DescribeNode[] = [];
  const stack: DescribeNode[] = [tree];
  while (stack.length > 0) {
    const n = stack.pop()!;
    out.push(n);
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!);
  }
  return out;
}

describe("parseUiAutomatorBounds", () => {
  it("parses well-formed [x1,y1][x2,y2]", () => {
    expect(parseUiAutomatorBounds("[10,20][110,220]")).toEqual({ x: 10, y: 20, w: 100, h: 200 });
  });

  it("clamps negative width/height to zero", () => {
    expect(parseUiAutomatorBounds("[100,200][50,180]")).toEqual({ x: 100, y: 200, w: 0, h: 0 });
  });

  it("returns null on malformed input", () => {
    expect(parseUiAutomatorBounds("not bounds")).toBeNull();
  });
});

describe("parseUiAutomatorXml", () => {
  it("preserves `>` inside quoted attribute values", () => {
    const xml = `<hierarchy><node text="A > B" bounds="[0,0][10,10]"/></hierarchy>`;
    const root = parseUiAutomatorXml(xml);
    expect(root?.tag).toBe("hierarchy");
    expect(root?.children[0]?.attrs.text).toBe("A > B");
  });
});

describe("parseUiAutomatorDump — v2 trim focused behaviour", () => {
  it("collapses a clickable parent + clickable child with identical bounds", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][100,100]" clickable="true" content-desc="outer">
    <node class="android.widget.Button" bounds="[0,0][100,100]" clickable="true" content-desc="inner"/>
  </node>
</hierarchy>`;
    const tree = parseUiAutomatorDump(xml, 100, 100);
    const all = flatten(tree).filter((n) => n.role !== "Screen");
    expect(all).toHaveLength(1);
    expect(all[0]?.label).toBe("inner");
    expect(all[0]?.role).toBe("Button");
  });

  it("redacts the value of password fields", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy>
  <node class="android.widget.EditText" bounds="[0,0][100,100]" clickable="true" focusable="true" password="true" text="hunter2"/>
</hierarchy>`;
    const tree = parseUiAutomatorDump(xml, 100, 100);
    const field = flatten(tree).find((n) => n.role === "TextField");
    expect(field?.label).toBe("[password]");
    expect(field?.password).toBe(true);
    // The actual secret must NOT leak into `value` either.
    expect(field?.value).toBeUndefined();
  });

  it("treats WebView as an opaque single leaf", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy>
  <node class="android.webkit.WebView" bounds="[0,0][100,100]" content-desc="checkout">
    <node class="android.view.View" bounds="[10,10][50,50]" content-desc="leaked-from-dom"/>
  </node>
</hierarchy>`;
    const tree = parseUiAutomatorDump(xml, 100, 100);
    const webview = flatten(tree).find((n) => n.role === "WebView");
    expect(webview).toBeDefined();
    expect(webview?.children).toHaveLength(0);
    expect(webview?.label).toContain("[web-view]");
    // The DOM-side content-desc must NOT bleed through as a sibling node.
    expect(flatten(tree).some((n) => n.label === "leaked-from-dom")).toBe(false);
  });

  it("aggregates descendant labels into a clickable container with no own label", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy>
  <node class="android.view.ViewGroup" bounds="[0,0][200,200]" clickable="true">
    <node class="android.widget.TextView" bounds="[0,0][100,50]" text="Alice"/>
    <node class="android.widget.TextView" bounds="[0,50][100,100]" text="@alice"/>
  </node>
</hierarchy>`;
    const tree = parseUiAutomatorDump(xml, 200, 200);
    // The clickable wrapper now shows the row's labels so an agent tapping
    // it knows what cell it's hitting.
    const container = flatten(tree).find((n) => n.clickable);
    expect(container?.label).toBe("Alice / @alice");
  });

  it("surfaces an EditText's content-desc as label and its text as value", () => {
    // The contract pre-dates the v2 trim: DescribeNode separates the screen-
    // reader-meaningful label (content-desc / role description) from the
    // user-visible text (value). An EditText that has typed input AND a
    // placeholder must keep both so an agent can read either piece.
    const xml = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy>
  <node class="android.widget.EditText" bounds="[0,0][100,40]" focusable="true" clickable="true" text="hello" content-desc="Email"/>
</hierarchy>`;
    const tree = parseUiAutomatorDump(xml, 100, 40);
    const field = flatten(tree).find((n) => n.role === "TextField");
    expect(field?.label).toBe("Email");
    expect(field?.value).toBe("hello");
  });

  it("re-validates the trimmed tree against the public DescribeNode schema", () => {
    // Cheap guardrail: the trim must always produce something
    // `parseDescribeResult` accepts, even on minimal input.
    const xml = `<?xml version='1.0' ?>
<hierarchy>
  <node class="android.widget.Button" bounds="[0,0][100,40]" clickable="true" text="OK"/>
</hierarchy>`;
    const tree = parseUiAutomatorDump(xml, 100, 40);
    expect(() => parseDescribeResult(tree)).not.toThrow();
  });

  it("drops com.android.systemui chrome by default", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy>
  <node class="android.widget.FrameLayout" package="xyz.app" bounds="[0,0][100,100]">
    <node class="android.widget.TextView" package="xyz.app" bounds="[0,0][50,50]" text="App content"/>
  </node>
  <node class="android.widget.FrameLayout" package="com.android.systemui" bounds="[0,0][100,30]" content-desc="status bar"/>
</hierarchy>`;
    const tree = parseUiAutomatorDump(xml, 100, 100);
    const labels = flatten(tree)
      .map((n) => n.label)
      .filter(Boolean);
    expect(labels).toContain("App content");
    expect(labels).not.toContain("status bar");
  });

  it("retains com.android.systemui chrome when includeSystem is set", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.android.systemui" bounds="[0,0][100,30]" content-desc="status bar"/>
</hierarchy>`;
    const tree = parseUiAutomatorDump(xml, 100, 100, { includeSystem: true });
    expect(flatten(tree).some((n) => n.label === "status bar")).toBe(true);
  });

  it("counts scroll-hidden children but keeps visible ones", () => {
    // The screen is 200x600 so both texts are within the screen rect, but
    // the parent ScrollView only covers the top 200 px. The row's scroll-
    // clip — inherited from its ScrollView ancestor — should drop the text
    // at y=400 while keeping the one inside the viewport.
    const xml = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy>
  <node class="android.widget.ScrollView" bounds="[0,0][200,200]" scrollable="true">
    <node class="android.view.ViewGroup" bounds="[0,0][200,200]" clickable="true" content-desc="row">
      <node class="android.widget.TextView" bounds="[0,50][200,100]" text="visible"/>
      <node class="android.widget.TextView" bounds="[0,400][200,450]" text="hidden"/>
    </node>
  </node>
</hierarchy>`;
    const tree = parseUiAutomatorDump(xml, 200, 600);
    const all = flatten(tree);
    expect(all.some((n) => n.label === "hidden")).toBe(false);
    const row = all.find((n) => n.label === "row");
    expect(row?.scrollHidden).toBe(1);
  });

  it("strips React Native SVG sub-paths entirely", () => {
    // com.horcrux.svg.{Path,Group,Svg}View are dump-side noise — the icon's
    // content-desc lives on the parent ImageView/Button, not these leaves.
    const xml = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy>
  <node class="android.widget.Button" bounds="[0,0][100,100]" clickable="true" content-desc="Send">
    <node class="com.horcrux.svg.SvgView" bounds="[10,10][90,90]">
      <node class="com.horcrux.svg.GroupView" bounds="[10,10][90,90]">
        <node class="com.horcrux.svg.PathView" bounds="[10,10][90,90]"/>
      </node>
    </node>
  </node>
</hierarchy>`;
    const tree = parseUiAutomatorDump(xml, 100, 100);
    const roles = new Set(flatten(tree).map((n) => n.role));
    expect(roles.has("PathView")).toBe(false);
    expect(roles.has("GroupView")).toBe(false);
    expect(roles.has("SvgView")).toBe(false);
    // The Button itself must survive — only the SVG subtree is stripped.
    expect(flatten(tree).find((n) => n.label === "Send")?.role).toBe("Button");
  });

  it("drops a node fully off-screen and contributing nothing", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy>
  <node class="android.widget.TextView" bounds="[2000,2000][3000,3000]" text="off screen"/>
  <node class="android.widget.TextView" bounds="[10,10][100,30]" text="on screen"/>
</hierarchy>`;
    const tree = parseUiAutomatorDump(xml, 1000, 1000);
    const labels = flatten(tree)
      .map((n) => n.label)
      .filter(Boolean);
    expect(labels).not.toContain("off screen");
    expect(labels).toContain("on screen");
  });
});
