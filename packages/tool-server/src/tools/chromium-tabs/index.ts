import { z } from "zod";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { resolveDevice } from "../../utils/device-info";
import type { TabInfo } from "../../chromium-server";

interface Result {
  /** Tabs after the action. */
  tabs: TabInfo[];
}

const tabAction = {
  list: {
    started: () => "Listing tabs",
    completed: (_params: Params, result: Result) =>
      `Listed ${result.tabs.length} ${result.tabs.length === 1 ? "tab" : "tabs"}`,
    failure: "list",
  },
  select: {
    started: (params: Params) => `Selecting tab ${params.tab}`,
    completed: (params: Params) => `Selected tab ${params.tab}`,
    failure: "select",
  },
  new: {
    started: () => "Opening a new tab",
    completed: () => "Opened a new tab",
    failure: "open",
  },
  close: {
    started: (params: Params) => `Closing ${params.tab ? `tab ${params.tab}` : "active tab"}`,
    completed: (params: Params) => `Closed ${params.tab ? `tab ${params.tab}` : "active tab"}`,
    failure: "close",
  },
} satisfies Record<
  Params["action"],
  {
    started: (params: Params) => string;
    completed: (params: Params, result: Result) => string;
    failure: string;
  }
>;

// No apple/android blocks: those platforms have no tab/window concept.
const capability: ToolCapability = {
  chromium: { app: true },
};

const zodSchema = z.object({
  udid: z.string().describe("Chromium device id from `list-devices` (e.g. `chromium-cdp-9222`)."),
  action: z
    .enum(["list", "select", "new", "close"])
    .describe(
      "list: enumerate tabs/windows. select: make a tab active. new: open a tab and activate it. close: close a tab; if it was active, another live tab becomes active."
    ),
  tab: z
    .string()
    .optional()
    .describe(
      "Target tab for `select` (required) / `close`: a tabId like `t2` or a label. `close` defaults to the active tab."
    ),
  url: z.string().optional().describe("`new` only: URL to open (defaults to about:blank)."),
  label: z
    .string()
    .optional()
    .describe("`new` only: a memorable label usable interchangeably with the tabId."),
});

type Params = z.infer<typeof zodSchema>;

export const chromiumTabsTool: ToolDefinition<Params, Result> = {
  id: "chromium-tabs",
  description: `List and switch the tabs / windows of a Chromium (CDP) app (an Electron app's BrowserWindows or a Chromium browser's tabs), and open or close them.
The active tab is what describe / gesture-tap / screenshot / debugger-evaluate / open-url all operate on, so select a tab before driving it. tabIds (\`t1\`, \`t2\`, …) are stable for the session and never reused.
Use when an app exposes multiple windows or tabs and you need to inspect or drive one other than the current page, or to open/close a page during an e2e test.
Returns { tabs: [{ tabId, targetId, title, url, active, label? }] } after the action. Fails if the device is not a Chromium (CDP) device, or the requested tabId/label no longer matches a live tab.`,
  zodSchema,
  searchHint: "tab tabs window windows switch select close new open multi-tab chromium electron",
  interaction: {
    startedMsg: ({ params }) => tabAction[params.action].started(params),
    completedMsg: ({ params, result }) => tabAction[params.action].completed(params, result),
    failedMsg: ({ params, failureSignal }) =>
      `Failed to ${tabAction[params.action].failure} browser tabs: ${failureSignal.error_code}`,
  },
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
          throw new FailureError("`select` requires `tab` (a tabId like `t2` or a label).", {
            error_code: FAILURE_CODES.CHROMIUM_PARAM_INVALID,
            failure_stage: "chromium_tabs_select_params",
            failure_area: "tool_server",
            error_kind: "validation",
          });
        }
        return { tabs: await tabs.select(params.tab) };
      case "new":
        return { tabs: await tabs.open({ url: params.url, label: params.label }) };
      case "close":
        return { tabs: await tabs.close(params.tab) };
    }
  },
};
