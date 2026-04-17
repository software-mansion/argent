import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { SimulatorServerApi } from "../../blueprints/simulator-server";
import { sendCommand } from "../../utils/simulator-client";
import { interpolateEvents } from "../../utils/gesture-utils";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const eventSchema = z.object({
  type: z.enum(["Down", "Move", "Up"]).describe("Touch event type"),
  x: z.number().describe("Normalized x 0.0–1.0 (not pixels; same as tap/swipe)"),
  y: z.number().describe("Normalized y 0.0–1.0 (not pixels; same as tap/swipe)"),
  x2: z
    .number()
    .optional()
    .describe("Second touch x for two-finger gestures: normalized 0.0–1.0 (not pixels)"),
  y2: z
    .number()
    .optional()
    .describe("Second touch y for two-finger gestures: normalized 0.0–1.0 (not pixels)"),
  delayMs: z
    .number()
    .optional()
    .describe("Delay before this event in milliseconds (default 16ms ≈ 60fps)"),
});

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
  events: z
    .array(eventSchema)
    .describe(
      "Sequence of touch events; x/y (and optional second touch) are normalized 0.0–1.0, not pixels"
    ),
  interpolate: z
    .number()
    .optional()
    .describe(
      "Number of intermediate Move events to auto-insert between each pair of consecutive events. " +
        "Smooths out gestures by linearly interpolating both primary (x,y) and secondary (x2,y2) coordinates. " +
        "The delay is split evenly across interpolated frames. Default: no interpolation."
    ),
});

export const gestureCustomTool: ToolDefinition<z.infer<typeof zodSchema>, { events: number }> = {
  id: "gesture-custom",
  description: `Send a sequence of touch events for complex gestures.
Use for: long press, drag-and-drop, custom scroll, pinch (second touch point).
For simple taps use the gesture-tap tool. For straight-line scrolling use the gesture-swipe tool.
For pinch gestures use gesture-pinch. For rotation gestures use gesture-rotate.
All x/y values are normalized 0.0–1.0 (screen fractions, not pixels). delayMs controls the delay before each event (default 16ms ≈ 60fps).
Set interpolate to auto-generate smooth intermediate Move events between your keyframes.
Returns { events: number } with the total count of events dispatched. Fails if the target device is not booted or an event type is invalid.

Example long-press at center:
  [{"type":"Down","x":0.5,"y":0.5},{"type":"Up","x":0.5,"y":0.5,"delayMs":800}]

Example smooth scroll down:
  [{"type":"Down","x":0.5,"y":0.7},
   {"type":"Move","x":0.5,"y":0.6},{"type":"Move","x":0.5,"y":0.5},{"type":"Move","x":0.5,"y":0.4},
   {"type":"Up","x":0.5,"y":0.3}]

Example pinch-to-zoom (with interpolate:10 for smoothness):
  events: [{"type":"Down","x":0.4,"y":0.5,"x2":0.6,"y2":0.5},
           {"type":"Up","x":0.2,"y":0.5,"x2":0.8,"y2":0.5}]
  interpolate: 10`,
  zodSchema,
  services: (params) => ({
    simulatorServer: `SimulatorServer:${params.udid}`,
  }),
  async execute(services, params) {
    const api = services.simulatorServer as SimulatorServerApi;
    const events =
      params.interpolate && params.interpolate > 0
        ? interpolateEvents(params.events, params.interpolate)
        : params.events;

    for (const event of events) {
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
    return { events: events.length };
  },
};
