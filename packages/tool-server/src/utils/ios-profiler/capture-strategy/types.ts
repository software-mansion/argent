// Capture-strategy abstraction for the iOS native profiler.
//
// `xctrace record --device <sim>` deadlocks in the recording-start handshake on
// Xcode 26.4 and later (host-side xctrace regression: the in-sim DTServiceHub
// waits forever for a "recording-started" reply the regressed xctrace never
// sends), so nothing is captured. The hang-free fallback profiles the HOST with
// `--all-processes` — simulator apps are host processes, so they're sampled too
// — and filters the exported samples down to the target app's PID. Everything
// else (startup readiness, stop/finalize, export, pipeline) is shared; ./select
// picks the implementation per environment.

/** The app to profile, as resolved from the running simulator. */
export interface CaptureTarget {
  /** CFBundleExecutable — also the attach-by-name fallback. */
  executable: string;
  /**
   * Host PID from `launchctl list`. Null when the target is not running yet (the
   * device strategy then attaches by name and lets the cold-start retry settle).
   */
  pid: number | null;
}

/** Inputs needed to build the `xctrace record …` argv. */
export interface RecordArgsInput {
  templatePath: string;
  deviceId: string;
  target: CaptureTarget;
  outputFile: string;
  /** Darwin notification name for `--notify-tracing-started`, when registered. */
  notifyName?: string;
}

export interface IosCaptureStrategy {
  /** Also the value accepted by the ARGENT_IOS_CAPTURE override. */
  readonly name: "device" | "all-processes";
  readonly description: string;
  buildRecordArgs(input: RecordArgsInput): string[];
  /**
   * PID to post-filter the exported CPU samples to, or `null` to keep all
   * samples. The device strategy scopes capture via `--attach`, so it returns
   * `null`; the all-processes strategy captures host-wide and returns the target
   * PID.
   */
  cpuFilterPid(target: CaptureTarget): number | null;
  /** Whether the cold-start "Cannot find process matching name" retry applies. */
  readonly attachesByName: boolean;
}
