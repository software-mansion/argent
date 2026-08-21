import * as p from "@clack/prompts";
import { PACKAGE_NAME } from "./constants.js";
import type { InstallMode } from "./install-record.js";

// `update` and `uninstall` act on an install "target": the global PATH binary,
// the project's local devDependency, or both.

export type TargetFlags = { global: boolean; local: boolean };

export function parseTargetFlags(args: string[]): TargetFlags {
  return { global: args.includes("--global"), local: args.includes("--local") };
}

export interface DecideTargetsContext {
  /** A global install exists on PATH. */
  globalPresent: boolean;
  /** The project's devDependency is both declared and installed. */
  localPresent: boolean;
  /**
   * Target when the choice is unambiguous. Callers pass the install that is
   * actually PRESENT, falling back to the recorded mode so guidance paths still
   * run when nothing is installed.
   */
  defaultTarget: InstallMode;
  flags: TargetFlags;
  nonInteractive: boolean;
  /**
   * Targets when both installs coexist and no prompt is possible. `update`
   * passes both (updating both is safe); `uninstall` passes ["local"] — the
   * global install is shared with other projects, so `-y` never removes it
   * without an explicit --global.
   */
  nonInteractiveBothDefault: InstallMode[];
}

export type TargetDecision =
  | { kind: "targets"; targets: InstallMode[]; reason: "flags" | "single" | "noninteractive-both" }
  | { kind: "prompt" };

// No I/O, so the whole selection matrix is unit-testable.
export function decideInstallTargets(ctx: DecideTargetsContext): TargetDecision {
  const { flags } = ctx;

  // A flag naming an absent install is deliberately NOT an error — the
  // per-command handler resolves it: `update` offers to install a missing
  // global, `uninstall` reports there was nothing to remove.
  if (flags.global || flags.local) {
    const targets: InstallMode[] = [];
    if (flags.global) targets.push("global");
    if (flags.local) targets.push("local");
    return { kind: "targets", targets, reason: "flags" };
  }

  // The only ambiguous case: a global install AND a project-local install both
  // exist.
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

// Preselection mirrors the command's non-interactive default so
// Enter-through-defaults and --yes agree: `remove` preselects only the local
// devDependency — the global install is shared with every other project, so
// removing it must stay an explicit selection. Returns "cancel" on Ctrl-C / Esc.
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
