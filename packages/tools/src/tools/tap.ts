import { z } from "zod";
import type { ToolDefinition } from "@radon-lite/registry";
import type { SimulatorServerApi } from "../blueprints/simulator-server";
import { sendCommand } from "../simulator-api";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  x: z.number().describe("Horizontal position (0.0=left, 1.0=right)"),
  y: z.number().describe("Vertical position (0.0=top, 1.0=bottom)"),
});

export const tapTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { tapped: boolean }
> = {
  id: "tap",
  description: `Tap the simulator screen at normalized coordinates (0.0=left/top, 1.0=right/bottom).
Sends a Down event followed by an Up event at the same point.`,
  zodSchema,
  services: (params) => ({
    simulatorServer: `SimulatorServer:${params.udid}`,
  }),
  async execute(services, params) {
    const api = services.simulatorServer as SimulatorServerApi;
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
    return { tapped: true };
  },
};
