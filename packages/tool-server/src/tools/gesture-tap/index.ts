import { z } from "zod";
import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { coreDeviceRef, type CoreDeviceApi } from "../../blueprints/core-device";
import { resolveDevice, isPhysicalIos } from "../../utils/device-info";
import { sendCommand } from "../../utils/simulator-client";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const zodSchema = z.object({
  udid: z
    .string()
    .describe("Target device id from `list-devices` (iOS UDID, Android serial, or Chromium id)."),
  x: z.number().describe("Normalized horizontal position 0.0–1.0 (left=0, right=1), not pixels"),
  y: z.number().describe("Normalized vertical position 0.0–1.0 (top=0, bottom=1), not pixels"),
});

type Params = z.infer<typeof zodSchema>;

interface Result {
  tapped: boolean;
  timestampMs: number;
}

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
};

async function tapChromium(api: ChromiumCdpApi, x: number, y: number): Promise<void> {
  const vp = api.getViewport();
  const pxX = Math.max(0, Math.min(vp.width, x * vp.width));
  const pxY = Math.max(0, Math.min(vp.height, y * vp.height));
  await api.dispatchMouseEvent({ type: "mouseMoved", x: pxX, y: pxY });
  await api.dispatchMouseEvent({ type: "mousePressed", x: pxX, y: pxY, clickCount: 1 });
  await sleep(50);
  await api.dispatchMouseEvent({ type: "mouseReleased", x: pxX, y: pxY, clickCount: 1 });
}

export const gestureTapTool: ToolDefinition<Params, Result> = {
  id: "gesture-tap",
  description: `Press the device screen (iOS simulator, Android emulator, or Chromium app) at normalized coordinates: x and y are fractions of screen width and height in 0.0–1.0 (not pixels).
Sends a Down event followed by an Up event at the same point. For Chromium, this dispatches a CDP mouse-press/release on the renderer.
Use when you need to tap a button, link, or any tappable element on the screen.
Returns { tapped: true, timestampMs }. On a physical iPhone, taps route over CoreDevice. Fails if the simulator-server / emulator backend / Chromium CDP is not reachable for the given device.
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
    if (isPhysicalIos(device)) {
      return { coreDevice: coreDeviceRef(device) };
    }
    return { simulatorServer: simulatorServerRef(device) };
  },
  async execute(services, params) {
    const device = resolveDevice(params.udid);
    const timestampMs = Date.now();
    if (device.platform === "chromium") {
      const chromium = services.chromium as ChromiumCdpApi;
      await tapChromium(chromium, params.x, params.y);
      return { tapped: true, timestampMs };
    }
    if (isPhysicalIos(device)) {
      const coreDevice = services.coreDevice as CoreDeviceApi;
      await coreDevice.tap(params.x, params.y);
      return { tapped: true, timestampMs };
    }
    const api = services.simulatorServer as SimulatorServerApi;
    sendCommand(api, {
      cmd: "touch",
      type: "Down",
      x: params.x,
      y: params.y,
      second_x: null,
      second_y: null,
    });
    await sleep(50);
    sendCommand(api, {
      cmd: "touch",
      type: "Up",
      x: params.x,
      y: params.y,
      second_x: null,
      second_y: null,
    });
    return { tapped: true, timestampMs };
  },
};
