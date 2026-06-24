import type { IosCaptureStrategy, RecordArgsInput, CaptureTarget } from "./types";

/**
 * Degraded-environment fallback for Xcode 26.4–27.0, where `xctrace record
 * --device <sim>` deadlocks at the recording-start handshake and never captures.
 *
 * Instead of targeting the simulator device, record the HOST with
 * `--all-processes` (NO `--device`). Simulator apps run as ordinary host
 * processes on the shared host kernel, so host-wide kperf sampling captures the
 * target app's threads too — at the same ~1kHz PET rate, with fully symbolicated
 * USER callstacks. The host path finalizes cleanly (no `--device` handshake), so
 * there is no deadlock.
 *
 * Trade-offs vs the device strategy:
 *  - Capture is system-wide, so the exported samples must be filtered to the
 *    target app's PID (see cpuFilterPid + the pipeline's optional pid filter).
 *  - Kernel callstacks are absent (`cp-kernel-callstack` is empty for simulator
 *    processes) — but no Argent analysis consumes them, and the device path has
 *    the same limitation for simulator targets, so this is not a regression.
 *  - The target app must be on-CPU during capture to produce samples (true of
 *    any sampling profiler).
 */
export const allProcessesStrategy: IosCaptureStrategy = {
  name: "all-processes",
  description: "xctrace --all-processes (host-wide), filtered to the app PID",
  attachesByName: false,

  buildRecordArgs(input: RecordArgsInput): string[] {
    // No --device and no --attach: profile the whole host. The simulator app is
    // included because its process lives on the host kernel.
    //
    // Use the built-in "Time Profiler" template (CPU + Hangs) rather than the
    // full Argent template: the Argent template's Leaks and Allocations
    // instruments require a single-process target and abort with "cannot handle
    // a target type of 'All Processes'", failing the whole recording. Time
    // Profiler is the host-wide-compatible subset and yields the same ~1kHz PET
    // CPU samples the pipeline consumes. Per-app leaks/allocations are not
    // available in host-wide capture (they'd need a process-scoped tool such as
    // `simctl spawn heap|leaks <pid>` — out of scope here).
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
    // Host-wide capture → keep only the target app's samples. Null only if the
    // app PID is unknown (target wasn't running); callers should guard against
    // that before selecting this strategy, since unfiltered host-wide output is
    // not a meaningful per-app profile.
    return target.pid;
  },
};
