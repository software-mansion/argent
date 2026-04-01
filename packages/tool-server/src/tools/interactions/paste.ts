import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { SimulatorServerApi } from "../../blueprints/simulator-server";
import { sendCommand } from "../../utils/simulator-client";

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  text: z.string().describe("Text to paste into the focused field"),
});

export const pasteTool: ToolDefinition<z.infer<typeof zodSchema>, { pasted: boolean }> = {
  id: "paste",
  description: `Fill a focused text field on the simulator by pasting text (fastest text entry method).
Use when you need to fill a text input quickly, e.g. entering a long email or password. Tap the text field first to focus it, then call paste.
Accepts: udid, text (the string to paste, such as "hello@example.com"). Returns the paste result.
Fails if no field is focused. If paste doesn't work for a particular field, use the keyboard tool instead.`,
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
