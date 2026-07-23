import {
  FAILURE_CODES,
  FailureError,
  ServiceRef,
  TypedEventEmitter,
  type DeviceInfo,
  type ServiceBlueprint,
  type ServiceEvents,
} from "@argent/registry";
import type { ChildProcess } from "child_process";
import { promises as fs } from "fs";
import { waitForChildExit } from "../utils/profiler-shared/lifecycle";
import { clearActiveScreenRecording } from "../utils/screen-recording-reminder";

// Session for the `screen-recording-*` tools. One shape for every platform:
// frames come from simulator-server's MJPEG stream and are paced into an ffmpeg
// child that writes the mp4 host-side, so there is nothing device-side to clean
// up. Mirrors the native-profiler session shape.
export const SCREEN_RECORDING_SESSION_NAMESPACE = "ScreenRecordingSession";

type ScreenRecordingSessionFactoryOptions = Record<string, unknown> & { device: DeviceInfo };

export function screenRecordingSessionRef(device: DeviceInfo): ServiceRef {
  return {
    urn: `${SCREEN_RECORDING_SESSION_NAMESPACE}:${device.id}`,
    options: { device },
  };
}

export interface ScreenRecordingSessionApi {
  deviceId: string;
  platform: "ios" | "android";
  /** True from a successful start until stop / cap / unexpected exit. */
  recordingActive: boolean;
  /**
   * True while a start is between its admission check and its session stamp
   * (spawn + readiness are async). Both flags below serialize the tool pair:
   * a second start or a stop admitted inside that window would race the
   * shared session state.
   */
  startPending: boolean;
  /** True while a stop is running; a concurrent start/stop must not interleave. */
  stopPending: boolean;
  /**
   * Set the moment dispose() begins (process shutdown). A start suspended at a
   * pre-spawn await (resolving ffmpeg, connecting to the frame stream) checks
   * this immediately before spawning and aborts — otherwise it would spawn an
   * encoder AFTER dispose already ran, orphaning a process that `pendingChild`
   * reaping can no longer see. Never reset (dispose is terminal).
   */
  disposed: boolean;
  /**
   * True once the capture ended (cap, crash) but the video has not been handed
   * over by `screen-recording-stop` yet — the state the reminder note keeps
   * pointing at.
   */
  pendingRetrieval: boolean;
  /** The ffmpeg child encoding the paced frames into the output file. */
  captureProcess: ChildProcess | null;
  /**
   * Child spawned by an in-flight start that has not stamped the session yet
   * (readiness pending). Tracked separately so dispose() can reap a capture
   * that is mid-startup at shutdown — `captureProcess` is success-only.
   */
  pendingChild: ChildProcess | null;
  /** Host path ffmpeg is writing the video to. */
  outputFile: string | null;
  /** Temp copy of the watermark logo ffmpeg reads; removed when the capture ends. */
  logoFile: string | null;
  /** Why the watermark was requested but not drawn; surfaced by stop's warning. */
  watermarkSkipped: string | null;
  /** Live subscription to simulator-server's frame stream. */
  frameStream: { readonly error: Error | null; close(): void } | null;
  /**
   * The frame stream's drop error, captured when the pump is torn down (cap,
   * crash, stop) before `frameStream` is nulled — so a stop arriving after a
   * cap/crash can still surface the "video may freeze" hint, which it could not
   * once `frameStream` (and its `error`) was gone.
   */
  lastFrameStreamError: Error | null;
  /** Interval pacing frames onto the fixed output frame rate. */
  pumpTimer: NodeJS.Timeout | null;
  wallClockStartMs: number | null;
  /** When the capture stopped producing frames (cap fired, process exited, stop signaled). */
  wallClockEndMs: number | null;
  /** Auto-stop cap applied to this capture. */
  timeLimitSeconds: number | null;
  /** Timer that ends the capture at the cap. */
  recordingTimeout: NodeJS.Timeout | null;
  recordingTimedOut: boolean;
  recordingExitedUnexpectedly: boolean;
  lastExitInfo: { code: number | null; signal: string | null } | null;
}

// Dispose only fires on process shutdown, where an in-flight recording is
// being abandoned. Closing ffmpeg's stdin is what finalizes the container, so
// give that one short grace before SIGKILL — shutdown must not be held up by a
// slow finalize, but a playable file is worth a moment.
const DISPOSE_FINALIZE_GRACE_MS = 1_500;
const DISPOSE_REAP_MS = 1_000;

function clearLiveState(state: ScreenRecordingSessionApi): void {
  state.recordingActive = false;
  state.startPending = false;
  state.stopPending = false;
  state.pendingRetrieval = false;
  state.captureProcess = null;
  state.pendingChild = null;
  state.frameStream = null;
  state.lastFrameStreamError = null;
  state.recordingTimedOut = false;
  state.recordingExitedUnexpectedly = false;
  state.lastExitInfo = null;
}

export const screenRecordingSessionBlueprint: ServiceBlueprint<
  ScreenRecordingSessionApi,
  DeviceInfo
> = {
  namespace: SCREEN_RECORDING_SESSION_NAMESPACE,

  getURN(device: DeviceInfo) {
    return `${SCREEN_RECORDING_SESSION_NAMESPACE}:${device.id}`;
  },

  async factory(_deps, _payload, options) {
    const opts = options as unknown as ScreenRecordingSessionFactoryOptions | undefined;
    if (!opts?.device) {
      throw new FailureError(
        `${SCREEN_RECORDING_SESSION_NAMESPACE}.factory requires a resolved DeviceInfo via options.device. ` +
          `Use screenRecordingSessionRef(device) when registering the service ref.`,
        {
          error_code: FAILURE_CODES.SCREEN_RECORDING_FACTORY_OPTIONS_MISSING,
          failure_stage: "screen_recording_session_factory_options",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }
    const { device } = opts;
    if (device.platform !== "ios" && device.platform !== "android") {
      throw new FailureError(
        `${SCREEN_RECORDING_SESSION_NAMESPACE}: unsupported platform "${device.platform}" for device '${device.id}'.`,
        {
          error_code: FAILURE_CODES.SCREEN_RECORDING_WRONG_PLATFORM,
          failure_stage: "screen_recording_session_factory_options",
          failure_area: "tool_server",
          error_kind: "unsupported",
        }
      );
    }
    const state: ScreenRecordingSessionApi = {
      deviceId: device.id,
      platform: device.platform,
      recordingActive: false,
      startPending: false,
      stopPending: false,
      disposed: false,
      pendingRetrieval: false,
      captureProcess: null,
      pendingChild: null,
      outputFile: null,
      logoFile: null,
      watermarkSkipped: null,
      frameStream: null,
      lastFrameStreamError: null,
      pumpTimer: null,
      wallClockStartMs: null,
      wallClockEndMs: null,
      timeLimitSeconds: null,
      recordingTimeout: null,
      recordingTimedOut: false,
      recordingExitedUnexpectedly: false,
      lastExitInfo: null,
    };

    const events = new TypedEventEmitter<ServiceEvents>();

    return {
      api: state,
      dispose: async () => {
        // Synchronously, before any await: a start suspended at a pre-spawn
        // await will observe this and abort instead of spawning an orphan the
        // teardown below can no longer reap.
        state.disposed = true;
        if (state.recordingTimeout) {
          clearTimeout(state.recordingTimeout);
          state.recordingTimeout = null;
        }
        // Stop producing frames first: the pump would otherwise keep writing
        // into a pipe we are about to close.
        if (state.pumpTimer) {
          clearInterval(state.pumpTimer);
          state.pumpTimer = null;
        }
        state.frameStream?.close();

        // A start still mid-readiness at shutdown has a live child that
        // `captureProcess` (success-only) can't see — reap it here or it
        // records forever.
        if (state.pendingChild) {
          try {
            state.pendingChild.kill("SIGKILL");
          } catch {
            // already dead
          }
        }

        try {
          const child = state.captureProcess;
          if (child) {
            // Closing stdin is ffmpeg's normal finalize path, so the abandoned
            // file still has a chance to be playable.
            if (child.stdin?.writable) child.stdin.end();
            if (!(await waitForChildExit(child, DISPOSE_FINALIZE_GRACE_MS))) {
              try {
                child.kill("SIGKILL");
              } catch {
                // already dead
              }
              await waitForChildExit(child, DISPOSE_REAP_MS);
            }
          }
        } finally {
          // The logo temp is normally removed by stop; shutdown abandons that
          // path, so clean it up here rather than leaking one file per
          // abandoned recording.
          if (state.logoFile) {
            await fs.rm(state.logoFile, { force: true }).catch(() => {});
            state.logoFile = null;
          }
          clearLiveState(state);
          // The reminder must not outlive the process that owns the capture.
          clearActiveScreenRecording(state.deviceId);
        }
      },
      events,
    };
  },
};
