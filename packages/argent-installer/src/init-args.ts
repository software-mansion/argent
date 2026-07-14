// Parsed view of `argent init <args>` and the cancel sentinel the step modules
// use to unwind to the orchestrator.

export interface InitArgs {
  /** --yes / -y */
  nonInteractive: boolean;
  /** --no-telemetry */
  noTelemetry: boolean;
  /** --from <path>  reinstall from a local tarball/path (developer flow) */
  fromTar: string | null;
  /** --local  force the local (devDependency) install mode */
  wantsLocal: boolean;
  /** --global  force the global install mode */
  wantsGlobal: boolean;
}

// Unknown flags are silently ignored (kept from the original parser): aborting
// on them would break existing invocations/scripts that pass flags this
// version doesn't know.
export function parseInitArgs(args: string[]): InitArgs {
  let fromTar: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--from" || arg.startsWith("--from=")) {
      const value = arg === "--from" ? (i + 1 < args.length ? args[++i]! : "") : arg.slice(7);
      // First non-empty occurrence wins, matching the previous indexOf-based
      // parser; a dangling `--from` is ignored like any other malformed input.
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

// Telemetry step labels for a cancelled prompt. "global_install" is absent
// because there is no such prompt anymore: choosing the global install mode
// (or --global) IS the consent, so a missing global package installs without
// a second question. The event schema keeps the label for older clients.
export type CancelStep = "install_mode" | "editors" | "scope" | "allowlist" | "skills";

// Thrown by a step module when the user cancels a prompt (Ctrl-C / Esc). The
// orchestrator catches it, emits `cli_init_cancel { step }`, finalizes
// telemetry, prints the cancel notice, and exits 0.
export class InitCancelled extends Error {
  constructor(public readonly step: CancelStep) {
    super(`init cancelled at step: ${step}`);
    this.name = "InitCancelled";
  }
}
