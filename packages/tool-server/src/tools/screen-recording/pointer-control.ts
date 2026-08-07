import type { ScreenRecordingSessionApi } from "../../blueprints/screen-recording-session";

/**
 * Turns simulator-server's touch visualizer on for the life of a recording and
 * back off afterwards. Built by the start tool from the resolved sim-server
 * handle; the capture paths only arm it and store the teardown, staying
 * decoupled from the sim-server client.
 *
 * The overlay is drawn into the frames simulator-server encodes, so it lands in
 * the video whichever side does the recording — but it is also server-global
 * state, which is why every path that ends a recording restores it to off.
 */
export interface PointerControl {
  /** Enable the overlay; resolves false if the sim-server would not turn it on. */
  enable(): Promise<boolean>;
  /** Restore the overlay to off. Best-effort — never throws. */
  disable(): Promise<void>;
}

/** Restore the touch visualizer to off. Best-effort, idempotent, never throws. */
export async function disablePointer(api: ScreenRecordingSessionApi): Promise<void> {
  const disable = api.pointerDisable;
  api.pointerDisable = null;
  if (disable) await disable().catch(() => {});
}
