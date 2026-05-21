import pc from "picocolors";
import type { TopologyId } from "./topology.js";

// Parsed view of `argent init <args>`. Single source of truth for what the
// user typed; downstream code reads named fields instead of grepping the
// raw argv. validateInitArgs enforces cross-flag invariants.

export interface InitArgs {
  /** --yes / -y */
  nonInteractive: boolean;
  /** --from <path>  reinstall from a local tarball/path */
  fromTar: string | null;
  /** --devdep / --local-install  forces the local topology */
  forcedTopology: TopologyId | null;
  /** --scope local|global, when present */
  explicitScope: "local" | "global" | null;
}

function extractValueFlag(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1] ?? null;
}

export function parseInitArgs(args: string[]): InitArgs {
  const nonInteractive = args.includes("--yes") || args.includes("-y");
  const fromTar = extractValueFlag(args, "--from");
  const devdep = args.includes("--devdep") || args.includes("--local-install");
  const scope = extractValueFlag(args, "--scope");
  const explicitScope = scope === "local" || scope === "global" ? scope : null;

  return {
    nonInteractive,
    fromTar,
    forcedTopology: devdep ? "local" : null,
    explicitScope,
  };
}

// Cross-flag validation. Throws to a process.exit(1) at the call site so
// the error string can be tested without a TUI in the loop.
export class InitArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InitArgsError";
  }
}

export function validateInitArgs(parsed: InitArgs): void {
  if (parsed.forcedTopology === "local" && parsed.explicitScope === "global") {
    throw new InitArgsError(
      "--devdep is incompatible with --scope global " +
        "(local installs must use the project-scoped MCP config)."
    );
  }
}

// Tiny stderr formatter so the dispatcher doesn't have to know about pc.
export function reportInitArgsError(err: InitArgsError): void {
  process.stderr.write(`${pc.red("error")}: ${err.message}\n`);
}
