// Inline-XML coverage for the v2 interactables-only trim. Each trim rule
// has a dedicated case below — duplicate-wrapper collapse, password
// redaction, WebView DOM passthrough, descendant aggregation, scroll-clip, system
// chrome — so the suite stays runnable without an external dump fixture.
import { describe, it, expect } from "vitest";
import {
  parseUiAutomatorDump,
  parseUiAutomatorXml,
  parseUiAutomatorBounds,
} from "../src/tools/describe/platforms/android/uiautomator-parser";
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

  it("does not borrow a password descendant's text into a container label", () => {
    // A clickable container with no label of its own borrows its descendants'
    // text via descendantText(). That walk reads the raw XML, so a password
    // field's secret must be redacted there too — otherwise it rides out as the
    // container's own (non-password) label and bypasses redaction entirely.
    const xml = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy>
  <node class="android.widget.LinearLayout" clickable="true" bounds="[0,0][100,100]">
    <node class="android.widget.EditText" focusable="true" password="true" text="hunter2" bounds="[10,10][90,40]"/>
  </node>
</hierarchy>`;
    const tree = parseUiAutomatorDump(xml, 100, 100);
    const strings = flatten(tree).flatMap((n) =>
      [n.label, n.value].filter((s): s is string => !!s)
    );
    expect(strings.join(" | ")).not.toContain("hunter2");
    // The row still surfaces the redacted marker instead of the plaintext.
    expect(flatten(tree).map((n) => n.label)).toContain("[password]");
  });

  it("keeps the WebView as a landmark and preserves its DOM subtree", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy>
  <node class="android.webkit.WebView" bounds="[0,0][100,100]" content-desc="checkout">
    <node class="android.view.View" bounds="[10,10][50,50]" content-desc="from-dom"/>
  </node>
</hierarchy>`;
    const tree = parseUiAutomatorDump(xml, 100, 100);
    const webview = flatten(tree).find((n) => n.role === "WebView");
    expect(webview).toBeDefined();
    // The landmark keeps the page title verbatim — no "[web-view]" marker,
    // which only ever meant "content deliberately withheld".
    expect(webview?.label).toBe("checkout");
    // Chromium publishes the DOM to the accessibility tree; it must survive.
    expect(webview?.children).toHaveLength(1);
    expect(flatten(tree).some((n) => n.label === "from-dom")).toBe(true);
  });

  it("keeps a zero-area WebView whose DOM children are still on screen", () => {
    // Every other branch drops a node only when it is both invisible AND
    // contributes nothing; the WebView branch used to drop on !visible alone,
    // taking a live subtree down with it.
    const xml = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy>
  <node class="android.webkit.WebView" bounds="[0,0][0,0]">
    <node class="android.widget.Button" bounds="[10,10][50,50]" text="Pay" clickable="true"/>
  </node>
</hierarchy>`;
    const tree = parseUiAutomatorDump(xml, 100, 100);
    expect(flatten(tree).some((n) => n.label === "Pay")).toBe(true);
  });

  it("drops a WebView that is off screen and has no surviving children", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy>
  <node class="android.webkit.WebView" bounds="[500,500][600,600]" content-desc="offscreen"/>
</hierarchy>`;
    const tree = parseUiAutomatorDump(xml, 100, 100);
    expect(flatten(tree).some((n) => n.role === "WebView")).toBe(false);
  });

  it("redacts a password input inside a WebView", () => {
    // Chromium sets password="true" on a web <input type=password>. The
    // existing redaction must cover it, and the plaintext must not ride out on
    // any node — including an ancestor that borrows descendant text.
    const xml = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][100,100]" clickable="true">
    <node class="android.webkit.WebView" bounds="[0,0][100,100]" content-desc="Login Page">
      <node class="android.widget.EditText" bounds="[10,10][90,40]" resource-id="password" password="true" focusable="true" text="hunter2"/>
    </node>
  </node>
</hierarchy>`;
    const tree = parseUiAutomatorDump(xml, 100, 100);
    const all = flatten(tree);
    const field = all.find((n) => n.role === "TextField");
    expect(field?.label).toBe("[password]");
    expect(field?.password).toBe(true);
    expect(field?.value).toBeUndefined();
    // Nothing anywhere in the tree carries the secret — not as a label, not as
    // a value borrowed onto the clickable ancestor via descendantText().
    const strings = all.flatMap((n) => [n.label, n.value].filter((x): x is string => !!x));
    expect(strings.join(" | ")).not.toContain("hunter2");
  });

  it("exposes an HTML id as the node identifier", () => {
    // Chromium maps an HTML `id` onto `resource-id`, which is what makes a web
    // control selector-addressable the same way a native one is.
    const xml = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy>
  <node class="android.webkit.WebView" bounds="[0,0][100,100]" content-desc="Login Page">
    <node class="android.widget.EditText" bounds="[10,10][90,40]" resource-id="username" clickable="true" focusable="true"/>
    <node class="android.widget.Button" bounds="[10,50][90,80]" resource-id="login" text="Login" clickable="true"/>
  </node>
</hierarchy>`;
    const tree = parseUiAutomatorDump(xml, 100, 100);
    const ids = flatten(tree).map((n) => n.identifier);
    expect(ids).toContain("username");
    expect(ids).toContain("login");
  });

  // Chromium emits the host WebView twice, nested. Both shapes occur in the
  // wild: the checked-in in-app fixture has the pair at identical bounds, and a
  // current WebView on Android 15 reports the inner node a few pixels larger
  // (measured: [0,0][1080,2400] outer, [0,0][1084,2402] inner). Neither reaches
  // the generic duplicate-wrapper collapse further down — the WebView branch
  // returns first — so both need the merge here.
  for (const [shape, innerBounds] of [
    ["identical bounds", "[0,220][1080,2154]"],
    ["bounds that drift by a few px", "[0,220][1084,2156]"],
  ] as const) {
    it(`collapses the doubled WebView Chromium emits with ${shape}`, () => {
      const xml = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy>
  <node class="android.webkit.WebView" bounds="[0,220][1080,2154]">
    <node class="android.webkit.WebView" bounds="${innerBounds}" content-desc="The Internet">
      <node class="android.widget.Button" bounds="[10,300][90,380]" text="Login" clickable="true"/>
    </node>
  </node>
</hierarchy>`;
      const tree = parseUiAutomatorDump(xml, 1080, 2400);
      const webviews = flatten(tree).filter((n) => n.role === "WebView");
      expect(webviews).toHaveLength(1);
      // The surviving landmark keeps whichever of the two carried the page title.
      expect(webviews[0]?.label).toBe("The Internet");
      expect(webviews[0]?.children.some((c) => c.label === "Login")).toBe(true);
    });
  }

  it("leaves an app's own WebView subclass beside the host, not merged into it", () => {
    // `deriveUiAutomatorRole` maps every class whose name contains "webview" to
    // the role "WebView", so a role test cannot tell the doubled host apart
    // from an unrelated native subclass a page embeds as a control. Merging
    // that child would delete a tappable element and move its id and label onto
    // the landmark, pointing a tap at the whole page instead.
    const xml = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy>
  <node class="android.webkit.WebView" bounds="[0,0][200,400]">
    <node class="com.acme.player.MyWebView" bounds="[0,20][200,140]" resource-id="com.acme:id/player" content-desc="Video player" clickable="true"/>
  </node>
</hierarchy>`;
    const tree = parseUiAutomatorDump(xml, 200, 400);
    const host = tree.children[0]!;
    // The landmark stays anonymous — it never adopts the child's identity.
    expect(host.role).toBe("WebView");
    expect(host.identifier).toBeUndefined();
    expect(host.label).toBeUndefined();
    // ...and the control is still its own tappable node underneath.
    const player = host.children[0];
    expect(player?.identifier).toBe("com.acme:id/player");
    expect(player?.label).toBe("Video player");
    expect(player?.clickable).toBe(true);
  });

  it("collapses three nested WebView nodes down to one landmark", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy>
  <node class="android.webkit.WebView" bounds="[0,0][200,400]">
    <node class="android.webkit.WebView" bounds="[0,0][200,400]">
      <node class="android.webkit.WebViewChromium" bounds="[0,0][200,400]" content-desc="Docs">
        <node class="android.widget.TextView" bounds="[10,10][190,40]" text="Chapter 1"/>
      </node>
    </node>
  </node>
</hierarchy>`;
    const webviews = flatten(parseUiAutomatorDump(xml, 200, 400)).filter(
      (n) => n.role === "WebView"
    );
    expect(webviews).toHaveLength(1);
    expect(webviews[0]?.label).toBe("Docs");
    expect(webviews[0]?.children.map((c) => c.label)).toEqual(["Chapter 1"]);
  });

  it("keeps an on-screen WebView whose renderer has published no DOM", () => {
    // The state right after launch, and for a page with no accessible content.
    // The node carries no label, no id and no gesture flag, so nothing but the
    // WebView role itself keeps the one element covering the screen on the page.
    const xml = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy>
  <node class="android.webkit.WebView" bounds="[0,0][100,100]"/>
</hierarchy>`;
    const webview = flatten(parseUiAutomatorDump(xml, 100, 100)).find((n) => n.role === "WebView");
    expect(webview).toBeDefined();
    expect(webview?.label).toBeUndefined();
    expect(webview?.frame).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it("rolls the merged pair's hidden-child counts together", () => {
    // A row scrolled out of a real web scroller is counted on the inner node.
    // The merge drops that node, so its count has to move to the landmark or
    // the "swipe before you tap" signal is silently lost.
    const xml = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy>
  <node class="android.webkit.WebView" bounds="[0,0][200,200]" scrollable="true">
    <node class="android.webkit.WebView" bounds="[0,0][200,200]" content-desc="Feed">
      <node class="android.widget.TextView" bounds="[10,10][190,40]" text="Row 1"/>
      <node class="android.widget.TextView" bounds="[10,250][190,290]" text="Row 40"/>
    </node>
  </node>
</hierarchy>`;
    const webview = flatten(parseUiAutomatorDump(xml, 200, 400)).find((n) => n.role === "WebView");
    expect(webview?.children.map((c) => c.label)).toEqual(["Row 1"]);
    expect(webview?.scrollHidden).toBe(1);
  });

  it("keeps the interaction flags either half of the doubled WebView carried", () => {
    // Whichever half the framework marked, the merged landmark inherits the
    // union — the flags decide whether an agent treats the region as tappable
    // or scrollable at all.
    const xml = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy>
  <node class="android.webkit.WebView" bounds="[0,0][200,400]" resource-id="host_web_view">
    <node class="android.webkit.WebView" bounds="[0,0][201,402]" scrollable="true" clickable="true" long-clickable="true" content-desc="Docs">
      <node class="android.widget.TextView" bounds="[10,10][190,40]" text="Chapter 1"/>
    </node>
  </node>
</hierarchy>`;
    const tree = parseUiAutomatorDump(xml, 200, 400);
    const webview = flatten(tree).find((n) => n.role === "WebView");
    expect(webview?.scrollable).toBe(true);
    expect(webview?.clickable).toBe(true);
    expect(webview?.longClickable).toBe(true);
    expect(webview?.identifier).toBe("host_web_view");
  });

  it("does not let a web list clip content positioned outside its box", () => {
    // Chromium maps a <ul> onto android.widget.ListView, which is a scroll
    // class — but a web list does not scroll, the WebView does. Treating it as
    // a scroll container turns its box into a clip window, so a submenu the
    // page positions below the list is dropped as "scrolled away" while it is
    // plainly on screen.
    const xml = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy>
  <node class="android.webkit.WebView" bounds="[0,0][1080,2400]" text="Menu Page">
    <node class="android.widget.ListView" bounds="[20,170][1060,260]" scrollable="false">
      <node class="android.view.View" bounds="[20,170][220,230]">
        <node class="android.widget.TextView" bounds="[20,170][220,230]" text="Inbox item"/>
        <node class="android.view.View" bounds="[20,1220][260,1280]" content-desc="Escaped link" clickable="true"/>
      </node>
    </node>
  </node>
</hierarchy>`;
    const labels = flatten(parseUiAutomatorDump(xml, 1080, 2400)).map((n) => n.label);
    expect(labels).toContain("Inbox item");
    expect(labels).toContain("Escaped link");
  });

  it("still clips against a web container the framework marks scrollable", () => {
    // A web scroller is real when Chromium says so (overflow: scroll). Its box
    // is then a genuine viewport and content outside it is genuinely hidden.
    const xml = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy>
  <node class="android.webkit.WebView" bounds="[0,0][1080,2400]" text="Menu Page">
    <node class="android.widget.ListView" bounds="[20,170][1060,260]" scrollable="true">
      <node class="android.view.View" bounds="[20,170][220,230]">
        <node class="android.widget.TextView" bounds="[20,170][220,230]" text="Inbox item"/>
        <node class="android.view.View" bounds="[20,1220][260,1280]" content-desc="Below the fold" clickable="true"/>
      </node>
    </node>
  </node>
</hierarchy>`;
    const labels = flatten(parseUiAutomatorDump(xml, 1080, 2400)).map((n) => n.label);
    expect(labels).toContain("Inbox item");
    expect(labels).not.toContain("Below the fold");
  });

  it("carries every flag and value the inner half of the WebView pair held", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy>
  <node class="android.webkit.WebView" bounds="[0,0][200,400]">
    <node class="android.webkit.WebView" bounds="[0,0][201,402]" resource-id="inner_web_view" text="Docs" checkable="true" checked="true" enabled="false" content-desc="Documentation">
      <node class="android.widget.TextView" bounds="[10,10][190,40]" text="Chapter 1"/>
    </node>
  </node>
</hierarchy>`;
    const webview = flatten(parseUiAutomatorDump(xml, 200, 400)).find((n) => n.role === "WebView");
    // The outer node carries none of these, so every one of them can only have
    // come from the inner half of the collapsed pair.
    expect(webview?.identifier).toBe("inner_web_view");
    expect(webview?.checkable).toBe(true);
    expect(webview?.checked).toBe(true);
    expect(webview?.disabled).toBe(true);
    expect(webview?.value).toBe("Docs");
  });

  it("reads a bare web text container as StaticText, and only inside a WebView", () => {
    // Chromium maps a generic web text run onto android.view.View, which
    // deriveUiAutomatorRole reports as "View" — unmatchable by an
    // `await-ui-element` role: StaticText. The remap must be contextual: the
    // same class on a native (Compose) screen keeps its current role.
    const xml = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy>
  <node class="android.webkit.WebView" bounds="[0,0][200,200]" content-desc="Login Page">
    <node class="android.view.View" bounds="[10,10][190,40]" text="Username"/>
    <node class="android.view.View" bounds="[10,50][190,80]" text="Open docs" clickable="true"/>
  </node>
  <node class="android.view.View" bounds="[10,120][190,150]" text="Native label"/>
</hierarchy>`;
    const tree = parseUiAutomatorDump(xml, 200, 200);
    const byLabel = new Map(flatten(tree).map((n) => [n.label, n.role]));
    expect(byLabel.get("Username")).toBe("StaticText");
    // A clickable web node is a control, not text — leave its role alone.
    expect(byLabel.get("Open docs")).toBe("View");
    // Same class outside the WebView is untouched (regression guard for the
    // shared deriveUiAutomatorRole used by the flow selector tree).
    expect(byLabel.get("Native label")).toBe("View");
  });

  it("reads a focusable web text run as StaticText, and a container as a container", () => {
    // Two guards on the remap that a gesture-flags test cannot reach. Chromium
    // marks some web text runs focusable, so focus must not disqualify one —
    // that is why the predicate is gesture flags only and not `isInteractive`.
    // And a labelled node that still has kept children is a container, not a
    // text run, whatever its class says.
    const xml = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy>
  <node class="android.webkit.WebView" bounds="[0,0][200,400]" content-desc="Article">
    <node class="android.view.View" bounds="[10,10][190,40]" text="Focusable caption" focusable="true"/>
    <node class="android.view.View" bounds="[10,50][190,140]" content-desc="Author card">
      <node class="android.widget.TextView" bounds="[10,60][190,90]" text="Ada Lovelace"/>
    </node>
  </node>
</hierarchy>`;
    const byLabel = new Map(flatten(parseUiAutomatorDump(xml, 200, 400)).map((n) => [n.label, n]));
    expect(byLabel.get("Focusable caption")?.role).toBe("StaticText");
    expect(byLabel.get("Author card")?.role).toBe("View");
    expect(byLabel.get("Author card")?.children).toHaveLength(1);
  });

  it("drops a child whose text its labelled tap target already spells out", () => {
    // A tap target that carries its own label repeats its text as a child node
    // on many screens (a link whose anchor text is also its content-desc, a
    // like button whose count is a child TextView). Showing both makes the
    // agent read one control as two items.
    const xml = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy>
  <node class="android.widget.Button" bounds="[0,0][200,60]" content-desc="Like (634 likes)" clickable="true">
    <node class="android.widget.TextView" bounds="[10,10][60,50]" text="634"/>
  </node>
</hierarchy>`;
    const nodes = flatten(parseUiAutomatorDump(xml, 200, 200));
    expect(nodes.map((n) => n.label)).toEqual([undefined, "Like (634 likes)"]);
  });

  it("keeps a repeated child that is a tap target in its own right", () => {
    // The same text under a tappable child is a separate control, not an echo.
    const xml = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy>
  <node class="android.widget.LinearLayout" bounds="[0,0][200,60]" content-desc="Powered by Elemental Selenium" clickable="true">
    <node class="android.widget.TextView" bounds="[10,10][190,50]" text="Elemental Selenium" clickable="true"/>
  </node>
</hierarchy>`;
    const labels = flatten(parseUiAutomatorDump(xml, 200, 200)).map((n) => n.label);
    expect(labels).toContain("Elemental Selenium");
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
