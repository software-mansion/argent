import type { IosCaptureStrategy, RecordArgsInput, CaptureTarget } from "./types";

/**
 * Fallback for Xcode 26.4 and later, where `xctrace record --device <sim>` deadlocks
 * at the recording-start handshake. Records the HOST with `--all-processes` (no
 * `--device`, so no handshake): simulator apps are ordinary host processes, so the
 * target app's threads are sampled too. Capture is system-wide, so the exported
 * samples must be filtered to the app's PID (see cpuFilterPid).
 */
export const allProcessesStrategy: IosCaptureStrategy = {
  name: "all-processes",
  description: "xctrace --all-processes (host-wide), filtered to the app PID",
  attachesByName: false,

  buildRecordArgs(input: RecordArgsInput): string[] {
    // The built-in "Time Profiler" template, not the Argent one: the latter's Leaks
    // and Allocations instruments require a single-process target and abort under
    // `--all-processes`, failing the whole recording. So no per-app leak/allocation
    // data in this mode.
    const args = [
      "record",
      "--template",
      "Time Profiler",
      "--all-processes",
      "--output",
      input.outputFile,
      "--no-prompt",
    ];
    if (input.notifyName) {
      args.push("--notify-tracing-started", input.notifyName);
    }
    return args;
  },

  cpuFilterPid(target: CaptureTarget): number | null {
    // Host-wide capture → keep only the target app's samples. Null when the app
    // isn't running; the start path refuses this strategy in that case, since
    // unfiltered host-wide output is not a per-app profile.
    return target.pid;
  },
};
