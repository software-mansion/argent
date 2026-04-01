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
  description: `Set text in the currently focused text field on the simulator by pasting (fastest entry method, supports Unicode).
Use when filling in forms, entering long strings, or inputting characters not supported by the keyboard tool. Tap the text field first to focus it, then call paste.

Parameters: udid — simulator UDID (e.g. A1B2C3D4-E5F6-7890-ABCD-EF1234567890); text — the string to paste (e.g. "Hello, 世界!").
Example: { "udid": "A1B2C3D4-E5F6-7890-ABCD-EF1234567890", "text": "test@example.com" }
Returns { pasted: true }. If paste has no effect for a particular field (some custom inputs block it), use the keyboard tool instead. Fails if the simulator-server cannot start.`,
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
