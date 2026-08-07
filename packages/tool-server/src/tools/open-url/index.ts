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

// RFC 3986 scheme grammar: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) ":".
// Requiring it rejects the schemeless input every backend would have failed on
// anyway, and — like launch-app's BUNDLE_ID_PATTERN — stops a value beginning
// with `-` from reaching a subprocess as a flag. That is not hypothetical: the
// physical-iOS path passes the url as the last argv element of `xcrun devicectl
// device process openURL`, and `--help` there exits 0 without opening anything,
// so the tool would report `opened: true` for a URL it never opened.
const URL_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Target device id from `list-devices` (iOS UDID, Android serial, or Chromium id)."),
  url: z
    .string()
    .regex(URL_SCHEME_PATTERN, "url must start with a scheme, e.g. https:, tel:, myapp:")
    .describe(
      "URL or scheme to open (e.g. https://example.com, messages://, tel:555, geo:37.0,-122.0). Must include a scheme. For Chromium this navigates the renderer."
    ),
});

type Params = z.infer<typeof zodSchema>;

// Keep credentials, paths, query parameters, and fragments out of the event log.
// Web URLs are reduced to their hostname; custom URLs are reduced to their scheme.
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
