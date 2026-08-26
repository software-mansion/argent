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
import { describeChromium } from "./platforms/chromium";
import { describeTv } from "./platforms/tv";
import { describeVega, vegaRequires } from "./platforms/vega";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { resolveDevice } from "../../utils/device-info";
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
  if (data.unreadable) {
    // Say it in the text too: the description is the one field every caller
    // reads, and an unlabelled empty tree reads as a blank screen.
    out.unreadable = data.unreadable;
    out.description = `SCREEN NOT READ (${data.unreadable.stage}: ${data.unreadable.message})\n${out.description}`;
  }
  return out;
}

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe(
      "Target device id from `list-devices` (iOS UDID, Android serial, Vega serial, or Chromium id)."
    ),
  bundleId: z
    .string()
    .optional()
    .describe(
      "Optional app bundle ID. Used as a target hint on iOS when the AX-service returns no elements " +
        "and the describe tool falls back to native-devtools inspection. " +
        "If omitted, the fallback auto-detects the frontmost connected app. Ignored on Android / Chromium."
    ),
  timeoutMs: z
    .number()
    .int()
    .min(250)
    .max(60_000)
    .optional()
    .describe(
      "iOS only. Budget for the accessibility read in milliseconds (default 10000, plus a 5s native-devtools " +
        "fallback when it comes back empty). When the budget elapses the result carries `unreadable`, the " +
        "description starts with `SCREEN NOT READ`, and the native fallback is skipped. Use a short budget " +
        "when a fast answer matters more than a complete one."
    ),
});

type Params = z.infer<typeof zodSchema>;

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
  vega: { vvd: true },
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
                await describeIos(registry, device, params, {
                  isTvOs: false,
                  axTimeoutMs: params.timeoutMs,
                  fallbackOnUnreadable: params.timeoutMs === undefined,
                })
              )
            ),
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
            await describeIos(registry, device, params, {
              isTvOs: false,
              axTimeoutMs: params.timeoutMs,
              fallbackOnUnreadable: params.timeoutMs === undefined,
            })
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
  });
}

export function createDescribeTool(registry: Registry): ToolDefinition<Params, DescribeResult> {
  return {
    id: "describe",
    interaction: {
      startedMsg: () => "Reading screen",
      completedMsg: () => "Read screen",
      failedMsg: ({ failureSignal }) => `Failed to read screen: ${failureSignal.error_code}`,
    },
    description: `Get the accessibility / DOM element tree for the current screen.
On iOS, uses the AXRuntime accessibility service to inspect whatever is currently visible — including
system dialogs, permission prompts, and any foreground app content. On Android, runs \`uiautomator dump\`.
On Chromium, walks the renderer's DOM via Chrome DevTools Protocol — every visible element with its ARIA
role, accessible name, and bounding rect (normalized to 0–1).
On Vega (Fire TV), reads the on-device automation toolkit (\`getPageSource\`); each element carries
\`[focused]\`/\`[selected]\` so you can see where the D-pad cursor is, then move it with the \`tv-remote\` tool
(Vega is remote-driven, not touch). If describe returns an empty tree on Vega, relaunch the foreground
app (the toolkit attaches at launch) and try again.

When a system dialog is visible, describe returns the dialog's interactive elements (buttons, text)
with tap coordinates. When no dialog is present, it returns the foreground app's accessible elements.

Returns \`{ description, source, unreadable? }\` where \`description\` is a text rendering of the UI tree — one
line per element with its role, label/value/id, interactivity flags, and frame. Frame coordinates
are normalized [0,1] fractions of the screen / window width/height (not pixels) — the same space as
gesture-tap / gesture-swipe / gesture-pinch.

To tap an element use the centre of its frame: \`tap_x = frame.x + frame.width / 2\`,
\`tap_y = frame.y + frame.height / 2\`. The same formula appears in the response header so it
can be applied to a line in isolation.

When the read does not complete (the app is busy and does not answer the accessibility query within the
budget) the result carries \`unreadable: { stage, error_code, message }\` and the description starts with
\`SCREEN NOT READ\`. That is not a blank screen: wait for the app to settle and call describe again.

For app-scoped inspection with full UIKit properties (accessibilityIdentifier, viewClassName),
use native-describe-screen with an explicit bundleId instead (iOS only).
For React Native apps, debugger-component-tree returns React component names with tap coordinates.

On a TV target (Apple TV / Android TV — a \`list-devices\` entry with runtimeKind 'tv') this returns
the focus-driven view instead: the currently FOCUSED element and the list of FOCUSABLE elements,
since a TV UI has no tap coordinates. Move the highlight with \`tv-remote\` (up/down/left/right/select/
back/menu/home), then call describe again to confirm where focus landed.`,
    alwaysLoad: true,
    searchHint:
      "accessibility element tree ui hierarchy tap coordinates ios android chromium vega dom tv tvos apple tv android tv fire tv focus focusable remote dpad",
    zodSchema,
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
