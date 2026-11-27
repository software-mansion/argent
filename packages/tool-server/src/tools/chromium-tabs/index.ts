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
  udid: z.string().describe("Chromium device id (`chromium-cdp-<port>`)."),
  action: z.enum(["list", "select", "new", "close"]).describe("Tab operation."),
  tab: z
    .string()
    .optional()
    .describe("Tab id (e.g. `t2`) or label (`select` required; `close` defaults to active)."),
  url: z.string().optional().describe("URL for `new` (default `about:blank`)."),
  label: z.string().optional().describe("Optional alias label for `new`."),
});

type Params = z.infer<typeof zodSchema>;

export const chromiumTabsTool: ToolDefinition<Params, Result> = {
  id: "chromium-tabs",
  description: `List, select, open, or close tabs/windows in a Chromium (CDP) or Electron app (all UI tools target the active tab).
Use when switching between multiple tabs/windows or opening/closing pages.
Returns \`{ tabs: [{ tabId, targetId, title, url, active, label? }] }\`. Fails on non-Chromium targets or unknown tab ids.`,
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
