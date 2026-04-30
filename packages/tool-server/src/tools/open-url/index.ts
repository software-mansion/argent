import { z } from "zod";
import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { iosImpl, type OpenUrlResult, type OpenUrlServices } from "./platforms/ios";
import { androidImpl } from "./platforms/android";

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  url: z.string().describe("URL or URL scheme to open (e.g. https://example.com or messages://)"),
});

type Params = z.infer<typeof zodSchema>;

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
};

export const openUrlTool: ToolDefinition<Params, OpenUrlResult> = {
  id: "open-url",
  description: `Open a URL or URL scheme on the simulator.
Use when you need to navigate to a web page or deep-link into an app. Returns { opened, url }. Fails if the URL scheme is not registered on the simulator.

Common URL schemes:
- messages://              — Messages app
- settings://              — Settings app
- maps://?q=<query>        — Maps with a search query
- tel://<number>           — Phone app
- mailto:<address>         — Mail app
- https://...              — Opens in Safari`,
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
