import { z } from "zod";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { resolveDevice } from "../../utils/device-info";
import {
  clearStorage,
  getStorageAll,
  getStorageItem,
  removeStorageItem,
  setStorageItem,
} from "../../chromium-server/storage";

const zodSchema = z.object({
  udid: z.string().describe("Chromium device id from `list-devices` (e.g. `chromium-cdp-9222`)."),
  store: z.enum(["local", "session"]).describe("`local`: localStorage. `session`: sessionStorage."),
  action: z
    .enum(["get", "set", "remove", "clear"])
    .describe(
      "get: read one key (with `key`) or all entries. set: write `key`=`value`. remove: delete `key`. clear: empty the store."
    ),
  key: z.string().optional().describe("The storage key."),
  value: z.string().optional().describe("The value to store."),
});

type Params = z.infer<typeof zodSchema>;

const storageAction = {
  get: { started: "Reading", completed: "Read", failure: "read" },
  set: { started: "Updating", completed: "Updated", failure: "update" },
  remove: { started: "Removing from", completed: "Removed from", failure: "remove from" },
  clear: { started: "Clearing", completed: "Cleared", failure: "clear" },
} as const;

type Result =
  | { value: string | null }
  | { entries: Record<string, string>; count: number }
  | { set: true }
  | { removed: true }
  | { cleared: true };

const capability: ToolCapability = {
  chromium: { app: true },
};

export const chromiumStorageTool: ToolDefinition<Params, Result> = {
  id: "chromium-storage",
  interaction: {
    startedMsg: ({ params }) => `${storageAction[params.action].started} ${params.store} storage`,
    completedMsg: ({ params }) =>
      `${storageAction[params.action].completed} ${params.store} storage`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to ${storageAction[params.action].failure} ${params.store} storage: ${failureSignal.error_code}`,
  },
  description: `Read and write localStorage / sessionStorage of a Chromium (CDP) app, for the origin of the active tab's page.
Use when seeding feature flags / auth tokens before an e2e test or asserting persisted app state after one.
Returns { value } for one key, { entries, count } for all keys, and { set } / { removed } / { cleared } for the writes. Fails if the device is not a Chromium (CDP) device, or the action is missing the \`key\` / \`value\` it needs.`,
  searchHint:
    "storage localstorage sessionstorage local session get set remove clear key value chromium",
  zodSchema,
  capability,
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.udid);
    if (device.platform === "chromium") {
      return { chromium: chromiumCdpRef(device) };
    }
    return {};
  },
  async execute(services, params): Promise<Result> {
    const api = services.chromium as ChromiumCdpApi;
    const cdp = api.cdp;
    switch (params.action) {
      case "get": {
        if (params.key != null) {
          return { value: await getStorageItem(cdp, params.store, params.key) };
        }
        const entries = await getStorageAll(cdp, params.store);
        return { entries, count: Object.keys(entries).length };
      }
      case "set": {
        if (params.key == null || params.value == null) {
          throw new FailureError("`set` requires `key` and `value`.", {
            error_code: FAILURE_CODES.CHROMIUM_PARAM_INVALID,
            failure_stage: "chromium_storage_set_params",
            failure_area: "tool_server",
            error_kind: "validation",
          });
        }
        await setStorageItem(cdp, params.store, params.key, params.value);
        return { set: true };
      }
      case "remove": {
        if (params.key == null)
          throw new FailureError("`remove` requires `key`.", {
            error_code: FAILURE_CODES.CHROMIUM_PARAM_INVALID,
            failure_stage: "chromium_storage_remove_params",
            failure_area: "tool_server",
            error_kind: "validation",
          });
        await removeStorageItem(cdp, params.store, params.key);
        return { removed: true };
      }
      case "clear":
        await clearStorage(cdp, params.store);
        return { cleared: true };
    }
  },
};
