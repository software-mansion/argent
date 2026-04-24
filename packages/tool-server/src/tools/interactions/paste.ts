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
  requires: ["xcrun"],
  description: `Fill the focused field on the iOS simulator by pasting text (fastest text entry).
Use when you need to fill a text input with a long string faster than character-by-character typing.
Returns { pasted: true }. Fails if no field is focused or the simulator server is not running.
Tap the text field first to focus it, then call paste.
If paste doesn't work for a particular field, use the keyboard tool instead.`,
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
