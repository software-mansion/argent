import { z } from "zod";

/** Input schema for the simulator-server tool (registry and HTTP). */
export const simulatorServerInputSchema = z.object({
  udid: z.string().describe("The UDID of the simulator to connect to"),
  token: z
    .string()
    .optional()
    .describe("JWT license token for Pro features"),
});

export const simulatorServerOutputSchema = z.object({
  udid: z.string(),
  apiUrl: z.string(),
  streamUrl: z.string(),
});
