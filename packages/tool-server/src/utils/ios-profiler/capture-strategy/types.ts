// Capture-strategy abstraction for the iOS native profiler.
//
// Why this exists: Apple's `xctrace record --device <sim>` path deadlocks during
// the recording-start handshake on Xcode 26.4–27.0 (a host-side xctrace
// regression — the in-sim DTServiceHub waits forever for a "recording-started"
// reply the regressed xctrace never sends). The capture never starts, so there
// is no data to recover. The hang-free fallback is to profile the HOST with
// `--all-processes` (simulator apps are host processes, so they're sampled too)
// and filter the exported samples down to the target app's PID.
//
// Both approaches share the same lifecycle (startup readiness, stop/finalize,
// export, pipeline). The ONLY differences are (1) the `xctrace record` argv and
// (2) whether a post-export PID filter is needed. This interface captures
// exactly those two differences so the two implementations are interchangeable
// and the right one can be picked per environment (see ./select).

/** The app to profile, as resolved from the running simulator. */
export interface CaptureTarget {
  /** CFBundleExecutable — human-readable name; also the attach-by-name fallback. */
  executable: string;
  /**
   * Host PID of the running app (the leading column of `launchctl list`). Null
   * when the target is not running yet (the device strategy then attaches by
   * name and lets the cold-start retry settle).
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
  /** Stable identifier — also the value accepted by the ARGENT_IOS_CAPTURE override. */
  readonly name: "device" | "all-processes";
  /** One-line human-readable description for logs. */
  readonly description: string;
  /** Build the `xctrace record …` argv for this strategy. */
  buildRecordArgs(input: RecordArgsInput): string[];
  /**
   * PID to post-filter the exported CPU samples to, or `null` to keep all
   * samples. The device strategy scopes capture via `--attach`, so it returns
   * `null` (no filtering). The all-processes strategy captures host-wide and
   * returns the target PID so the pipeline keeps only the app's samples.
   */
  cpuFilterPid(target: CaptureTarget): number | null;
  /**
   * Whether this strategy attaches by process name — i.e. whether the cold-start
   * "Cannot find process matching name" retry applies. The all-processes
   * strategy does not attach, so this is false.
   */
  readonly attachesByName: boolean;
}
