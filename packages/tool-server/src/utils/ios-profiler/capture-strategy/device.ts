import type { IosCaptureStrategy, RecordArgsInput, CaptureTarget } from "./types";

/**
 * `xctrace record --device <sim> --attach <pid|name>` — xctrace scopes the
 * recording to the target process, so no post-export filtering is needed.
 *
 * Correct on Xcode versions where the `--device` recording handshake works
 * (≤ 26.3); 26.4 and later deadlock at startup — see ./all-processes and ./select.
 */
export const deviceStrategy: IosCaptureStrategy = {
  name: "device",
  description: "xctrace --device <sim> --attach <app> (scoped to the simulator app)",
  attachesByName: true,

  buildRecordArgs(input: RecordArgsInput): string[] {
    // Xcode 26.5's `--attach` matches the display name, not CFBundleExecutable,
    // so prefer the PID. Fall back to the name when the target isn't running yet,
    // so the cold-start retry can still kick in.
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
    // Already scoped to the target by --attach.
    return null;
  },
};
