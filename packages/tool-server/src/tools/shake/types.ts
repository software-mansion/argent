import type { z } from "zod";
import type { shakeZodSchema } from "./schema";

export type ShakeParams = z.infer<typeof shakeZodSchema>;

export interface ShakeResult {
  shaken: true;
  /** Shake gestures delivered. */
  count: number;
}

/** No services — `simctl`/`adb` are called directly. */
export type ShakeServices = Record<string, never>;
