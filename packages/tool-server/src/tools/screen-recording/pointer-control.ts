import type { ScreenRecordingSessionApi } from "../../blueprints/screen-recording-session";

/**
 * simulator-server's touch visualizer, on for the life of a recording. Built by
 * the start tool from the resolved sim-server handle, so capture stays
 * decoupled from the sim-server client.
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
