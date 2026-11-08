import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { CDPClient } from "../utils/debugger/cdp-client";
import type { ViewportSize } from "./types";

// `unknown`, not `validation`: the renderer's main world is not a schema we own
// (unlike the android profiler metadata sidecar).
const VIEWPORT_FAILURE = {
  error_code: FAILURE_CODES.CHROMIUM_VIEWPORT_READ_FAILED,
  failure_area: "tool_server",
  error_kind: "unknown",
} as const;

/**
 * Throws rather than falling back to a default size: wrong dimensions would
 * corrupt every subsequent tap's normalized → CSS-pixel math.
 */
export async function readViewport(cdp: CDPClient): Promise<ViewportSize> {
  const out = (await cdp.send("Runtime.evaluate", {
    expression:
      "JSON.stringify({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 })",
    returnByValue: true,
  })) as { result?: { value?: string } };
  const raw = out.result?.value;
  if (typeof raw !== "string") {
    throw new FailureError(
      "Chromium CDP: Runtime.evaluate for viewport returned no value. The renderer may be navigating or its main world is detached.",
      { ...VIEWPORT_FAILURE, failure_stage: "chromium_viewport_read" }
    );
  }
  let parsed: { w: number; h: number; dpr: number };
  try {
    parsed = JSON.parse(raw) as { w: number; h: number; dpr: number };
  } catch (err) {
    throw new FailureError(
      `Chromium CDP: viewport payload was not JSON: ${err instanceof Error ? err.message : String(err)}`,
      { ...VIEWPORT_FAILURE, failure_stage: "chromium_viewport_parse" },
      { cause: err instanceof Error ? err : new Error(String(err)) }
    );
  }
  if (!parsed.w || !parsed.h) {
    throw new FailureError(
      `Chromium CDP: viewport reported zero dimensions (w=${parsed.w}, h=${parsed.h}). The BrowserWindow may be hidden.`,
      { ...VIEWPORT_FAILURE, failure_stage: "chromium_viewport_dimensions" }
    );
  }
  return { width: parsed.w, height: parsed.h, devicePixelRatio: parsed.dpr || 1 };
}

/** What `Page.getLayoutMetrics` reports about where the window sits in the page. */
interface CssViewportMetrics {
  pageX?: number;
  pageY?: number;
  offsetX?: number;
  offsetY?: number;
  scale?: number;
  zoom?: number;
}

interface LayoutMetrics {
  cssVisualViewport?: CssViewportMetrics;
  cssLayoutViewport?: CssViewportMetrics;
  layoutViewport?: CssViewportMetrics;
}

const finite = (n: number | undefined): number =>
  typeof n === "number" && Number.isFinite(n) ? n : 0;

function scrollOffsetFrom(metrics: LayoutMetrics): { x: number; y: number } {
  const layout = metrics.cssLayoutViewport;
  const visual = metrics.cssVisualViewport;
  const page = layout ?? visual ?? metrics.layoutViewport;
  return {
    x: finite(page?.pageX) + (layout ? finite(visual?.offsetX) : 0),
    y: finite(page?.pageY) + (layout ? finite(visual?.offsetY) : 0),
  };
}

/**
 * Where the window's top-left corner sits in document coordinates, in CSS
 * pixels. A `Page.captureScreenshot` clip is measured from there: clipping from
 * the document origin on a scrolled page captures the blank area above the window.
 *
 * The layout viewport plus the visual offset, not `cssVisualViewport.pageX`: on
 * a right-to-left or vertical-rl page that one follows `window.scrollX` and is
 * 0 or negative, while a clip counts from the left edge of the document.
 * A read that fails or answers with nothing usable falls back to the document
 * origin, which is the unscrolled answer and no worse than not asking.
 */
export async function readScrollOffset(cdp: CDPClient): Promise<{ x: number; y: number }> {
  try {
    return scrollOffsetFrom((await cdp.send("Page.getLayoutMetrics")) as LayoutMetrics);
  } catch {
    return { x: 0, y: 0 };
  }
}

// Exact 1 in practice; the tolerance only keeps float noise from costing a clip.
const isOne = (n: number | undefined): boolean => typeof n === "number" && Math.abs(n - 1) < 1e-3;

/**
 * The origin for a clip of the whole window, or null when such a clip cannot be
 * trusted. Page zoom is the catch: CDP sizes the output from the widget's device
 * scale factor while `devicePixelRatio` also carries the zoom, so at 150% the
 * clip crops the window, or comes out blank on a scrolled page. Pinch zoom is
 * the same trap: `innerWidth` stays at the layout size while less of the page
 * is visible. A read that fails is null too, so nothing is clipped at a guess.
 */
export async function readWindowClipOrigin(
  cdp: CDPClient
): Promise<{ x: number; y: number } | null> {
  try {
    const metrics = (await cdp.send("Page.getLayoutMetrics")) as LayoutMetrics;
    const { zoom, scale } = metrics.cssVisualViewport ?? {};
    return isOne(zoom) && isOne(scale) ? scrollOffsetFrom(metrics) : null;
  } catch {
    return null;
  }
}
