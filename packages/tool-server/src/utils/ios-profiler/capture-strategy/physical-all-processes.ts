import type { CaptureTarget, IosCaptureStrategy, RecordArgsInput } from "./types";

/**
 * Physical iOS system apps (Maps, Settings, Safari, …) reject a process-scoped
 * Instruments attach because the host cannot acquire their task port. Device-
 * wide Time Profiler capture is permitted and records CPU samples and potential
 * hangs for every process. The analysis pipeline filters those rows to the PID
 * resolved through devicectl, giving the same per-app report without requiring
 * get-task-allow or ownership of the app.
 */
export const physicalAllProcessesStrategy: IosCaptureStrategy = {
  name: "physical-all-processes",
  description: "xctrace --device <iPhone> --all-processes, filtered to the app PID",
  attachesByName: false,

  buildRecordArgs(input: RecordArgsInput): string[] {
    const args = [
      "record",
      "--template",
      input.templatePath,
      "--device",
      input.deviceId,
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
    return target.pid;
  },
};
