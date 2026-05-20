import type { CDPClient } from "../utils/debugger/cdp-client";
import type { ViewportSize } from "./types";

/**
 * Read window.innerWidth/Height/devicePixelRatio from the renderer's main
 * world. Throws when the call returns nothing — silently substituting a fake
 * 800×600 would corrupt every subsequent tap's normalized → CSS-pixel math.
 */
export async function readViewport(cdp: CDPClient): Promise<ViewportSize> {
  const out = (await cdp.send("Runtime.evaluate", {
    expression:
      "JSON.stringify({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 })",
    returnByValue: true,
  })) as { result?: { value?: string } };
  const raw = out.result?.value;
  if (typeof raw !== "string") {
    throw new Error(
      "Electron CDP: Runtime.evaluate for viewport returned no value. The renderer may be navigating or its main world is detached."
    );
  }
  let parsed: { w: number; h: number; dpr: number };
  try {
    parsed = JSON.parse(raw) as { w: number; h: number; dpr: number };
  } catch (err) {
    throw new Error(
      `Electron CDP: viewport payload was not JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!parsed.w || !parsed.h) {
    throw new Error(
      `Electron CDP: viewport reported zero dimensions (w=${parsed.w}, h=${parsed.h}). The BrowserWindow may be hidden.`
    );
  }
  return { width: parsed.w, height: parsed.h, devicePixelRatio: parsed.dpr || 1 };
}
