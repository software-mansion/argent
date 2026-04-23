import { z } from "zod";
import type { Registry, ToolDefinition } from "@argent/registry";
import type { AXServiceApi } from "../../blueprints/ax-service";
import { AX_SERVICE_NAMESPACE } from "../../blueprints/ax-service";
import type { NativeDevtoolsApi } from "../../blueprints/native-devtools";
import { NATIVE_DEVTOOLS_NAMESPACE } from "../../blueprints/native-devtools";
import type { DescribeResult } from "./describe-contract";
import { adaptAXDescribeToDescribeResult } from "./describe-ax-adapter";
import { adaptNativeDescribeToDescribeResult } from "./describe-native-adapter";
import { parseNativeDescribeScreenResult } from "../native-devtools/native-describe-contract";
import { resolveNativeTargetApp } from "../../utils/native-target-app";

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  bundleId: z
    .string()
    .optional()
    .describe(
      "Optional app bundle ID. Used as a target hint when the AX-service returns no elements " +
        "and the describe tool falls back to native-devtools inspection. " +
        "If omitted, the fallback auto-detects the frontmost connected app."
    ),
});

export function createDescribeTool(
  registry: Registry
): ToolDefinition<z.infer<typeof zodSchema>, DescribeResult> {
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
    alwaysLoad: true,
    searchHint: "ios accessibility element tree discovery tap coordinates",
    zodSchema,
    services: () => ({}),
    async execute(_services, params, _options) {
      const axApi = await registry.resolveService<AXServiceApi>(
        `${AX_SERVICE_NAMESPACE}:${params.udid}`
      );
      const response = await axApi.describe();
      const tree = adaptAXDescribeToDescribeResult(response);

      if (tree.children.length > 0) {
        return { tree, source: "ax-service" };
      }

      // AX returned zero elements — attempt native-devtools fallback
      try {
        const nativeApi = await registry.resolveService<NativeDevtoolsApi>(
          `${NATIVE_DEVTOOLS_NAMESPACE}:${params.udid}`
        );

        const target = await resolveNativeTargetApp(nativeApi, params.bundleId);

        if (await nativeApi.requiresAppRestart(target.bundleId)) {
          return { tree, source: "ax-service", should_restart: true };
        }

        const rawResult = (await nativeApi.queryViewHierarchy(
          target.bundleId,
          "ViewHierarchy.describeScreen"
        )) as { screenFrame?: unknown; elements?: unknown[]; error?: string };

        if (rawResult.error) {
          return { tree, source: "ax-service" };
        }

        const parsed = parseNativeDescribeScreenResult(rawResult);
        const nativeTree = adaptNativeDescribeToDescribeResult(parsed);
        return { tree: nativeTree, source: "native-devtools" };
      } catch {
        // Native devtools unavailable or no connected app — return the empty AX result
        return { tree, source: "ax-service" };
      }
    },
  };
}
