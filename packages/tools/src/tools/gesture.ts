import { z } from "zod";
import { Tool } from "../types";
import { ensureServer, sendCommand } from "../simulator-registry";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const eventSchema = z.object({
  type: z.enum(["Down", "Move", "Up"]).describe("Touch event type"),
  x: z.number().describe("Normalized x coordinate (0.0–1.0)"),
  y: z.number().describe("Normalized y coordinate (0.0–1.0)"),
  x2: z
    .number()
    .optional()
    .describe("Second touch x coordinate for two-finger gestures (0.0–1.0)"),
  y2: z
    .number()
    .optional()
    .describe("Second touch y coordinate for two-finger gestures (0.0–1.0)"),
  delayMs: z
    .number()
    .optional()
    .describe("Delay before this event in milliseconds (default 16ms ≈ 60fps)"),
});

const inputSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  events: z
    .array(eventSchema)
    .describe("Sequence of touch events to send to the simulator"),
});

export const gestureTool: Tool<
  typeof inputSchema,
  { events: number }
> = {
  name: "gesture",
  description: `Send a sequence of touch events for complex gestures.
Use for: long press, drag-and-drop, custom scroll, pinch (second touch point).
For simple taps use the tap tool. For straight-line scrolling use the swipe tool.
Coordinates are normalized 0.0–1.0. delayMs controls the delay before each event (default 16ms ≈ 60fps).

Example long-press at center:
  [{"type":"Down","x":0.5,"y":0.5},{"type":"Up","x":0.5,"y":0.5,"delayMs":800}]

Example smooth scroll down:
  [{"type":"Down","x":0.5,"y":0.7},
   {"type":"Move","x":0.5,"y":0.6},{"type":"Move","x":0.5,"y":0.5},{"type":"Move","x":0.5,"y":0.4},
   {"type":"Up","x":0.5,"y":0.3}]`,
  inputSchema,
  async execute(input) {
    const entry = await ensureServer(input.udid);
    for (const event of input.events) {
      await sleep(event.delayMs ?? 16);
      sendCommand(entry, {
        cmd: "touch",
        type: event.type,
        x: event.x,
        y: event.y,
        second_x: event.x2 ?? null,
        second_y: event.y2 ?? null,
      });
    }
    return { events: input.events.length };
  },
};
