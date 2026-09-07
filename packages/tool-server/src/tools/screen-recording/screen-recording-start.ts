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
import { setPointerTrail, setPointerVisible } from "../../utils/simulator-client";
import { startCapture, type PointerControl } from "./capture";
import type { StartRecordingResult } from "./session-guards";

const DEFAULT_TIME_LIMIT_SECONDS = 180;
const MAX_TIME_LIMIT_SECONDS = 600;
/** Comet-tail frames left behind a moving touch, so swipes/drags read as motion. */
const POINTER_TRAIL_LENGTH = 8;
/** Bound each pointer toggle so a wedged sim-server never stalls start/stop. */
const POINTER_REQUEST_TIMEOUT_MS = 2_000;

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
  trimStatic: z
    .boolean()
    .optional()
    .describe(
      "Default true. Collapse stretches where the screen does not change: the first second of " +
        "each still stretch is kept, then unchanged frames are dropped until something moves again, " +
        "so a long recording with brief activity comes back short instead of full of dead air. " +
        "The returned durationMs is the trimmed length; wallClockMs/trimmedMs report what was removed. " +
        "Set false to keep a faithful real-time recording."
    ),
  showTouches: z
    .boolean()
    .optional()
    .describe(
      "Default true. Draw simulator-server's touch visualizer into the recording: a pulse marks each " +
        "tap, a comet trail follows swipes and drags, and paired markers show two-finger pinch/rotate, so " +
        "the video makes clear where every interaction landed. Set false to record the raw screen with no overlay."
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
    interaction: {
      startedMsg: () => "Starting screen recording",
      completedMsg: () => "Started screen recording",
      failedMsg: ({ failureSignal }) =>
        `Failed to start screen recording: ${failureSignal.error_code}`,
    },
    capability,
    description: `Start recording the device screen to a video file (h264 mp4, 30fps at the device's native resolution).
By default stretches where the screen does not change are trimmed out (see trimStatic), so a long session with only brief activity comes back as a short clip instead of minutes of dead air.
By default every tap, swipe, drag, pinch and rotate is drawn into the video as an on-screen touch marker (see showTouches), so the recording shows where each interaction landed.
The recording keeps running across other tool calls (every result carries a reminder) until \`screen-recording-stop\` is called or timeLimitSeconds elapses — immediately after starting, set yourself a reminder/wakeup for the expected end of the recording so it is never left running.
Use when the user wants a video of an interaction, animation, or app behavior — for a single still frame use \`screenshot\` instead.
Returns { status: "recording", timeLimitSeconds, outputFile } — the video is retrieved later by \`screen-recording-stop\`, not by reading outputFile directly.
Fails if a recording is already running on the device, the device is not booted, ffmpeg is not installed, or the platform cannot be recorded (tvOS, Chromium, Vega, HarmonyOS and remote simulators are unsupported).`,
    searchHint: "record video screen capture movie mp4 start filming screencast",
    zodSchema,
    // Resolved inside execute, not declared eagerly: a tvOS udid classifies as
    // iOS by shape, so an eager service would spawn simulator-server for a
    // device it cannot drive and hang on its ready timeout (as in `screenshot`).
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

      // The same simulator-server instance `screenshot` and the input tools use;
      // resolving here attaches to it, or starts it if nothing else needed it yet.
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

      // capture.ts arms the visualizer once the encoder is live and restores it
      // to off when the recording ends. The toggles are best-effort: a failure
      // only costs the overlay, surfaced as a warning at stop.
      const showTouches = params.showTouches ?? true;
      const pointer: PointerControl | undefined = showTouches
        ? makePointerControl(simulator)
        : undefined;

      // Read the flag live per call so `argent enable/disable video-watermark`
      // takes effect without restarting the long-lived tool-server.
      return startCapture(api, {
        streamUrl,
        timeLimitSeconds,
        watermark: isFeatureEnabled("video-watermark"),
        trimStatic: params.trimStatic ?? true,
        pointer,
      });
    },
  };
}

/**
 * Touch-visualizer control for the life of a recording. `enable`'s result
 * reflects only the `show` toggle; the trail is cosmetic.
 *
 * `disable` waits for an in-flight `enable` first: enabling is the one
 * suspension point after a recording is stamped, so a dispose can call
 * `disable` while `show:true` is still outstanding, and unserialized the later
 * `show:true` overtakes `show:false` — leaving the overlay stuck on and drawing
 * markers into subsequent non-recording screenshots.
 */
export function makePointerControl(simulator: SimulatorServerApi): PointerControl {
  let enabling: Promise<unknown> | null = null;
  return {
    async enable() {
      const run = (async () => {
        await setPointerTrail(
          simulator,
          POINTER_TRAIL_LENGTH,
          AbortSignal.timeout(POINTER_REQUEST_TIMEOUT_MS)
        );
        return setPointerVisible(simulator, true, AbortSignal.timeout(POINTER_REQUEST_TIMEOUT_MS));
      })();
      enabling = run;
      try {
        return await run;
      } finally {
        if (enabling === run) enabling = null;
      }
    },
    async disable() {
      const pending = enabling;
      if (pending) await pending.catch(() => {});
      await setPointerVisible(simulator, false, AbortSignal.timeout(POINTER_REQUEST_TIMEOUT_MS));
    },
  };
}
