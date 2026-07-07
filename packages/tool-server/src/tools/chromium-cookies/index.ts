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

const zodSchema = z.object({
  udid: z.string().describe("Chromium device id from `list-devices` (e.g. `chromium-cdp-9222`)."),
  action: z
    .enum(["get", "set", "delete", "clear"])
    .describe(
      "get: read cookies. set: create/update a cookie. delete: remove a named cookie. clear: remove all browser cookies."
    ),
  name: z.string().optional().describe("set/delete: cookie name."),
  value: z.string().optional().describe("set: cookie value."),
  url: z
    .string()
    .optional()
    .describe(
      "get: restrict to these URLs (defaults to the active page). set/delete: scope the cookie by URL."
    ),
  domain: z.string().optional().describe("set/delete: scope the cookie by domain (alt to url)."),
  path: z.string().optional().describe("set/delete: cookie path (default /)."),
  secure: z.boolean().optional().describe("set: mark Secure."),
  httpOnly: z.boolean().optional().describe("set: mark HttpOnly."),
  sameSite: z.enum(["Strict", "Lax", "None"]).optional().describe("set: SameSite policy."),
  expires: z
    .number()
    .optional()
    .describe("set: expiry as a Unix timestamp (seconds). Omit for a session cookie."),
});

type Params = z.infer<typeof zodSchema>;

type Result =
  | { cookies: Cookie[]; count: number }
  | { set: boolean }
  | { deleted: true }
  | { cleared: true };

const capability: ToolCapability = {
  chromium: { app: true },
};

export const chromiumCookiesTool: ToolDefinition<Params, Result> = {
  id: "chromium-cookies",
  description: `Read and write cookies of a Chromium (CDP) app (via the Network domain, so HttpOnly cookies are included).
- action="get" (url?): list cookies, optionally restricted to given URLs (defaults to the active page).
- action="set" (name, value, + url OR domain, optional path/secure/httpOnly/sameSite/expires): create or update a cookie.
- action="delete" (name, + url/domain/path): remove a matching cookie.
- action="clear": remove ALL browser cookies.
Use when seeding an authenticated session before a flow (set the session cookie, then navigate) or asserting cookie state after one.
Returns { cookies, count } for get, or a small status object ({ set } / { deleted } / { cleared }) otherwise. Fails if the device is not a Chromium (CDP) device, or set is missing name/value. Chromium-only.`,
  searchHint: "cookies cookie get set delete clear httponly samesite session auth chromium",
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
