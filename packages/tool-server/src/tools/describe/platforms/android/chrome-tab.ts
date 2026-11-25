import type { DescribeFrame, DescribeNode } from "../../contract";
import type { WebViewport } from "../../../../blueprints/android-chrome-cdp";
import {
  clipBoundsToScreen,
  parseUiAutomatorBounds,
  parseUiAutomatorXml,
  type ParsedXmlNode,
} from "./uiautomator-parser";

const CHROME_PACKAGE = String.raw`com\.android\.chrome|com\.chrome\.(?:beta|dev|canary)|org\.chromium\.chrome`;
/** A Chrome-family browser's toolbar ids; the package is the browser to read over CDP. */
const CHROME_TOOLBAR_ID = new RegExp(
  `^(${CHROME_PACKAGE}):id/(?:toolbar|url_bar|control_container)$`
);
const CHROME_PACKAGE_ATTR = new RegExp(`\\spackage="(${CHROME_PACKAGE})"`);
const CHROME_PACKAGE_NAME = new RegExp(`^(?:${CHROME_PACKAGE})$`);

/** A childless FrameLayout or WebView of a Chrome-family browser's window. */
export interface ChromeView {
  frame: DescribeFrame;
  pkg: string;
}

/**
 * The childless content views a hierarchy dump holds of Chrome-family
 * windows, framed as the parser frames them: the helper dumps every
 * interactive window, so a match elsewhere in the tree may be another app's.
 */
export function chromeViewsIn(
  xml: string,
  screen: { width: number; height: number }
): ChromeView[] {
  if (!CHROME_PACKAGE_ATTR.test(xml)) return [];
  const views: ChromeView[] = [];
  const walk = (n: ParsedXmlNode) => {
    const kids = n.children.filter((c) => c.tag === "node");
    const pkg = n.attrs.package ?? "";
    const cls = (n.attrs.class ?? "").split(".").pop() ?? "";
    const b = parseUiAutomatorBounds(n.attrs.bounds ?? "");
    if (
      kids.length === 0 &&
      b &&
      CHROME_PACKAGE_NAME.test(pkg) &&
      (cls === "FrameLayout" || /webview/i.test(cls))
    ) {
      const c = clipBoundsToScreen(b, screen.width, screen.height);
      views.push({
        pkg,
        frame: {
          x: c.x / screen.width,
          y: c.y / screen.height,
          width: c.w / screen.width,
          height: c.h / screen.height,
        },
      });
    }
    kids.forEach(walk);
  };
  // Cut where the parser cuts, so trailing output cannot add nodes.
  const end = xml.lastIndexOf("</hierarchy>");
  const root = parseUiAutomatorXml(end === -1 ? xml : xml.slice(0, end + "</hierarchy>".length));
  if (root) walk(root);
  return views;
}

export interface ChromeTab {
  /** The childless content view the page belongs under. */
  content: DescribeNode;
  pkg: string;
  /** Bottom edge (screen fraction) of the toolbar over the content's top, if any. */
  toolbarBottom?: number;
}

function visit(node: DescribeNode, fn: (n: DescribeNode) => void): void {
  fn(node);
  for (const c of node.children) visit(c, fn);
}

/**
 * A browser tab whose page the tree does not hold: a childless content view
 * (`WebView`, or Chrome's FrameLayout labelled "Web View" in the UI language)
 * beside a Chrome-family toolbar. Chrome 158+ leaves a regular tab like this
 * for good while only UiAutomation is connected. Scrolling hides the toolbar,
 * so a lone content view of the browser's window (one of `browser`, from
 * {@link chromeViewsIn}) that fills at least half the screen also counts.
 */
export function findChromeTab(
  root: DescribeNode,
  browser: ChromeView[] = []
): ChromeTab | undefined {
  const tab = findBesideToolbar(root);
  if (tab || browser.length === 0) return tab;
  let found: ChromeTab | undefined;
  visit(root, (n) => {
    const area = n.frame.width * n.frame.height;
    const view = browser.find((v) => sameFrame(v.frame, n.frame));
    if (
      view &&
      n.children.length === 0 &&
      (n.role === "WebView" || (n.role === "FrameLayout" && n.label)) &&
      area >= 0.5 &&
      area > (found ? found.content.frame.width * found.content.frame.height : 0)
    ) {
      found = { content: n, pkg: view.pkg };
    }
  });
  return found;
}

function sameFrame(a: DescribeFrame, b: DescribeFrame): boolean {
  const eps = 1e-6;
  return (
    Math.abs(a.x - b.x) < eps &&
    Math.abs(a.y - b.y) < eps &&
    Math.abs(a.width - b.width) < eps &&
    Math.abs(a.height - b.height) < eps
  );
}

function findBesideToolbar(node: DescribeNode): ChromeTab | undefined {
  const empty = node.children.filter(
    (c) =>
      c.children.length === 0 &&
      (c.role === "WebView" || c.role === "FrameLayout") &&
      !CHROME_TOOLBAR_ID.test(c.identifier ?? "")
  );
  if (empty.length > 0) {
    const ids: DescribeNode[] = [];
    for (const sibling of node.children) {
      if (!empty.includes(sibling)) {
        visit(sibling, (n) => {
          if (CHROME_TOOLBAR_ID.test(n.identifier ?? "")) ids.push(n);
        });
      }
    }
    if (ids.length > 0) {
      const area = (n: DescribeNode) => n.frame.width * n.frame.height;
      const content = empty.reduce((a, b) => (area(b) > area(a) ? b : a));
      const top = content.frame.y;
      let toolbarBottom: number | undefined;
      for (const n of ids) {
        const bottom = n.frame.y + n.frame.height;
        if (n.frame.y <= top + 0.001 && bottom > top) {
          toolbarBottom = Math.max(toolbarBottom ?? 0, bottom);
        }
      }
      return { content, pkg: CHROME_TOOLBAR_ID.exec(ids[0]!.identifier!)![1]!, toolbarBottom };
    }
  }
  for (const c of node.children) {
    const found = findBesideToolbar(c);
    if (found) return found;
  }
  return undefined;
}

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Where the visual viewport sits on screen, in px. Its top is under the
 * toolbar when the toolbar covers the content view's top edge, else the
 * content view's top: Chrome hides the toolbar on scroll. Anchored at the top,
 * since the keyboard shortens the viewport from the bottom. Undefined when the
 * viewport is taller than the room below either top.
 */
export function chromeContentRect(
  tab: ChromeTab,
  vp: WebViewport,
  screen: { width: number; height: number }
): Rect | undefined {
  const k = vp.scale * vp.dpr;
  const f = tab.content.frame;
  const left = f.x * screen.width;
  const right = Math.min((f.x + f.width) * screen.width, left + vp.width * k);
  const viewBottom = (f.y + f.height) * screen.height;
  const height = vp.height * k;
  const tolerance = 0.02 * screen.height;
  const tops = [f.y * screen.height];
  if (tab.toolbarBottom !== undefined) tops.unshift(tab.toolbarBottom * screen.height);
  for (const top of tops) {
    if (top + height <= viewBottom + tolerance) {
      return { left, top, right, bottom: Math.min(viewBottom, top + height) };
    }
  }
  return undefined;
}

/**
 * Turns the DOM walk's frames (fractions of innerWidth / innerHeight) into
 * screen fractions, clipped to `clip` (px). A node left with no area goes, and
 * its children take its place.
 */
export function mapWebTree(
  node: DescribeNode,
  vp: WebViewport,
  clip: Rect,
  screen: { width: number; height: number }
): DescribeNode[] {
  const children = node.children.flatMap((c) => mapWebTree(c, vp, clip, screen));
  const k = vp.scale * vp.dpr;
  const x = clip.left + (node.frame.x * vp.innerWidth - vp.offsetLeft) * k;
  const y = clip.top + (node.frame.y * vp.innerHeight - vp.offsetTop) * k;
  const x1 = Math.max(x, clip.left);
  const y1 = Math.max(y, clip.top);
  const x2 = Math.min(x + node.frame.width * vp.innerWidth * k, clip.right);
  const y2 = Math.min(y + node.frame.height * vp.innerHeight * k, clip.bottom);
  if (x2 - x1 <= 0 || y2 - y1 <= 0) return children;
  // Scroll-clip geometry is in page fractions and serves only Chromium's wheel scrolling.
  const { clipFrame: _f, clipBounds: _b, clipAnchors: _a, ...rest } = node;
  return [
    {
      ...rest,
      frame: {
        x: x1 / screen.width,
        y: y1 / screen.height,
        width: (x2 - x1) / screen.width,
        height: (y2 - y1) / screen.height,
      },
      children,
    },
  ];
}
