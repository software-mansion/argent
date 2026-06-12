import { z } from "zod";
import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { resolveDevice } from "../../utils/device-info";
import { UnsupportedOperationError } from "../../utils/capability";
import { REMOTE_KEYCODES, type RemoteButton } from "../../utils/vega-input";
import { resolveVegaTransport } from "../../utils/vega-transport";

const BUTTONS = Object.keys(REMOTE_KEYCODES) as [RemoteButton, ...RemoteButton[]];

// `button` accepts a single button OR a path of buttons. A path runs in ONE
// device round-trip + one tool call, so it is strongly preferred for any
// multi-step move. Some MCP clients serialize array arguments as a JSON (or
// comma-separated) string, so coerce those back to an array before validating.
const buttonSchema = z
  .preprocess((val) => {
    if (typeof val !== "string") return val;
    const trimmed = val.trim();
    if (trimmed.startsWith("[")) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return val;
      }
    }
    if (trimmed.includes(",")) {
      return trimmed
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    return trimmed;
  }, z.union([z.enum(BUTTONS), z.array(z.enum(BUTTONS)).min(1).max(64)]))
  .describe(
    "A single TV-remote button, or a path of them run in ONE device round-trip. " +
      "Buttons: up/down/left/right (D-pad), select (OK), back, home, menu, playPause, " +
      "rewind, fastForward, next, previous, volumeUp, volumeDown, mute. " +
      'For multi-step navigation pass an array, e.g. ["up","right","right","select"] — ' +
      "STRONGLY PREFER this over multiple `remote` calls: each call pays a ~1.6s device " +
      "handshake, so one path of N presses (~1.6s + N*0.3s, one API round-trip) replaces " +
      "N separate calls (N*~1.9s, N round-trips)."
  );

const zodSchema = z.object({
  udid: z.string().describe("Target Vega device id from `list-devices`."),
  button: buttonSchema,
  repeat: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe(
      "Repeat the whole `button` value this many times (default 1). " +
        'Compact for long same-button runs, e.g. { button: "down", repeat: 12 }.'
    ),
});

type Params = z.infer<typeof zodSchema>;

interface Result {
  pressed: RemoteButton[];
  count: number;
}

const capability: ToolCapability = {
  vega: { virtual: true },
};

export const remoteTool: ToolDefinition<Params, Result> = {
  id: "remote",
  description: `Press a TV remote / D-pad button (or a whole path of them) on a Vega (Fire TV) device.
Vega apps are navigated with a directional remote, not touch — use this instead of gesture-tap/swipe (which do not apply on Vega). Move focus with up/down/left/right, confirm with select, go back with back, and use home/menu/playPause/rewind/fastForward/next/previous/volumeUp/volumeDown/mute for the corresponding remote keys.
Single press: { button: "down" }. Repeat the same button: { button: "down", repeat: 3 }.
Multi-step navigation: pass a path as { button: ["up","right","right","select"] } — it runs in ONE device round-trip and one tool call, dramatically faster than separate presses (each call pays a ~1.6s device handshake).
Returns { pressed, count }. Keys are injected on-device via inputd-cli so the focused app's focus engine moves (real remote/navigation events).`,
  alwaysLoad: true,
  searchHint:
    "vega fire tv remote dpad d-pad navigate focus up down left right select ok back home menu play pause rewind fast forward sequence path",
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
    const base = Array.isArray(params.button) ? params.button : [params.button];
    const repeat = Math.max(1, Math.floor(params.repeat ?? 1));
    const buttons = repeat === 1 ? base : Array.from({ length: repeat }, () => base).flat();
    const transport = await resolveVegaTransport(params.udid);
    const count = await transport.pressButtons(buttons);
    return { pressed: buttons, count };
  },
};
