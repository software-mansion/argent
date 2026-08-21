import { z } from "zod";
import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { assertChromiumWindowVisible } from "../../utils/chromium-visibility";
import { resolveDevice, harmonyConnectKey } from "../../utils/device-info";
import {
  HARMONY_INTERACTION_TIMEOUT_MS,
  assertHarmonyDisplayReady,
  harmonyDisplay,
  harmonyTouch,
  toDevicePoint,
} from "../../utils/harmony-uitest";
import { ensureDep } from "../../utils/check-deps";
import { sendCommand } from "../../utils/simulator-client";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const zodSchema = z.object({
  udid: z
    .string()
    .describe(
      "Target device id from `list-devices` (iOS UDID, Android serial, HarmonyOS id, or Chromium id)."
    ),
  x: z.number().describe("Normalized horizontal position 0.0–1.0 (left=0, right=1), not pixels"),
  y: z.number().describe("Normalized vertical position 0.0–1.0 (top=0, bottom=1), not pixels"),
  clickCount: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe(
      "Number of taps/clicks dispatched as ONE multi-tap gesture (2 = double-tap / double-click). " +
        "The taps land inside the OS double-tap window; on Chromium each click carries an escalating " +
        "CDP clickCount so dblclick actually fires. On HarmonyOS only 2 is one gesture — 3 or more " +
        "are separate injections a device round trip apart, which the OS reads as single taps. " +
        "Default 1."
    ),
});

type Params = z.infer<typeof zodSchema>;

interface Result {
  tapped: boolean;
  timestampMs: number;
}

function tapDescription(params: Params, tense: "present" | "past"): string {
  const count = params.clickCount ?? 1;
  const action =
    count === 1
      ? tense === "present"
        ? "Tapping"
        : "Tapped"
      : count === 2
        ? tense === "present"
          ? "Double-tapping"
          : "Double-tapped"
        : `${tense === "present" ? "Tapping" : "Tapped"} ${count} times`;
  return `${action} at (${Math.round(params.x * 100)}%, ${Math.round(params.y * 100)}%)`;
}

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
  harmony: { device: true },
};

// One press-release is 50ms; taps in a multi-tap gesture are 100ms apart —
// comfortably inside the OS double-tap window (~300ms on both platforms and
// in Chromium's click counter), which separate tool calls could not guarantee.
//
// The gap holds the window only where the injection itself is free. On
// HarmonyOS each click is its own `hdc shell` round trip, measured at
// 0.24–0.63s on a 6.1.1 emulator, so it dominates the gap and only the native
// `doubleClick` {@link tapHarmony} uses for a count of 2 stays inside.
const TAP_HOLD_MS = 50;
const MULTI_TAP_GAP_MS = 100;

async function tapChromium(
  api: ChromiumCdpApi,
  x: number,
  y: number,
  clickCount: number
): Promise<void> {
  const vp = api.getViewport();
  const pxX = Math.max(0, Math.min(vp.width, x * vp.width));
  const pxY = Math.max(0, Math.min(vp.height, y * vp.height));
  await api.dispatchMouseEvent({ type: "mouseMoved", x: pxX, y: pxY });
  // The browser's click counter drives dblclick: each press carries the
  // running count (1, then 2, …), the way a real mouse reports it.
  for (let i = 1; i <= clickCount; i++) {
    if (i > 1) await sleep(MULTI_TAP_GAP_MS);
    await api.dispatchMouseEvent({ type: "mousePressed", x: pxX, y: pxY, clickCount: i });
    await sleep(TAP_HOLD_MS);
    await api.dispatchMouseEvent({ type: "mouseReleased", x: pxX, y: pxY, clickCount: i });
  }
}

/**
 * HarmonyOS taps go through the device's own `uitest uiInput`, not
 * simulator-server — the platform has no simulator-server controller, and
 * `uitest` is the vendor's supported injection path. This mirrors how `button`
 * and `keyboard` already reach Android through `adb` rather than the HID
 * transport.
 *
 * `uitest` has a native double-click, so a 2-tap request uses it rather than two
 * timed clicks: two separate injections are not guaranteed to land inside the
 * OS double-tap window, which is the whole point of `clickCount`. Counts above 2
 * have no native form and fall back to repeated clicks — a round trip apart, so
 * outside that window, which is why `clickCount`'s description says so rather
 * than promising a multi-tap the platform cannot deliver.
 */
async function tapHarmony(
  connectKey: string,
  x: number,
  y: number,
  clickCount: number
): Promise<void> {
  // One deadline for the read and every injection that follows it, so a
  // multi-tap cannot spend a fresh ceiling per click and outlive the MCP layer's
  // abort-and-replay cap — where the replay is another tap on the same spot.
  const deadline = Date.now() + HARMONY_INTERACTION_TIMEOUT_MS;
  const display = await harmonyDisplay(connectKey);
  // A tap against a panel that is suspended, or that the render service could
  // not size, reports `No Error` and lands nowhere — refuse it rather than
  // report { tapped: true } for a touch that did nothing.
  assertHarmonyDisplayReady(display, "tap");
  const point = toDevicePoint(x, y, display);
  if (clickCount === 2) {
    await harmonyTouch(connectKey, "doubleClick", point, deadline - Date.now());
    return;
  }
  for (let i = 0; i < clickCount; i++) {
    if (i > 0) await sleep(MULTI_TAP_GAP_MS);
    await harmonyTouch(connectKey, "click", point, deadline - Date.now());
  }
}

export const gestureTapTool: ToolDefinition<Params, Result> = {
  id: "gesture-tap",
  interaction: {
    startedMsg: ({ params }) => tapDescription(params, "present"),
    completedMsg: ({ params }) => tapDescription(params, "past"),
    failedMsg: ({ params, failureSignal }) =>
      `Failed to tap at (${Math.round(params.x * 100)}%, ${Math.round(params.y * 100)}%): ${failureSignal.error_code}`,
  },
  description: `Press the device screen (iOS simulator, Android emulator, HarmonyOS device, or Chromium app) at normalized coordinates: x and y are fractions of screen width and height in 0.0–1.0 (not pixels).
Sends a Down event followed by an Up event at the same point. For Chromium, this dispatches a CDP mouse-press/release on the renderer.
Set clickCount: 2 for a double-tap / double-click — the taps are dispatched as one gesture with proper click counting, which two separate tap calls cannot guarantee.
Use when you need to tap a button, link, or any tappable element on the screen.
Returns { tapped: true, timestampMs }. Fails if the simulator-server / emulator backend / Chromium CDP / \`hdc\` is not reachable for the given device.
Before tapping, determine the correct coordinates by using discovery tools — pick by platform: iOS / Android use \`describe\`, \`native-describe-screen\`, or \`debugger-component-tree\`; Chromium uses \`describe\` (the DOM walker) and HarmonyOS uses \`describe\` (the \`uitest\` layout dump), since the native and RN-specific discovery tools don't apply to either. More information in \`argent-device-interact\` skill`,
  alwaysLoad: true,
  searchHint: "tap press button element device simulator emulator chromium touch down up click",
  zodSchema,
  capability,
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.udid);
    if (device.platform === "chromium") {
      return { chromium: chromiumCdpRef(device) };
    }
    // HarmonyOS drives `uitest` over hdc, so resolving the iOS/Android-only
    // simulator-server blueprint here would fail the tap before it runs — the
    // factory refuses any platform but those two.
    if (device.platform === "harmony") return {};
    return { simulatorServer: simulatorServerRef(device) };
  },
  async execute(services, params) {
    const device = resolveDevice(params.udid);
    const timestampMs = Date.now();
    const clickCount = params.clickCount ?? 1;
    if (device.platform === "chromium") {
      const chromium = services.chromium as ChromiumCdpApi;
      // Mouse dispatches wait on compositor hit-testing, which a hidden
      // window services at ~5s per event — refuse up front like gesture-scroll.
      await assertChromiumWindowVisible(chromium, "tap", "chromium_tap_window_hidden");
      await tapChromium(chromium, params.x, params.y, clickCount);
      return { tapped: true, timestampMs };
    }
    if (device.platform === "harmony") {
      await ensureDep("hdc");
      await tapHarmony(harmonyConnectKey(device.id), params.x, params.y, clickCount);
      return { tapped: true, timestampMs };
    }
    const api = services.simulatorServer as SimulatorServerApi;
    for (let i = 1; i <= clickCount; i++) {
      if (i > 1) await sleep(MULTI_TAP_GAP_MS);
      sendCommand(api, {
        cmd: "touch",
        type: "Down",
        x: params.x,
        y: params.y,
        second_x: null,
        second_y: null,
      });
      await sleep(TAP_HOLD_MS);
      sendCommand(api, {
        cmd: "touch",
        type: "Up",
        x: params.x,
        y: params.y,
        second_x: null,
        second_y: null,
      });
    }
    return { tapped: true, timestampMs };
  },
};
