import { z } from "zod";
import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { resolveDevice } from "../../utils/device-info";
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

type Params = z.infer<typeof zodSchema>;

interface Result {
  tapped: boolean;
  timestampMs: number;
}

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
};

export const gestureTapTool: ToolDefinition<Params, Result> = {
  id: "gesture-tap",
  description: `Press the simulator screen at normalized coordinates: x and y are fractions of screen width and height in 0.0–1.0 (not pixels), matching simulator-server touch input.
Sends a Down event followed by an Up event at the same point.
Use when you need to tap a button, link, or any tappable element on the simulator screen.
Returns { tapped: true, timestampMs }. Fails if the simulator server is not running for the given UDID.
Before tapping, determine the correct coordinates by using discovery tools: describe, native-describe-screen, debugger-component-tree. More information in \`device-interact\` skill`,
  alwaysLoad: true,
  searchHint: "tap press button element simulator touch down up",
  zodSchema,
  capability,
  services: (params) => ({
    simulatorServer: simulatorServerRef(resolveDevice(params.udid)),
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
