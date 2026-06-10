import { z } from "zod";
import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { resolveDevice } from "../../utils/device-info";
import { UnsupportedOperationError } from "../../utils/capability";
import { vegaDevice } from "../../utils/vega-cli";

const zodSchema = z.object({
  udid: z.string().describe("Target Vega device id from `list-devices`."),
});

type Params = z.infer<typeof zodSchema>;

interface Result {
  apps: string[];
  count: number;
}

const capability: ToolCapability = {
  vega: { virtual: true, device: true },
};

/**
 * Parse `vega device installed-apps` — one app id per line. The CLI may prepend
 * a human banner line; keep only lines that look like reverse-DNS app ids.
 */
function parseInstalledApps(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[A-Za-z0-9_]+(\.[A-Za-z0-9_-]+)+$/.test(l));
}

export const listInstalledAppsTool: ToolDefinition<Params, Result> = {
  id: "list-installed-apps",
  description: `List the app ids installed on a Vega (Fire TV) device.
Use to discover what's installed before launching, or to confirm an install/uninstall. Returns { apps, count } where apps is the list of component app ids (e.g. com.example.app.main).`,
  searchHint: "vega fire tv installed apps packages list inventory app id",
  zodSchema,
  capability,
  services: () => ({}),
  async execute(_services, params) {
    const device = resolveDevice(params.udid);
    if (device.platform !== "vega") {
      throw new UnsupportedOperationError("list-installed-apps", device, "Vega-only");
    }
    const { stdout } = await vegaDevice(params.udid, ["installed-apps"], { timeoutMs: 30_000 });
    const apps = parseInstalledApps(stdout);
    return { apps, count: apps.length };
  },
};
