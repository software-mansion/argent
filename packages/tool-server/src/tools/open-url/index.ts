import { z } from "zod";
import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { forgettingUiOrientation } from "../../utils/ios-ui-orientation";
import { resolveDevice } from "../../utils/device-info";
import { chromiumCdpRef } from "../../blueprints/chromium-cdp";
import { macosAppRef } from "../../blueprints/macos-app";
import { BUNDLE_ID_MESSAGE, BUNDLE_ID_PATTERN } from "../../utils/bundle-id";
import type { OpenUrlResult, OpenUrlServices } from "./types";
import { iosImpl } from "./platforms/ios";
import { iosDeviceImpl } from "./platforms/ios-device";
import { androidImpl } from "./platforms/android";
import { harmonyImpl } from "./platforms/harmony";
import { iosRemoteImpl } from "./platforms/ios-remote";
import { chromiumImpl, type OpenUrlChromiumServices } from "./platforms/chromium";
import { macosImpl } from "./platforms/macos";

// Keep credentials, paths, query parameters, and fragments out of the event log.
function safeDestination(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.hostname
      : url.protocol.replace(/:$/, "");
  } catch {
    return "URL";
  }
}

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
  harmony: { device: true },
  macos: { app: true, catalyst: true },
};

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe(
      "Device id from `list-devices` (iOS UDID, Android serial, <flag:harmonyos>HarmonyOS id, </flag:harmonyos>or Chromium id)."
    ),
  url: z.string().describe("URL or custom scheme (e.g. https://example.com, myapp://path)."),
  bundleId: z
    .string()
    .regex(BUNDLE_ID_PATTERN, BUNDLE_ID_MESSAGE)
    .optional()
    .describe(
      "Physical iOS only: receiving app (defaults to Safari for http/https; required otherwise)."
    ),
});

type Params = z.infer<typeof zodSchema>;

export const openUrlTool: ToolDefinition<Params, OpenUrlResult> = {
  id: "open-url",
  // On iOS it first waits up to 15s for the simulator watcher's first poll, so a
  // slow openurl can pass the MCP fetch timeout, whose replay would open the URL twice.
  longRunning: true,
  description: `Open a URL or deep-link scheme on the device.
Use when navigating to a web page or deep-linking into an app (prefer custom schemes or \`launch-app\` over \`https://\` Universal/App Links). On Chromium, navigates the primary page (non-page schemes like \`tel:\`/\`mailto:\` fail). On physical iOS, the receiving app becomes active for automation.<flag:harmonyos> HarmonyOS opens URIs via \`aa start -U\`.</flag:harmonyos>
Returns \`{ opened, url, note? }\`. Fails if no handler is registered<flag:harmonyos> (iOS/Android/HarmonyOS)</flag:harmonyos> or Chromium rejects navigation.`,
  zodSchema,
  interaction: {
    startedMsg: ({ params }) => `Opening ${safeDestination(params.url)}`,
    completedMsg: ({ params }) => `Opened ${safeDestination(params.url)}`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to open ${safeDestination(params.url)}: ${failureSignal.error_code}`,
  },
  capability,
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.udid);
    if (device.platform === "chromium") {
      return { chromium: chromiumCdpRef(device) };
    }
    if (device.platform === "macos") return { macosApp: macosAppRef(device) };
    return {};
  },
  execute: dispatchByPlatform<
    OpenUrlServices,
    OpenUrlServices,
    Params,
    OpenUrlResult,
    OpenUrlChromiumServices,
    OpenUrlServices,
    OpenUrlServices,
    OpenUrlServices
  >({
    toolId: "open-url",
    capability,
    ios: forgettingUiOrientation(iosImpl),
    iosDevice: iosDeviceImpl,
    android: androidImpl,
    harmony: harmonyImpl,
    iosRemote: forgettingUiOrientation(iosRemoteImpl),
    chromium: chromiumImpl,
    macos: macosImpl,
  }),
};
