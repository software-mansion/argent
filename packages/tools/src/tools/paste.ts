import { z } from "zod";
import type { ToolDefinition } from "@radon-lite/registry";
import type { SimulatorServerApi } from "../blueprints/simulator-server";
import { sendCommand } from "../simulator-api";

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  text: z.string().describe("Text to paste into the focused input field"),
});

export const pasteTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { pasted: boolean }
> = {
  id: "paste",
  description: `Paste text into the focused input field on the simulator.
Faster and more reliable than simulating individual key presses.`,
  zodSchema,
  services: (params) => ({
    simulatorServer: `SimulatorServer:${params.udid}`,
  }),
  async execute(services, params) {
    const api = services.simulatorServer as SimulatorServerApi;
    sendCommand(api, { cmd: "paste", text: params.text });
    return { pasted: true };
  },
};
