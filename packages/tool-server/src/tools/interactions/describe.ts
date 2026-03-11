import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { SimulatorServerApi } from "../../blueprints/simulator-server";
import { httpDescribe } from "../../utils/simulator-client";

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
});

export const describeTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  unknown
> = {
  id: "describe",
  description: `Get the iOS accessibility element tree for the simulator screen.
Returns a JSON tree of UI elements with roles, labels, identifiers, values, and
normalized [0,1] frame coordinates (same space as the tap/swipe tools).

Use this to find exact tap targets: \`frame.x + frame.width/2\` gives the tap X,
\`frame.y + frame.height/2\` gives the tap Y.

For React Native apps, the debugger-component-tree tool is also available and returns React component names with tap coordinates.

Only supported on iOS simulators. On first use, macOS may require granting
Accessibility permission to the simulator-server binary. If this happens,
the tool will automatically open System Settings and Finder with step-by-step
instructions — follow them and retry.`,
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
