// Android WebView coverage on real captures (API 35 / WebView 124, 1080x2424):
// an in-app WebView (HtmlViewer), a Chrome tab, and a cold capture taken before
// Chromium published the page. The android-devtools helper and the
// `uiautomator dump` fallback emit the same XML shape, so one parser pass
// covers both; `describeAndroid` adds the one re-read the cold shape needs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import type { Registry } from "@argent/registry";
import { parseUiAutomatorDump } from "../src/tools/describe/platforms/android/uiautomator-parser";
import { describeAndroid, hasUnreadWebView } from "../src/tools/describe/platforms/android";
import { formatDescribeTree } from "../src/tools/describe/format-tree";
import type { DescribeNode } from "../src/tools/describe/contract";

const fixture = (name: string): string =>
  readFileSync(join(__dirname, "fixtures", `android-webview-${name}.xml`), "utf-8");

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

describe("parseUiAutomatorDump — WebView captures", () => {
  it("lists the form inside an in-app WebView as one merged landmark", () => {
    const tree = parseUiAutomatorDump(fixture("inapp"), 1080, 2424);
    const webviews = flatten(tree).filter((n) => n.role === "WebView");
    expect(webviews).toHaveLength(1);
    const labels = flatten(webviews[0]!).map((n) => `${n.role} ${n.label ?? ""}`.trim());
    expect(labels).toContain("Button Pay now");
    expect(labels).toContain("TextField");
    expect(labels.some((l) => l.startsWith("StaticText"))).toBe(true);
    // A web `<ul>` is a List, never a scroll clip.
    expect(labels).toContain("List");
    expect(labels.some((l) => l.startsWith("ScrollView"))).toBe(false);
  });

  it("keeps a heading that repeats the page title in a Chrome tab", () => {
    const tree = parseUiAutomatorDump(fixture("chrome"), 1080, 2424);
    const webview = flatten(tree).find((n) => n.role === "WebView");
    expect(webview?.label).toMatch(/Wikipedia/);
    const rendered = formatDescribeTree(tree, { source: "android-devtools" });
    expect(rendered).toContain('StaticText "Android version history"');
    expect(rendered).toContain("[clickable]");
  });

  it("renders the cold capture as a leaf the adapter re-reads on", () => {
    const tree = parseUiAutomatorDump(fixture("cold"), 1080, 2424);
    expect(hasUnreadWebView(tree)).toBe(true);
    expect(hasUnreadWebView(parseUiAutomatorDump(fixture("inapp"), 1080, 2424))).toBe(false);
  });

  it("does not surface the native chrome text through the WebView branch", () => {
    // Status-bar nodes stay filtered exactly as before.
    const rendered = formatDescribeTree(parseUiAutomatorDump(fixture("inapp"), 1080, 2424), {
      source: "android-devtools",
    });
    expect(rendered).not.toContain("Battery");
  });
});

describe("describeAndroid — re-read on an unread WebView", () => {
  function fakeRegistry(hierarchies: string[]) {
    // Serve the captures in order and repeat the last one.
    const getHierarchy = vi.fn(async () => ({
      xml: hierarchies.length > 1 ? hierarchies.shift()! : hierarchies[0]!,
    }));
    const resolveService = vi.fn(async () => ({
      isReady: () => true,
      getHierarchy,
      getScreenSize: async () => ({ width: 1080, height: 2424, rotation: 0 }),
    }));
    return { registry: { resolveService } as unknown as Registry, getHierarchy };
  }

  it("reads once more when the first tree holds an empty WebView", async () => {
    const { registry, getHierarchy } = fakeRegistry([fixture("cold"), fixture("inapp")]);
    const { tree, source } = await describeAndroid(registry, "emulator-5554", undefined, false);
    expect(source).toBe("android-devtools");
    expect(getHierarchy).toHaveBeenCalledTimes(2);
    expect(flatten(tree).some((n) => n.label === "Pay now")).toBe(true);
  });

  it("reads once more on Chrome's unpublished content view", async () => {
    // A browser tab before the page is published: no `android.webkit.WebView`
    // node yet, just Chrome's childless content view.
    const cold = `<?xml version='1.0'?><hierarchy rotation="0">
      <node class="android.widget.FrameLayout" content-desc="Web View" bounds="[0,142][1080,2361]"/>
      <node class="android.widget.EditText" resource-id="com.android.chrome:id/url_bar" text="example.org" clickable="true" bounds="[210,150][690,280]"/>
    </hierarchy>`;
    const { registry, getHierarchy } = fakeRegistry([cold, fixture("chrome")]);
    const { tree } = await describeAndroid(registry, "emulator-5554", undefined, false);
    expect(getHierarchy).toHaveBeenCalledTimes(2);
    expect(flatten(tree).find((n) => n.role === "WebView")?.label).toMatch(/Wikipedia/);
  });

  it("reads exactly once on a screen without a WebView", async () => {
    const native = `<?xml version='1.0'?><hierarchy rotation="0">
      <node class="android.widget.Button" text="Settings" clickable="true" bounds="[0,0][200,100]"/>
    </hierarchy>`;
    const { registry, getHierarchy } = fakeRegistry([native]);
    await describeAndroid(registry, "emulator-5554", undefined, false);
    expect(getHierarchy).toHaveBeenCalledTimes(1);
  });

  it("gives up within the budget when the WebView never publishes", async () => {
    const { registry, getHierarchy } = fakeRegistry([fixture("cold")]);
    const started = Date.now();
    const { tree } = await describeAndroid(registry, "emulator-5554", undefined, false);
    // 1.5 s budget in 250 ms steps: the first read plus six re-reads.
    expect(getHierarchy).toHaveBeenCalledTimes(7);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(flatten(tree).find((n) => n.role === "WebView")?.label).toBe("(no web content exposed)");
  });
});
