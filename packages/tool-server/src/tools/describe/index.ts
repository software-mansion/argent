import { z } from "zod";
import type { Registry, ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import type { DescribeResult, DescribeTreeData } from "./contract";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { describeAndroid, androidRequires } from "./platforms/android";
import { iosRequires, describeIos } from "./platforms/ios";
import { describeChromium } from "./platforms/chromium";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { resolveDevice } from "../../utils/device-info";
import { formatDescribeTree } from "./format-tree";

// In-between layer between the per-platform adapters (which still own all
// pruning — the Android v2 trimmer in uiautomator-parser stays untouched) and
// the public DescribeResult. The internal `tree` is converted to a token-
// efficient text rendering here and then dropped, so the caller (LLM) never
// pays for the JSON tree.
function withDescription(data: DescribeTreeData): DescribeResult {
  const out: DescribeResult = {
    description: formatDescribeTree(data.tree, { source: data.source }),
    source: data.source,
  };
  if (data.should_restart) out.should_restart = data.should_restart;
  if (data.hint) out.hint = data.hint;
  return out;
}

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Target device id from `list-devices` (iOS UDID, Android serial, or Chromium id)."),
  bundleId: z
    .string()
    .optional()
    .describe(
      "Optional app bundle ID. Used as a target hint on iOS when the AX-service returns no elements " +
        "and the describe tool falls back to native-devtools inspection. " +
        "If omitted, the fallback auto-detects the frontmost connected app. Ignored on Android / Chromium."
    ),
});

type Params = z.infer<typeof zodSchema>;

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
};

interface ChromiumServices {
  chromium: ChromiumCdpApi;
}

// `describe` doesn't fit dispatchByPlatform's standard service-typed
// signature because the iOS handler resolves AX / native-devtools through
// `registry` (closed over below) rather than via the registry's services()
// declaration. We still feed `iosRequires` / `androidRequires` to the
// dispatcher so the per-branch host-binary preflight fires uniformly. The
// Chromium branch *does* go through services() since the CDP session lives in
// the registry as a normal service blueprint.
export function createDescribeTool(registry: Registry): ToolDefinition<Params, DescribeResult> {
  return {
    id: "describe",
    description: `Get the accessibility / DOM element tree for the current screen.
On iOS, uses the AXRuntime accessibility service to inspect whatever is currently visible — including
system dialogs, permission prompts, and any foreground app content. On Android, runs \`uiautomator dump\`.
On Chromium, walks the renderer's DOM via Chrome DevTools Protocol — every visible element with its ARIA
role, accessible name, and bounding rect (normalized to 0–1).

When a system dialog is visible, describe returns the dialog's interactive elements (buttons, text)
with tap coordinates. When no dialog is present, it returns the foreground app's accessible elements.

Returns \`{ description, source }\` where \`description\` is a text rendering of the UI tree — one
line per element with its role, label/value/id, interactivity flags, and frame. Frame coordinates
are normalized [0,1] fractions of the screen / window width/height (not pixels) — the same space as
gesture-tap / gesture-swipe / gesture-pinch.

To tap an element use the centre of its frame: \`tap_x = frame.x + frame.width / 2\`,
\`tap_y = frame.y + frame.height / 2\`. The same formula appears in the response header so it
can be applied to a line in isolation.

For app-scoped inspection with full UIKit properties (accessibilityIdentifier, viewClassName),
use native-describe-screen with an explicit bundleId instead (iOS only).
For React Native apps, debugger-component-tree returns React component names with tap coordinates.`,
    alwaysLoad: true,
    searchHint: "accessibility element tree ui hierarchy tap coordinates ios android chromium dom",
    zodSchema,
    capability,
    services: (params): Record<string, ServiceRef> => {
      const device = resolveDevice(params.udid);
      if (device.platform === "chromium") {
        return { chromium: chromiumCdpRef(device) };
      }
      return {};
    },
    execute: dispatchByPlatform<
      Record<string, unknown>,
      Record<string, unknown>,
      Params,
      DescribeResult,
      ChromiumServices
    >({
      toolId: "describe",
      capability,
      ios: {
        requires: iosRequires,
        handler: async (_services, params, device) =>
          withDescription(await describeIos(registry, device, params)),
      },
      android: {
        requires: androidRequires,
        handler: async (_services, params) =>
          withDescription(await describeAndroid(registry, params.udid, params.bundleId)),
      },
      chromium: {
        handler: async (services) => withDescription(await describeChromium(services.chromium)),
      },
    }),
  };
}
