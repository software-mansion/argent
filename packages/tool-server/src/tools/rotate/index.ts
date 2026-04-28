import { z } from "zod";
import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { rotateIos, type RotateResult, type RotateServices } from "./platforms/ios";
import { rotateAndroid } from "./platforms/android";

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  orientation: z
    .enum(["Portrait", "LandscapeLeft", "LandscapeRight", "PortraitUpsideDown"])
    .describe("Target orientation"),
});

type Params = z.infer<typeof zodSchema>;

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
};

export const rotateTool: ToolDefinition<Params, RotateResult> = {
  id: "rotate",
  description: `Set the simulator orientation to Portrait, LandscapeLeft, LandscapeRight, or PortraitUpsideDown. Use when testing layout in a different orientation. Returns { orientation }. Fails if the simulator-server is not running for the given UDID.`,
  zodSchema,
  capability,
  services: (params) => ({
    simulatorServer: `SimulatorServer:${params.udid}`,
  }),
  execute: dispatchByPlatform<RotateServices, Params, RotateResult>({
    toolId: "rotate",
    capability,
    ios: rotateIos,
    android: rotateAndroid,
  }),
};
