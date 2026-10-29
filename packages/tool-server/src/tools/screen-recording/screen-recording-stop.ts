import { basename } from "node:path";
import { z } from "zod";
import type { ToolDefinition, Registry } from "@argent/registry";
import {
  screenRecordingSessionRef,
  assertRecordingNotTerminating,
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
  outputFile: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Expected outputFile from start. Required to retrieve a completed stop again after a lost connection."
    ),
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
  encodingComplete?: boolean;
  /**
   * Length of the returned video — frame-derived while trimming is on (the
   * default). Null when the start stamp is missing or debug encoding failed.
   */
  durationMs: number | null;
  /** Real elapsed recording time. Present only when trimming actually removed frames. */
  wallClockMs?: number;
  /** Dead-air time removed. Present only when trimming actually removed frames. */
  trimmedMs?: number;
  /**
   * Foldables only, and only when it happened: how many times the capture
   * moved to the other panel because the device was folded or unfolded. The
   * video keeps one size, the panel it started on.
   */
  panelSwitches?: number;
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
  longRunning: true,
  interaction: {
    startedMsg: () => "Stopping screen recording",
    completedMsg: ({ result }) => `Saved screen recording ${result.video.filename}`,
    failedMsg: ({ failureSignal }) =>
      `Failed to stop screen recording: ${failureSignal.error_code}`,
  },
  capability,
  description: `Stop the screen recording started by \`screen-recording-start\` and retrieve the video: frame capture ends and ffmpeg finalizes the mp4.
Debug encoding can take longer to finish. For a partial video, debug returns encodingComplete: false, durationMs: null and an encoding warning. If no readable video was saved, the tool fails with encoder diagnostics. Failed encoding can discard captured JPEGs. After a lost stop connection, pass the outputFile returned by start to retrieve the completed result or failure again. This retry is available until another recording starts or the session is torn down. Wait for stop to return before shutting down the tool-server.
Also retrieves the video when the recording already ended on its own (time limit reached, capture process died); call it even after the cap fired.
Use when the interaction being captured is finished, or a tool-result note reminds you a recording is still running.
Returns { video, durationMs, wallClockMs?, trimmedMs?, panelSwitches?, encodingComplete?, warning? }; video is a downloadable artifact materialized to a local path. When static-frame trimming removed dead air, durationMs is the trimmed video length and wallClockMs/trimmedMs report the real duration and how much was cut. On a foldable simulator, the recording follows the panel that shows the UI. panelSwitches gives the number of panel changes. The video keeps the size of the first panel. warning is set when argent could not find that panel during the recording.
Fails if no running, pending, or cached completed recording exists for the given udid.`,
  searchHint: "stop end finish screen recording video capture save retrieve",
  zodSchema,
  services: (params) => ({
    session: screenRecordingSessionRef(resolveDevice(params.udid)),
  }),
  async execute(services, params, ctx) {
    const api = services.session as ScreenRecordingSessionApi;
    const device = resolveDevice(params.udid);
    assertSupported("screen-recording-stop", capability, device);

    const outputFile = api.outputFile ?? api.finishedRecording?.outputFile;
    if (outputFile) ctx?.onRecordingOutput?.(api.deviceId, outputFile);
    // The capture encodes straight to the final mp4, so the file is ready as
    // soon as this returns — no post-processing pass.
    const stopped = await stopCapture(api, params.outputFile);

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
    if (stopped.encodingComplete !== undefined) result.encodingComplete = stopped.encodingComplete;
    if (stopped.wallClockMs !== undefined) result.wallClockMs = stopped.wallClockMs;
    if (stopped.trimmedMs !== undefined) result.trimmedMs = stopped.trimmedMs;
    if (stopped.panelSwitches !== undefined) result.panelSwitches = stopped.panelSwitches;
    if (stopped.warning) result.warning = stopped.warning;
    return result;
  },
};

export function createScreenRecordingStopTool(registry: Registry): typeof screenRecordingStopTool {
  return {
    ...screenRecordingStopTool,
    services: (params) => {
      assertRecordingNotTerminating(registry, resolveDevice(params.udid));
      return screenRecordingStopTool.services(params);
    },
  };
}
