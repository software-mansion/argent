import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import { classifyDevice } from "../../utils/platform-detect";
import { adbShell } from "../../utils/adb";

const execFileAsync = promisify(execFile);

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

export const openUrlTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { opened: boolean; url: string }
> = {
  id: "open-url",
  description: `Open a URL or URL scheme on the device.
Use to navigate to a web page or deep-link into an app.
Cross-platform schemes: https://, tel:, mailto:. iOS also: messages://, settings://, maps://. Android also: geo:, plus any app-specific deep link.
Returns { opened, url }. Fails if no app is registered to handle the URI.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    if ((await classifyDevice(params.udid)) === "android") {
      const quoted = `'${params.url.replace(/'/g, "'\\''")}'`;
      const out = await adbShell(
        params.udid,
        `am start -a android.intent.action.VIEW -d ${quoted}`,
        { timeoutMs: 15_000 }
      );
      if (/Error:|No Activity found/i.test(out)) {
        throw new Error(`open-url failed: ${out.trim()}`);
      }
      return { opened: true, url: params.url };
    }
    await execFileAsync("xcrun", ["simctl", "openurl", params.udid, params.url]);
    return { opened: true, url: params.url };
  },
};
