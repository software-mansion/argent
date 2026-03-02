import { z } from "zod";
import type { ToolDefinition } from "@radon-lite/registry";
import { activateWithSSO } from "../license";

const zodSchema = z.object({
  name: z
    .string()
    .optional()
    .describe("Display name for this activation (defaults to hostname)"),
});

export const activateSsoTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  | { success: true; plan: string }
  | { success: false; error: string; ssoUrl?: string }
> = {
  id: "activate-sso",
  description:
    "Call this tool when a license_required error is returned by any other tool. " +
    "Activates Radon Lite via SSO (PKCE browser flow): opens a browser window on the " +
    "user's machine for sign-in. Returns { success: true, plan } on success. " +
    "If the browser cannot be opened, returns { success: false, ssoUrl } — show that " +
    "URL to the user. Stores the resulting JWT token locally for all future calls.",
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    return activateWithSSO(params.name);
  },
};
