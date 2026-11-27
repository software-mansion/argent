import { z } from "zod";

export const pasteZodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe(
      "Device id from `list-devices` (iOS simulator UDID, Android emulator serial<flag:macos-apps>, or Mac app id</flag:macos-apps>)."
    ),
  text: z
    .string()
    .min(1)
    .describe(
      "Text to paste. Supports `{{secret:<NAME>}}` placeholders resolved server-side (never ask the user for plaintext)."
    ),
});
