import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { ScreenRecordingSessionApi } from "../../../blueprints/screen-recording-session";
import { listIosPhysicalDevices } from "../../../utils/ios-device/devicectl";
import { requireFfmpeg, startCapture } from "../capture";
import { assertNoActiveRecording, type StartRecordingResult } from "../session-guards";
import { startIosScreenStream } from "./ios-screen-stream";

export const NO_TOUCH_MARKERS_WARNING =
  "Touch markers are not drawn on a physical iPhone; the video shows the raw screen.";

/**
 * Record a cabled iPhone. Its frames come from the host-side capture helper
 * instead of simulator-server; encoding is the same `startCapture` pipeline.
 */
export async function startIosDeviceCapture(
  api: ScreenRecordingSessionApi,
  udid: string,
  opts: {
    timeLimitSeconds: number;
    watermark: boolean;
    trimStatic: boolean;
    showTouches: boolean | undefined;
  }
): Promise<StartRecordingResult> {
  // Everything that refuses a start is checked before the helper starts: the
  // helper may compile, or wait minutes on the camera prompt, for a start
  // that would fail anyway.
  assertNoActiveRecording(api, "screen_recording_start");
  await requireFfmpeg();
  const phone = (await listIosPhysicalDevices()).find((d) => d.udid === udid);
  if (!phone || (phone.transportType !== null && phone.transportType !== "wired")) {
    throw new FailureError(
      phone
        ? `iPhone ${udid} is not on a USB cable (transport "${phone.transportType}"). ` +
            `Screen recording reads the screen over the cable; connect it and retry.`
        : `iPhone ${udid} is not connected. Connect it with a USB cable, check \`list-devices\`, and retry.`,
      {
        error_code: FAILURE_CODES.SCREEN_RECORDING_DEVICE_SCREEN_NOT_FOUND,
        failure_stage: "screen_recording_device_resolve",
        failure_area: "tool_server",
        error_kind: "not_found",
      }
    );
  }

  const source = await startIosScreenStream(phone.name);
  // startCapture releases the helper on every path once it has it, its own
  // failures included.
  const started = await startCapture(api, {
    streamUrl: source.streamUrl,
    timeLimitSeconds: opts.timeLimitSeconds,
    watermark: opts.watermark,
    trimStatic: opts.trimStatic,
    releaseStreamSource: source.close,
  });
  // No touch markers: simulator-server draws them, and a phone runs none.
  return opts.showTouches === true ? { ...started, warning: NO_TOUCH_MARKERS_WARNING } : started;
}
