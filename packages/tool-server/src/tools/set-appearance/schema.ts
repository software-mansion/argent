import { z } from "zod";

export const setAppearanceZodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Target device id from `list-devices` (iOS simulator UDID or Android serial)."),
  appearance: z
    .enum(["light", "dark"])
    .describe("The system appearance to switch to: `light` or `dark` (dark mode)."),
});
