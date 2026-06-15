import { z } from "zod";
import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { resolveDevice } from "../../utils/device-info";
import type { TabInfo } from "../../chromium-server";

const zodSchema = z.object({
  udid: z.string().describe("Chromium device id from `list-devices` (e.g. `chromium-cdp-9222`)."),
  action: z
    .enum(["list", "select", "new", "close"])
    .describe(
      "list: enumerate tabs/windows. select: make a tab active (every other tool then acts on it). new: open a tab. close: close a tab."
    ),
  tab: z
    .string()
    .optional()
    .describe(
      "Target tab for `select` / `close`: a tabId like `t2` or a label. `close` defaults to the active tab."
    ),
  url: z.string().optional().describe("`new` only: URL to open (defaults to about:blank)."),
  label: z
    .string()
    .optional()
    .describe("`new` only: a memorable label usable interchangeably with the tabId."),
});

type Params = z.infer<typeof zodSchema>;

interface Result {
  /** Tabs after the action, with `active` marking the one other tools drive. */
  tabs: TabInfo[];
}

// Chromium-only: iOS/Android have no tab/window concept, so the capability gate
// rejects them up-front (no apple/android blocks declared).
const capability: ToolCapability = {
  chromium: { app: true },
};

export const chromiumTabsTool: ToolDefinition<Params, Result> = {
  id: "chromium-tabs",
  description: `Manage tabs / windows of a Chromium (CDP) app — an Electron app's BrowserWindows or a Chromium browser's tabs.
- action="list": enumerate page targets with stable ids (\`t1\`, \`t2\`, …), title, url, and which is active.
- action="select" (tab=<tabId|label>): make that tab the active one. The active tab is what describe / gesture-tap / screenshot / debugger-evaluate / open-url all operate on, so switch before driving a different tab.
- action="new" (url?, label?): open a new tab/page and activate it.
- action="close" (tab?=<tabId|label>): close a tab (defaults to the active one); if the active tab is closed, another live tab becomes active.
tabIds are stable for the session and never reused. Returns { tabs: [{ tabId, targetId, title, url, active, label? }] }. Chromium-only.`,
  searchHint: "tab tabs window windows switch select close new open multi-tab chromium electron",
  zodSchema,
  capability,
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.udid);
    if (device.platform === "chromium") {
      return { chromium: chromiumCdpRef(device) };
    }
    // Non-chromium devices are rejected by the capability gate before execute.
    return {};
  },
  async execute(services, params) {
    const api = services.chromium as ChromiumCdpApi;
    const { tabs } = api.server;
    switch (params.action) {
      case "list":
        return { tabs: await tabs.list() };
      case "select":
        if (!params.tab) {
          throw new Error("`select` requires `tab` (a tabId like `t2` or a label).");
        }
        return { tabs: await tabs.select(params.tab) };
      case "new":
        return { tabs: await tabs.open({ url: params.url, label: params.label }) };
      case "close":
        return { tabs: await tabs.close(params.tab) };
    }
  },
};
