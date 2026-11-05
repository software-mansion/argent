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
}

/**
 * Where the window's top-left corner sits in document coordinates, in CSS
 * pixels. A `Page.captureScreenshot` clip is measured from there: clipping from
 * the document origin on a scrolled page captures the blank area above the window.
 *
 * `cssVisualViewport` is preferred because it also carries a pinch-zoom offset;
 * `cssLayoutViewport` is the fallback for a protocol that predates it. A read
 * that fails or answers with nothing usable falls back to the document origin,
 * which is the unscrolled answer and no worse than not asking.
 */
export async function readScrollOffset(cdp: CDPClient): Promise<{ x: number; y: number }> {
  try {
    const metrics = (await cdp.send("Page.getLayoutMetrics")) as {
      cssVisualViewport?: CssViewportMetrics;
      cssLayoutViewport?: CssViewportMetrics;
      layoutViewport?: CssViewportMetrics;
    };
    const vp = metrics.cssVisualViewport ?? metrics.cssLayoutViewport ?? metrics.layoutViewport;
    const x = vp?.pageX;
    const y = vp?.pageY;
    return {
      x: typeof x === "number" && Number.isFinite(x) ? x : 0,
      y: typeof y === "number" && Number.isFinite(y) ? y : 0,
    };
  } catch {
    return { x: 0, y: 0 };
  }
}
