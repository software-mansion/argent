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
  description: `Press (tap) a point on the simulator screen using normalized coordinates: x and y are fractions of width/height in 0.0–1.0 (not pixels), matching simulator-server touch input.
Sends a Down event followed by an Up event at the same point.
Use when you need to tap a button, link, or any UI element — always call describe or debugger-component-tree first to get exact coordinates (e.g. x: 0.5, y: 0.3).
Accepts: x, y, udid. Returns the tap result. Fails if udid is invalid or coordinates are outside 0.0–1.0.`,
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
