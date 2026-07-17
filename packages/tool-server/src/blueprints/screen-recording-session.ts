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
import { waitForChildExit } from "../utils/profiler-shared/lifecycle";
import { adbShell } from "../utils/adb";
import { clearActiveScreenRecording } from "../utils/screen-recording-reminder";

// Cross-platform session for the `screen-recording-*` tools: iOS drives an
// `xcrun simctl io recordVideo` child that writes the file host-side, Android
// an `adb shell screenrecord` child whose file lives on the device until stop
// pulls it. Mirrors the native-profiler session shape so start/stop branch
// only in the platform helpers.
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
  /** iOS: the recordVideo child. Android: the host-side `adb shell` child. */
  captureProcess: ChildProcess | null;
  /**
   * Host path of the video. iOS: written there directly by recordVideo.
   * Android: destination `screen-recording-stop` pulls the on-device file to.
   */
  outputFile: string | null;
  /** Android-only: the mp4 path on the device while recording. */
  androidOnDeviceFile: string | null;
  /** Android-only: on-device screenrecord PID (SIGINT target for stop). */
  androidDevicePid: number | null;
  wallClockStartMs: number | null;
  /** Cap applied to this capture, after per-platform clamping. */
  timeLimitSeconds: number | null;
  /**
   * iOS: host timer that SIGINTs recordVideo at the cap. Android: safety timer
   * slightly past the cap that reaps a hung adb child (screenrecord self-stops
   * at its --time-limit, so this only fires when the device went unreachable).
   */
  recordingTimeout: NodeJS.Timeout | null;
  recordingTimedOut: boolean;
  recordingExitedUnexpectedly: boolean;
  lastExitInfo: { code: number | null; signal: string | null } | null;
}

// Dispose only fires on process shutdown, where an in-flight recording is
// being abandoned. Give recordVideo one short SIGINT grace so the file it
// leaves behind has a chance to be playable, then SIGKILL — shutdown must not
// be held up by a slow finalize.
const DISPOSE_SIGINT_GRACE_MS = 1_500;
const DISPOSE_REAP_MS = 1_000;
const ANDROID_DISPOSE_ADB_TIMEOUT_MS = 5_000;

function clearLiveState(state: ScreenRecordingSessionApi): void {
  state.recordingActive = false;
  state.captureProcess = null;
  state.androidOnDeviceFile = null;
  state.androidDevicePid = null;
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
      captureProcess: null,
      outputFile: null,
      androidOnDeviceFile: null,
      androidDevicePid: null,
      wallClockStartMs: null,
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
        if (state.recordingTimeout) {
          clearTimeout(state.recordingTimeout);
          state.recordingTimeout = null;
        }

        try {
          if (state.platform === "ios") {
            const child = state.captureProcess;
            if (state.recordingActive && child) {
              try {
                child.kill("SIGINT");
              } catch {
                // already dead
              }
              if (!(await waitForChildExit(child, DISPOSE_SIGINT_GRACE_MS))) {
                try {
                  child.kill("SIGKILL");
                } catch {
                  // already dead
                }
                await waitForChildExit(child, DISPOSE_REAP_MS);
              }
            }
            return;
          }

          // Android: the capture and its file live on the device; the host adb
          // child follows once the device-side shell ends. Best-effort — the
          // device may already be gone at shutdown.
          if (state.recordingActive && state.androidDevicePid) {
            await adbShell(state.deviceId, `kill -INT ${state.androidDevicePid}`, {
              timeoutMs: ANDROID_DISPOSE_ADB_TIMEOUT_MS,
            }).catch(() => {});
            if (state.androidOnDeviceFile) {
              await adbShell(state.deviceId, `rm -f ${state.androidOnDeviceFile}`, {
                timeoutMs: ANDROID_DISPOSE_ADB_TIMEOUT_MS,
              }).catch(() => {});
            }
          }
          const child = state.captureProcess;
          if (child) {
            try {
              child.kill("SIGKILL");
            } catch {
              // already dead
            }
            await waitForChildExit(child, DISPOSE_REAP_MS);
          }
        } finally {
          clearLiveState(state);
          // The reminder must not outlive the process that owns the capture.
          clearActiveScreenRecording(state.deviceId);
        }
      },
      events,
    };
  },
};
