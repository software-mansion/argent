import type { z } from "zod";
import type { setAppearanceZodSchema } from "./schema";

export type SetAppearanceParams = z.infer<typeof setAppearanceZodSchema>;

export type Appearance = SetAppearanceParams["appearance"];

export interface SetAppearanceResult {
  appearance: Appearance;
  /**
   * The appearance before the call, so a caller can put it back afterwards.
   * `null` when the device reported something other than light or dark (an
   * Android night mode of `auto` or `custom`).
   */
  previous: Appearance | null;
}

/** No services — `simctl`/`adb` are called directly. */
export type SetAppearanceServices = Record<string, never>;
