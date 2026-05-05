import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  parseUiAutomatorBounds,
  parseUiAutomatorDump,
  parseUiAutomatorXml,
} from "../src/utils/uiautomator-parser";
import { parseDescribeResult, type DescribeNode } from "../src/tools/describe/contract";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIXTURE_PATH = resolve(
  __dirname,
  "../../../research/android-ui-inspection/artifacts/02_uiautomator_compressed.xml"
);

const SCREEN_W = 1280;
const SCREEN_H = 2856;

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

function findByLabel(tree: DescribeNode, label: string): DescribeNode | null {
  return flatten(tree).find((n) => n.label === label) ?? null;
}

function tapPoint(n: DescribeNode): { x: number; y: number } {
  return { x: n.frame.x + n.frame.width / 2, y: n.frame.y + n.frame.height / 2 };
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

describe("parseUiAutomatorDump — v2 trim sanity checks", () => {
  // Real captured Bluesky post-thread dump: `uiautomator dump --compressed`
  // on emulator-5554 (1280x2856). Used as the regression fixture for the
  // README's "Sanity checks" — every claim there should hold here.
  const fixture = readFileSync(FIXTURE_PATH, "utf-8");
  const tree = parseUiAutomatorDump(fixture, SCREEN_W, SCREEN_H);
  const all = flatten(tree);

  it("returns a Screen-rooted tree with normalized [0,1] frame", () => {
    expect(tree.role).toBe("Screen");
    expect(tree.frame).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it("preserves the Compose reply Button at the centre of the bottom bar", () => {
    // The README's headline failure case: the previous agent tapped at
    // (0.24, 0.85) — a placeholder Text inside the Button — and missed.
    // The Button's centre is (0.50, 0.90).
    const compose = findByLabel(tree, "Compose reply");
    expect(compose).not.toBeNull();
    expect(compose!.role).toBe("Button");
    expect(compose!.clickable).toBe(true);
    const tap = tapPoint(compose!);
    expect(tap.x).toBeCloseTo(0.5, 2);
    expect(tap.y).toBeCloseTo(0.9, 2);
  });

  it("preserves the placeholder Text inside the Compose reply Button", () => {
    // "Write your reply" must survive — it's the visible text inside the
    // Button, and an agent matching against the union of text/desc would
    // find it. The previous-agent narrative claimed UiAutomator hides it;
    // it doesn't.
    const writeReply = findByLabel(tree, "Write your reply");
    expect(writeReply).not.toBeNull();
    expect(writeReply!.role).toBe("StaticText");
  });

  it("preserves all five bottom-bar nav buttons", () => {
    const labels = ["Home", "Search", "Chat", "Notifications", "Profile"];
    for (const lbl of labels) {
      const node = findByLabel(tree, lbl);
      expect(node, `expected ${lbl} button`).not.toBeNull();
      expect(node!.role).toBe("Button");
      expect(node!.clickable).toBe(true);
    }
  });

  it("preserves the social action buttons (reply/repost/like/save/share/menu)", () => {
    // Sanity-checks the "drop redundant child Text" rule: the `likeBtn`
    // with label "Like (634 likes)" must remain in the tree — only its
    // inner "634" Text child should be elided. Same for repostBtn / replyBtn.
    const likeBtn = all.find((n) => n.identifier === "likeBtn");
    expect(likeBtn?.label).toBe("Like (634 likes)");
    expect(likeBtn?.clickable).toBe(true);
    expect(all.find((n) => n.identifier === "replyBtn")?.label).toBe("Reply (13 replies)");
    expect(all.find((n) => n.identifier === "repostBtn")?.label).toBe("Repost (49 reposts)");
    expect(all.find((n) => n.identifier === "postBookmarkBtn")?.label).toBe("Add to saved posts");
    expect(all.find((n) => n.identifier === "postShareBtn")?.label).toBe("Open share menu");
    expect(all.find((n) => n.identifier === "postDropdownBtn")?.label).toBe(
      "Open post options menu"
    );
  });

  it("preserves all 27 clickable nodes from the dump", () => {
    // README §"Sanity checks (confirmed not over-pruned)": "All 27 clickable
    // elements — kept". Counted from the raw XML (clickable="true").
    const clickableCount = all.filter((n) => n.clickable).length;
    expect(clickableCount).toBe(27);
  });

  it("strips React Native SVG sub-paths", () => {
    // com.horcrux.svg.{Path,Group,Svg}View are dump-side noise — there are
    // 45+ of them in the un-trimmed Bluesky dump. None should survive.
    const roles = new Set(all.map((n) => n.role));
    expect(roles.has("PathView")).toBe(false);
    expect(roles.has("GroupView")).toBe(false);
    expect(roles.has("SvgView")).toBe(false);
  });

  it("flattens decorative wrappers — nothing has zero-area frame", () => {
    // After trim, every emitted node should have a concrete tap target
    // (no [0,0,0,0] holes) so the agent doesn't see hollow rows.
    for (const n of all) {
      if (n.role === "Screen") continue;
      expect(n.frame.width + n.frame.height).toBeGreaterThan(0);
    }
  });

  it("never emits frames outside the [0,1] contract", () => {
    for (const n of all) {
      expect(n.frame.x).toBeGreaterThanOrEqual(0);
      expect(n.frame.y).toBeGreaterThanOrEqual(0);
      expect(n.frame.x + n.frame.width).toBeLessThanOrEqual(1.0001);
      expect(n.frame.y + n.frame.height).toBeLessThanOrEqual(1.0001);
    }
  });

  it("trims the parsed tree by an order of magnitude", () => {
    // The raw compressed dump has 64 <node> elements; the README expects the
    // trim to land near 41 emitted nodes. Allow a 10-node grace band so
    // small upstream label changes don't false-flag.
    const emitted = all.length - 1; // exclude Screen root
    expect(emitted).toBeGreaterThanOrEqual(35);
    expect(emitted).toBeLessThanOrEqual(55);
  });
});

describe("parseUiAutomatorDump — focused trim behaviour", () => {
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

  it("preserves Scroll roles with the scrollable flag set", () => {
    // The README emphasises surfacing scrolls so the agent knows to swipe
    // before tapping. Verifies the flag survives the trim.
    const fixture = readFileSync(FIXTURE_PATH, "utf-8");
    const tree = parseUiAutomatorDump(fixture, SCREEN_W, SCREEN_H);
    const scrollable = flatten(tree).filter((n) => n.scrollable === true);
    expect(scrollable.length).toBeGreaterThanOrEqual(1);
    expect(scrollable[0]?.role).toBe("ScrollView");
  });

  it("re-validates the trimmed fixture against the public DescribeNode schema", () => {
    // Cheap guardrail: the trim must produce something `parseDescribeResult`
    // accepts so the contract test in describe-contract.test.ts continues to
    // catch any frame/role drift downstream.
    const fixture = readFileSync(FIXTURE_PATH, "utf-8");
    const tree = parseUiAutomatorDump(fixture, SCREEN_W, SCREEN_H);
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
    const labels = flatten(tree).map((n) => n.label).filter(Boolean);
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
    // Screen is 200x600 so both texts fall on screen and survive the
    // visibility filter; the Scroll only covers the top 200 rows. The row's
    // scroll-clip — inherited from its parent ScrollView — should drop the
    // text at y=400 while keeping the one inside the viewport.
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
});
