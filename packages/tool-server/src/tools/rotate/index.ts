import { z } from "zod";
import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { iosImpl, type RotateResult, type RotateServices } from "./platforms/ios";
import { androidImpl } from "./platforms/android";

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
  orientation: z
    .enum(["Portrait", "LandscapeLeft", "LandscapeRight", "PortraitUpsideDown"])
    .describe("Target orientation"),
});

type Params = z.infer<typeof zodSchema>;

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
};

export const rotateTool: ToolDefinition<Params, RotateResult> = {
  id: "rotate",
  description: `Set the device orientation to Portrait, LandscapeLeft, LandscapeRight, or PortraitUpsideDown.
Use to test layout in a different orientation. Re-run \`describe\` afterwards — frame coordinates change with the orientation.
Returns { orientation }. Fails if the target device is not booted.`,
  zodSchema,
  capability,
  services: (params) => ({
    simulatorServer: `SimulatorServer:${params.udid}`,
  }),
  execute: dispatchByPlatform<RotateServices, Params, RotateResult>({
    toolId: "rotate",
    capability,
    ios: iosImpl,
    android: androidImpl,
  }),
};
