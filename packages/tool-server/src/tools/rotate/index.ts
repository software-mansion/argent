import { z } from "zod";
import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { resolveDevice } from "../../utils/device-info";
import { sendCommand } from "../../utils/simulator-client";
import { IOS_ROTATED_CAPTURE_NOTE } from "../../utils/ios-orientation-hint";

const zodSchema = z.object({
  udid: z.string().describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
  orientation: z
    .enum(["Portrait", "LandscapeLeft", "LandscapeRight", "PortraitUpsideDown"])
    .describe("Target orientation"),
});

type Params = z.infer<typeof zodSchema>;

interface Result {
  orientation: string;
  /** Present on iOS, where rotating leaves the capture in a different space. */
  note?: string;
}

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
};

export const rotateTool: ToolDefinition<Params, Result> = {
  id: "rotate",
  interaction: {
    startedMsg: ({ params }) => `Rotating device to ${params.orientation}`,
    completedMsg: ({ params }) => `Rotated device to ${params.orientation}`,
    failedMsg: ({ failureSignal }) => `Failed to rotate device: ${failureSignal.error_code}`,
  },
  description: `Set the device orientation to Portrait, LandscapeLeft, LandscapeRight, or PortraitUpsideDown.
Use to test layout in a different orientation. Re-run \`describe\` afterwards — frame coordinates change with the orientation.
On iOS a rotated simulator still captures in its unrotated space, so the screenshot looks sideways; \`describe\` stays the source of tap coordinates.
Returns { orientation, note }. Fails if the target device is not booted.`,
  zodSchema,
  capability,
  services: (params) => ({
    simulatorServer: simulatorServerRef(resolveDevice(params.udid)),
  }),
  async execute(services, params) {
    const api = services.simulatorServer as SimulatorServerApi;
    const device = resolveDevice(params.udid);
    sendCommand(api, { cmd: "rotate", direction: params.orientation });
    // On iOS the capture is composited in the device's unrotated space, so it
    // comes back sideways after a rotation. `rotation` on `screenshot` will make
    // it readable, but that image is then in a different space from `describe`
    // frames and from where taps land — so say both halves rather than
    // recommending a flag that silently breaks coordinates (#609).
    const note =
      device.platform === "ios" || device.platform === "ios-remote"
        ? IOS_ROTATED_CAPTURE_NOTE
        : undefined;
    return { orientation: params.orientation, ...(note ? { note } : {}) };
  },
};
