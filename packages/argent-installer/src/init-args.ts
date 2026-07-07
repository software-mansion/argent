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

function extractFlag(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1]!;
}

export function parseInitArgs(args: string[]): InitArgs {
  return {
    nonInteractive: args.includes("--yes") || args.includes("-y"),
    noTelemetry: args.includes("--no-telemetry"),
    fromTar: extractFlag(args, "--from"),
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
