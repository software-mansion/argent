import { z } from "zod";
import type { NetworkConditions } from "../../utils/network-conditions";
import { metroPortField } from "../../utils/debugger/metro-port";

export const networkConditionsZodSchema = z
  .object({
    udid: z
      .string()
      .min(1)
      .describe(
        "Target device id from `list-devices`: an iOS simulator UDID, an Android emulator serial, or a Chromium id."
      ),
    bundleId: z
      .string()
      .min(1)
      .optional()
      .describe("iOS only, and required there: the bundle id of the app to throttle."),
    port: metroPortField.describe(
      "iOS only: the Metro port the throttle leaves alone. Omit it to use this device's port (8081 by default)."
    ),
    latencyMs: z
      .number()
      .int()
      .min(0)
      .max(60_000)
      .optional()
      .describe(
        "Minimum time in milliseconds from sending a request to its response. iOS and Chromium only."
      ),
    downloadKbps: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Download limit in kilobits per second. iOS and Chromium only."),
    uploadKbps: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Upload limit in kilobits per second. iOS and Chromium only."),
    offline: z
      .boolean()
      .optional()
      .describe(
        "Make requests fail as if the network were down. On Android, ports forwarded with adb reverse stay reachable."
      ),
  })
  .strict();

export type NetworkConditionsParams = z.infer<typeof networkConditionsZodSchema>;

/** The conditions a call asks for, or `null` when it sets none and so resets the network. */
export function requestedConditions(params: NetworkConditionsParams): NetworkConditions | null {
  const { latencyMs, downloadKbps, uploadKbps, offline } = params;
  const conditions: NetworkConditions = {
    ...(latencyMs !== undefined && { latencyMs }),
    ...(downloadKbps !== undefined && { downloadKbps }),
    ...(uploadKbps !== undefined && { uploadKbps }),
    ...(offline && { offline }),
  };
  return Object.keys(conditions).length > 0 ? conditions : null;
}
