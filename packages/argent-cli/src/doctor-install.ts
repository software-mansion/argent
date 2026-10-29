import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { type ToolsServerPaths } from "@argent/tools-client";
import {
  isNewerVersion,
  isTempRunnerPath,
  isYarnPnp,
  nodeSatisfiesEngines,
  probeLocalInstall,
  readManifestDeclaration,
  readCliRecord,
  readInstallRecord,
  MCP_BINARY_NAME,
  PACKAGE_NAME,
} from "@argent/installer";
import {
  type DoctorCheck,
  type DoctorContext,
  type DoctorSection,
  type GlobalInstall,
  check,
  childFailureReason,
  home,
} from "./doctor-shared.js";

// `argent doctor`: the Install section (global and project installs).

const SHIM_PROBE_TIMEOUT_MS = 5_000;
export const GLOBAL_SHIM_FIX =
  "Install argent for the Node version this project uses (npm i -g @swmansion/argent), " +
  "or put a working argent first on PATH";

function isExecutableFile(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (process.platform !== "win32") fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Whether a spawn with this PATH finds `command` (as named, or with a Windows PATHEXT suffix). */
export function isOnPath(command: string, pathValue: string): boolean {
  const exts =
    process.platform === "win32"
      ? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
      : [""];
  return pathDirs(pathValue).some(
    (dir) => dir && exts.some((ext) => isExecutableFile(path.join(dir, command + ext)))
  );
}

function argentPackageRoot(bin: string): string | null {
  let dir: string;
  try {
    dir = path.dirname(fs.realpathSync(bin));
  } catch {
    return null;
  }
  // The FIRST package.json up the tree decides, as in the installer's probe: a
  // shim's walk would otherwise reach an unrelated manifest.
  for (;;) {
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(manifest, "utf8")) as { name?: string };
        return pkg.name === PACKAGE_NAME ? dir : null;
      } catch {
        return null;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// On Windows npm's bin dir is its prefix, and its shims are copies, not links.
function npmPrefixPackageRoot(binDir: string): string | null {
  const root = path.join(binDir, "node_modules", ...PACKAGE_NAME.split("/"));
  return fs.existsSync(path.join(root, "package.json")) ? root : null;
}

/**
 * Where a global install's `argent` would be: `<prefix>/bin` for npm, `<prefix>`
 * for npm on Windows, ~/.bun/bin for bun and ~/.yarn/bin for Yarn classic.
 */
export function globalBinDirOf(packageRoot: string): string | null {
  const nodeModules = path.dirname(path.dirname(packageRoot));
  if (path.basename(nodeModules) !== "node_modules") return null;
  const prefixDir = path.dirname(nodeModules);
  return globalBinCandidates(prefixDir).find((dir) => findGlobalArgent(dir) !== null) ?? null;
}

function globalBinCandidates(prefixDir: string): string[] {
  const p = prefixDir.replace(/\\/g, "/");
  if (p.endsWith("/.bun/install/global")) {
    return [path.join(path.dirname(path.dirname(prefixDir)), "bin")];
  }
  if (/\/yarn\/(global|data\/global)$/i.test(p)) return [path.join(homedir(), ".yarn", "bin")];
  // <PNPM_HOME>/global/5: the bin is PNPM_HOME itself, or PNPM_HOME/bin on newer pnpm.
  if (/\/\.?pnpm\/global\/[^/]+$/i.test(p)) {
    const pnpmHome = path.dirname(path.dirname(prefixDir));
    return [pnpmHome, path.join(pnpmHome, "bin")];
  }
  if (path.basename(prefixDir) === "lib") return [path.join(path.dirname(prefixDir), "bin")];
  return [prefixDir];
}

export type PackageManager = "npm" | "yarn" | "pnpm" | "bun";

/**
 * pnpm, bun and Yarn classic trust their install state and skip a package
 * dir that was deleted or damaged, so only their forced install restores it.
 */
export function localReinstallCommand(
  pm: PackageManager,
  projectRoot: string,
  packageRoot: string,
  installCmd: string
): string {
  if (pm === "pnpm" || pm === "bun") return `${pm} install --force`;
  if (pm === "yarn" && !fs.existsSync(path.join(projectRoot, ".yarnrc.yml"))) {
    return "yarn install --force";
  }
  return `delete ${home(packageRoot)}, then ${installCmd}`;
}

/** The package manager that owns a global install, from where it lives. */
export function globalPackageManagerOf(packageRoot: string): PackageManager {
  const p = packageRoot.replace(/\\/g, "/");
  if (p.includes("/.bun/")) return "bun";
  // PNPM_HOME is often ~/Library/pnpm, but also ~/.pnpm.
  if (/\/\.?pnpm\//i.test(p)) return "pnpm";
  if (/\/yarn\/(global|data\/global)\//i.test(p) || p.includes("/.yarn/")) return "yarn";
  return "npm";
}

/** Windows strips double quotes from PATH entries (cmd, libuv, `where` all do). */
function pathDirs(pathValue: string | undefined): string[] {
  const dirs = (pathValue ?? "").split(path.delimiter);
  return process.platform === "win32" ? dirs.map((dir) => dir.replace(/"/g, "")) : dirs;
}

/**
 * The `argent` an editor would start, looked up on `pathValue` in-process: no
 * `which` (missing on some images) and no change to this process's PATH. Any
 * executable counts, like the installer's `isGloballyInstalled()`, so pnpm and
 * Yarn script shims pass; npx / dlx caches don't.
 */
export function findGlobalArgent(pathValue: string | undefined): GlobalInstall | null {
  // Windows can't run the extensionless sh script npm also puts there.
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  for (const dir of pathDirs(pathValue)) {
    if (!dir) continue;
    for (const ext of exts) {
      const bin = path.join(dir, MCP_BINARY_NAME + ext);
      if (isTempRunnerPath(bin) || !isExecutableFile(bin)) continue;
      const root = argentPackageRoot(bin) ?? npmPrefixPackageRoot(dir);
      let version: string | null = null;
      if (root) {
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
            version?: string;
          };
          version = pkg.version ?? null;
        } catch {
          // Version stays unknown.
        }
      }
      return { bin, root, version };
    }
  }
  return null;
}

/**
 * A script shim hides its version, and a version manager's shim (mise, asdf,
 * nodenv) fails outright in a project that pins a Node without argent. Running
 * it from the project, where an editor starts it, is the only way to tell.
 * Doctor must change nothing, so mise's auto-install is off, and the timeout
 * kills the whole process group. `pathValue` is the PATH the shim was found
 * on: with the project's node_modules/.bin still there, a mise shim falls
 * through to the local copy. Windows shims are .cmd files execFile can't run,
 * so they stay unverified.
 */
export async function runGlobalShim(
  global: GlobalInstall,
  projectRoot: string,
  pathValue: string,
  timeoutMs = SHIM_PROBE_TIMEOUT_MS
): Promise<GlobalInstall> {
  if (global.root || process.platform === "win32") return global;
  return new Promise((resolve) => {
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(global.bin, ["--version"], {
      cwd: projectRoot,
      env: { ...process.env, PATH: pathValue, MISE_AUTO_INSTALL: "false" },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    const killGroup = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    // A detached group misses the Ctrl-C the terminal sends doctor, so pass it on.
    const onSignal = (signal: NodeJS.Signals) => {
      killGroup();
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    const finish = (code: number | null, err?: Error) => {
      clearTimeout(timer);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      if (timedOut) {
        resolve({
          ...global,
          runError: `\`argent --version\` timed out after ${timeoutMs / 1000}s`,
        });
      } else if (code === 0) {
        resolve({ ...global, version: /\d+\.\d+\.\d+\S*/.exec(stdout)?.[0] ?? null });
      } else {
        const fallback = err?.message ?? `exited with code ${code}`;
        resolve({ ...global, runError: childFailureReason(stderr, fallback) });
      }
    };
    child.on("error", (err) => finish(null, err));
    child.on("close", (code) => finish(code));
  });
}

/** Windows does not expand `~` in PATH, so print the full dir there. */
export function addToPathFix(dir: string): string {
  return `Add ${process.platform === "win32" ? dir : home(dir)} to PATH`;
}

function readEnginesNode(packageRoot: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
      engines?: { node?: string };
    };
    return pkg.engines?.node ?? null;
  } catch {
    return null;
  }
}

function isWorkspaceRoot(dir: string): boolean {
  if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return true;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
      workspaces?: unknown;
    };
    return pkg.workspaces !== undefined;
  } catch {
    return false;
  }
}

/**
 * probeLocalInstall goes through Node resolution, which also searches every
 * ancestor's node_modules and NODE_PATH, so a stray `npm i` in ~ would pass for
 * the project's install. Here only the project's own node_modules counts, or
 * that of a workspace root that hoists it.
 */
export function probeProjectInstall(projectRoot: string): {
  installed: boolean;
  version: string | null;
} {
  // PnP has no node_modules, and without its loader Node resolution would find
  // only strays, so the manifest declaration decides.
  if (isYarnPnp(projectRoot)) {
    const spec = readManifestDeclaration(projectRoot);
    return {
      installed: spec !== null,
      version: spec && /^\d+\.\d+\.\d+$/.test(spec) ? spec : null,
    };
  }
  const probe = probeLocalInstall(projectRoot);
  if (!probe.packageDir) return probe;
  const notInstalled = { installed: false, version: null };
  let dir = projectRoot;
  while (!fs.existsSync(path.join(dir, "node_modules", PACKAGE_NAME, "package.json"))) {
    const parent = path.dirname(dir);
    if (parent === dir) return notInstalled;
    dir = parent;
  }
  return dir === projectRoot || isWorkspaceRoot(dir) ? probe : notInstalled;
}

/**
 * Editors started from the Dock get launchd's PATH unless they load the
 * shell's. Every entry needs `node` (npm's `argent` shim runs it through
 * `env`), so its dir counts as well as the global install's.
 */
function dockPathNote(ctx: DoctorContext): DoctorCheck | null {
  if (!ctx.guiPath) return null;
  const guiDirs = ctx.guiPath.split(path.delimiter);
  const globalDir = ctx.global && !ctx.global.runError ? path.dirname(ctx.global.bin) : null;
  const needed = [globalDir, path.dirname(process.execPath)];
  const missing = [...new Set(needed)].filter((d): d is string => !!d && !guiDirs.includes(d));
  if (missing.length === 0) return null;
  const entryPath = [...missing, ctx.guiPath].join(path.delimiter);
  return check("info", "Apps started from the Dock don't get this shell's PATH", {
    detail: `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not on launchd's PATH (${ctx.guiPath})`,
    fix: `If an editor started outside a terminal can't start argent, add "env": {"PATH": "${entryPath}"} to its entry`,
  });
}

export function installSection(
  ctx: DoctorContext,
  running: string,
  paths: ToolsServerPaths
): DoctorSection {
  const { projectRoot } = ctx;
  const checks: DoctorCheck[] = [];
  const packageRoot = path.dirname(path.dirname(paths.bundlePath));
  checks.push(
    check("info", `Running v${running} (${paths.installKind ?? "global"} install)`, {
      detail: home(packageRoot),
    })
  );

  const dockNote = dockPathNote(ctx);
  if (dockNote) checks.push(dockNote);

  const engines = readEnginesNode(packageRoot);
  const satisfied = engines ? nodeSatisfiesEngines(process.versions.node, engines) : null;
  if (engines && satisfied !== null) {
    checks.push(
      satisfied
        ? check("ok", `Node v${process.versions.node} satisfies ${engines}`)
        : check("error", `Node v${process.versions.node} does not satisfy ${engines}`, {
            fix: "Install a newer Node.js (nvm install --lts)",
          })
    );
  }

  const global = ctx.global;
  checks.push(
    global?.runError
      ? check(
          ctx.mode === "local" ? "warn" : "error",
          "`argent` on PATH fails to run in this project",
          {
            detail: `${home(global.bin)}: ${global.runError}`,
            fix: GLOBAL_SHIM_FIX,
          }
        )
      : !global && ctx.offPathGlobalBin
        ? check("warn", "Installed globally, but its bin dir is not on PATH", {
            detail: home(ctx.offPathGlobalBin),
            fix: addToPathFix(ctx.offPathGlobalBin),
          })
        : !global
          ? check("info", "No global install on PATH")
          : global.root
            ? check("ok", `Global install v${global.version ?? "?"} on PATH`, {
                detail: home(global.root),
              })
            : global.version
              ? check("ok", `Global install v${global.version} on PATH`, {
                  detail: `${home(global.bin)} (a script shim)`,
                })
              : check("ok", "Global install on PATH", {
                  detail: `${home(global.bin)} (a script shim, so its version can't be read)`,
                })
  );

  if (ctx.mode === "local") {
    const local = probeProjectInstall(projectRoot);
    const source = readInstallRecord(projectRoot) ? ".argent/install.json" : "package.json";
    if (!local.installed) {
      // A leftover install record with no dependency behind it: installing changes nothing.
      const declared = readManifestDeclaration(projectRoot) !== null;
      checks.push(
        check("error", `Project uses a local install (${source}) but it is not installed`, {
          fix: declared
            ? ctx.installCmd
            : "Add @swmansion/argent to devDependencies and install it, or delete .argent/install.json to use a global install",
        })
      );
    } else if (local.version && isNewerVersion(running, local.version)) {
      checks.push(
        check("warn", `Project's local install v${local.version} is older than v${running}`, {
          fix: `${ctx.argentCmd} update`,
        })
      );
    } else {
      checks.push(check("ok", `Project local install v${local.version ?? "?"} (${source})`));
    }
  }

  const record = readCliRecord();
  if (!record && ctx.mode === "local" && isYarnPnp(projectRoot)) {
    checks.push(check("info", "~/.argent/cli.json is not written under Yarn PnP"));
  } else if (!record) {
    checks.push(
      check("warn", "~/.argent/cli.json is missing (device providers can't find the CLI)", {
        fix: `${ctx.argentCmd} update (or start the MCP server once)`,
      })
    );
  } else if (!fs.existsSync(record.cli) || !fs.existsSync(record.node)) {
    const gone = !fs.existsSync(record.cli) ? record.cli : record.node;
    checks.push(
      check("warn", "~/.argent/cli.json points at a path that no longer exists", {
        detail: home(gone),
        fix: `${ctx.argentCmd} update (or start the MCP server once)`,
      })
    );
  } else {
    checks.push(check("ok", `~/.argent/cli.json → v${record.version}`));
  }

  return { title: "Install", checks };
}
