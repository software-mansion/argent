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
 * Key events skip hit-testing and stay fast on a hidden window (measured on a
 * minimized Electron window: Input.dispatchKeyEvent 1–14ms against 5002–5005ms
 * for each mouse move), so the `keyboard` tool deliberately does NOT use this
 * guard — pinned by keyboard-chromium-unguarded.test.ts. The `button` tool
 * never reaches it either, for a different reason: its capability omits
 * chromium entirely, so chromium hardware buttons exist only on the
 * chromium-server HTTP surface the preview window drives.
 *
 * It is a backstop: while a session is attached, primePageSession's focus
 * emulation pins the renderer's reported visibility to "visible" and keeps
 * input fast even for a genuinely minimized window, so the probe only ever
 * reads "hidden" on sessions where emulation could not be applied (unsupported
 * runtime, failed priming) — exactly the world where the stall is real and
 * un-minimizing is the fix.
 *
 * Any throw from the probe means "proves nothing about visibility", and there
 * are two distinct shapes: a CDP rejection (mid-navigation teardown), and a
 * TypeError from a `chromium` carrying no usable `cdp` — the shape the bare
 * tool fakes in the sibling gesture tests pass.
 *
 * `failureStage` is derived rather than passed in: all three call sites want
 * `chromium_<action>_window_hidden`, and hand-writing it invites a silent drift
 * that would break the joinability the CHROMIUM_WINDOW_HIDDEN migration
 * deliberately preserved by leaving `chromium_scroll_window_hidden` unchanged.
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
