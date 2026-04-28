import { z } from "zod";
import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { iosImpl, type GestureRotateResult, type GestureRotateServices } from "./platforms/ios";
import { androidImpl } from "./platforms/android";

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
  centerX: z
    .number()
    .describe(
      "Center of rotation, horizontal: normalized 0.0–1.0 (fraction of screen width, not pixels)"
    ),
  centerY: z
    .number()
    .describe(
      "Center of rotation, vertical: normalized 0.0–1.0 (fraction of screen height, not pixels)"
    ),
  radius: z
    .number()
    .describe(
      "Distance from center to each finger: normalized 0.0–1.0 (fraction of screen, not pixels). " +
        "E.g. 0.15 = fingers placed 15% of screen away from center."
    ),
  startAngle: z.number().describe("Starting angle in degrees (0 = right, 90 = down)"),
  endAngle: z.number().describe("Ending angle in degrees. endAngle > startAngle = clockwise."),
  durationMs: z
    .number()
    .optional()
    .describe("Total gesture duration in milliseconds (default 300)"),
});

type Params = z.infer<typeof zodSchema>;

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
};

export const gestureRotateTool: ToolDefinition<Params, GestureRotateResult> = {
  id: "gesture-rotate",
  description: `Send a two-finger circular arc gesture to rotate on-screen content by a specified angle. Two fingers are placed opposite each other at a fixed radius from the center, then swept from startAngle to endAngle degrees. All positions and radius are normalized 0.0–1.0 (fractions of screen width/height, not pixels)—same coordinate space as gesture-tap and gesture-swipe.
endAngle > startAngle = clockwise rotation. Typical values: radius 0.15, startAngle 0, endAngle 90 for a 90° clockwise turn.
Auto-generates interpolated frames at ~60fps.
Unlike gesture-pinch which moves fingers linearly to zoom, this orbits fingers in an arc to change orientation.
Use when you need to rotate a map, image picker, or any rotateable UI element. Returns { rotated: true, timestampMs }. Fails if the simulator server is not running for the given UDID.`,
  zodSchema,
  capability,
  services: (params) => ({
    simulatorServer: `SimulatorServer:${params.udid}`,
  }),
  execute: dispatchByPlatform<GestureRotateServices, Params, GestureRotateResult>({
    toolId: "gesture-rotate",
    capability,
    ios: iosImpl,
    android: androidImpl,
  }),
};
