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
import { stopMacosCapture } from "./capture-macos";

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
  /**
   * Foldables only, and only when it happened: how many times the capture
   * moved to the other panel because the device was folded or unfolded. The
   * video keeps one size, the panel it started on.
   */
  panelSwitches?: number;
  warning?: string;
}

const capability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
  macos: { app: true, catalyst: true },
} as const;

const zodSchema = z.object({
  udid: z
    .string()
    .describe(
      "Target ID from `list-devices`.<flag:macos-apps> For a Mac app, use its device ID, such as `macos-app-com.example.notes`.</flag:macos-apps>"
    ),
});

export const screenRecordingStopTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  ScreenRecordingStopResult
> = {
  id: "screen-recording-stop",
  description: `Stop a screen recording and retrieve its MP4. Call this even after the time limit or an early capture exit. The tool downloads recordings from remote simulators.
Returns the saved \`video\` and its \`durationMs\`. When trimming removes still sections, \`wallClockMs\` gives the original duration and \`trimmedMs\` gives the time removed. On a foldable simulator the video follows the active panel, keeps the first panel's size, and reports any \`panelSwitches\`.
Check \`warning\` for capture problems, such as an undetected foldable panel.<flag:macos-apps> On a Mac app, a warning can report when the video held its last frame or omitted a protected window. Quitting or restarting the app or connecting to it from another Argent tool-server during capture can discard the recording. A stop error can include a path to a recoverable video.</flag:macos-apps>`,
  zodSchema,
  searchHint: "stop end finish screen recording video capture save retrieve",
  interaction: {
    startedMsg: () => "Stopping screen recording",
    completedMsg: ({ result }) => `Saved screen recording ${result.video.filename}`,
    failedMsg: ({ failureSignal }) =>
      `Failed to stop screen recording: ${failureSignal.error_code}`,
  },
  capability,
  // A remote stop waits for the runner to finish the mp4, downloads it and
  // re-encodes it locally, which routinely exceeds the 30s MCP fetch timeout.
  longRunning: true,
  services: (params) => ({
    session: screenRecordingSessionRef(resolveDevice(params.udid)),
  }),
  async execute(services, params, ctx) {
    const api = services.session as ScreenRecordingSessionApi;
    const device = resolveDevice(params.udid);
    assertSupported("screen-recording-stop", capability, device);

    // A local capture encodes straight to the final mp4, so the file is ready
    // as soon as this returns; a remote one ends the runner-side recording,
    // downloads it, and post-processes it here; a Mac app ends its recording
    // and writes the mp4 out.
    const stopped =
      device.platform === "ios-remote"
        ? await stopRemoteCapture(api)
        : device.platform === "macos"
          ? await stopMacosCapture(api)
          : await stopCapture(api);

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
    if (stopped.panelSwitches !== undefined) result.panelSwitches = stopped.panelSwitches;
    if (stopped.warning) result.warning = stopped.warning;
    return result;
  },
};
