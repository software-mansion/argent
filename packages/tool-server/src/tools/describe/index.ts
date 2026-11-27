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
import { describeMacos } from "./platforms/macos";
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
  macos: { app: true, catalyst: true },
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
    // The in-app library's connection resolves through the closed-over
    // registry, after the macos-apps flag check, as the iOS services do.
    macos: {
      handler: async (_services, _params, device) =>
        withDescription(await describeMacos(registry, device)),
    },
  });
}

const zodSchema = z.object({
  udid: z.string().min(1).describe("Target device id from `list-devices`."),
  bundleId: z
    .string()
    .optional()
    .describe(
      "iOS simulator only: fallback bundle id when AX-service returns empty (auto-detects frontmost if omitted)."
    ),
});

type Params = z.infer<typeof zodSchema>;

export function createDescribeTool(registry: Registry): ToolDefinition<Params, DescribeResult> {
  return {
    id: "describe",
    // Android's device probes plus the tree dump can outlast the 30s MCP fetch timeout.
    longRunning: true,
    description: `Read the accessibility / DOM element tree for the current screen (or focused/focusable elements on TV targets).
Use when you need tap coordinates or labels and have no fresh tree: interaction tools already attach one after each action (or reference an earlier \`Tree id\`).
Returns \`{ description, source, hint? }\`: one line per element with role, label/value/id/hint, flags, and normalized \`[0,1]\` frame \`(x,y,w,h)\` — tap at \`(x+w/2, y+h/2)\`. No z-order/occlusion info; check a screenshot if a tap hits an overlay or a text field shows its placeholder as value. Fails if the tree backend is unreachable.
For UIKit view properties (iOS sim) use \`native-find-views\`; for React Native components/testIDs use \`debugger-component-tree\`.`,
    zodSchema,
    alwaysLoad: true,
    searchHint:
      "accessibility element tree ui hierarchy tap coordinates ios android chromium vega <flag:harmonyos>harmony harmonyos </flag:harmonyos><flag:macos-apps>macos mac app </flag:macos-apps>dom tv tvos apple tv android tv fire tv focus focusable remote dpad",
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
