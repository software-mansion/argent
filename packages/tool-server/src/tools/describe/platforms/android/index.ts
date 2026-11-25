import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { Registry, ToolDependency } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../contract";
import { adbExecOutBinary, isAndroidTv } from "../../../../utils/adb";
import { uiautomatorKilledMessage, withUiautomatorLock } from "../../../../utils/uiautomator-lock";
import { resolveDevice } from "../../../../utils/device-info";
import {
  getAndroidScreenSize,
  orientScreenSize,
  parseDumpRotation,
} from "../../../../utils/android-screen";
import { parseUiAutomatorDump } from "./uiautomator-parser";
import {
  androidDevtoolsRef,
  type AndroidDevtoolsApi,
} from "../../../../blueprints/android-devtools";
import {
  androidChromeCdpRef,
  type AndroidChromeCdpApi,
} from "../../../../blueprints/android-chrome-cdp";
import {
  chromeContentRect,
  chromeViewsIn,
  findChromeTab,
  mapWebTree,
  type ChromeView,
} from "./chrome-tab";

export const androidRequires: ToolDependency[] = ["adb"];

// Android TV keeps a readable uiautomator tree (unlike tvOS, which describe
// short-circuits), so point at the focus-driven tools instead of blocking it.
const ANDROID_TV_HINT =
  "This is an Android TV (leanback) device — it is focus-driven and has no touch. " +
  "Prefer the `describe` tool to read the focused / focusable elements, `tv-remote` " +
  "(up/down/left/right/select/back/menu/home) to move focus, and `keyboard` to type, " +
  "rather than coordinate taps.";

/**
 * Tries the `android-devtools` helper, falling back to `uiautomator dump` on any
 * error: the legacy path fails independently (APK install rejection, helper
 * spawn failure, adb-forward conflict) and still works on locked-down devices
 * that block `adb install -t`.
 */
export async function describeAndroid(
  registry: Registry | undefined,
  serial: string,
  _bundleId?: string,
  // Verdict from a caller that already probed: `getAndroidRuntimeKind` shells out
  // to `adb devices` even on a cache hit and `describe` is an alwaysLoad hot
  // path. `undefined` means "unknown, probe".
  isTv?: boolean
): Promise<DescribeTreeData> {
  const hint = (isTv ?? (await isAndroidTv(serial))) ? ANDROID_TV_HINT : undefined;
  const readTab = registry
    ? async (pkg: string) =>
        (
          await registry.resolveService<AndroidChromeCdpApi>(androidChromeCdpRef(serial))
        ).readVisibleTab(pkg)
    : undefined;

  if (registry) {
    try {
      const device = resolveDevice(serial);
      const ref = androidDevtoolsRef(device);
      const devtools = await registry.resolveService<AndroidDevtoolsApi>(ref.urn, ref.options);
      const [{ xml }, size] = await Promise.all([
        // clearCache: a cached node keeps stale text until its app emits a content-change event.
        devtools.getHierarchy({ clearCache: true }),
        devtools.getScreenSize(),
      ]);
      const capture = (x: string): Capture => ({
        tree: parseUiAutomatorDump(x, size.width, size.height),
        browser: chromeViewsIn(x, size),
      });
      const read = await awaitWebViewPublished(
        capture(xml),
        async () => capture((await devtools.getHierarchy({ clearCache: true })).xml),
        size,
        readTab
      );
      return withTabHint(read, "android-devtools", hint);
    } catch (serviceErr) {
      // Debug level: the legacy path below is expected to recover, so this
      // shouldn't leak into the per-call result.

      console.debug(
        `[describe.android] devtools service failed, falling back to uiautomator dump: ${
          serviceErr instanceof Error ? serviceErr.message : String(serviceErr)
        }`
      );
    }
  }

  const [size, raw] = await Promise.all([getAndroidScreenSize(serial), uiautomatorDump(serial)]);
  const capture = (x: string): Capture => ({
    tree: parseDump(x, size),
    browser: chromeViewsIn(x, orientScreenSize(size, parseDumpRotation(x))),
  });
  const read = await awaitWebViewPublished(
    capture(raw),
    async () => capture(await uiautomatorDump(serial)),
    orientScreenSize(size, parseDumpRotation(raw)),
    readTab
  );
  return withTabHint(read, "uiautomator", hint);
}

const CHROME_TAB_HINT =
  "The web content of this Chrome tab comes from the page DOM over Chrome DevTools, not from accessibility: roles and labels follow the HTML.";

function withTabHint(
  read: { tree: DescribeNode; fromCdp: boolean; webHint?: string },
  source: "android-devtools" | "uiautomator",
  hint: string | undefined
): DescribeTreeData {
  if (!read.fromCdp) return { tree: read.tree, source, hint };
  return {
    tree: read.tree,
    source: `${source}+cdp`,
    hint: [hint, CHROME_TAB_HINT, read.webHint].filter(Boolean).join("\n"),
  };
}

/**
 * Chromium builds a WebView's accessibility tree on the first request for it,
 * so the read that asks sees the WebView with nothing under it. Re-read until
 * the page is there, within a bound: a small page is complete on the next read
 * (measured 10–400 ms on API 35 / WebView 124), a Chrome tab over a long
 * article needs ~600 ms. A screen without a WebView returns at once; a WebView
 * that never publishes costs at most the bound.
 */
const WEBVIEW_PUBLISH_STEP_MS = 250;
const WEBVIEW_PUBLISH_BUDGET_MS = 1_500;
/** Cap on the DevTools read of a Chrome tab, from its start. */
const CHROME_TAB_CDP_BUDGET_MS = 2_000;

/** A parsed read, with the content views of the Chrome-family windows it holds. */
interface Capture {
  tree: DescribeNode;
  browser: ChromeView[];
}

/**
 * Chrome 158+ never publishes a regular tab while only UiAutomation is
 * connected, so on a Chrome tab the page is read over DevTools alongside the
 * re-reads, from the first read that shows the tab. A re-read that publishes
 * wins; else the DevTools read fills the content view. Any failure there
 * leaves the tree as the re-reads left it.
 */
async function awaitWebViewPublished(
  first: Capture,
  read: () => Promise<Capture>,
  screen: { width: number; height: number },
  readTab: AndroidChromeCdpApi["readVisibleTab"] | undefined
): Promise<{ tree: DescribeNode; fromCdp: boolean; webHint?: string }> {
  const unread = (c: Capture) =>
    hasUnreadWebView(c.tree) || findChromeTab(c.tree, c.browser) !== undefined;
  type Web = Awaited<ReturnType<AndroidChromeCdpApi["readVisibleTab"]>>;
  let page: Promise<Web | undefined> | undefined;
  // Settles only on a DevTools read with content, so a failed one never
  // cuts the re-reads short.
  let pageWon: Promise<{ web: Web }> | undefined;
  const startPage = (c: Capture) => {
    if (page || !readTab) return;
    const tab = findChromeTab(c.tree, c.browser);
    if (!tab) return;
    let timer: NodeJS.Timeout | undefined;
    page = Promise.race([
      readTab(tab.pkg),
      new Promise<undefined>((r) => {
        timer = setTimeout(() => {
          console.debug(
            `[describe.android] Chrome tab DevTools read passed its ${CHROME_TAB_CDP_BUDGET_MS} ms budget`
          );
          r(undefined);
        }, CHROME_TAB_CDP_BUDGET_MS);
      }),
    ])
      .catch((err: unknown) => {
        console.debug(`[describe.android] Chrome tab DevTools read failed: ${String(err)}`);
        return undefined;
      })
      .finally(() => clearTimeout(timer));
    pageWon = page.then((web) => (web ? { web } : new Promise<never>(() => undefined)));
  };
  const fill = (c: Capture, web: Web) => {
    const now = findChromeTab(c.tree, c.browser);
    const clip = now && chromeContentRect(now, web.viewport, screen);
    if (!now || !clip) return undefined;
    now.content.role = "WebView";
    now.content.children = mapWebTree(web.tree, web.viewport, clip, screen);
    return { tree: c.tree, fromCdp: true, webHint: web.hint };
  };

  let last = first;
  startPage(first);
  for (let waited = 0; waited < WEBVIEW_PUBLISH_BUDGET_MS && unread(last);) {
    let step: NodeJS.Timeout | undefined;
    const next = new Promise((r) => (step = setTimeout(r, WEBVIEW_PUBLISH_STEP_MS))).then(read);
    waited += WEBVIEW_PUBLISH_STEP_MS;
    const won = pageWon ? await Promise.race([next.then((c) => ({ c })), pageWon]) : undefined;
    if (won && "web" in won) {
      // The DevTools read landed mid-step: drop the step unless the page
      // does not fit the tree, then keep re-reading without it.
      const filled = fill(last, won.web);
      if (filled) {
        clearTimeout(step);
        next.catch(() => undefined);
        return filled;
      }
      pageWon = undefined;
    }
    last = won && "c" in won ? won.c : await next;
    startPage(last);
  }
  if (!unread(last)) return { tree: last.tree, fromCdp: false };
  const web = await page;
  return (web && fill(last, web)) ?? { tree: last.tree, fromCdp: false };
}

async function uiautomatorDump(serial: string): Promise<string> {
  // Per-call dump path so concurrent describes on the same serial don't cat each
  // other's half-written dump.
  const randomSuffix = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  const dumpPath = `/data/local/tmp/argent-ui-dump-${randomSuffix}.xml`;
  // `--compressed` skips nodes `isImportantForAccessibility()` drops (decorative
  // wrappers, RN SVG sub-paths, bounds-less Compose containers) while keeping the
  // text, content-desc, clickable and resource-id the agent contract uses.
  // `;` rather than `&&` before `rm -f` so cleanup fires even when dump/cat fails.
  const rawBuf = await withUiautomatorLock(serial, () =>
    adbExecOutBinary(
      serial,
      `uiautomator dump --compressed ${dumpPath} >/dev/null && cat ${dumpPath}; rm -f ${dumpPath}`,
      { timeoutMs: 20_000 }
    )
  );
  const raw = rawBuf.toString("utf-8");
  const trimmed = raw.trim();
  const killed = trimmed.includes("<hierarchy")
    ? undefined
    : uiautomatorKilledMessage(trimmed.slice(0, 200), serial);
  if (killed) {
    throw new FailureError(killed, {
      error_code: FAILURE_CODES.ANDROID_UIAUTOMATOR_CAPTURE_FAILED,
      failure_stage: "android_uiautomator_capture",
      failure_area: "tool_server",
      error_kind: "subprocess",
    });
  }
  if (/^ERROR:/i.test(trimmed) || (!trimmed.includes("<hierarchy") && /error/i.test(trimmed))) {
    throw new FailureError(
      `uiautomator could not capture the screen: ${trimmed}. ` +
        `Common causes: device locked / keyguard, DRM or secure overlay, Play Integrity screen. ` +
        `Unlock the device or take a screenshot as a fallback.`,
      {
        // adb exits 0, but uiautomator reported an in-band `ERROR:` line — same
        // adb-exit-0/unusable-output shape as ANDROID_UIAUTOMATOR_PARSE_FAILED.
        error_code: FAILURE_CODES.ANDROID_UIAUTOMATOR_CAPTURE_FAILED,
        failure_stage: "android_uiautomator_capture",
        failure_area: "tool_server",
        error_kind: "subprocess",
      }
    );
  }
  return raw;
}

function parseDump(raw: string, size: { width: number; height: number }): DescribeNode {
  // `wm size` is not rotation-aware, but the dump says which rotation it was
  // taken at. Orienting the divisor here is what keeps a rotated device's frames
  // in the same upright space the android-devtools path already produces — and
  // stops the right-hand half of a landscape screen being pruned away as
  // off-screen (#609).
  const oriented = orientScreenSize(size, parseDumpRotation(raw));
  return parseUiAutomatorDump(raw, oriented.width, oriented.height);
}

/**
 * The shape a WebView has before Chromium publishes its page: the WebView
 * node with nothing under it (a read 6 s after load, with no earlier read, is
 * still this shape — the tree is built on request, not on load).
 *
 * A browser tab has no `android.webkit.WebView` view of its own: before the
 * page is published, Chrome's content view is a childless FrameLayout whose
 * content-desc is "Web View" (English UI only — other locales miss the
 * re-read and see the tab the way they do today).
 */
export function hasUnreadWebView(node: DescribeNode): boolean {
  if (node.children.length === 0 && (node.role === "WebView" || node.label === "Web View")) {
    return true;
  }
  return node.children.some(hasUnreadWebView);
}
