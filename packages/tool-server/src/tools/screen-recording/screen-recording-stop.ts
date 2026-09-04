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
import { stopRemoteCapture } from "./capture-remote";

const zodSchema = z.object({
  udid: z
    .string()
    .describe("Target device id from `list-devices` (iOS Simulator UDID or Android serial)."),
});

/**
 * Wire hint asking the client to save the mp4 durably instead of in temp; the
 * client resolves the real path (and may redirect it via `recordings.directory`).
 * Must stay constant: any other value falls off the client's allowlist and the
 * recording is demoted to the disposable cache.
 */
const RECORDINGS_DIR = ".argent/recordings";

interface ScreenRecordingStopResult {
  /** The finished recording (mp4). */
  video: ArtifactHandle;
  /**
   * Length of the returned video — frame-derived while trimming is on (the
   * default). Null only with `trimStatic: false` and no recorded start stamp.
   */
  durationMs: number | null;
  /** Real elapsed recording time. Present only when trimming actually removed frames. */
  wallClockMs?: number;
  /** Dead-air time removed. Present only when trimming actually removed frames. */
  trimmedMs?: number;
  warning?: string;
}

const capability = {
  apple: { simulator: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
} as const;

export const screenRecordingStopTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  ScreenRecordingStopResult
> = {
  id: "screen-recording-stop",
  interaction: {
    startedMsg: () => "Stopping screen recording",
    completedMsg: ({ result }) => `Saved screen recording ${result.video.filename}`,
    failedMsg: ({ failureSignal }) =>
      `Failed to stop screen recording: ${failureSignal.error_code}`,
  },
  capability,
  description: `Stop the screen recording started by \`screen-recording-start\` and retrieve the video: frame capture ends and ffmpeg finalizes the mp4.
Also retrieves the video when the recording already ended on its own (time limit reached, capture process died) — call it even after the cap fired.
On a remote (\`remote:\`) simulator this is what ends the runner-side recording and downloads the mp4, so a large capture takes a moment to transfer.
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

    // A local capture encodes straight to the final mp4, so the file is ready
    // as soon as this returns; a remote one ends the runner-side recording,
    // downloads it, and post-processes it here.
    const stopped =
      device.platform === "ios-remote" ? await stopRemoteCapture(api) : await stopCapture(api);

    // After the stop, so a "no active recording" failure isn't masked by a
    // missing artifact store.
    const artifacts = requireArtifacts(ctx);
    const video = await artifacts.register({
      hostPath: stopped.outputFile,
      kind: "screen-recording",
      mimeType: "video/mp4",
      // Drop the internal `argent-` temp-file prefix from the saved name.
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
