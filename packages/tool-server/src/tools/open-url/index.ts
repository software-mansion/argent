import { z } from "zod";
import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { resolveDevice } from "../../utils/device-info";
import { chromiumCdpRef } from "../../blueprints/chromium-cdp";
import type { OpenUrlResult, OpenUrlServices } from "./types";
import { iosImpl } from "./platforms/ios";
import { androidImpl } from "./platforms/android";
import { iosRemoteImpl } from "./platforms/ios-remote";
import { chromiumImpl, type OpenUrlChromiumServices } from "./platforms/chromium";

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Target device id from `list-devices` (iOS UDID, Android serial, or Chromium id)."),
  url: z
    .string()
    .describe(
      "URL or scheme to open (e.g. https://example.com, messages://, tel:555, geo:37.0,-122.0). For Chromium this navigates the renderer."
    ),
});

type Params = z.infer<typeof zodSchema>;

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
};

export const openUrlTool: ToolDefinition<Params, OpenUrlResult> = {
  id: "open-url",
  description: `Open a URL or URL scheme on the device.
Use to navigate to a web page or deep-link into an app. On Chromium, this navigates the primary renderer to the given URL.
Cross-platform schemes: https://, tel:, mailto:. iOS also: messages://, settings://, maps://. Android also: geo:, plus any app-specific deep link.
Deep-linking caveat: an https:// link opens the native app only when an installed app is verified for the link's domain (iOS Universal Links / Android App Links) — otherwise it opens in the browser, and on iOS simulators it may open in Safari even when the owning app is installed. To reliably open an installed app, use its custom scheme (scheme://path) or launch-app with its bundle id.
Returns { opened, url, note? }. note carries the deep-linking caveat when a web URL was opened on a native device. Fails if no app is registered to handle the URI (iOS/Android) or the renderer rejects the navigation (Chromium).`,
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
    OpenUrlChromiumServices
  >({
    toolId: "open-url",
    capability,
    ios: iosImpl,
    android: androidImpl,
    iosRemote: iosRemoteImpl,
    chromium: chromiumImpl,
  }),
};
