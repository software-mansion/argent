import type { IosCaptureStrategy, RecordArgsInput, CaptureTarget } from "./types";

/**
 * The original (and preferred) strategy: `xctrace record --device <sim>
 * --attach <pid|name>`. xctrace scopes the recording to the target process on
 * the simulator, so no post-export filtering is needed. This is the full
 * Time-Profiler path with the simulator as the Instruments device.
 *
 * It is the correct choice on Xcode versions where the `--device` recording
 * handshake works (≤ 26.3). On 26.4 and later it deadlocks at startup — see
 * ./all-processes and ./select.
 */
export const deviceStrategy: IosCaptureStrategy = {
  name: "device",
  description: "xctrace --device <sim> --attach <app> (scoped to the simulator app)",
  attachesByName: true,

  buildRecordArgs(input: RecordArgsInput): string[] {
    // Attach by PID when we know it (immune to Xcode 26.5's display-name
    // `--attach` matching); fall back to the executable name when the target
    // isn't running yet so the cold-start retry can still kick in.
    const attachTarget =
      input.target.pid != null ? String(input.target.pid) : input.target.executable;

    const args = [
      "record",
      "--template",
      input.templatePath,
      "--device",
      input.deviceId,
      "--attach",
      attachTarget,
      "--output",
      input.outputFile,
      "--no-prompt",
    ];
    if (input.notifyName) {
      args.push("--notify-tracing-started", input.notifyName);
    }
    return args;
  },

  cpuFilterPid(_target: CaptureTarget): number | null {
    // Already scoped to the target by --attach; keep every exported sample.
    return null;
  },
};
