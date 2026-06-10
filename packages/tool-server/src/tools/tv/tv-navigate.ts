import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import { resolveDevice } from "../../utils/device-info";
import { tvControlRef, type TvControlApi, type TvDirection } from "../../blueprints/tv-control";

const DIRECTIONS = [
  "up",
  "down",
  "left",
  "right",
  "select",
  "menu",
  "home",
  "playpause",
] as const;

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Apple TV simulator UDID from `list-devices` (a device with runtimeKind 'tv')."),
  direction: z
    .enum(DIRECTIONS)
    .describe(
      "Siri-remote action: up/down/left/right move the focus engine; select activates the focused element; menu goes back; home exits to the tvOS home screen; playpause toggles playback."
    ),
});

type Params = z.infer<typeof zodSchema>;

interface Result {
  sent: TvDirection;
}

const tvNavigateTool: ToolDefinition<Params, Result> = {
  id: "tv-navigate",
  description: `Send a Siri-remote input to a tvOS (Apple TV) simulator via injected HID.
This is how you interact with tvOS: move focus with up/down/left/right, activate with select, go back with menu, exit with home, toggle media with playpause.
Call \`tv-describe\` afterwards to see where focus landed.
Returns { sent: direction }.
Requires a booted Apple TV simulator; fails for iOS/Android — use \`button\`/\`gesture-tap\` for those.`,
  alwaysLoad: true,
  searchHint: "tvos apple tv navigate remote dpad up down left right select menu home play pause siri",
  zodSchema,
  services: (params) => ({
    tv: tvControlRef(resolveDevice(params.udid)),
  }),
  async execute(services, params) {
    const api = services.tv as TvControlApi;
    await api.navigate(params.direction);
    return { sent: params.direction };
  },
};

export { tvNavigateTool };
