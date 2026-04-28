import { z } from "zod";
import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { iosImpl, type GestureSwipeResult, type GestureSwipeServices } from "./platforms/ios";
import { androidImpl } from "./platforms/android";

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
  fromX: z.number().describe("Start x: normalized 0.0–1.0 (not pixels; same as tap)"),
  fromY: z.number().describe("Start y: normalized 0.0–1.0 (not pixels; same as tap)"),
  toX: z.number().describe("End x: normalized 0.0–1.0 (not pixels; same as tap)"),
  toY: z.number().describe("End y: normalized 0.0–1.0 (not pixels; same as tap)"),
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

export const gestureSwipeTool: ToolDefinition<Params, GestureSwipeResult> = {
  id: "gesture-swipe",
  description: `Execute a smooth swipe gesture between two points. All from/to positions are normalized 0.0–1.0 (fractions of screen width/height, not pixels), same as gesture-tap and simulator-server touch.
Generates interpolated Move events for a natural feel (~60fps).
Swipe up (fromY > toY) to scroll content down.
Swipe down (fromY < toY) to scroll content up.
Use when you need to scroll a list, dismiss a modal, or navigate between pages. Returns { swiped: true, timestampMs }. Fails if the simulator server is not running for the given UDID.`,
  alwaysLoad: true,
  searchHint: "swipe scroll drag pan gesture simulator touch move",
  zodSchema,
  capability,
  services: (params) => ({
    simulatorServer: `SimulatorServer:${params.udid}`,
  }),
  execute: dispatchByPlatform<GestureSwipeServices, Params, GestureSwipeResult>({
    toolId: "gesture-swipe",
    capability,
    ios: iosImpl,
    android: androidImpl,
  }),
};
