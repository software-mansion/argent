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
