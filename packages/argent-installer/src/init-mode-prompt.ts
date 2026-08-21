import * as p from "@clack/prompts";
import { InitCancelled } from "./init-args.js";
import type { InstallMode } from "./install-record.js";
import {
  blockedGlobalTargetCause,
  suggestedNpmPrefix,
  type GlobalInstallTarget,
} from "./global-prefix.js";
import type { PackageManager } from "./package-manager.js";
import { hasProjectPackageJson, resolveProjectRoot } from "./utils.js";

/** A global install this machine cannot carry out — see probeGlobalInstallTarget. */
export interface BlockedGlobalInstall {
  target: GlobalInstallTarget;
  pm: PackageManager;
}

// Step-0 selector: global (default) vs local (committable devDependency). Used
// only when neither --local/--global nor --yes fixed the mode. `defaultMode`
// seeds the highlight (the committed record's mode, so re-running init in a
// local repo stays local) unless `blockedGlobal` overrides it: a global install
// would land in a directory this user cannot write, so the prompt explains that
// and steers to local instead of recommending the option that cannot work.
// Throws InitCancelled("install_mode") on cancel.
export async function promptInstallMode(
  defaultMode: InstallMode = "global",
  blockedGlobal: BlockedGlobalInstall | null = null
): Promise<InstallMode> {
  if (blockedGlobal) {
    p.log.warn(blockedGlobalTargetCause(blockedGlobal.target, blockedGlobal.pm, "install"));
  }

  // Local is a way out only where there is a package.json to hold the
  // devDependency — the same condition installLocally enforces.
  const localViable = hasProjectPackageJson(resolveProjectRoot(process.cwd()));
  const recommended = blockedGlobal === null ? "global" : localViable ? "local" : null;

  const globalHint = blockedGlobal
    ? blockedGlobal.pm === "npm"
      ? `Needs a writable global directory — argent will point npm at ${suggestedNpmPrefix()}`
      : `Needs a writable global directory, and argent cannot relocate ${blockedGlobal.pm}'s`
    : "Installs the argent command on your PATH; shared across every project";

  const modeChoice = await p.select({
    message: "How should argent be installed?",
    options: [
      {
        value: "global" as const,
        label: `Globally${recommended === "global" ? " (recommended)" : ""}`,
        hint: globalHint,
      },
      {
        value: "local" as const,
        label: `This project only${recommended === "local" ? " (recommended)" : ""}`,
        hint: "Adds @swmansion/argent to devDependencies and commits MCP config that runs the local copy — best for teams",
      },
    ],
    initialValue: recommended === "local" ? "local" : defaultMode,
  });

  if (p.isCancel(modeChoice)) throw new InitCancelled("install_mode");
  return modeChoice as InstallMode;
}
