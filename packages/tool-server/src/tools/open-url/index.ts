import { z } from "zod";
import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { iosImpl, type OpenUrlResult, type OpenUrlServices } from "./platforms/ios";
import { androidImpl } from "./platforms/android";

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
  url: z
    .string()
    .describe(
      "URL or scheme to open (e.g. https://example.com, messages://, tel:555, geo:37.0,-122.0)."
    ),
});

type Params = z.infer<typeof zodSchema>;

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
};

export const openUrlTool: ToolDefinition<Params, OpenUrlResult> = {
  id: "open-url",
  description: `Open a URL or URL scheme on the device.
Use to navigate to a web page or deep-link into an app.
Cross-platform schemes: https://, tel:, mailto:. iOS also: messages://, settings://, maps://. Android also: geo:, plus any app-specific deep link.
Returns { opened, url }. Fails if no app is registered to handle the URI.`,
  zodSchema,
  capability,
  services: () => ({}),
  execute: dispatchByPlatform<OpenUrlServices, Params, OpenUrlResult>({
    toolId: "open-url",
    capability,
    ios: iosImpl,
    android: androidImpl,
  }),
};
