import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { ChromiumCdpApi } from "../blueprints/chromium-cdp";

/**
 * Refuse mouse gestures on a hidden window: a minimized or fully occluded
 * window throttles compositor hit-testing to ~5s per mouse event, so a drag's
 * interpolated moves stall for minutes while describe stays fast and the agent
 * loop keeps working blind.
 *
 * Key events bypass hit-testing and stay fast on a hidden window — measured on
 * a minimized Electron window with no focus emulation applied,
 * Input.dispatchKeyEvent 1–14ms against 5002–5005ms per mouse move — so the
 * `keyboard` tool deliberately does NOT use this guard, which
 * keyboard-chromium-unguarded.test.ts holds in place. The `button` tool never
 * reaches it either, for a different reason: its capability omits chromium
 * entirely, and a Chromium app has no hardware buttons to press — the
 * chromium-server's WebSocket `button` command emulates `Back` alone, as an
 * Alt+Left chord, and throws for every other button.
 *
 * It is a backstop: primePageSession applies focus emulation to every session
 * at connect, pinning reported visibility to "visible" and leaving input
 * unthrottled even while the window is minimized, so the probe reads "hidden"
 * only where the runtime refused it. Launch origin does not narrow that: an app
 * carrying all three ANTI_THROTTLING_ARGS, minimized without emulation, still
 * reads "hidden" and still costs ~5s per mouse event (measured on Electron 42
 * and Chrome 152).
 *
 * A throw from the probe proves nothing about visibility, and there are two
 * shapes: a CDP rejection (mid-navigation teardown, or the client's 10s request
 * timeout), and a TypeError from a `chromium` carrying no usable `cdp`.
 *
 * The stage string is derived from `action` so it cannot drift from the three
 * values telemetry is keyed on: `chromium_tap_window_hidden`,
 * `chromium_drag_window_hidden` and `chromium_scroll_window_hidden`. The
 * CHROMIUM_WINDOW_HIDDEN migration kept the scroll spelling so rows from either
 * side of it stay joinable; chromium-window-hidden-guard.test.ts asserts all
 * three literally.
 */
export async function assertChromiumWindowVisible(
  chromium: ChromiumCdpApi,
  action: "tap" | "drag" | "scroll"
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
        failure_stage: `chromium_${action}_window_hidden`,
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }
}
