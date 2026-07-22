import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import {
  screenRecordingSessionRef,
  type ScreenRecordingSessionApi,
} from "../../blueprints/screen-recording-session";
import { resolveDevice } from "../../utils/device-info";
import { assertSupported } from "../../utils/capability";
import { requireArtifacts, type ArtifactHandle } from "../../artifacts";
import { stopCapture } from "./capture";

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
  description: `Stop the screen recording started by \`screen-recording-start\` and retrieve the video: frame capture ends and ffmpeg finalizes the mp4.
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

    // The video is already finished when this returns: the capture encodes to
    // its final form live (constant 30fps, watermark stamped in the same pass),
    // so there is no post-processing step between stop and hand-off.
    const stopped = await stopCapture(api);

    // Resolve the store only after a successful stop — the "no active
    // recording" error path never needs it.
    const artifacts = requireArtifacts(ctx);
    const video = await artifacts.register(stopped.outputFile, { mimeType: "video/mp4" });
    const result: ScreenRecordingStopResult = { video, durationMs: stopped.durationMs };
    if (stopped.warning) result.warning = stopped.warning;
    return result;
  },
};
