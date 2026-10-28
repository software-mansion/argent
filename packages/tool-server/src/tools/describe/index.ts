import { z } from "zod";
import type {
  InvokeToolOptions,
  Registry,
  ServiceRef,
  ToolCapability,
  ToolDefinition,
} from "@argent/registry";
import type { DescribeResult, DescribeTreeData } from "./contract";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { describeAndroid, androidRequires } from "./platforms/android";
import { iosRequires, describeIos, withBootCaveatOncePerDevice } from "./platforms/ios";
import { describeIosDevice } from "./platforms/ios-device";
import { describeChromium } from "./platforms/chromium";
import { describeTv } from "./platforms/tv";
import { describeVega, vegaRequires } from "./platforms/vega";
import { describeHarmony, harmonyRequires } from "./platforms/harmony";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { resolveDevice, harmonyConnectKey } from "../../utils/device-info";
import { isTvOsSimulator } from "../../utils/ios-devices";
import { isAndroidTv } from "../../utils/adb";
import { formatDescribeTree } from "./format-tree";

// Renders the adapter-internal `tree` to text and drops it, so the caller (LLM)
// never pays for the JSON tree. Pruning stays in the per-platform adapters.
function withDescription(data: DescribeTreeData): DescribeResult {
  const out: DescribeResult = {
    description: formatDescribeTree(data.tree, { source: data.source }),
    source: data.source,
  };
  if (data.should_restart) out.should_restart = data.should_restart;
  if (data.hint) out.hint = data.hint;
  return out;
}

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
  vega: { vvd: true },
  harmony: { device: true },
};

interface ChromiumServices {
  chromium: ChromiumCdpApi;
}

// The service type params are untyped because the iOS handler resolves AX /
// native-devtools through the closed-over `registry` rather than the
// registry's services() declaration; only the Chromium CDP session is a normal
// service blueprint. `iosRequires` / `androidRequires` still go through the
// dispatcher so the per-branch host-binary preflight fires uniformly.
//
// TV is not a `platform` but a `runtimeKind` spanning two (a tvOS sim
// classifies as "ios", an Android TV emulator as "android" by id shape), so
// instead of a fourth branch the iOS and Android branches runtime-probe their
// own TV kind and delegate to the shared focus-driven `describeTv`.
function makeDescribeExecute(
  registry: Registry
): (
  services: Record<string, unknown>,
  params: Params,
  options?: InvokeToolOptions
) => Promise<DescribeResult> {
  return dispatchByPlatform<
    Record<string, unknown>,
    Record<string, unknown>,
    Params,
    DescribeResult,
    ChromiumServices,
    Record<string, unknown>
  >({
    toolId: "describe",
    capability,
    ios: {
      requires: iosRequires,
      handler: async (_services, params, device) =>
        // Probe tvOS once here, then pass the verdict into describeIos.
        (await isTvOsSimulator(device.id))
          ? describeTv(registry, device)
          : withDescription(
              withBootCaveatOncePerDevice(
                device.id,
                await describeIos(registry, device, params, { isTvOs: false })
              )
            ),
    },
    iosDevice: {
      requires: iosRequires,
      handler: async (_services, _params, device) =>
        withDescription(await describeIosDevice(registry, device)),
    },
    iosRemote: {
      // Both the ax-service and native-devtools blueprints route through
      // sim-remote for an ios-remote device, so only the preflight dep differs
      // from the ios branch.
      requires: ["sim-remote"],
      handler: async (_services, params, device) =>
        withDescription(
          withBootCaveatOncePerDevice(
            device.id,
            await describeIos(registry, device, params, { isTvOs: false })
          )
        ),
    },
    android: {
      requires: androidRequires,
      handler: async (_services, params, device) =>
        // Resolve the form factor once and thread the known `isTv: false`
        // through so describeAndroid doesn't re-probe.
        (await isAndroidTv(device.id))
          ? describeTv(registry, device)
          : withDescription(await describeAndroid(registry, params.udid, params.bundleId, false)),
    },
    chromium: {
      handler: async (services) => withDescription(await describeChromium(services.chromium)),
    },
    vega: {
      requires: vegaRequires,
      handler: async (_services, params) => withDescription(await describeVega(params.udid)),
    },
    harmony: {
      requires: harmonyRequires,
      handler: async (_services, _params, device) =>
        withDescription(await describeHarmony(harmonyConnectKey(device.id))),
    },
  });
}

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe(
      "Target device id from `list-devices` (iOS UDID, Android serial, Vega serial, <flag:harmonyos>HarmonyOS id, </flag:harmonyos>or Chromium id)."
    ),
  bundleId: z
    .string()
    .optional()
    .describe(
      "App bundle ID, used as a target hint on iOS when the AX-service returns no elements " +
        "and describe falls back to native-devtools inspection. " +
        "If omitted, the fallback auto-detects the frontmost connected app. Ignored on every other platform, " +
        "including a physical iOS device."
    ),
});

type Params = z.infer<typeof zodSchema>;

export function createDescribeTool(registry: Registry): ToolDefinition<Params, DescribeResult> {
  return {
    id: "describe",
    description: `Get the accessibility / DOM element tree for the current screen.
Use when you need element frames or labels and have no fresh tree: most interaction tools (not tv-remote or shake) already return one after each action.
On iOS it reads the AXRuntime accessibility service, so it sees whatever is visible, including system dialogs and permission prompts. While a system dialog is visible it returns the dialog's elements (buttons, text); otherwise the foreground app's. On a physical iOS device it covers only the app started with launch-app; to read system dialogs there, launch-app \`com.apple.springboard\` first.
On Android it reads the tree through Argent's UiAutomation helper, falling back to \`uiautomator dump\`. On Chromium it walks the DOM over the Chrome DevTools Protocol: every visible element with its ARIA role, accessible name and bounding rect.
On Vega (Fire TV) it reads the on-device automation toolkit; \`[focused]\`/\`[selected]\` mark the D-pad cursor, which you move with \`tv-remote\` (Vega has no touch).<flag:harmonyos>
On HarmonyOS it runs the device's \`uitest dumpLayout\` (\`source: "harmony-uitest"\`); each top-level child is a window whose \`identifier\` (not its label) is the owning bundle, so an app plus the status bar reads as two windows. A suspended display still dumps its last frame, so the result then carries a \`hint\`, as it does for an empty dump.</flag:harmonyos>
On a TV target (Apple TV / Android TV: a \`list-devices\` entry with runtimeKind 'tv') it returns the FOCUSED element and the FOCUSABLE elements instead, since a TV UI has no tap coordinates. Move the highlight with \`tv-remote\`, then call describe again to confirm where focus landed.

Returns \`{ description, source }\`: \`description\` renders the tree one line per element, with its role, label/value/id, interactivity flags and frame. Frames are normalized [0,1] fractions of the screen / window width and height (not pixels); tap an element at the centre of its frame. The tree has no z-order or occlusion information: an element may be covered by an overlay (e.g. a toolbar over list rows), so check a screenshot when a tap lands unexpectedly.
Fails if the tree cannot be read, e.g. on a locked Android screen, or on a physical iOS device before launch-app has started an app.

For app-scoped inspection with full UIKit properties (accessibilityIdentifier, viewClassName),
use native-describe-screen with an explicit bundleId instead (iOS simulator only).
For React Native component names, or a testID describe does not list, use debugger-component-tree.`,
    zodSchema,
    alwaysLoad: true,
    searchHint:
      "accessibility element tree ui hierarchy tap coordinates ios android chromium vega <flag:harmonyos>harmony harmonyos </flag:harmonyos>dom tv tvos apple tv android tv fire tv focus focusable remote dpad",
    readOnly: true,
    interaction: {
      startedMsg: () => "Reading screen",
      completedMsg: () => "Read screen",
      failedMsg: ({ failureSignal }) => `Failed to read screen: ${failureSignal.error_code}`,
    },
    capability,
    services: (params): Record<string, ServiceRef> => {
      const device = resolveDevice(params.udid);
      if (device.platform === "chromium") {
        return { chromium: chromiumCdpRef(device) };
      }
      return {};
    },
    execute: makeDescribeExecute(registry),
  };
}
