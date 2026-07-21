import { z } from "zod";
import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { resolveDevice } from "../../utils/device-info";
import { sendCommand } from "../../utils/simulator-client";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const zodSchema = z.object({
  udid: z
    .string()
    .describe("Target device id from `list-devices` (iOS UDID, Android serial, or Chromium id)."),
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
        "CDP clickCount so dblclick actually fires. Default 1."
    ),
});

type Params = z.infer<typeof zodSchema>;

interface Result {
  tapped: boolean;
  timestampMs: number;
}

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
};

// One press-release is 50ms; taps in a multi-tap gesture are 100ms apart —
// comfortably inside the OS double-tap window (~300ms on both platforms and
// in Chromium's click counter), which separate tool calls could not guarantee.
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

export const gestureTapTool: ToolDefinition<Params, Result> = {
  id: "gesture-tap",
  description: `Press the device screen (iOS simulator, Android emulator, or Chromium app) at normalized coordinates: x and y are fractions of screen width and height in 0.0–1.0 (not pixels).
Sends a Down event followed by an Up event at the same point. For Chromium, this dispatches a CDP mouse-press/release on the renderer.
Set clickCount: 2 for a double-tap / double-click — the taps are dispatched as one gesture with proper click counting, which two separate tap calls cannot guarantee.
Use when you need to tap a button, link, or any tappable element on the screen.
Returns { tapped: true, timestampMs }. Fails if the simulator-server / emulator backend / Chromium CDP is not reachable for the given device.
Before tapping, determine the correct coordinates by using discovery tools — pick by platform: iOS / Android use \`describe\`, \`native-describe-screen\`, or \`debugger-component-tree\`; Chromium uses \`describe\` (the DOM walker), since the native and RN-specific discovery tools don't apply. More information in \`argent-device-interact\` skill`,
  alwaysLoad: true,
  searchHint: "tap press button element device simulator emulator chromium touch down up click",
  zodSchema,
  capability,
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.udid);
    if (device.platform === "chromium") {
      return { chromium: chromiumCdpRef(device) };
    }
    // A physical iPhone drives the sim-server `ios_device` subcommand like any
    // other device; no special CoreDevice branch.
    return { simulatorServer: simulatorServerRef(device) };
  },
  async execute(services, params) {
    const device = resolveDevice(params.udid);
    const timestampMs = Date.now();
    const clickCount = params.clickCount ?? 1;
    if (device.platform === "chromium") {
      const chromium = services.chromium as ChromiumCdpApi;
      await tapChromium(chromium, params.x, params.y, clickCount);
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
