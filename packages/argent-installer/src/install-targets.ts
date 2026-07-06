import * as p from "@clack/prompts";
import { PACKAGE_NAME } from "./constants.js";
import type { InstallMode } from "./install-record.js";

// `update` and `uninstall` act on an install "target": the global PATH binary,
// the project's local devDependency, or — when a developer has both at once —
// possibly both. Selection rules (shared by both commands):
//   1. Explicit --global / --local flags win and are additive (pass both = both).
//   2. Otherwise, when only ONE install is present, act on it (no prompt).
//   3. When BOTH coexist, interactively ask which to act on (both preselected);
//      non-interactively fall back to a caller-chosen default so the
//      agent-triggered path never blocks on a prompt.
// This keeps the historical single-install behavior byte-for-byte and only
// changes the genuinely ambiguous "global + local coexist" case, which used to
// be resolved silently (and sometimes wrongly) in favor of the local devDep.

export type TargetFlags = { global: boolean; local: boolean };

export function parseTargetFlags(args: string[]): TargetFlags {
  return { global: args.includes("--global"), local: args.includes("--local") };
}

export interface DecideTargetsContext {
  /** A global install exists on PATH. */
  globalPresent: boolean;
  /** A local install is present for this project (declared devDep / installed). */
  localPresent: boolean;
  /**
   * Target when only one selection is unambiguous. Callers pass the PRESENT
   * install: local if materialized, else global if on PATH, else the project's
   * recorded mode (so the guidance paths still run when nothing is installed).
   */
  defaultTarget: InstallMode;
  flags: TargetFlags;
  nonInteractive: boolean;
  /**
   * Targets to act on when both installs coexist and the run is non-interactive
   * (no prompt possible). `update` passes ["global", "local"] — updating both
   * is safe and matches the interactive prompt's both-preselected default.
   * `uninstall` passes ["local"] — removal is destructive and the global
   * install is shared with other projects, so `-y` never nukes it without an
   * explicit --global. (The agent-triggered `update` always pins an explicit
   * flag, so it never reaches this default.)
   */
  nonInteractiveBothDefault: InstallMode[];
}

export type TargetDecision =
  | { kind: "targets"; targets: InstallMode[]; reason: "flags" | "single" | "noninteractive-both" }
  | { kind: "prompt" };

// Pure target resolver — no I/O, so the whole selection matrix is unit-testable.
export function decideInstallTargets(ctx: DecideTargetsContext): TargetDecision {
  const { flags } = ctx;

  // Explicit flags always win and are additive. A flag naming an install that
  // is not present is deliberately NOT an error — the per-command handler
  // resolves it the friendly way: `update` installs a missing global (and points
  // a missing local at `argent init`), `uninstall` reports there was nothing to
  // remove. This mirrors how `update` already installed a missing global.
  if (flags.global || flags.local) {
    const targets: InstallMode[] = [];
    if (flags.global) targets.push("global");
    if (flags.local) targets.push("local");
    return { kind: "targets", targets, reason: "flags" };
  }

  // The only ambiguous case: a global install AND a project-local install both
  // exist. Everything else keeps the historical single-install default.
  if (ctx.globalPresent && ctx.localPresent) {
    if (ctx.nonInteractive) {
      return {
        kind: "targets",
        targets: ctx.nonInteractiveBothDefault,
        reason: "noninteractive-both",
      };
    }
    return { kind: "prompt" };
  }

  return { kind: "targets", targets: [ctx.defaultTarget], reason: "single" };
}

// Interactive multiselect shown when a global install and a project-local
// install coexist. Both are preselected (Enter acts on both). `verb` shapes the
// wording ("update" / "remove"). Returns "cancel" on Ctrl-C / Esc.
export async function promptInstallTargets(
  verb: "update" | "remove"
): Promise<InstallMode[] | "cancel"> {
  const selected = await p.multiselect({
    message: `argent is installed both globally and in this project. Which should ${verb === "update" ? "update" : "removal"} affect?`,
    options: [
      {
        value: "global" as const,
        label: "Global install",
        hint: "the argent command on your PATH",
      },
      {
        value: "local" as const,
        label: "This project's devDependency",
        hint: `${PACKAGE_NAME} in this project's node_modules`,
      },
    ],
    initialValues: ["global", "local"] as InstallMode[],
    required: true,
  });

  if (p.isCancel(selected)) return "cancel";
  return selected as InstallMode[];
}
