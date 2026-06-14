import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import { tvServiceRef } from "./tv-service";
import { TV_DIRECTIONS, type TvControlApi, type TvDirection } from "../../blueprints/tv-control-types";

const DIRECTIONS = TV_DIRECTIONS as readonly [TvDirection, ...TvDirection[]];

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe(
      "TV target id from `list-devices` (a device with runtimeKind 'tv') — an Apple TV simulator UDID or an Android TV serial."
    ),
  direction: z
    .enum(DIRECTIONS)
    .describe(
      "D-pad / remote action: up/down/left/right move the focus highlight; select activates the focused element; menu goes back; home exits to the TV home screen; playpause toggles playback."
    ),
});

type Params = z.infer<typeof zodSchema>;

interface Result {
  sent: TvDirection;
}

const tvNavigateTool: ToolDefinition<Params, Result> = {
  id: "tv-navigate",
  description: `Send a remote / D-pad input to a TV device — an Apple TV (tvOS) simulator (injected Siri-remote HID) or an Android TV device (adb keyevents).
This is how you interact with a TV: move focus with up/down/left/right, activate with select, go back with menu, exit with home, toggle media with playpause.
Call \`tv-describe\` afterwards to see where focus landed.
Returns { sent: direction }.
Requires a booted TV target (runtimeKind 'tv'); fails for phones/tablets — use \`button\`/\`gesture-tap\` for those.`,
  alwaysLoad: true,
  searchHint:
    "tvos apple tv android tv navigate remote dpad up down left right select menu home play pause siri leanback",
  zodSchema,
  services: (params) => ({
    tv: tvServiceRef(params.udid),
  }),
  async execute(services, params) {
    const api = services.tv as TvControlApi;
    await api.navigate(params.direction);
    return { sent: params.direction };
  },
};

export { tvNavigateTool };
