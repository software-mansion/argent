import type { z } from "zod";
import type { shakeZodSchema } from "./schema";

export type ShakeParams = z.infer<typeof shakeZodSchema>;

export interface ShakeResult {
  shaken: true;
  /** Number of shake gestures delivered. */
  count: number;
}

/** This tool talks to `simctl` / `adb` directly, so it declares no services. */
export type ShakeServices = Record<string, never>;
