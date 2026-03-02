import { z } from "zod";
import type { ToolDefinition } from "@radon-lite/registry";
import { activateWithLicenseKey } from "../license";

const zodSchema = z.object({
  licenseKey: z
    .string()
    .regex(
      /^[0-9A-F]{4}(?:-[0-9A-F]{4}){7}$/i,
      "Invalid license key format — expected XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
    )
    .describe("License key in the format XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"),
  name: z
    .string()
    .optional()
    .describe("Display name for this activation (defaults to hostname)"),
});

export const activateLicenseKeyTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { success: true; plan: string } | { success: false; error: string }
> = {
  id: "activate-license-key",
  description:
    "Activate Radon Lite with a license key. Stores the resulting JWT token locally for all future tool calls. Returns { success, plan } on success or { success: false, error } on failure.",
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    return activateWithLicenseKey(params.licenseKey, params.name);
  },
};
