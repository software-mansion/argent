import * as p from "@clack/prompts";
import { PACKAGE_NAME } from "./constants.js";
import type { InstallMode } from "./install-record.js";

// `update` and `uninstall` act on an install "target": the global PATH binary,
// the project's local devDependency, or both. Shared selection rules:
//   1. Explicit --global / --local flags win and are additive.
//   2. Only one install present: act on it, no prompt.
//   3. Both coexist: prompt interactively (see promptInstallTargets); when
//      non-interactive, fall back to a caller-chosen default so agent-triggered
//      runs never block on a prompt.
// Single-install behavior is unchanged; only the ambiguous coexist case is new.

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
   * Target when only one selection is unambiguous: local if materialized, else
   * global if on PATH, else the project's recorded mode (so guidance paths
   * still run when nothing is installed).
   */
  defaultTarget: InstallMode;
  flags: TargetFlags;
  nonInteractive: boolean;
  /**
   * Targets when both installs coexist and no prompt is possible. `update`
   * passes ["global", "local"] (updating both is safe); `uninstall` passes
   * ["local"] — removal is destructive and the global install is shared with
   * other projects, so `-y` never removes it without an explicit --global.
   */
  nonInteractiveBothDefault: InstallMode[];
}

export type TargetDecision =
  | { kind: "targets"; targets: InstallMode[]; reason: "flags" | "single" | "noninteractive-both" }
  | { kind: "prompt" };

// Pure target resolver — no I/O, so the whole selection matrix is unit-testable.
export function decideInstallTargets(ctx: DecideTargetsContext): TargetDecision {
  const { flags } = ctx;

  // Explicit flags win and are additive. A flag naming an absent install is
  // deliberately NOT an error — the per-command handler resolves it: `update`
  // installs a missing global (a missing local points at `argent init`),
  // `uninstall` reports there was nothing to remove.
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

// Interactive multiselect for the coexist case. `verb` shapes the wording AND
// the preselection, which mirrors the command's non-interactive default so
// Enter-through-defaults and --yes agree: `update` preselects both; `remove`
// preselects only the local devDependency — the global install is shared with
// every other project, so removing it must stay an explicit selection, never
// the default. Returns "cancel" on Ctrl-C / Esc.
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
    initialValues: (verb === "update" ? ["global", "local"] : ["local"]) as InstallMode[],
    required: true,
  });

  if (p.isCancel(selected)) return "cancel";
  return selected as InstallMode[];
}
