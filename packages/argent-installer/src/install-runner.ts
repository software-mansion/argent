import * as p from "@clack/prompts";
import pc from "picocolors";
import { PACKAGE_NAME } from "./constants.js";
import { formatShellCommand } from "./package-manager.js";
import { runShellCommand } from "./shell.js";
import { hasPackageJson, isYarnPnp } from "./preflight.js";
import { GLOBAL, LOCAL, type Topology } from "./topology.js";
import { reportLocalInstallFailure } from "./install-error.js";
import { getInstalledVersion, getLocallyInstalledVersion } from "./utils.js";

// Run the install for a chosen topology, returning the post-install
// version. On failure: prints contextual guidance and process.exit(1).

interface RunArgs {
  topology: Topology;
  projectRoot: string;
  /** --from <path> or null. */
  fromTar: string | null;
  /** Version reported before install — fallback if post-install read fails. */
  fallbackVersion: string;
}

export async function runInstall(args: RunArgs): Promise<string> {
  return args.topology === LOCAL ? runLocal(args) : runGlobal(args);
}

async function runGlobal({ projectRoot, fromTar, fallbackVersion }: RunArgs): Promise<string> {
  const target = fromTar ?? PACKAGE_NAME;
  const cmd = GLOBAL.installCommand(projectRoot, target);
  const cmdStr = formatShellCommand(cmd);
  const spinner = p.spinner();
  spinner.start(
    fromTar ? `Installing from ${fromTar}...` : `Installing ${PACKAGE_NAME} globally...`
  );
  try {
    await runShellCommand(cmd, GLOBAL.spawnCwd(projectRoot));
    spinner.stop(pc.green(fromTar ? "Installed from tarball." : "Installed globally."));
    return getInstalledVersion() ?? fallbackVersion;
  } catch (err) {
    spinner.stop(pc.red("Installation failed."));
    p.log.error(`${err}`);
    p.log.info(`Install Argent manually with: ${pc.cyan(cmdStr)}`);
    process.exit(1);
  }
}

async function runLocal({ projectRoot, fromTar, fallbackVersion }: RunArgs): Promise<string> {
  refusePreflightFailures(projectRoot);

  const target = fromTar ?? PACKAGE_NAME;
  const cmd = LOCAL.installCommand(projectRoot, target);
  const cmdStr = formatShellCommand(cmd);
  const pmName = cmd.bin;
  const spinner = p.spinner();
  spinner.start(`Installing ${PACKAGE_NAME} as a devDependency with ${pmName}...`);
  try {
    await runShellCommand(cmd, LOCAL.spawnCwd(projectRoot));
    spinner.stop(pc.green(`Installed as devDependency (via ${pmName}).`));
    // Read the just-installed copy, not the running module — under `npx`,
    // getInstalledVersion() returns the npx cache version.
    return getLocallyInstalledVersion(projectRoot) ?? fallbackVersion;
  } catch (err) {
    spinner.stop(pc.red("Installation failed."));
    reportLocalInstallFailure(err, cmdStr, projectRoot);
    process.exit(1);
  }
}

function refusePreflightFailures(projectRoot: string): void {
  if (!hasPackageJson(projectRoot)) {
    p.log.error(
      `No package.json found at ${pc.dim(projectRoot)}.\n` +
        `  Run ${pc.cyan("npm init -y")} first, then re-run ${pc.cyan("argent init --devdep")}.`
    );
    process.exit(1);
  }
  if (isYarnPnp(projectRoot)) {
    p.log.error(
      `Yarn PnP detected (.pnp.cjs at ${pc.dim(projectRoot)}).\n` +
        `  The devDep flow needs a real node_modules/.bin directory.\n` +
        `  Switch to ${pc.cyan('nodeLinker: "node-modules"')} in .yarnrc.yml or ` +
        `re-run with ${pc.cyan("argent init")} for a global install.`
    );
    process.exit(1);
  }
}
