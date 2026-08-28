// Golden coverage over two real `getHierarchy` captures taken on an Android 14
// emulator (1080x2400): an in-app `android.webkit.WebView` and a Chrome tab,
// both on the same login form. Both dumps used to collapse to a single opaque
// `WebView` line; they are checked in so a future trim rule cannot silently
// re-hide the web DOM.
//
// To refresh a capture:
//   1. Serve this page from the host on port 8765 (`python3 -m http.server`) —
//      a local copy of https://the-internet.herokuapp.com/login, which the
//      Chrome capture was taken against directly:
//        <!doctype html><html><head><title>Login Page</title></head><body>
//        <h2>Login Page</h2>
//        <p>This is where you can log into the secure area.</p>
//        <form id="login"><label for="username">Username</label>
//        <input type="text" id="username" name="username">
//        <label for="password">Password</label>
//        <input type="password" id="password" name="password">
//        <button type="submit" id="login">Login</button></form>
//        <div id="footer">Powered by Elemental Selenium</div></body></html>
//   2. Chrome capture: `adb shell am start -a android.intent.action.VIEW
//      -d http://10.0.2.2:8765/login.html com.android.chrome`.
//      In-app capture: any app whose `setContentView` is a `WebView` loading
//      the same URL — a bare Activity with `new WebView(this)` is enough.
//   3. Wait for the renderer to publish its DOM (`describe` shows a childless
//      `WebView` until then), then save `getHierarchy().xml` from the
//      android-devtools helper here verbatim.
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { parseUiAutomatorDump } from "../src/tools/describe/platforms/android/uiautomator-parser";
import type { DescribeNode } from "../src/tools/describe/contract";

const SCREEN_W = 1080;
const SCREEN_H = 2400;

function read(name: string): string {
  return fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
}

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

// One line per direct child of a node: role plus whatever identifies it, with
// long body copy cut short so the expectation stays readable (and so a page's
// prose does not get duplicated into this file).
function webRows(n: DescribeNode): string[] {
  return n.children.map((c) => {
    // Chrome's own icon-font glyphs live in the Private Use Area and render as
    // nothing, so drop them rather than embedding invisible characters here.
    const name = (c.identifier ?? c.label ?? "").replace(/[\uE000-\uF8FF]/g, "").trim();
    return [c.role, name.length > 32 ? name.slice(0, 32) + "…" : name].filter(Boolean).join(" ");
  });
}

function roleByLabel(nodes: DescribeNode[]): Map<string | undefined, string> {
  return new Map(nodes.map((n) => [n.label, n.role]));
}

function countWebViewNodes(xml: string): number {
  return xml.split('class="android.webkit.WebView"').length - 1;
}

describe("Android WebView describe — real captures", () => {
  it("surfaces the in-app WebView login form", () => {
    const xml = read("android-webview-inapp.xml");
    // This capture is the doubled-node shape: Chromium published two nested
    // WebView nodes, which the merge collapses into one landmark.
    expect(countWebViewNodes(xml)).toBe(2);

    const tree = parseUiAutomatorDump(xml, SCREEN_W, SCREEN_H);
    const nodes = flatten(tree);

    const webviews = nodes.filter((n) => n.role === "WebView");
    expect(webviews).toHaveLength(1);
    expect(webviews[0]!.label).toBe("Login Page");

    // The whole form is reachable, in page order, and the HTML ids came through
    // as identifiers so every control is selector-addressable. Asserting the
    // shape rather than a node count says what changed when it changes.
    expect(webRows(webviews[0]!)).toEqual([
      "StaticText Login Page",
      "StaticText This is where you can log into t…",
      "StaticText Username",
      "TextField username",
      "StaticText Password",
      "TextField password",
      "Button login",
      "StaticText Powered by Elemental Selenium",
    ]);
    const byId = new Map(nodes.filter((n) => n.identifier).map((n) => [n.identifier!, n]));
    expect(byId.get("login")?.label).toBe("Login");
    expect(byId.get("login")?.clickable).toBe(true);

    // The two form labels are the nodes the contextual remap actually touches:
    // Chromium emits them as bare `android.view.View`. ("Login Page" and the
    // footer are TextViews, which map to StaticText without any remap.)
    const roles = roleByLabel(nodes);
    expect(roles.get("Username")).toBe("StaticText");
    expect(roles.get("Password")).toBe("StaticText");
  });

  it("surfaces the Chrome tab's web DOM alongside Chrome's own toolbar", () => {
    const xml = read("android-webview-chrome.xml");
    // Chrome publishes a single WebView node, so this capture covers the
    // un-doubled shape — the merge is exercised by the in-app fixture above.
    expect(countWebViewNodes(xml)).toBe(1);

    const tree = parseUiAutomatorDump(xml, SCREEN_W, SCREEN_H);
    const nodes = flatten(tree);

    const webviews = nodes.filter((n) => n.role === "WebView");
    expect(webviews).toHaveLength(1);
    expect(webviews[0]!.label).toBe("The Internet");

    expect(webRows(webviews[0]!)).toEqual([
      "StaticText flash-messages",
      "View Fork me on GitHub",
      "StaticText Login Page",
      "StaticText This is where you can log into t…",
      "StaticText Username",
      "TextField username",
      "StaticText Password",
      "TextField password",
      "Button Login",
      "StaticText Powered by",
      "View Elemental Selenium",
    ]);

    // Chrome's native chrome is unaffected and still sits beside the web DOM.
    const byId = new Map(nodes.filter((n) => n.identifier).map((n) => [n.identifier!, n]));
    expect(byId.has("com.android.chrome:id/url_bar")).toBe(true);
    expect(byId.get("com.android.chrome:id/url_bar")?.label).toBe(
      "the-internet.herokuapp.com/login"
    );
  });

  it("never lets a WebView password input's plaintext escape", () => {
    for (const fixture of ["android-webview-inapp.xml", "android-webview-chrome.xml"]) {
      const nodes = flatten(parseUiAutomatorDump(read(fixture), SCREEN_W, SCREEN_H));
      const field = nodes.find((n) => n.identifier === "password");
      expect(field?.password).toBe(true);
      expect(field?.label).toBe("[password]");
      expect(field?.value).toBeUndefined();
    }
  });
});
