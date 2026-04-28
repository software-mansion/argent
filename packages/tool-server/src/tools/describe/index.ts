import { z } from "zod";
import type { Registry, ToolCapability, ToolDefinition } from "@argent/registry";
import type { DescribeResult } from "./contract";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { describeIos, iosRequires } from "./platforms/ios";
import { describeAndroid, androidRequires } from "./platforms/android";

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
  bundleId: z
    .string()
    .optional()
    .describe(
      "Optional app bundle ID. Used as a target hint on iOS when the AX-service returns no elements " +
        "and the describe tool falls back to native-devtools inspection. " +
        "If omitted, the fallback auto-detects the frontmost connected app. Ignored on Android."
    ),
});

type Params = z.infer<typeof zodSchema>;

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
};

// `describe` doesn't fit dispatchByPlatform's standard service-typed
// signature because the iOS handler resolves AX / native-devtools through
// `registry` (closed over below) rather than via the registry's services()
// declaration. We still feed `iosRequires` / `androidRequires` to the
// dispatcher so the per-branch host-binary preflight fires uniformly.
export function createDescribeTool(registry: Registry): ToolDefinition<Params, DescribeResult> {
  return {
    id: "describe",
    description: `Get the accessibility element tree for the current screen.
On iOS, uses the AXRuntime accessibility service to inspect whatever is currently visible — including
system dialogs, permission prompts, and any foreground app content. On Android, runs \`uiautomator dump\`.

When a system dialog is visible, describe returns the dialog's interactive elements (buttons, text)
with tap coordinates. When no dialog is present, it returns the foreground app's accessible elements.

Returns a JSON tree of UI elements with roles, labels, values, and frame coordinates in normalized
[0,1] space (fractions of the screen, not pixels) — the same coordinate space as tap/swipe/gesture
and simulator-server touch input.

Use frame.x + frame.width/2 as the tap X coordinate, frame.y + frame.height/2 as tap Y.

For app-scoped inspection with full UIKit properties (accessibilityIdentifier, viewClassName),
use native-describe-screen with an explicit bundleId instead (iOS only).
For React Native apps, debugger-component-tree returns React component names with tap coordinates.`,
    alwaysLoad: true,
    searchHint: "accessibility element tree ui hierarchy tap coordinates ios android",
    zodSchema,
    capability,
    services: () => ({}),
    execute: dispatchByPlatform<Record<string, unknown>, Params, DescribeResult>({
      toolId: "describe",
      capability,
      ios: {
        requires: iosRequires,
        handler: (_services, params) => describeIos(registry, params),
      },
      android: {
        requires: androidRequires,
        handler: (_services, params) => describeAndroid(params.udid, params.bundleId),
      },
    }),
  };
}
