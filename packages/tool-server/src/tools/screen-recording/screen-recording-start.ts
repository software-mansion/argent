import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import {
  screenRecordingSessionRef,
  type ScreenRecordingSessionApi,
} from "../../blueprints/screen-recording-session";
import { resolveDevice } from "../../utils/device-info";
import { assertSupported } from "../../utils/capability";
import { ensureDeps } from "../../utils/check-deps";
import { startScreenRecordingIos } from "./platforms/ios";
import { startScreenRecordingAndroid, ANDROID_MAX_TIME_LIMIT_SECONDS } from "./platforms/android";
import type { StartRecordingResult } from "./platforms/shared";

const DEFAULT_TIME_LIMIT_SECONDS = 180;
const MAX_TIME_LIMIT_SECONDS = 600;

const zodSchema = z.object({
  udid: z
    .string()
    .describe("Target device id from `list-devices` (iOS Simulator UDID or Android serial)."),
  timeLimitSeconds: z
    .number()
    .int()
    .min(1)
    .max(MAX_TIME_LIMIT_SECONDS)
    .optional()
    .describe(
      `Auto-stop cap in seconds (default ${DEFAULT_TIME_LIMIT_SECONDS}). Set it to slightly more than ` +
        `the interaction you plan to capture. Android's screenrecord hard-caps at ` +
        `${ANDROID_MAX_TIME_LIMIT_SECONDS}s — larger values are clamped and the applied cap is returned.`
    ),
});

const capability = {
  apple: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
} as const;

export const screenRecordingStartTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  StartRecordingResult
> = {
  id: "screen-recording-start",
  capability,
  description: `Start recording the device screen to a video file. iOS simulators: \`simctl io recordVideo\` (h264 mp4). Android emulators/devices: on-device \`screenrecord\`, pulled to the host on stop.
The recording keeps running across other tool calls (every result carries a reminder) until \`screen-recording-stop\` is called or timeLimitSeconds elapses — immediately after starting, set yourself a reminder/wakeup for the expected end of the recording so it is never left running.
Use when the user wants a video of an interaction, animation, or app behavior — for a single still frame use \`screenshot\` instead.
Returns { status: "recording", timeLimitSeconds, outputFile } — the video is retrieved later by \`screen-recording-stop\`, not by reading outputFile directly.
Fails if a recording is already running on the device, the device is not booted, or the platform cannot record (Chromium/Vega/remote simulators are unsupported).`,
  searchHint: "record video screen capture movie mp4 start filming screencast",
  zodSchema,
  services: (params) => ({
    session: screenRecordingSessionRef(resolveDevice(params.udid)),
  }),
  async execute(services, params) {
    const api = services.session as ScreenRecordingSessionApi;
    const device = resolveDevice(params.udid);
    assertSupported("screen-recording-start", capability, device);

    const timeLimitSeconds = params.timeLimitSeconds ?? DEFAULT_TIME_LIMIT_SECONDS;

    // The session blueprint already classified the platform at factory time;
    // trust that over re-parsing the udid (mirrors native-profiler-start, and
    // lets tests build sessions with synthetic udids).
    if (api.platform === "ios") {
      await ensureDeps(["xcrun"]);
      return startScreenRecordingIos(api, { udid: params.udid, timeLimitSeconds });
    }
    await ensureDeps(["adb"]);
    return startScreenRecordingAndroid(api, { udid: params.udid, timeLimitSeconds });
  },
};
