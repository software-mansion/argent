import { z } from "zod";
import type { Registry, ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { REMOTE_BUTTONS, type RemoteButton } from "../../utils/vega-input";
import type { TvRemoteParams, TvRemoteResult } from "./types";
import { makeIosImpl } from "./platforms/ios";
import { makeAndroidImpl } from "./platforms/android";
import { vegaImpl } from "./platforms/vega";

const BUTTONS = [...REMOTE_BUTTONS] as [RemoteButton, ...RemoteButton[]];

// `button` accepts a single button OR a path of buttons. A path runs in ONE
// tool call (and, on Vega, one device round-trip), so it is strongly preferred
// for any multi-step move. Some MCP clients serialize array arguments as a JSON
// (or comma-separated) string, so coerce those back to an array before validating.
const buttonSchema = z
  .preprocess(
    (val) => {
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
    },
    z.union([z.enum(BUTTONS), z.array(z.enum(BUTTONS)).min(1).max(64)])
  )
  .describe(
    "A single TV-remote button, or a path of them run in one call. " +
      "Buttons: up/down/left/right (D-pad), select (OK), back, home, menu, playPause, " +
      "rewind, fastForward, next, previous, volumeUp, volumeDown, mute. " +
      "The media-transport and volume keys work on Android TV and Vega; on the Apple TV " +
      "simulator they are rejected (its HID stack ignores them) — the D-pad/select/back/menu/" +
      "home/playPause core works on all three. " +
      'For multi-step navigation pass an array, e.g. ["up","right","right","select"] — ' +
      "strongly prefer this over multiple `tv-remote` calls: the whole path runs in a single call."
  );

const zodSchema = z.object({
  udid: z
    .string()
    .describe("Target TV device id from `list-devices` (Apple TV, Android TV, or Vega)."),
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

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
  vega: { vvd: true },
};

// `tv-remote` drives the directional remote on every TV platform through
// `dispatchByPlatform`: Apple TV (tvOS HID daemon) and Android TV (`adb input
// keyevent`) share the focus-engine subset of buttons; Vega (Fire TV) injects
// the full remote vocabulary over `inputd-cli`. The ios/android branches
// runtime-probe their TV kind inside resolveTvApi (a tvOS sim is "ios", an
// Android TV emulator "android" by id shape) and reject non-TV targets there.
// No eager service: the backend is resolved lazily per platform.
export function createTvRemoteTool(registry: Registry): ToolDefinition<Params, TvRemoteResult> {
  return {
    id: "tv-remote",
    description: `Press a TV remote / D-pad button (or a whole path of them) on a TV device — Apple TV (tvOS), Android TV (leanback), or Vega (Fire TV).
A TV is navigated with a directional remote, not touch — use this instead of gesture-tap/swipe (which do not apply on a TV). Move focus with up/down/left/right, confirm with select, go back with back/menu, exit with home, and use playPause/rewind/fastForward/next/previous/volumeUp/volumeDown/mute for the corresponding remote keys. (On the Apple TV simulator the media-transport and volume keys are rejected — its HID stack ignores them; they work on Android TV and Vega.)
Single press: { button: "down" }. Repeat the same button: { button: "down", repeat: 3 }.
Multi-step navigation: pass a path as { button: ["up","right","right","select"] } — it runs in one tool call, far cheaper than separate presses.
Read the screen with \`describe\` before and after to see where focus landed.
Returns { pressed, count }.`,
    alwaysLoad: true,
    // A path (≤64 buttons) × repeat (≤50) flattens to thousands of presses that
    // settle apart in one held device session — minutes of wall-clock. Mark
    // long-running so the MCP adapter doesn't abort it at its per-request fetch
    // timeout and the idle-shutdown timer is kept warm for the call's duration.
    longRunning: true,
    searchHint:
      "tv remote dpad d-pad navigate focus up down left right select ok back home menu play pause rewind fast forward sequence path apple tv tvos android tv leanback vega fire tv",
    zodSchema,
    capability,
    services: () => ({}),
    execute: dispatchByPlatform<
      Record<string, unknown>,
      Record<string, unknown>,
      TvRemoteParams,
      TvRemoteResult,
      Record<string, unknown>,
      Record<string, unknown>
    >({
      toolId: "tv-remote",
      capability,
      ios: makeIosImpl(registry),
      android: makeAndroidImpl(registry),
      vega: vegaImpl,
    }),
  };
}
