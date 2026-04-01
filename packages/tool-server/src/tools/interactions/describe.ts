import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { SimulatorServerApi } from "../../blueprints/simulator-server";
import { httpDescribe } from "../../utils/simulator-client";

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
});

export const describeTool: ToolDefinition<z.infer<typeof zodSchema>, unknown> = {
  id: "describe",
  description: `Get the iOS accessibility element tree for the current simulator screen.
Use when you need to find exact tap coordinates before calling gesture-tap or any gesture tool. Returns roles, labels, identifiers, and frame coordinates in normalized 0.0–1.0 space. Compute tap X as frame.x + frame.width/2, tap Y as frame.y + frame.height/2.

Parameters: udid — simulator UDID (e.g. A1B2C3D4-E5F6-7890-ABCD-EF1234567890). No other parameters needed.
Example: { "udid": "A1B2C3D4-E5F6-7890-ABCD-EF1234567890" }
Returns a JSON accessibility tree. For React Native apps, also consider debugger-component-tree for React-specific component names. On macOS, may prompt for Accessibility permission on first use — follow the on-screen instructions and retry if the tool fails.`,
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
