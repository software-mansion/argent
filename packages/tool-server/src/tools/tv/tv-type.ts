import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import { tvServiceRef } from "./tv-service";
import type { TvControlApi } from "../../blueprints/tv-control-types";

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe(
      "TV target id from `list-devices` (a device with runtimeKind 'tv') — an Apple TV simulator UDID or an Android TV serial."
    ),
  text: z.string().describe("Text to type into the focused TV text field."),
});

type Params = z.infer<typeof zodSchema>;

interface Result {
  typed: string;
}

const tvTypeTool: ToolDefinition<Params, Result> = {
  id: "tv-type",
  description: `Type text into a TV device's focused field — an Apple TV (tvOS) simulator (injected HID keyboard) or an Android TV device (adb input text).
Focus a text field first (with \`tv-navigate\` / \`tv-set-focus\`), then call this. Uppercase and common symbols are handled automatically.
Returns { typed: text }.
Requires a booted TV target (runtimeKind 'tv'); fails for phones/tablets — use \`keyboard\` for those.`,
  searchHint: "tvos apple tv android tv type text keyboard input search field hid leanback",
  zodSchema,
  services: (params) => ({
    tv: tvServiceRef(params.udid),
  }),
  async execute(services, params) {
    const api = services.tv as TvControlApi;
    await api.type(params.text);
    return { typed: params.text };
  },
};

export { tvTypeTool };
