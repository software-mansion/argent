import { z } from "zod";
import type { Registry, ToolDefinition } from "@argent/registry";
import type { AXServiceApi } from "../../blueprints/ax-service";
import { AX_SERVICE_NAMESPACE } from "../../blueprints/ax-service";
import type { DescribeNode } from "./describe-contract";
import { adaptAXDescribeToDescribeResult } from "./describe-ax-adapter";

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  bundleId: z
    .string()
    .optional()
    .describe(
      "Deprecated — ignored by describe. Use native-describe-screen for app-scoped inspection with a specific bundleId."
    ),
});

export function createDescribeTool(
  registry: Registry
): ToolDefinition<z.infer<typeof zodSchema>, DescribeNode> {
  return {
    id: "describe",
    description: `Get the iOS accessibility element tree for the current simulator screen.
Uses the AXRuntime accessibility service to inspect whatever is currently visible — including
system dialogs, permission prompts, and any foreground app content.

When a system dialog is visible, describe returns the dialog's interactive elements (buttons, text)
with tap coordinates. When no dialog is present, it returns the foreground app's accessible elements.

Returns a JSON tree of UI elements with roles, labels, values, and frame coordinates in normalized
[0,1] space (fractions of the screen, not pixels) — the same coordinate space as tap/swipe/gesture
and simulator-server touch input.

Use frame.x + frame.width/2 as the tap X coordinate, frame.y + frame.height/2 as tap Y.

For app-scoped inspection with full UIKit properties (accessibilityIdentifier, viewClassName),
use native-describe-screen with an explicit bundleId instead.
For React Native apps, debugger-component-tree returns React component names with tap coordinates.
Only supported on iOS simulators.`,
    zodSchema,
    services: () => ({}),
    async execute(_services, params, _options) {
      const axApi = await registry.resolveService<AXServiceApi>(
        `${AX_SERVICE_NAMESPACE}:${params.udid}`
      );
      const response = await axApi.describe();
      return adaptAXDescribeToDescribeResult(response);
    },
  };
}
