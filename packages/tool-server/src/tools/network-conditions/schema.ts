import { z } from "zod";
import type { NetworkConditions } from "../../utils/network-conditions";
import { metroPortField } from "../../utils/debugger/metro-port";

export const networkConditionsZodSchema = z
  .object({
    udid: z.string().min(1).describe("Device ID from list-devices."),
    bundleId: z
      .string()
      .min(1)
      .optional()
      .describe("Bundle ID of the app to shape. Required on iOS and ignored elsewhere."),
    port: metroPortField.describe(
      "Metro port to exempt from shaping on iOS and Android. Omit for the device's port (usually 8081)."
    ),
    latencyMs: z
      .number()
      .int()
      .min(0)
      .max(60_000)
      .optional()
      .describe(
        "Delay in milliseconds. Android adds it per round trip. iOS and Chromium use it as a minimum response delay."
      ),
    downloadKbps: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Download limit in kilobits per second."),
    uploadKbps: z.number().int().min(1).optional().describe("Upload limit in kilobits per second."),
    offline: z
      .boolean()
      .optional()
      .describe(
        "Make requests fail as if the network were down. On Android, adb reverse ports stay reachable, but Metro at 10.0.2.2 does not. False alone resets the conditions."
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
