import { z } from "zod";
import type { Registry, ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { REMOTE_BUTTONS, type RemoteButton } from "../../utils/vega-input";
import type { TvRemoteParams, TvRemoteResult } from "./types";
import { makeIosImpl } from "./platforms/ios";
import { makeAndroidImpl } from "./platforms/android";
import { vegaImpl } from "./platforms/vega";

const BUTTONS = [...REMOTE_BUTTONS] as [RemoteButton, ...RemoteButton[]];

const capability: ToolCapability = {
  apple: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
  vega: { vvd: true },
};

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
    'Single remote button or array path run in one call (e.g. ["up","right","select"]; prefer an array over repeated calls).'
  );

const zodSchema = z.object({
  udid: z.string().describe("TV device id from `list-devices` (Apple TV, Android TV, or Vega)."),
  button: buttonSchema,
  repeat: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('Repeat `button` N times (default 1, e.g. `{ button: "down", repeat: 12 }`).'),
});

type Params = z.infer<typeof zodSchema>;

// `capability` can't tell a TV apart from a phone, so the ios/android branches
// accept any Apple/Android target and `resolveTvApi` rejects the non-TV ones at
// call time — which is also why `services()` is empty: the backend can only be
// resolved lazily, per device.
export function createTvRemoteTool(registry: Registry): ToolDefinition<Params, TvRemoteResult> {
  return {
    id: "tv-remote",
    description: `Press a TV remote / D-pad button (or array path) on Apple TV (tvOS), Android TV, or Vega (Fire TV).
Use when navigating focus or pressing remote keys on a TV instead of touch gestures. Call \`describe\` first to locate focus; check the returned tree after.
Returns \`{ pressed, count }\`. Fails on non-TV targets, or on Apple TV sim for rewind/fastForward/next/previous/volume/mute.`,
    zodSchema,
    searchHint:
      "tv remote dpad d-pad navigate focus up down left right select ok back home menu play pause rewind fast forward sequence path apple tv tvos android tv leanback vega fire tv",
    interaction: {
      startedMsg: ({ params }) =>
        `Pressing ${params.button} on TV remote${(params.repeat ?? 1) > 1 ? ` ${params.repeat} times` : ""}`,
      completedMsg: ({ params }) =>
        `Pressed ${params.button} on TV remote${(params.repeat ?? 1) > 1 ? ` ${params.repeat} times` : ""}`,
      failedMsg: ({ params, failureSignal }) =>
        `Failed to press ${params.button} on TV remote: ${failureSignal.error_code}`,
    },
    // A path (≤64 buttons) × repeat (≤50) flattens to thousands of presses, sent
    // one round-trip at a time on the Apple/Android path — minutes of wall-clock.
    longRunning: true,
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
