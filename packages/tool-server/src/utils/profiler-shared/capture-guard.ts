/**
 * Shared "a capture still holds this session" guard for the native-profiler
 * drill-down consumers (analyze, profiler-load, combined-report). All three
 * render or re-label data keyed off the live session fields (traceFile, CPU
 * filter PID, wall-clock anchor, exportedFiles), so none may run while a capture
 * is mid-recording or has ended (cap/crash) with a partial trace that
 * native-profiler-stop has not yet exported — otherwise they pair one capture's
 * frozen data with another capture's live fields.
 */

/** The three session flags that mean a capture is not yet settled. */
export interface CaptureRecoveryState {
  profilingActive: boolean;
  recordingTimedOut: boolean;
  recordingExitedUnexpectedly: boolean;
}

/**
 * True while a capture holds the session: actively recording, or ended (10-min
 * cap / unexpected exit) with a partial trace still awaiting stop's recovery
 * export. Consumers that render or re-label a capture must refuse in this window.
 */
export function isCaptureInFlight(state: CaptureRecoveryState): boolean {
  return state.profilingActive || state.recordingTimedOut || state.recordingExitedUnexpectedly;
}

/**
 * Human-facing refusal message for {@link isCaptureInFlight}, distinguishing the
 * three states so the stated cause matches what `native-profiler-stop` itself
 * reports next (a 10-min cap is not an unexpected exit). `retryAction` names the
 * step to repeat after stop, e.g. `"analyze"` or `"retry profiler-load"`.
 */
export function inFlightGuardMessage(state: CaptureRecoveryState, retryAction: string): string {
  if (state.profilingActive) {
    return `A native profiling session is recording on this device. Run native-profiler-stop first, then ${retryAction}.`;
  }
  if (state.recordingTimedOut) {
    return (
      `A native profiling capture on this device hit the 10-minute recording cap and its ` +
      `partial trace has not been exported yet. Run native-profiler-stop first (it recovers ` +
      `the partial trace), then ${retryAction}.`
    );
  }
  return (
    `A native profiling capture on this device ended unexpectedly and its partial trace has ` +
    `not been exported yet. Run native-profiler-stop first (it recovers the partial trace), ` +
    `then ${retryAction}.`
  );
}
