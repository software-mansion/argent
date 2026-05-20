import { z } from "zod";
import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { resolveDevice } from "../../utils/device-info";
import { electronCdpRef } from "../../blueprints/electron-cdp";
import type { OpenUrlResult, OpenUrlServices } from "./types";
import { iosImpl } from "./platforms/ios";
import { androidImpl } from "./platforms/android";
import { electronImpl, type OpenUrlElectronServices } from "./platforms/electron";

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Target device id from `list-devices` (iOS UDID, Android serial, or Electron id)."),
  url: z
    .string()
    .describe(
      "URL or scheme to open (e.g. https://example.com, messages://, tel:555, geo:37.0,-122.0). For Electron this navigates the renderer."
    ),
});

type Params = z.infer<typeof zodSchema>;

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
  electron: { app: true },
};

export const openUrlTool: ToolDefinition<Params, OpenUrlResult> = {
  id: "open-url",
  description: `Open a URL or URL scheme on the device.
Use to navigate to a web page or deep-link into an app. On Electron, this navigates the primary renderer to the given URL.
Cross-platform schemes: https://, tel:, mailto:. iOS also: messages://, settings://, maps://. Android also: geo:, plus any app-specific deep link.
Returns { opened, url }. Fails if no app is registered to handle the URI (iOS/Android) or the renderer rejects the navigation (Electron).`,
  zodSchema,
  capability,
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.udid);
    if (device.platform === "electron") {
      return { electron: electronCdpRef(device) };
    }
    return {};
  },
  execute: dispatchByPlatform<
    OpenUrlServices,
    OpenUrlServices,
    Params,
    OpenUrlResult,
    OpenUrlElectronServices
  >({
    toolId: "open-url",
    capability,
    ios: iosImpl,
    android: androidImpl,
    electron: electronImpl,
  }),
};
