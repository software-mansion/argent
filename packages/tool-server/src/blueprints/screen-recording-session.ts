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
import { recordReapedSession } from "../utils/reaped-sessions";

// Session for the `screen-recording-*` tools, one shape for both platforms:
// frames come from simulator-server's MJPEG stream and are paced into an ffmpeg
// child that writes the mp4 host-side, so there is nothing device-side to clean
// up. Mirrors the native-profiler session.
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
   * True from a start's admission check until its session stamp (spawn and
   * readiness are async). With `stopPending`, keeps a second start or a stop
   * admitted inside that window from racing the shared session state.
   */
  startPending: boolean;
  /** True while a stop is running; a concurrent start/stop must not interleave. */
  stopPending: boolean;
  /**
   * Set the moment dispose() begins — process shutdown, or a
   * `stop-all-simulator-servers` reaping this device (scoped or machine-wide).
   * A start suspended at a pre-spawn await checks this immediately before
   * spawning and aborts; otherwise it would spawn an encoder AFTER dispose ran,
   * orphaning a process `pendingChild` reaping can no longer see. Never reset.
   */
  disposed: boolean;
  /**
   * Capture ended (cap, crash) but `screen-recording-stop` has not handed the
   * video over yet — the state the reminder note keeps pointing at.
   */
  pendingRetrieval: boolean;
  /** The ffmpeg child encoding the paced frames into the output file. */
  captureProcess: ChildProcess | null;
  /**
   * Child of an in-flight start that has not stamped the session yet, tracked
   * separately so dispose() can reap a capture that is mid-startup —
   * `captureProcess` is success-only.
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
   * The frame stream's drop error, stashed when the pump is torn down (cap,
   * crash, stop) before `frameStream` is nulled, so a stop arriving after a
   * cap/crash can still surface the "video may freeze" hint.
   */
  lastFrameStreamError: Error | null;
  /** Interval pacing frames onto the fixed output frame rate. */
  pumpTimer: NodeJS.Timeout | null;
  /** Drop unchanged frames past a short grace so dead stretches don't pad the video. */
  trimStatic: boolean;
  /** Frames the pump has fed the encoder; the output video's length in frames. */
  framesWritten: number;
  /** Whether trimming ever collapsed a static stretch (crossed the grace and dropped frames). */
  trimmedAnyFrames: boolean;
  /** Restores the touch visualizer to off; set for a recording that asked for it. */
  pointerDisable: (() => Promise<void>) | null;
  /** The touch visualizer was requested but simulator-server would not enable it. */
  pointerFailed: boolean;
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

// Dispose abandons an in-flight recording — process shutdown, or a
// `stop-all-simulator-servers` reaping this device-owned service — so the video
// is a best-effort salvage rather than something a caller is waiting on:
// closing ffmpeg's stdin is what finalizes the container, so give that one
// short grace before SIGKILL. `screen-recording-stop` has its own, longer
// finalize contract.
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
  state.pointerDisable = null;
  state.pointerFailed = false;
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
      trimStatic: true,
      framesWritten: 0,
      trimmedAnyFrames: false,
      pointerDisable: null,
      pointerFailed: false,
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
        // Before any await, so a start suspended at a pre-spawn await aborts
        // instead of spawning an orphan the teardown below can no longer reap.
        state.disposed = true;
        // Decided BEFORE the teardown below clears the flags it reads: a
        // capture still encoding, a start mid-flight and one waiting to be
        // handed over all owe the caller a video.
        const hadUnretrievedCapture =
          state.recordingActive || state.startPending || state.pendingRetrieval;
        const abandonedOutput = state.outputFile;
        if (state.recordingTimeout) {
          clearTimeout(state.recordingTimeout);
          state.recordingTimeout = null;
        }
        // Stop producing frames first; the pump would keep writing into a
        // pipe we are about to close.
        if (state.pumpTimer) {
          clearInterval(state.pumpTimer);
          state.pumpTimer = null;
        }
        state.frameStream?.close();

        // The overlay is sim-server global state that must not outlive the
        // capture.
        if (state.pointerDisable) {
          const disable = state.pointerDisable;
          state.pointerDisable = null;
          await disable().catch(() => {});
        }

        // A start still mid-readiness has a live child `captureProcess`
        // (success-only) can't see — reap it here or it records forever.
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
          // The logo temp is normally removed by stop, a path this teardown
          // abandons — otherwise one file leaks per abandoned recording.
          if (state.logoFile) {
            await fs.rm(state.logoFile, { force: true }).catch(() => {});
            state.logoFile = null;
          }
          clearLiveState(state);
          // The reminder must not outlive the capture it points at.
          clearActiveScreenRecording(state.deviceId);
          // Leave a breadcrumb so the owner's `screen-recording-stop` reports
          // the teardown instead of "you never started a recording": the next
          // resolve builds a session that has never heard of this capture, and
          // nothing else would say the salvaged file exists.
          if (hadUnretrievedCapture) {
            recordReapedSession(
              "screen-recording",
              state.deviceId,
              abandonedOutput
                ? `ffmpeg was given a moment to finalize the container first, so the video ` +
                    `captured up to that point is usually playable at ${abandonedOutput} — ` +
                    `check it before re-recording.`
                : undefined
            );
          }
        }
      },
      events,
    };
  },
};
