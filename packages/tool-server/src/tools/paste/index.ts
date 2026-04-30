import { z } from "zod";
import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { iosImpl, type PasteResult, type PasteServices } from "./platforms/ios";
import { androidImpl } from "./platforms/android";

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
  text: z.string().describe("Text to paste into the focused field"),
});

type Params = z.infer<typeof zodSchema>;

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
};

export const pasteTool: ToolDefinition<Params, PasteResult> = {
  id: "paste",
  description: `Fill the focused field on the simulator/emulator by pasting text (fastest text entry).
Use when you need to fill a text input with a long string faster than character-by-character typing.
Returns { pasted: true }. Fails if the simulator server is not running.
Tap the text field first to focus it, then call paste.
If paste doesn't work for a particular field, use the keyboard tool instead.`,
  zodSchema,
  capability,
  services: (params) => ({
    simulatorServer: `SimulatorServer:${params.udid}`,
  }),
  execute: dispatchByPlatform<PasteServices, Params, PasteResult>({
    toolId: "paste",
    capability,
    ios: iosImpl,
    android: androidImpl,
  }),
};
