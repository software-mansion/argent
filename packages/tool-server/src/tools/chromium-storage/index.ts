import { z } from "zod";
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
  store: z
    .enum(["local", "session"])
    .describe("Which Web Storage area: `local` (localStorage) or `session` (sessionStorage)."),
  action: z
    .enum(["get", "set", "remove", "clear"])
    .describe(
      "get: read one key (with `key`) or all entries. set: write `key`=`value`. remove: delete `key`. clear: empty the store."
    ),
  key: z.string().optional().describe("get (optional) / set / remove: the storage key."),
  value: z.string().optional().describe("set: the value to store."),
});

type Params = z.infer<typeof zodSchema>;

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
  description: `Read and write localStorage / sessionStorage of a Chromium (CDP) app's active page.
- action="get": with \`key\`, returns that value; without \`key\`, returns all entries.
- action="set" (key, value): write an entry.
- action="remove" (key): delete an entry.
- action="clear": empty the store.
Set \`store\` to "local" or "session". Storage is per-origin, so it reflects the active tab's document. Chromium-only.`,
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
          throw new Error("`set` requires `key` and `value`.");
        }
        await setStorageItem(cdp, params.store, params.key, params.value);
        return { set: true };
      }
      case "remove": {
        if (params.key == null) throw new Error("`remove` requires `key`.");
        await removeStorageItem(cdp, params.store, params.key);
        return { removed: true };
      }
      case "clear":
        await clearStorage(cdp, params.store);
        return { cleared: true };
    }
  },
};
