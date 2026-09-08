// Parsed `argent init` flags, plus the sentinel step modules throw to unwind to
// the orchestrator on a cancelled prompt.

interface InitArgs {
  /** --yes / -y */
  nonInteractive: boolean;
  /** --no-telemetry */
  noTelemetry: boolean;
  /** --from <path>: reinstall from a local tarball (developer flow) */
  fromTar: string | null;
  /** --local: the devDependency install mode */
  wantsLocal: boolean;
  /** --global */
  wantsGlobal: boolean;
}

// Unknown flags are ignored rather than rejected, so scripts passing flags this
// version doesn't know still run.
export function parseInitArgs(args: string[]): InitArgs {
  let fromTar: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--from" || arg.startsWith("--from=")) {
      const value = arg === "--from" ? (i + 1 < args.length ? args[++i]! : "") : arg.slice(7);
      if (value !== "" && fromTar === null) fromTar = value;
    }
  }
  return {
    nonInteractive: args.includes("--yes") || args.includes("-y"),
    noTelemetry: args.includes("--no-telemetry"),
    fromTar,
    wantsLocal: args.includes("--local"),
    wantsGlobal: args.includes("--global"),
  };
}

// Telemetry step labels for a cancelled prompt. No "global_install": picking the
// global mode (or --global) is itself the consent, so that prompt is gone — the
// event schema still accepts the label.
type CancelStep = "install_mode" | "editors" | "scope" | "allowlist" | "skills";

// Thrown by a step module on a cancelled prompt (Ctrl-C / Esc); the orchestrator
// emits `cli_init_cancel { step }`, finalizes telemetry and exits 0.
export class InitCancelled extends Error {
  constructor(public readonly step: CancelStep) {
    super(`init cancelled at step: ${step}`);
    this.name = "InitCancelled";
  }
}
