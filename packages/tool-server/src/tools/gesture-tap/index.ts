import { z } from "zod";
import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { iosDeviceRunnerRef, type IosDeviceRunnerApi } from "../../blueprints/ios-device-runner";
import { requireCurrentIosDeviceApp } from "../../utils/ios-device/app-session";
import { getViewport, tapAt, toPoints } from "../../utils/ios-device/runner-commands";
import { assertChromiumWindowVisible } from "../../utils/chromium-visibility";
import { isIosPhysicalDevice, resolveDevice, harmonyConnectKey } from "../../utils/device-info";
import {
  HARMONY_INTERACTION_TIMEOUT_MS,
  assertHarmonyDisplayReady,
  harmonyDisplay,
  holdUitestQueue,
  remainingBudget,
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
        "CDP clickCount so dblclick actually fires; on physical iOS 2 is the native double-tap and " +
        "higher counts land as separate taps. On HarmonyOS only 2 is one gesture — 3 or more are " +
        "separate injections a device round trip apart, which the OS reads as single taps. Default 1."
    ),
});

type Params = z.infer<typeof zodSchema>;

interface Result {
  tapped: boolean;
  timestampMs: number;
  /**
   * Physical iOS only: the target app was backgrounded and the runner
   * re-fronted it to run this tap, so the foreground screen changed as a side
   * effect. Set only when true.
   */
  reactivated?: true;
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

// Timings keep a multi-tap inside the OS double-tap window, which separate
// tool calls could not guarantee. The gap holds only where the injection itself
// is free: on HarmonyOS each click is its own `hdc shell` round trip, so only
// the native `doubleClick` {@link tapHarmony} uses for a count of 2 stays inside.
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
  // dblclick fires off the escalating clickCount, not off timing.
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
  // One deadline for both display reads and every injection that follows them,
  // so a multi-tap cannot spend a fresh ceiling per click and outlive the MCP
  // layer's abort-and-replay cap — where the replay is another tap on the same
  // spot.
  const deadline = Date.now() + HARMONY_INTERACTION_TIMEOUT_MS;
  // Fast prefilter, ahead of the queue wait: a panel already suspended or not
  // yet composited is refused without waiting behind this device's queued work.
  // It is NOT the check the injection trusts — see inside the hold.
  const display = await harmonyDisplay(connectKey);
  assertHarmonyDisplayReady(display, "tap");
  await holdUitestQueue(connectKey, deadline, async (ui) => {
    // The check the injection trusts, read while holding the queue: the
    // prefilter above saw a state that may be a full queue depth stale by the
    // time this call reaches the device, and `uitest uiInput` answers `No
    // Error` into a suspended panel regardless.
    const live = await harmonyDisplay(
      connectKey,
      remainingBudget(connectKey, deadline, "the display re-read")
    );
    assertHarmonyDisplayReady(live, "tap");
    const point = toDevicePoint(x, y, live);
    if (clickCount === 2) {
      await ui.touch("doubleClick", point);
      return;
    }
    for (let i = 0; i < clickCount; i++) {
      if (i > 0) await sleep(MULTI_TAP_GAP_MS);
      await ui.touch("click", point);
    }
  });
}

export const gestureTapTool: ToolDefinition<Params, Result> = {
  id: "gesture-tap",
  interaction: {
    startedMsg: ({ params }) => tapDescription(params, "present"),
    completedMsg: ({ params }) => tapDescription(params, "past"),
    failedMsg: ({ params, failureSignal }) =>
      `Failed to tap at (${Math.round(params.x * 100)}%, ${Math.round(params.y * 100)}%): ${failureSignal.error_code}`,
  },
  description: `Press the device screen (iOS simulator or physical device, Android emulator, HarmonyOS device, or Chromium app) at normalized coordinates: x and y are fractions of screen width and height in 0.0–1.0 (not pixels).
Sends a Down event followed by an Up event at the same point. For Chromium, this dispatches a CDP mouse-press/release on the renderer.
Set clickCount: 2 for a double-tap / double-click — the taps are dispatched as one gesture with proper click counting, which two separate tap calls cannot guarantee.
Use when you need to tap a button, link, or any tappable element on the screen.
Returns { tapped: true, timestampMs }. On physical iOS, reactivated: true = app was re-fronted; re-describe. Fails if the simulator-server / emulator backend / Chromium CDP / \`hdc\` is not reachable for the given device.
On a physical iPhone use \`describe\`; \`native-describe-screen\` is simulator-only.
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
    if (isIosPhysicalDevice(device)) {
      return { iosDeviceRunner: iosDeviceRunnerRef(device) };
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
      // Mouse dispatch stalls at ~5s per event on a hidden window.
      await assertChromiumWindowVisible(chromium, "tap", "chromium_tap_window_hidden");
      await tapChromium(chromium, params.x, params.y, clickCount);
      return { tapped: true, timestampMs };
    }
    if (isIosPhysicalDevice(device)) {
      const runner = services.iosDeviceRunner as IosDeviceRunnerApi;
      const bundleId = requireCurrentIosDeviceApp(device.id);
      const viewport = await getViewport(runner, bundleId);
      const point = toPoints(viewport, params.x, params.y);
      // The whole count is one runner command: a double-tap must be the native one, and any loop
      // above 2 stays on-device (separate taps either way, but without wire round trips between them).
      const tap = await tapAt(runner, bundleId, point, clickCount);
      // Either leg can be the one that re-fronted a backgrounded target: the
      // viewport read fronts it first, so the tap then finds it foreground.
      const reactivated = viewport.reactivated === true || tap.reactivated;
      return { tapped: true, timestampMs, ...(reactivated ? { reactivated: true as const } : {}) };
    }
    if (device.platform === "harmony") {
      await ensureDep("hdc");
      await tapHarmony(harmonyConnectKey(device.id), params.x, params.y, clickCount);
      return { tapped: true, timestampMs };
    }
    const api = services.simulatorServer as SimulatorServerApi;
    for (let i = 1; i <= clickCount; i++) {
      if (i > 1) await sleep(MULTI_TAP_GAP_MS);
      await sendCommand(api, {
        cmd: "touch",
        type: "Down",
        x: params.x,
        y: params.y,
        second_x: null,
        second_y: null,
      });
      await sleep(TAP_HOLD_MS);
      await sendCommand(api, {
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
