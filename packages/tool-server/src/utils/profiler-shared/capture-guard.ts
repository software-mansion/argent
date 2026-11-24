/**
 * Guard shared by the native-profiler drill-down consumers (analyze,
 * profiler-load, combined-report): each pairs frozen capture data with the live
 * session fields (traceFile, cpuFilterPid, wallClockStartMs, exportedFiles), so
 * none may run while a capture is mid-recording or has ended (cap/crash) with a
 * partial trace native-profiler-stop has not yet exported.
 */

/** Session flags that mean a capture is not yet settled. */
interface CaptureRecoveryState {
  profilingActive: boolean;
  recordingTimedOut: boolean;
  recordingExitedUnexpectedly: boolean;
  /** xctrace only: the stop that is ending the recording and exporting its trace. */
  stopInProgress?: Promise<unknown> | null;
}

/**
 * True while a capture holds the session: recording, being stopped and exported,
 * or ended (10-min cap / unexpected exit) with a partial trace still awaiting
 * stop's recovery export.
 */
export function isCaptureInFlight(state: CaptureRecoveryState): boolean {
  return (
    state.profilingActive ||
    state.recordingTimedOut ||
    state.recordingExitedUnexpectedly ||
    Boolean(state.stopInProgress)
  );
}

/**
 * Refusal message for {@link isCaptureInFlight}, distinguishing the three states
 * so the stated cause matches what `native-profiler-stop` reports next (a 10-min
 * cap is not an unexpected exit). `retryAction` names the step to repeat after
 * stop, e.g. `"analyze"`.
 */
export function inFlightGuardMessage(state: CaptureRecoveryState, retryAction: string): string {
  if (state.stopInProgress) {
    return (
      `native-profiler-stop is still ending the recording on this device and exporting its ` +
      `trace. Wait for it to return, then ${retryAction}.`
    );
  }
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
