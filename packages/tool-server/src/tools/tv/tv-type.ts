import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import { resolveDevice } from "../../utils/device-info";
import { tvControlRef, type TvControlApi } from "../../blueprints/tv-control";

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Apple TV simulator UDID from `list-devices` (a device with runtimeKind 'tv')."),
  text: z.string().describe("Text to type via the HID keyboard into the focused tvOS field."),
});

type Params = z.infer<typeof zodSchema>;

interface Result {
  typed: string;
}

const tvTypeTool: ToolDefinition<Params, Result> = {
  id: "tv-type",
  description: `Type text into a tvOS (Apple TV) simulator via injected HID keyboard events.
Focus a text field first (with \`tv-navigate\` / \`tv-set-focus\`), then call this. Streams characters as keyboard events; uppercase and common symbols are handled automatically.
Returns { typed: text }.
Requires a booted Apple TV simulator; fails for iOS/Android — use \`keyboard\` for those.`,
  searchHint: "tvos apple tv type text keyboard input search field hid",
  zodSchema,
  services: (params) => ({
    tv: tvControlRef(resolveDevice(params.udid)),
  }),
  async execute(services, params) {
    const api = services.tv as TvControlApi;
    await api.type(params.text);
    return { typed: params.text };
  },
};

export { tvTypeTool };
