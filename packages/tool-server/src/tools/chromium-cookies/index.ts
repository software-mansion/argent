import { z } from "zod";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { resolveDevice } from "../../utils/device-info";
import {
  clearCookies,
  deleteCookies,
  getCookies,
  setCookie,
  type Cookie,
} from "../../chromium-server/storage";

const cookieAction = {
  get: { started: "Reading", completed: "Read", failure: "read" },
  set: { started: "Setting", completed: "Set", failure: "set" },
  delete: { started: "Deleting", completed: "Deleted", failure: "delete" },
  clear: { started: "Clearing", completed: "Cleared", failure: "clear" },
} as const;

type Result =
  { cookies: Cookie[]; count: number } | { set: boolean } | { deleted: true } | { cleared: true };

const capability: ToolCapability = {
  chromium: { app: true },
};

const zodSchema = z.object({
  udid: z.string().describe("Chromium device id (`chromium-cdp-<port>`)."),
  action: z.enum(["get", "set", "delete", "clear"]).describe("Cookie operation."),
  name: z.string().optional().describe("Cookie name (required for `set`/`delete`)."),
  value: z.string().optional().describe("Cookie value (required for `set`)."),
  url: z.string().optional().describe("URL filter (`get`) or scope (`set`/`delete`)."),
  domain: z.string().optional().describe("Domain scope (`set`/`delete`)."),
  path: z.string().optional().describe("Path scope (default `/`)."),
  secure: z.boolean().optional().describe("Secure flag (`set`)."),
  httpOnly: z.boolean().optional().describe("HttpOnly flag (`set`)."),
  sameSite: z.enum(["Strict", "Lax", "None"]).optional().describe("SameSite policy (`set`)."),
  expires: z.number().optional().describe("Unix expiry in seconds (`set`; omit for session)."),
});

type Params = z.infer<typeof zodSchema>;

export const chromiumCookiesTool: ToolDefinition<Params, Result> = {
  id: "chromium-cookies",
  description: `Read, set, delete, or clear cookies (including HttpOnly) in a Chromium (CDP) app.
Use when seeding an auth session or asserting cookie state (\`set\`/\`delete\` need \`url\` or \`domain\`).
Returns \`{ cookies, count }\` (\`get\`) or \`{ set }\` / \`{ deleted }\` / \`{ cleared }\`. Fails on non-Chromium targets or missing required params.`,
  zodSchema,
  searchHint: "cookies cookie get set delete clear httponly samesite session auth chromium",
  interaction: {
    startedMsg: ({ params }) => `${cookieAction[params.action].started} browser cookies`,
    completedMsg: ({ params }) => `${cookieAction[params.action].completed} browser cookies`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to ${cookieAction[params.action].failure} browser cookies: ${failureSignal.error_code}`,
  },
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
        const cookies = await getCookies(cdp, params.url ? [params.url] : undefined);
        return { cookies, count: cookies.length };
      }
      case "set": {
        if (!params.name || params.value == null) {
          throw new FailureError("`set` requires `name` and `value`.", {
            error_code: FAILURE_CODES.CHROMIUM_PARAM_INVALID,
            failure_stage: "chromium_cookie_set_params",
            failure_area: "tool_server",
            error_kind: "validation",
          });
        }
        const set = await setCookie(cdp, {
          name: params.name,
          value: params.value,
          url: params.url,
          domain: params.domain,
          path: params.path,
          secure: params.secure,
          httpOnly: params.httpOnly,
          sameSite: params.sameSite,
          expires: params.expires,
        });
        return { set };
      }
      case "delete": {
        if (!params.name)
          throw new FailureError("`delete` requires `name`.", {
            error_code: FAILURE_CODES.CHROMIUM_PARAM_INVALID,
            failure_stage: "chromium_cookie_delete_params",
            failure_area: "tool_server",
            error_kind: "validation",
          });
        await deleteCookies(cdp, {
          name: params.name,
          url: params.url,
          domain: params.domain,
          path: params.path,
        });
        return { deleted: true };
      }
      case "clear":
        await clearCookies(cdp);
        return { cleared: true };
    }
  },
};
