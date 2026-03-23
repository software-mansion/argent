import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { SimulatorServerApi } from "../../blueprints/simulator-server";
import { sendCommand } from "../../utils/simulator-client";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const eventSchema = z.object({
  type: z.enum(["Down", "Move", "Up"]).describe("Touch event type"),
  x: z.number().describe(
    "Normalized x 0.0–1.0 (not pixels; same as tap/swipe)",
  ),
  y: z.number().describe(
    "Normalized y 0.0–1.0 (not pixels; same as tap/swipe)",
  ),
  x2: z
    .number()
    .optional()
    .describe(
      "Second touch x for two-finger gestures: normalized 0.0–1.0 (not pixels)",
    ),
  y2: z
    .number()
    .optional()
    .describe(
      "Second touch y for two-finger gestures: normalized 0.0–1.0 (not pixels)",
    ),
  delayMs: z
    .number()
    .optional()
    .describe("Delay before this event in milliseconds (default 16ms ≈ 60fps)"),
});

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  events: z
    .array(eventSchema)
    .describe(
      "Sequence of touch events; x/y (and optional second touch) are normalized 0.0–1.0, not pixels",
    ),
});

export const gestureTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { events: number }
> = {
  id: "gesture",
  description: `Send a sequence of touch events for complex gestures.
Use for: long press, drag-and-drop, custom scroll, pinch (second touch point).
For simple taps use the tap tool. For straight-line scrolling use the swipe tool.
All x/y values are normalized 0.0–1.0 (screen fractions, not pixels), matching simulator-server touch input—same convention as tap and swipe. delayMs controls the delay before each event (default 16ms ≈ 60fps).

Example long-press at center:
  [{"type":"Down","x":0.5,"y":0.5},{"type":"Up","x":0.5,"y":0.5,"delayMs":800}]

Example smooth scroll down:
  [{"type":"Down","x":0.5,"y":0.7},
   {"type":"Move","x":0.5,"y":0.6},{"type":"Move","x":0.5,"y":0.5},{"type":"Move","x":0.5,"y":0.4},
   {"type":"Up","x":0.5,"y":0.3}]`,
  zodSchema,
  services: (params) => ({
    simulatorServer: `SimulatorServer:${params.udid}`,
  }),
  async execute(services, params) {
    const api = services.simulatorServer as SimulatorServerApi;
    for (const event of params.events) {
      await sleep(event.delayMs ?? 16);
      sendCommand(api, {
        cmd: "touch",
        type: event.type,
        x: event.x,
        y: event.y,
        second_x: event.x2 ?? null,
        second_y: event.y2 ?? null,
      });
    }
    return { events: params.events.length };
  },
};
