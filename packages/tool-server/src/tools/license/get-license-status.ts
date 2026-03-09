import { z } from "zod";
import type { ToolDefinition } from "@radon-lite/registry";
import { readToken, decodeJWTPayload, verifyToken } from "../../utils/license";

const zodSchema = z.object({});

type LicenseStatus =
  | { present: false }
  | { present: true; valid: true; plan: string; expiresAt: string | null }
  | { present: true; valid: false; reason: "corrupted" | "expired" | "fingerprint_mismatch" | "unknown"; expiresAt: string | null };

export const getLicenseStatusTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  LicenseStatus
> = {
  id: "get-license-status",
  description:
    "Check the current license token status. Calls the simulator-server binary to verify the token signature, expiry, and machine fingerprint. Returns { present: false } if no token is stored, { present: true, valid: true, plan, expiresAt } on success, or { present: true, valid: false, reason, expiresAt } if the token is invalid.",
  zodSchema,
  services: () => ({}),
  async execute() {
    const token = await readToken();
    if (!token) return { present: false };

    const result = await verifyToken(token);
    const payload = decodeJWTPayload(token);
    const expiresAt =
      payload?.exp != null ? new Date(payload.exp * 1000).toISOString() : null;

    if (result.valid) {
      return { present: true, valid: true, plan: result.plan, expiresAt };
    } else {
      return { present: true, valid: false, reason: result.reason, expiresAt };
    }
  },
};
