import { basename } from "node:path";
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

/**
 * Where the finished video is durably saved, relative to the client's project
 * root (or its home dir when not in a project — the client decides). The client
 * materializer copies (co-located) or downloads (remote `argent link`) the mp4
 * here, so a recording always lands under `<project>/.argent/recordings/` on the
 * client host rather than in disposable temp — even when the tool-server that
 * produced it is remote.
 */
const RECORDINGS_DIR = ".argent/recordings";

export interface ScreenRecordingStopResult {
  /** The finalized video as a downloadable artifact (mp4). */
  video: ArtifactHandle;
  /**
   * Length of the returned video; null when the session lost its start stamp.
   * Shorter than the real recording when static-frame trimming removed dead air.
   */
  durationMs: number | null;
  /** Real elapsed recording time. Present only when trimming actually removed frames. */
  wallClockMs?: number;
  /** How much dead-air time trimming removed. Present only when trimming applied. */
  trimmedMs?: number;
  warning?: string;
}

const capability = {
  apple: { simulator: true },
  // Remote (`sim-remote`) recordings finalize host-side exactly like local ones.
  appleRemote: { simulator: true },
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
Returns { video, durationMs, wallClockMs?, trimmedMs?, warning? }; video is a downloadable artifact materialized to a local path. When static-frame trimming removed dead air, durationMs is the trimmed video length and wallClockMs/trimmedMs report the real duration and how much was cut.
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
    const video = await artifacts.register(stopped.outputFile, {
      mimeType: "video/mp4",
      // Drop the internal `argent-` temp prefix so the saved file reads cleanly
      // as `.argent/recordings/screen-recording-<device>-<ts>.mp4`.
      filename: basename(stopped.outputFile).replace(/^argent-/, ""),
      saveDir: RECORDINGS_DIR,
    });
    const result: ScreenRecordingStopResult = { video, durationMs: stopped.durationMs };
    if (stopped.wallClockMs !== undefined) result.wallClockMs = stopped.wallClockMs;
    if (stopped.trimmedMs !== undefined) result.trimmedMs = stopped.trimmedMs;
    if (stopped.warning) result.warning = stopped.warning;
    return result;
  },
};
