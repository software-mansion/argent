import { z } from "zod";

export const pasteZodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe(
      "Target device id from `list-devices` (iOS simulator UDID or Android emulator serial)."
    ),
  text: z
    .string()
    .min(1)
    .describe(
      "Text to put on the device clipboard and paste into the focused field. " +
        "Supports `{{secret:<NAME>}}` placeholders, resolved on the tool-server from the " +
        "`ARGENT_SECRET_<NAME>` environment variable or an argent secrets file — the same " +
        "sources as `keyboard` — so a credential never enters your context. If the secret is " +
        "not set, the failure lists the available names and every source it looked in; ask the " +
        "user to add it there, NEVER ask for the value in the conversation."
    ),
});
