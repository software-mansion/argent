import { z } from "zod";
import type { NetworkConditions } from "../../utils/network-conditions";
import { metroPortField } from "../../utils/debugger/metro-port";

export const networkConditionsZodSchema = z
  .object({
    udid: z.string().min(1).describe("Device ID from `list-devices`."),
    bundleId: z
      .string()
      .min(1)
      .optional()
      .describe("App bundle ID (required on iOS; ignored elsewhere)."),
    port: metroPortField.describe(
      "Metro port exempt from shaping (omit for device default, usually 8081)."
    ),
    latencyMs: z.number().int().min(0).max(60_000).optional().describe("Added latency in ms."),
    downloadKbps: z.number().int().min(1).optional().describe("Download cap in kbps."),
    uploadKbps: z.number().int().min(1).optional().describe("Upload cap in kbps."),
    offline: z.boolean().optional().describe("Simulate offline (`false` alone resets conditions)."),
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
