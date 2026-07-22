import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import {
  screenRecordingSessionRef,
  type ScreenRecordingSessionApi,
} from "../../blueprints/screen-recording-session";
import { resolveDevice } from "../../utils/device-info";
import { assertSupported } from "../../utils/capability";
import { ensureDeps } from "../../utils/check-deps";
import { isFeatureEnabled } from "@argent/configuration-core";
import { requireArtifacts, type ArtifactHandle } from "../../artifacts";
import { stopScreenRecordingIos } from "./platforms/ios";
import { stopScreenRecordingAndroid } from "./platforms/android";
import { finishRecording } from "./finish-recording";
import type { StopRecordingFile } from "./platforms/shared";

const zodSchema = z.object({
  udid: z
    .string()
    .describe("Target device id from `list-devices` (iOS Simulator UDID or Android serial)."),
});

export interface ScreenRecordingStopResult {
  /** The finalized video as a downloadable artifact (mp4). */
  video: ArtifactHandle;
  /** Wall-clock capture length; null when the session lost its start stamp. */
  durationMs: number | null;
  warning?: string;
}

const capability = {
  apple: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
} as const;

export const screenRecordingStopTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  ScreenRecordingStopResult
> = {
  id: "screen-recording-stop",
  capability,
  description: `Stop the screen recording started by \`screen-recording-start\` and retrieve the video. iOS: SIGINTs recordVideo and waits for the mp4 to finalize. Android: stops the on-device screenrecord, then \`adb pull\`s the file.
Also retrieves the video when the recording already ended on its own (time limit reached, capture process died) — call it even after the cap fired.
Use when the interaction being captured is finished, or a tool-result note reminds you a recording is still running.
Returns { video, durationMs, warning? }; video is a downloadable artifact materialized to a local path.
Fails if no recording (running or finished-but-unretrieved) exists for the given udid.`,
  searchHint: "stop end finish screen recording video capture save retrieve",
  zodSchema,
  services: (params) => ({
    session: screenRecordingSessionRef(resolveDevice(params.udid)),
  }),
  async execute(services, params, ctx) {
    const api = services.session as ScreenRecordingSessionApi;
    const device = resolveDevice(params.udid);
    assertSupported("screen-recording-stop", capability, device);

    let stopped: StopRecordingFile;
    if (api.platform === "ios") {
      await ensureDeps(["xcrun"]);
      stopped = await stopScreenRecordingIos(api);
    } else {
      await ensureDeps(["adb"]);
      stopped = await stopScreenRecordingAndroid(api);
    }

    // Finish the raw capture before handing it over: normalize to a constant
    // 30fps (recordVideo / screenrecord emit variable-framerate video that
    // stutters on playback) and overlay the corner watermark unless it has been
    // turned off (`argent disable video-watermark`). Read live per-call so the
    // flag takes effect without restarting the long-lived tool-server. The step
    // is best-effort — it falls back to the raw capture with a warning, so a
    // recording is never lost to post-processing.
    const finished = await finishRecording(stopped.outputFile, {
      watermark: isFeatureEnabled("video-watermark"),
    });

    // Resolve the store only after a successful stop — the "no active
    // recording" error path never needs it.
    const artifacts = requireArtifacts(ctx);
    const video = await artifacts.register(finished.outputFile, { mimeType: "video/mp4" });
    const result: ScreenRecordingStopResult = { video, durationMs: stopped.durationMs };
    const warning = [stopped.warning, finished.warning].filter(Boolean).join(" ");
    if (warning) result.warning = warning;
    return result;
  },
};
