import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { SimulatorServerApi } from "../../blueprints/simulator-server";
import { sendCommand } from "../../utils/simulator-client";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const zodSchema = z.object({
  udid: z
    .string()
    .describe(
      "Device id. iOS: simulator UDID (UUID shape). Android: adb serial (e.g. `emulator-5554`)."
    ),
  x: z.number().describe("Normalized horizontal position 0.0–1.0 (left=0, right=1), not pixels"),
  y: z.number().describe("Normalized vertical position 0.0–1.0 (top=0, bottom=1), not pixels"),
});

export const gestureTapTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { tapped: boolean; timestampMs: number }
> = {
  id: "gesture-tap",
  description: `Press the screen at normalized coordinates on iOS or Android. x and y are fractions of screen width and height in 0.0–1.0 (not pixels), matching simulator-server touch input.
Sends a Down event followed by an Up event at the same point.
Use when you need to tap a button, link, or any tappable element. Returns { tapped: true, timestampMs }. Fails if the simulator server cannot start for the given udid (e.g. device not booted).
Before tapping, determine coordinates with a discovery tool: \`describe\`, \`debugger-component-tree\`, or \`native-describe-screen\` (iOS only). More in the \`argent-simulator-interact\` skill.`,
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
