import { z } from "zod";
import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { resolveDevice } from "../../utils/device-info";
import { UnsupportedOperationError } from "../../utils/capability";
import { pressRemoteButton, REMOTE_KEYCODES, type RemoteButton } from "../../utils/vega-input";

const BUTTONS = Object.keys(REMOTE_KEYCODES) as [RemoteButton, ...RemoteButton[]];

const zodSchema = z.object({
  udid: z.string().describe("Target Vega device id from `list-devices`."),
  button: z
    .enum(BUTTONS)
    .describe(
      "TV remote button: up/down/left/right (D-pad), select (OK), back, home, menu, " +
        "playPause, rewind, fastForward."
    ),
  repeat: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Press the button this many times in a row (default 1). Useful for D-pad navigation."),
});

type Params = z.infer<typeof zodSchema>;

interface Result {
  pressed: RemoteButton;
  count: number;
}

const capability: ToolCapability = {
  vega: { virtual: true },
};

export const remoteTool: ToolDefinition<Params, Result> = {
  id: "remote",
  description: `Press a TV remote / D-pad button on a Vega (Fire TV) device.
Vega apps are navigated with a directional remote, not touch — use this instead of gesture-tap/swipe (which do not apply on Vega). Move focus with up/down/left/right, confirm with select, go back with back, and use home/menu/playPause/rewind/fastForward for the corresponding remote keys.
Pass repeat to step the D-pad multiple times (e.g. { button: "down", repeat: 3 }).
Returns { pressed, count }. Keys are injected on-device via inputd-cli so the focused app's focus engine moves (real remote/navigation events).`,
  alwaysLoad: true,
  searchHint:
    "vega fire tv remote dpad d-pad navigate focus up down left right select ok back home menu play pause rewind fast forward",
  zodSchema,
  capability,
  services: () => ({}),
  async execute(_services, params) {
    // Guard the platform explicitly: the HTTP layer gates on `capability`, but
    // internal callers (run-sequence, tests) reach execute directly.
    const device = resolveDevice(params.udid);
    if (device.platform !== "vega") {
      throw new UnsupportedOperationError("remote", device, "remote is Vega-only");
    }
    const count = await pressRemoteButton(params.udid, params.button, {
      repeat: params.repeat,
    });
    return { pressed: params.button, count };
  },
};
