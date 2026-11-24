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
import { isRemoteTvOsSimulator } from "../../utils/sim-remote";
import { isFeatureEnabled } from "@argent/configuration-core";
import { setPointerTrail, setPointerVisible } from "../../utils/simulator-client";
import { resolveLivePanel, streamUrlForScreen, unresolvedPanelNote } from "../../utils/foldable";
import { startCapture, type PanelFollow, type PointerControl } from "./capture";
import { startRemoteCapture } from "./capture-remote";
import type { StartRecordingResult } from "./session-guards";
import { startIosDeviceCapture } from "./ios-device-stream/start-device-capture";
import { startMacosCapture } from "./capture-macos";
import { resolveMacosApp } from "../../utils/macos-input";

const DEFAULT_TIME_LIMIT_SECONDS = 180;
const MAX_TIME_LIMIT_SECONDS = 600;
/** Comet-tail frames left behind a moving touch, so swipes/drags read as motion. */
const POINTER_TRAIL_LENGTH = 8;
/** Bound each pointer toggle so a wedged sim-server never stalls start/stop. */
const POINTER_REQUEST_TIMEOUT_MS = 2_000;

const capability = {
  // A cabled iPhone records through a host-side CoreMediaIO helper, not
  // simulator-server (see ios-device-stream/).
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
  // argent's library records the app's window from inside the app.
  macos: { app: true, catalyst: true },
} as const;

const zodSchema = z.object({
  udid: z
    .string()
    .describe(
      "Target ID from `list-devices`.<flag:macos-apps> For a Mac app, use its device ID, such as `macos-app-com.example.notes`.</flag:macos-apps>"
    ),
  timeLimitSeconds: z
    .number()
    .int()
    .min(1)
    .max(MAX_TIME_LIMIT_SECONDS)
    .optional()
    .describe(
      `Auto-stop cap in seconds (default ${DEFAULT_TIME_LIMIT_SECONDS}). ` +
        `Set it to slightly more than the interaction you plan to capture.`
    ),
  trimStatic: z
    .boolean()
    .optional()
    .describe(
      "Default true. Collapse stretches where the screen does not change: the first second of " +
        "each still stretch is kept, then unchanged frames are dropped until something moves again, " +
        "so a long recording with brief activity comes back short instead of full of dead air. " +
        "Set false to keep a faithful real-time recording."
    ),
  showTouches: z
    .boolean()
    .optional()
    .describe(
      "Draw touch markers in the video (default true). Recordings of physical iPhones have no touch markers." +
        "<flag:macos-apps> For Mac apps, this shows the agent's pointer, a click ring, and a dot while a mouse button is held.</flag:macos-apps>"
    ),
});

export function createScreenRecordingStartTool(
  registry: Registry
): ToolDefinition<z.infer<typeof zodSchema>, StartRecordingResult> {
  return {
    id: "screen-recording-start",
    description: `Start an MP4 recording of the device screen<flag:macos-apps> or Mac app window</flag:macos-apps>. Use when the user wants a video of an interaction or animation. Use \`screenshot\` for a still image.
Recording continues across tool calls until stopped or until the time limit. Set a reminder as soon as recording starts. The start result returns \`outputFile\` on the tool-server host. Retrieve the video with \`screen-recording-stop\`, even after the time limit.
Start fails if the target is unavailable or already has a recording waiting to be stopped or retrieved. Local simulators, Android emulators and devices, and cabled iPhones require ffmpeg. On a physical iPhone, check for \`transportType: "wired"\` in \`list-devices\` and have the user allow camera access for \`ios-screen-stream\` if prompted on the first recording. tvOS, Chromium<flag:harmonyos>, HarmonyOS</flag:harmonyos>, and Vega are unsupported.<flag:macos-apps>
For a Mac app started by Argent, restore its window and move it fully onto one display. Capture protection blocks recording. Mac app recording needs neither Screen Recording permission nor ffmpeg and continues while the Mac is locked. If start returns \`MACOS_APP_LIBRARY_OUTDATED\`, run \`restart-app\` and retry.</flag:macos-apps>`,
    zodSchema,
    searchHint: "record video screen capture movie mp4 start filming screencast",
    interaction: {
      startedMsg: () => "Starting screen recording",
      completedMsg: () => "Started screen recording",
      failedMsg: ({ failureSignal }) =>
        `Failed to start screen recording: ${failureSignal.error_code}`,
    },
    capability,
    // A remote start first ends a leftover runner-side recording, which can
    // take minutes, past the 30s MCP fetch timeout.
    longRunning: true,
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
      const isTvOs =
        device.platform === "ios-remote"
          ? await isRemoteTvOsSimulator(params.udid)
          : device.platform === "ios" &&
            device.kind !== "device" &&
            (await isTvOsSimulator(params.udid));
      if (isTvOs) {
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
      // Read the watermark flag live per call so `argent enable/disable
      // video-watermark` takes effect without restarting the long-lived
      // tool-server.
      const watermark = isFeatureEnabled("video-watermark");
      const showTouches = params.showTouches ?? true;

      if (device.platform === "ios-remote") {
        // Nothing local to encode: simulator-server records on the runner and
        // the mp4 is fetched at stop. The touch visualizer is drawn there too,
        // into the frames before they are encoded.
        return startRemoteCapture(api, {
          timeLimitSeconds,
          watermark,
          trimStatic: params.trimStatic ?? true,
          showTouches,
        });
      }

      if (device.platform === "macos") {
        const app = await resolveMacosApp(registry, device, "screen-recording-start");
        return startMacosCapture(api, app, {
          timeLimitSeconds,
          watermark,
          trimStatic: params.trimStatic ?? true,
          showTouches,
        });
      }

      if (device.platform === "ios" && device.kind === "device") {
        return startIosDeviceCapture(api, device.id, {
          timeLimitSeconds,
          watermark,
          trimStatic: params.trimStatic ?? true,
          showTouches: params.showTouches,
        });
      }

      // The same simulator-server instance `screenshot` and the input tools use;
      // resolving here attaches to it, or starts it if nothing else needed it yet.
      const ref = simulatorServerRef(device);
      const simulator = (await registry.resolveService(ref.urn, ref.options)) as SimulatorServerApi;
      let streamUrl = simulator.streamUrl;
      if (!streamUrl || !/^https?:\/\//.test(streamUrl)) {
        throw new FailureError(
          `simulator-server is not exposing a frame stream for device ${device.id}, so there is ` +
            `nothing to record: the bundled simulator-server build predates streaming support.`,
          {
            error_code: FAILURE_CODES.SCREEN_RECORDING_STREAM_UNAVAILABLE,
            failure_stage: "screen_recording_resolve_stream",
            failure_area: "tool_server",
            error_kind: "unsupported",
            failure_command: "simulator_server",
          }
        );
      }

      // A foldable's stream is per panel. The recording starts on the panel the
      // device renders to now, and follows it across folds (capture.ts) with
      // the same resolution every touch and screenshot makes. A start that
      // resolves nothing records the main screen, as every command then
      // targets it, says so in its result, and counts it for stop's warning;
      // the checks move the capture as soon as a source answers.
      let followPanel: PanelFollow | undefined;
      let warning: string | undefined;
      if (simulator.display?.foldable) {
        const base = streamUrl;
        const initial = await resolveLivePanel(device.id);
        streamUrl = streamUrlForScreen(base, initial.screen);
        followPanel = {
          initial,
          streamUrlForScreen: (screen) => streamUrlForScreen(base, screen),
          resolveLivePanel: () => resolveLivePanel(device.id),
        };
        if (initial.source === "unknown") {
          warning =
            `${unresolvedPanelNote(device.id, initial.reason, "the recording started on", simulator.display.panels)} ` +
            "It moves to the panel the device renders to as soon as a check resolves it.";
        }
      }

      // capture.ts arms the visualizer once the encoder is live and restores it
      // to off when the recording ends. The toggles are best-effort: a failure
      // only costs the overlay, surfaced as a warning at stop.
      const pointer: PointerControl | undefined = showTouches
        ? makePointerControl(simulator)
        : undefined;

      const started = await startCapture(api, {
        streamUrl,
        timeLimitSeconds,
        watermark,
        trimStatic: params.trimStatic ?? true,
        pointer,
        followPanel,
      });
      return warning !== undefined ? { ...started, warning } : started;
    },
  };
}

/**
 * Touch-visualizer control for the life of a recording. `enable`'s result
 * reflects only the `show` toggle; the trail is cosmetic.
 *
 * Neither toggle names a screen: on a foldable the server then applies the
 * setting to every panel, so the markers keep landing in the recording after
 * it has moved to the other panel. Each touch is drawn on the stream of the
 * screen the touch named, which is the one the recording follows.
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
