import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";

const execFileAsync = promisify(execFile);

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  url: z.string().describe("URL or URL scheme to open (e.g. https://example.com or messages://)"),
});

export const openUrlTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { opened: boolean; url: string }
> = {
  id: "open-url",
  description: `Open a URL or URL scheme on the simulator.
Use when you need to navigate to a web page or launch an app via its scheme, e.g. "https://example.com" or "settings://".
Accepts: udid, url (such as "maps://?q=Paris"). Returns the opened url.
Fails if the udid is invalid or the URL scheme is not registered on the simulator.

Common URL schemes:
- messages://              — Messages app
- settings://              — Settings app
- maps://?q=<query>        — Maps with a search query
- tel://<number>           — Phone app
- mailto:<address>         — Mail app
- https://...              — Opens in Safari`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    await execFileAsync("xcrun", ["simctl", "openurl", params.udid, params.url]);
    return { opened: true, url: params.url };
  },
};
