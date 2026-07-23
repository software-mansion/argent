import { z } from "zod";
import { FAILURE_CODES, FailureError, type Registry, type ToolDefinition } from "@argent/registry";
import {
  screenRecordingSessionRef,
  type ScreenRecordingSessionApi,
} from "../../blueprints/screen-recording-session";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { resolveDevice } from "../../utils/device-info";
import { assertSupported } from "../../utils/capability";
import { isTvOsSimulator } from "../../utils/ios-devices";
import { isFeatureEnabled } from "@argent/configuration-core";
import { startCapture } from "./capture";
import type { StartRecordingResult } from "./session-guards";

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
      `Auto-stop cap in seconds (default ${DEFAULT_TIME_LIMIT_SECONDS}, max ${MAX_TIME_LIMIT_SECONDS}). ` +
        `Set it to slightly more than the interaction you plan to capture.`
    ),
});

const capability = {
  apple: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
} as const;

export function createScreenRecordingStartTool(
  registry: Registry
): ToolDefinition<z.infer<typeof zodSchema>, StartRecordingResult> {
  return {
    id: "screen-recording-start",
    capability,
    description: `Start recording the device screen to a video file (h264 mp4, constant 30fps at the device's native resolution).
The recording keeps running across other tool calls (every result carries a reminder) until \`screen-recording-stop\` is called or timeLimitSeconds elapses — immediately after starting, set yourself a reminder/wakeup for the expected end of the recording so it is never left running.
Use when the user wants a video of an interaction, animation, or app behavior — for a single still frame use \`screenshot\` instead.
Returns { status: "recording", timeLimitSeconds, outputFile } — the video is retrieved later by \`screen-recording-stop\`, not by reading outputFile directly.
Fails if a recording is already running on the device, the device is not booted, ffmpeg is not installed, or the platform cannot be recorded (tvOS, Chromium, Vega and remote simulators are unsupported).`,
    searchHint: "record video screen capture movie mp4 start filming screencast",
    zodSchema,
    // simulator-server is resolved inside execute, not declared here: a tvOS
    // udid classifies as iOS by shape, and an eager service would spawn
    // simulator-server for a device it cannot drive and hang on its ready
    // timeout (same reasoning as `screenshot`).
    services: (params) => ({
      session: screenRecordingSessionRef(resolveDevice(params.udid)),
    }),
    async execute(services, params) {
      const api = services.session as ScreenRecordingSessionApi;
      const device = resolveDevice(params.udid);
      assertSupported("screen-recording-start", capability, device);

      // Distinguish tvOS from iOS by runtime — shape alone can't. tvOS has no
      // simulator-server backend, so say so here instead of failing deeper in.
      if (device.platform === "ios" && (await isTvOsSimulator(params.udid))) {
        throw new FailureError(
          `Screen recording is not supported on tvOS simulators (device ${params.udid}).`,
          {
            error_code: FAILURE_CODES.SCREEN_RECORDING_WRONG_PLATFORM,
            failure_stage: "screen_recording_platform_check",
            failure_area: "tool_server",
            error_kind: "unsupported",
          }
        );
      }

      const timeLimitSeconds = params.timeLimitSeconds ?? DEFAULT_TIME_LIMIT_SECONDS;

      // Frames come from the same simulator-server instance that already serves
      // `screenshot` and every input tool; resolving it here attaches to that
      // instance (or starts it, if this tool is the first to need it).
      const ref = simulatorServerRef(device);
      const simulator = (await registry.resolveService(ref.urn, ref.options)) as SimulatorServerApi;
      const streamUrl = simulator.streamUrl;
      if (!streamUrl || !/^https?:\/\//.test(streamUrl)) {
        throw new FailureError(
          `simulator-server is not exposing a frame stream for device ${device.id}, so there is ` +
            `nothing to record. Remote (\`remote:\`) simulators stream over a transport this tool ` +
            `cannot read; otherwise the bundled simulator-server build predates streaming support.`,
          {
            error_code: FAILURE_CODES.SCREEN_RECORDING_STREAM_UNAVAILABLE,
            failure_stage: "screen_recording_resolve_stream",
            failure_area: "tool_server",
            error_kind: "unsupported",
            failure_command: "simulator_server",
          }
        );
      }

      // Read the flag live per call so `argent enable/disable video-watermark`
      // takes effect without restarting the long-lived tool-server.
      return startCapture(api, {
        streamUrl,
        timeLimitSeconds,
        watermark: isFeatureEnabled("video-watermark"),
      });
    },
  };
}
