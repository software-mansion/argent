import { z } from "zod";

/** Upper bound on `count`, so a typo can't hold the device in a shake loop for minutes. */
const MAX_SHAKE_COUNT = 10;

export const shakeZodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe(
      "Target device id from `list-devices` (iOS simulator UDID or Android emulator serial)."
    ),
  count: z
    .number()
    .int()
    .min(1)
    .max(MAX_SHAKE_COUNT)
    .optional()
    .describe(
      `How many shake gestures to deliver back-to-back (default 1, max ${MAX_SHAKE_COUNT}). Raise it for apps whose shake detector needs sustained motion before it fires.`
    ),
});
