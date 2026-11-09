import { z } from "zod";
import type { NetworkConditions } from "../../utils/network-conditions";

export const networkConditionsZodSchema = z.object({
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
  latencyMs: z
    .number()
    .int()
    .min(0)
    .max(60_000)
    .optional()
    .describe("Added latency in milliseconds."),
  downloadKbps: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Download limit in kilobits per second. Omit for no limit."),
  uploadKbps: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Upload limit in kilobits per second. Omit for no limit."),
  offline: z.boolean().optional().describe("Fail every request as if the network were down."),
});

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
