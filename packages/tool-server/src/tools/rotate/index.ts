import { z } from "zod";
import type { Registry, ToolCapability, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { resolveDevice } from "../../utils/device-info";
import { sendCommand } from "../../utils/simulator-client";
import { ADB_DEVICES_TIMEOUT_MS, isAndroidTv } from "../../utils/adb";
import { UnsupportedOperationError } from "../../utils/capability";

const zodSchema = z.object({
  udid: z.string().describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
  orientation: z
    .enum(["Portrait", "LandscapeLeft", "LandscapeRight", "PortraitUpsideDown"])
    .describe("Target orientation"),
});

type Params = z.infer<typeof zodSchema>;

interface Result {
  orientation: string;
}

const capability: ToolCapability = {
  apple: { simulator: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
};

/**
 * A wedged adb server must not hold a phone's rotate for the 30 s `adb devices`
 * default, so that listing is capped and a failed probe counts as not a TV. The
 * device-side probe is not capped: cutting it short would rotate a slow TV.
 */
async function isAndroidTvForRotate(serial: string): Promise<boolean> {
  return isAndroidTv(serial, { devicesTimeoutMs: ADB_DEVICES_TIMEOUT_MS }).catch(() => false);
}

export function createRotateTool(registry: Registry): ToolDefinition<Params, Result> {
  return {
    id: "rotate",
    interaction: {
      startedMsg: ({ params }) => `Rotating device to ${params.orientation}`,
      completedMsg: ({ params }) => `Rotated device to ${params.orientation}`,
      failedMsg: ({ failureSignal }) => `Failed to rotate device: ${failureSignal.error_code}`,
    },
    description: `Set the device orientation to Portrait, LandscapeLeft, LandscapeRight, or PortraitUpsideDown.
Use to test layout in a different orientation. Re-run \`describe\` afterwards: frame coordinates change with the orientation.
On an unfolded foldable iOS simulator (the iPhone Duo), the value sets the orientation of the device, not of the UI: \`Portrait\` gives a landscape UI and \`LandscapeLeft\` gives a portrait UI. To fold or unfold the device, use \`fold\`.
Returns { orientation }. Fails on a TV target, or if the target device is not booted.`,
    zodSchema,
    capability,
    // The simulator-server is resolved in execute, after the Android TV check, so a
    // TV is refused without first starting one.
    services: () => ({}),
    async execute(_services, params) {
      const device = resolveDevice(params.udid);
      if (device.platform === "android" && (await isAndroidTvForRotate(device.id)))
        throw new UnsupportedOperationError("rotate", device, "Android TV has a fixed orientation");
      const ref = simulatorServerRef(device);
      const api = await registry.resolveService<SimulatorServerApi>(ref.urn, ref.options);
      await sendCommand(api, { cmd: "rotate", direction: params.orientation });
      return { orientation: params.orientation };
    },
  };
}
