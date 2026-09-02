import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { ChromiumCdpApi } from "../blueprints/chromium-cdp";

/**
 * Refuse mouse gestures on a hidden window: a minimized or fully occluded
 * window throttles compositor hit-testing to ~5s per mouse event, so a drag's
 * interpolated moves stall for minutes while describe stays fast and the agent
 * loop keeps working blind. Key events bypass hit-testing, so the
 * keyboard/button tools deliberately skip this guard.
 *
 * Only an explicit "hidden" refuses — a failed or empty read proves nothing.
 * primePageSession's focus emulation pins reported visibility to "visible"
 * while a session is attached, so the probe reads "hidden" only where emulation
 * could not be applied — exactly where the stall is real and un-minimizing is
 * the fix.
 *
 * The `chromium.cdp` access stays inside the try: test fakes and
 * mid-navigation contexts may lack `cdp`, which says nothing about visibility.
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
