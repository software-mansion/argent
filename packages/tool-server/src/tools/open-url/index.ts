import { z } from "zod";
import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { resolveDevice } from "../../utils/device-info";
import { chromiumCdpRef } from "../../blueprints/chromium-cdp";
import { BUNDLE_ID_MESSAGE, BUNDLE_ID_PATTERN } from "../../utils/bundle-id";
import type { OpenUrlResult, OpenUrlServices } from "./types";
import { iosImpl } from "./platforms/ios";
import { iosDeviceImpl } from "./platforms/ios-device";
import { androidImpl } from "./platforms/android";
import { harmonyImpl } from "./platforms/harmony";
import { iosRemoteImpl } from "./platforms/ios-remote";
import { chromiumImpl, type OpenUrlChromiumServices } from "./platforms/chromium";

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe(
      "Target device id from `list-devices` (iOS UDID, Android serial, <flag:harmonyos>HarmonyOS id, </flag:harmonyos>or Chromium id)."
    ),
  url: z
    .string()
    .describe(
      "URL or scheme to open (e.g. https://example.com, messages://, tel:555, geo:37.0,-122.0)."
    ),
  bundleId: z
    .string()
    .regex(BUNDLE_ID_PATTERN, BUNDLE_ID_MESSAGE)
    .optional()
    .describe(
      "Physical iOS only: the app that receives the URL. Defaults to Safari for http(s); required for any other scheme."
    ),
});

type Params = z.infer<typeof zodSchema>;

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
};

export const openUrlTool: ToolDefinition<Params, OpenUrlResult> = {
  id: "open-url",
  interaction: {
    startedMsg: ({ params }) => `Opening ${safeDestination(params.url)}`,
    completedMsg: ({ params }) => `Opened ${safeDestination(params.url)}`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to open ${safeDestination(params.url)}: ${failureSignal.error_code}`,
  },
  description: `Open a URL or URL scheme on the device.
Use when navigating to a web page or deep-linking into an app. On Chromium, this navigates the primary renderer to the given URL.
Cross-platform schemes: https://, tel:, mailto:. iOS also: messages://, settings://, maps://. Android also: geo:, plus any app-specific deep link.<flag:harmonyos> HarmonyOS resolves any scheme through \`aa start -U\`.</flag:harmonyos>
An https:// link opens the native app only if that app is verified for the link's domain (Universal Links / App Links); even then, an iOS simulator may open Safari. To reliably open an installed app, use its custom scheme (scheme://path) or launch-app.
On a physical iPhone, the app that receives the URL becomes the app under automation.
Returns { opened, url, note? }. \`note\` explains the routing caveat when a web URL was opened on a native device<flag:harmonyos>; on HarmonyOS every result carries one, since success only means the system accepted the URI</flag:harmonyos>. Fails if no app is registered to handle the URI (iOS/Android<flag:harmonyos>/HarmonyOS</flag:harmonyos>) or the renderer rejects the navigation (Chromium).`,
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
    ios: iosImpl,
    iosDevice: iosDeviceImpl,
    android: androidImpl,
    harmony: harmonyImpl,
    iosRemote: iosRemoteImpl,
    chromium: chromiumImpl,
  }),
};
