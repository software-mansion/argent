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
  /** Today's single-install default (resolveInstallMode) — used when unambiguous. */
  defaultTarget: InstallMode;
  flags: TargetFlags;
  nonInteractive: boolean;
  /**
   * Targets to act on when both installs coexist and the run is non-interactive
   * (no prompt possible). The agent-triggered `update` passes ["local"] as an
   * interim default; a proper resolution is planned separately.
   */
  nonInteractiveBothDefault: InstallMode[];
  /** Allow a `--global` flag even when no global install is present (update installs). */
  allowAbsentGlobalFlag?: boolean;
  /** Allow a `--local` flag even when no local install is present. */
  allowAbsentLocalFlag?: boolean;
}

export type TargetDecision =
  | { kind: "targets"; targets: InstallMode[]; reason: "flags" | "single" | "noninteractive-both" }
  | { kind: "prompt" }
  | { kind: "error"; message: string };

// Pure target resolver — no I/O, so the whole selection matrix is unit-testable.
export function decideInstallTargets(ctx: DecideTargetsContext): TargetDecision {
  const { flags } = ctx;

  if (flags.global || flags.local) {
    const targets: InstallMode[] = [];
    if (flags.global) {
      if (!ctx.globalPresent && !ctx.allowAbsentGlobalFlag) {
        return { kind: "error", message: `No global ${PACKAGE_NAME} install found on your PATH.` };
      }
      targets.push("global");
    }
    if (flags.local) {
      if (!ctx.localPresent && !ctx.allowAbsentLocalFlag) {
        return {
          kind: "error",
          message: `This project has no local ${PACKAGE_NAME} install (not declared in package.json).`,
        };
      }
      targets.push("local");
    }
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
