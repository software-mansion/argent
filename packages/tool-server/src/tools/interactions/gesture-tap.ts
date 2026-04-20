import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { SimulatorServerApi } from "../../blueprints/simulator-server";
import { sendCommand } from "../../utils/simulator-client";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
  x: z.number().describe("Normalized horizontal position 0.0–1.0 (left=0, right=1), not pixels"),
  y: z.number().describe("Normalized vertical position 0.0–1.0 (top=0, bottom=1), not pixels"),
});

export const gestureTapTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { tapped: boolean; timestampMs: number }
> = {
  id: "gesture-tap",
  requires: ["xcrun"],
  description: `Tap the screen at normalized coordinates. x and y are fractions of screen width/height in 0.0–1.0 (not pixels).
Use for any tappable element (buttons, links, cells). Sends a Down followed by an Up at the same point.
Before tapping, determine coordinates with a discovery tool (\`describe\`, \`debugger-component-tree\`, or \`native-describe-screen\`) — never eyeball them from a screenshot.
Returns { tapped, timestampMs }. Fails if the target device is not booted.`,
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
