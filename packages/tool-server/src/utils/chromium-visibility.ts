import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { ChromiumCdpApi } from "../blueprints/chromium-cdp";

/**
 * A hidden window (minimized, fully occluded, or on another workspace) halts
 * the renderer's mouse-input pipeline: every mouse dispatch waits on
 * compositor hit-testing, which a throttled window services at ~5s per event
 * — a drag's ~60fps interpolated moves would stall for minutes, and an agent
 * loop would keep "working" blind because describe stays fast. Probe
 * `document.visibilityState` and refuse up front with a fix the caller can
 * act on. Only an explicit "hidden" refuses — a failed or empty read proves
 * nothing, and the gesture itself will surface a real transport error.
 *
 * Key events skip hit-testing and stay fast on hidden windows, so the
 * keyboard/button tools deliberately do NOT use this guard. It is a backstop:
 * while a session is attached, primePageSession's focus emulation pins the
 * renderer's reported visibility to "visible" and keeps input fast even for a
 * genuinely minimized window, so the probe only ever reads "hidden" on
 * sessions where emulation could not be applied (unsupported runtime, failed
 * priming) — exactly the world where the stall is real and un-minimizing is
 * the fix.
 *
 * The entire probe (including the property access on `chromium`) stays inside
 * the try: test fakes and mid-navigation contexts may lack `cdp`, and neither
 * says anything about visibility.
 */
export async function assertChromiumWindowVisible(
  chromium: ChromiumCdpApi,
  action: string,
  failureStage: string
): Promise<void> {
  let value: unknown;
  try {
    const raw = (await chromium.cdp.send("Runtime.evaluate", {
      expression: "document.visibilityState",
      returnByValue: true,
    })) as { result?: { value?: unknown } };
    value = raw.result?.value;
  } catch {
    return;
  }
  if (value === "hidden") {
    throw new FailureError(
      `Cannot ${action}: the Chromium window is hidden (minimized or fully occluded), so the renderer will not process mouse input. Bring the window to the foreground and retry.`,
      {
        error_code: FAILURE_CODES.CHROMIUM_WINDOW_HIDDEN,
        failure_stage: failureStage,
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }
}
