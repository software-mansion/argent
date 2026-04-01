import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { SimulatorServerApi } from "../../blueprints/simulator-server";
import { sendCommand } from "../../utils/simulator-client";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  x: z.number().describe("Normalized horizontal position 0.0–1.0 (left=0, right=1), not pixels"),
  y: z.number().describe("Normalized vertical position 0.0–1.0 (top=0, bottom=1), not pixels"),
});

export const gestureTapTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { tapped: boolean; timestampMs: number }
> = {
  id: "gesture-tap",
  description: `Send a tap gesture to the simulator screen at normalized coordinates (x, y in 0.0–1.0 space, not pixels).
Use when pressing a button, selecting a list item, or interacting with any tappable UI element. Always call describe or debugger-component-tree first to get exact coordinates — never guess.

Parameters: udid — simulator UDID (e.g. A1B2C3D4-E5F6-7890-ABCD-EF1234567890); x, y — normalized screen fractions (0.0=left/top, 1.0=right/bottom).
Example: { "udid": "A1B2C3D4-E5F6-7890-ABCD-EF1234567890", "x": 0.5, "y": 0.25 }
Returns { tapped: true, timestampMs }. Returns an error if the simulator-server cannot start (simulator not booted) or coordinates are outside 0.0–1.0.`,
  zodSchema,
  services: (params) => ({
    simulatorServer: `SimulatorServer:${params.udid}`,
  }),
  async execute(services, params) {
    const api = services.simulatorServer as SimulatorServerApi;
    const timestampMs = Date.now();
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
