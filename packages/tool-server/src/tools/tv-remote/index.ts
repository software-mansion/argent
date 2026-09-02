import { z } from "zod";
import type { Registry, ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { REMOTE_BUTTONS, type RemoteButton } from "../../utils/vega-input";
import type { TvRemoteParams, TvRemoteResult } from "./types";
import { makeIosImpl } from "./platforms/ios";
import { makeAndroidImpl } from "./platforms/android";
import { vegaImpl } from "./platforms/vega";

const BUTTONS = [...REMOTE_BUTTONS] as [RemoteButton, ...RemoteButton[]];

// Some MCP clients serialize array arguments as a JSON (or comma-separated)
// string, so coerce those back to an array before validating.
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

// `capability` can't tell a TV apart from a phone, so the ios/android branches
// accept any Apple/Android target and `resolveTvApi` rejects the non-TV ones at
// call time — which is also why `services()` is empty: the backend can only be
// resolved lazily, per device.
export function createTvRemoteTool(registry: Registry): ToolDefinition<Params, TvRemoteResult> {
  return {
    id: "tv-remote",
    interaction: {
      startedMsg: ({ params }) =>
        `Pressing ${params.button} on TV remote${(params.repeat ?? 1) > 1 ? ` ${params.repeat} times` : ""}`,
      completedMsg: ({ params }) =>
        `Pressed ${params.button} on TV remote${(params.repeat ?? 1) > 1 ? ` ${params.repeat} times` : ""}`,
      failedMsg: ({ params, failureSignal }) =>
        `Failed to press ${params.button} on TV remote: ${failureSignal.error_code}`,
    },
    description: `Press a TV remote / D-pad button (or a whole path of them) on a TV device — Apple TV (tvOS), Android TV (leanback), or Vega (Fire TV).
A TV is navigated with a directional remote, not touch — use this instead of gesture-tap/swipe (which do not apply on a TV). Move focus with up/down/left/right, confirm with select, go back with back/menu, exit with home, and use playPause/rewind/fastForward/next/previous/volumeUp/volumeDown/mute for the corresponding remote keys. (On the Apple TV simulator the media-transport and volume keys are rejected — its HID stack ignores them; they work on Android TV and Vega.)
Single press: { button: "down" }. Repeat the same button: { button: "down", repeat: 3 }.
Multi-step navigation: pass a path as { button: ["up","right","right","select"] } — it runs in one tool call, far cheaper than separate presses.
Read the screen with \`describe\` before and after to see where focus landed.
Returns { pressed, count }.`,
    alwaysLoad: true,
    // A path (≤64 buttons) × repeat (≤50) flattens to thousands of presses, sent
    // one round-trip at a time on the Apple/Android path — minutes of wall-clock.
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
