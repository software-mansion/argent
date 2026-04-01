import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { SimulatorServerApi } from "../../blueprints/simulator-server";
import { httpDescribe } from "../../utils/simulator-client";

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
});

export const describeTool: ToolDefinition<z.infer<typeof zodSchema>, unknown> = {
  id: "describe",
  description: `Get the iOS accessibility element tree for the simulator screen.
Returns a JSON tree of UI elements with roles, labels, identifiers, values, and
frame coordinates in normalized [0,1] space — same coordinate space as gesture-tap and gesture-swipe.
Use frame.x + frame.width/2 for the tap X and frame.y + frame.height/2 for the tap Y.
Use when you need to find tappable elements or verify the current screen state before interacting, e.g. before calling gesture-tap.
For React Native apps, debugger-component-tree also returns React component names with tap coordinates.
Requires: udid of the target simulator. Fails if accessibility permission is not granted to simulator-server.`,
  zodSchema,
  services: (params) => ({
    simulatorServer: `SimulatorServer:${params.udid}`,
  }),
  async execute(services, _params, options) {
    const api = services.simulatorServer as SimulatorServerApi;
    const signal = options?.signal ?? AbortSignal.timeout(10_000);
    return httpDescribe(api, signal);
  },
};
