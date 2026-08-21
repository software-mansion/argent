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
import type { ServerRecordingResult } from "../utils/simulator-client";

// Session for the `screen-recording-*` tools. One shape for every platform and
// for both capture paths: simulator-server records and muxes the video itself
// where its build supports it, otherwise its MJPEG stream is paced into a host
// ffmpeg child. Either way the video is host-side, so there is nothing
// device-side to clean up. Mirrors the native-profiler session shape.
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
   * Set the moment dispose() begins — process shutdown, or a
   * `stop-all-simulator-servers` that reaps this device (a scoped call
   * including it, or an unscoped machine-wide sweep). A start suspended at a
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
  /** Host path the finished video lands at. */
  outputFile: string | null;
  /**
   * Finalizes a recording simulator-server is running and hands back the muxed
   * video. Set only while a server-side capture is live, so it doubles as the
   * marker for which side owns the recording: with it set there is no capture
   * child, no frame stream and no pump, and stop goes to the server.
   */
  serverStop: (() => Promise<ServerRecordingResult>) | null;
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
  /** Drop unchanged frames past a short grace so dead stretches don't pad the video. */
  trimStatic: boolean;
  /** Frames the pump has fed the encoder; the output video's length in frames. */
  framesWritten: number;
  /** Whether trimming ever collapsed a static stretch (crossed the grace and dropped frames). */
  trimmedAnyFrames: boolean;
  /** Restore the touch visualizer to off; set while it is on for this recording. */
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

// Dispose fires on process shutdown, and on `stop-all-simulator-servers` (which
// reaps every device-owned service, `ScreenRecordingSession` among them) — the
// call every agent makes at session end. Either way an in-flight recording is
// being abandoned, so the video is a best-effort salvage rather than something a
// caller is waiting on: closing ffmpeg's stdin is what finalizes the container,
// so give that one short grace before SIGKILL. A caller that wants the file
// calls `screen-recording-stop`, which has its own (longer) finalize contract.
const DISPOSE_FINALIZE_GRACE_MS = 1_500;
const DISPOSE_REAP_MS = 1_000;

function clearLiveState(state: ScreenRecordingSessionApi): void {
  state.recordingActive = false;
  state.startPending = false;
  state.stopPending = false;
  state.pendingRetrieval = false;
  state.captureProcess = null;
  state.pendingChild = null;
  state.serverStop = null;
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
      serverStop: null,
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
        // Synchronously, before any await: a start suspended at a pre-spawn
        // await will observe this and abort instead of spawning an orphan the
        // teardown below can no longer reap.
        state.disposed = true;
        // Whether this dispose is destroying an unretrieved capture, decided
        // BEFORE the teardown below clears the flags it is read from. Both
        // states owe the caller a video: one is still encoding, the other
        // finished and is waiting to be handed over.
        const hadUnretrievedCapture =
          state.recordingActive || state.startPending || state.pendingRetrieval;
        const abandonedOutput = state.outputFile;
        // Which side held the video, read before the teardown below hands
        // `serverStop` over — the two paths owe the caller opposite stories.
        const serverCapture = state.serverStop !== null;
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

        // Restore the touch visualizer if this recording turned it on — the
        // overlay is sim-server global state that must not outlive the capture.
        if (state.pointerDisable) {
          const disable = state.pointerDisable;
          state.pointerDisable = null;
          await disable().catch(() => {});
        }

        // A recording running inside simulator-server outlives this process, and
        // it accumulates frames until something stops it — so end it here even
        // though the video is being abandoned.
        if (state.serverStop) {
          const stop = state.serverStop;
          state.serverStop = null;
          await stop().catch(() => {});
        }

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
          // Leave a breadcrumb so the owner's `screen-recording-stop` reports
          // the teardown instead of "you never started a recording": nothing
          // else would ever say the capture existed, and the next resolve
          // builds a session that has never heard of it.
          if (hadUnretrievedCapture) {
            // Where that leaves the video depends on the path. ffmpeg has been
            // writing the host file all along and the stdin close above
            // finalizes it; a server-side recording is muxed inside
            // simulator-server and only `screen-recording-stop` ever copies it
            // out, so the path start handed the caller was never written — and
            // the stop above ended the recording that was the only way to
            // reach it.
            let salvage: string | undefined;
            if (abandonedOutput) {
              salvage = serverCapture
                ? `The video was inside simulator-server and went with the recording this ` +
                  `teardown ended, so nothing was written to ${abandonedOutput} — re-record ` +
                  `rather than looking for it.`
                : `ffmpeg was given a moment to finalize the container first, so the video ` +
                  `captured up to that point is usually playable at ${abandonedOutput} — ` +
                  `check it before re-recording.`;
            }
            recordReapedSession("screen-recording", state.deviceId, salvage);
          }
        }
      },
      events,
    };
  },
};
