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
  description: `Open a URL or URL scheme on the simulator, launching the appropriate app.
Use when navigating to a web page in Safari, deep-linking into an app via its URL scheme, or opening system apps without knowing their bundle ID.

Parameters: udid — simulator UDID (e.g. A1B2C3D4-E5F6-7890-ABCD-EF1234567890); url — the URL or scheme to open.
Example: { "udid": "A1B2C3D4-E5F6-7890-ABCD-EF1234567890", "url": "https://example.com" }
Common schemes: messages://, settings://, maps://?q=coffee, tel://555-1234.
Returns { opened: true, url }. Fails if the URL scheme is not registered on the simulator or the simulator is not booted.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    await execFileAsync("xcrun", ["simctl", "openurl", params.udid, params.url]);
    return { opened: true, url: params.url };
  },
};
