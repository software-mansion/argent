import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import pc from "picocolors";
import { getResolvedToolsUrl, type ToolsServerPaths } from "@argent/tools-client";
import {
  detectProjectPackageManager,
  formatShellCommand,
  getInstalledVersion,
  globalInstallCommand,
  projectInstallCommand,
  resolveInstallMode,
  resolveProjectRoot,
  MCP_BINARY_NAME,
  PACKAGE_NAME,
  type McpServerEntry,
} from "@argent/installer";
import {
  type CheckStatus,
  type DoctorContext,
  type DoctorReport,
  type EntryToolsUrl,
  home,
  localArgentCmd,
  samePath,
} from "./doctor-shared.js";
import {
  type PackageManager,
  findGlobalArgent,
  globalBinDirOf,
  globalPackageManagerOf,
  installSection,
  localReinstallCommand,
  runGlobalShim,
} from "./doctor-install.js";
import { claudeProjectKey, editorsSection, gitToplevel, linksToRemote } from "./doctor-editors.js";
import { skillsSection } from "./doctor-skills.js";
import { entryRemoteChecks, toolServerSection } from "./doctor-tool-server.js";
import { platformsSection } from "./doctor-platforms.js";
import { READ_ONLY_PM_ENV, otherSection } from "./doctor-other.js";
import { exitAfterFlush } from "./e2e.js";

const execFileAsync = promisify(execFile);

// `argent doctor`: a read-only health report. Checks reuse the probes the real
// code paths run (install topology, MCP entries, tool-server state, the
// tool-server's own dependency resolvers). Two are stricter on purpose:
// probeProjectInstall ignores an argent above the project that `argent update`
// still counts, and classifyMcpEntry flags entries `init` would keep. It never
// repairs anything: each problem names the command that does (`argent init`,
// `argent update`, an installer).

/**
 * This shell's PATH without the dirs package scripts add (an editor started
 * from the Dock gets launchd's PATH instead, see guiPath). `npx argent doctor`
 * and npm scripts prepend the `node_modules/.bin` of the project and its
 * ancestors, which would make the project-local copy pass for a global install
 * (and a bare `argent mcp` entry look startable). Editors don't see those dirs.
 * A `node_modules/.bin` outside cwd's ancestry is a real global bin (Yarn
 * classic's) and stays.
 */
export function stripPackageBinDirs(pathValue: string, cwd: string): string {
  const here = path.resolve(cwd);
  return pathValue
    .split(path.delimiter)
    .filter((dir) => {
      const match = /^(.*)[\\/]node_modules[\\/]\.bin[\\/]?$/.exec(dir);
      if (!match) return true;
      const rel = path.relative(path.resolve(match[1] || path.sep), here);
      return rel.startsWith("..") || path.isAbsolute(rel);
    })
    .join(path.delimiter);
}

/** `argent update` installs through npm unless launched by another package manager. */
export function updateCommand(runningLocal: boolean, globalPm: PackageManager, argentCmd: string) {
  return !runningLocal && globalPm !== "npm"
    ? formatShellCommand(globalInstallCommand(globalPm, `${PACKAGE_NAME}@latest`))
    : `${argentCmd} update`;
}

// `argent update` only installs when a newer version exists, so it can't
// repair a broken copy of the current one: these reinstall it.

/** bun skips a global package that is already at the requested version. */
export function globalReinstallCommand(pm: PackageManager): string {
  const cmd = globalInstallCommand(pm, PACKAGE_NAME);
  return formatShellCommand(pm === "bun" ? { ...cmd, args: [...cmd.args, "--force"] } : cmd);
}

/**
 * resolveProjectRoot stops below ~ by comparing paths as strings. When HOME
 * names the home dir through a symlink, that misses, and ~/.claude, ~/.cursor
 * and the like make a project without markers of its own resolve to ~. Those
 * are global config dirs: use the project's git root, or cwd.
 */
function doctorProjectRoot(cwd: string): string {
  const resolved = resolveProjectRoot(cwd);
  if (!samePath(resolved, homedir()) || samePath(cwd, homedir())) return resolved;
  const top = gitToplevel(cwd);
  return samePath(top, homedir()) ? cwd : top;
}

/** The PATH launchd hands apps started from the Dock (its default when unset). */
async function launchdPath(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await execFileAsync("launchctl", ["getenv", "PATH"], { timeout: 2_000 });
    return stdout.trim() || "/usr/bin:/bin:/usr/sbin:/sbin";
  } catch {
    return null;
  }
}

/** Whether npm's global prefix, where `npx --no-install` looks, has an `argent`. */
async function npmGlobalHasArgent(): Promise<boolean | null> {
  try {
    const { stdout } = await execFileAsync("npm", ["prefix", "-g"], {
      env: { ...process.env, ...READ_ONLY_PM_ENV },
      timeout: 5_000,
      shell: process.platform === "win32",
    });
    const prefix = stdout.trim();
    if (!prefix) return null;
    const binDir = process.platform === "win32" ? prefix : path.join(prefix, "bin");
    return findGlobalArgent(binDir) !== null;
  } catch {
    return null;
  }
}

/** A bare `argent` command runs the global install on PATH. */
function startsGlobalArgent(entry: McpServerEntry): boolean {
  return entry.command.replace(/\.(cmd|exe)$/i, "") === MCP_BINARY_NAME;
}

function currentDir(): string {
  try {
    return process.cwd();
  } catch {
    // The shell's directory was deleted (a removed worktree). Move to ~ so the
    // installer probes that read process.cwd() don't throw either.
    process.chdir(homedir());
    return homedir();
  }
}

export async function collectDoctorReport(options: {
  paths: ToolsServerPaths;
  offline: boolean;
}): Promise<DoctorReport> {
  const cwd = currentDir();
  const projectRoot = doctorProjectRoot(cwd);
  const mode = resolveInstallMode(projectRoot);
  const lookupPath = stripPackageBinDirs(process.env.PATH ?? "", cwd);
  const found = findGlobalArgent(lookupPath);
  const global = found && (await runGlobalShim(found, projectRoot, lookupPath));
  const packageRoot = path.dirname(path.dirname(options.paths.bundlePath));
  const runningLocal = options.paths.installKind === "local";
  const projectPm = detectProjectPackageManager(projectRoot);
  const localCmd = localArgentCmd(projectRoot);
  const [guiPath, npmGlobal] = await Promise.all([launchdPath(), npmGlobalHasArgent()]);
  const gitRoot = gitToplevel(cwd);
  const ctx: DoctorContext = {
    projectRoot,
    claudeRoot: gitRoot,
    claudeKey: claudeProjectKey(cwd),
    gitRoot,
    cwd,
    mode,
    global,
    argentCmd:
      global && !global.runError ? "argent" : mode === "local" ? localCmd : "npx @swmansion/argent",
    installCmd: formatShellCommand(projectInstallCommand(projectPm)),
    offPathGlobalBin: !global && !runningLocal ? globalBinDirOf(packageRoot) : null,
    guiPath,
    npmGlobalHasArgent: npmGlobal,
  };
  const running = options.paths.version ?? getInstalledVersion() ?? "unknown";
  const globalPm = globalPackageManagerOf(packageRoot);
  const reinstall = `Reinstall argent: ${
    runningLocal
      ? localReinstallCommand(projectPm, projectRoot, packageRoot, ctx.installCmd)
      : globalReinstallCommand(globalPm)
  }`;
  const updateCmd = updateCommand(runningLocal, globalPm, ctx.argentCmd);
  const linked = await getResolvedToolsUrl();
  const entryToolsUrls: EntryToolsUrl[] = [];
  const startedEntries: McpServerEntry[] = [];
  const editors = editorsSection(ctx, entryToolsUrls, startedEntries);
  const entriesAllRemote = startedEntries.length > 0 && startedEntries.every(linksToRemote);

  // Sections that touch the network or spawn a process run concurrently.
  const [toolServer, entryRemotes, platforms, other] = await Promise.all([
    toolServerSection(ctx, running, options.paths, linked),
    entryRemoteChecks(entryToolsUrls, ctx.argentCmd),
    platformsSection(ctx, options.paths, linked, reinstall, entriesAllRemote),
    otherSection(
      ctx,
      running,
      options.offline,
      updateCmd,
      runningLocal ? projectPm : globalPm,
      startedEntries.some(startsGlobalArgent)
    ),
  ]);
  toolServer.checks.push(...entryRemotes);
  const sections = [
    installSection(ctx, running, options.paths),
    editors,
    skillsSection(ctx, reinstall),
    toolServer,
    platforms,
    other,
  ];
  const all = sections.flatMap((s) => s.checks);
  return {
    version: running,
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`,
    projectRoot,
    sections,
    errors: all.filter((c) => c.status === "error").length,
    warnings: all.filter((c) => c.status === "warn").length,
  };
}

const MARKS: Record<CheckStatus, string> = {
  ok: pc.green("✓"),
  warn: pc.yellow("!"),
  error: pc.red("✗"),
  info: pc.dim("·"),
};

/**
 * Labels and details carry text from editor configs (args, env values), so a
 * control character could move the cursor or recolour a row in the terminal.
 */
function printable(text: string): string {
  return [...text]
    .map((ch) => {
      const code = ch.codePointAt(0)!;
      const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
      return control ? `\\x${code.toString(16).padStart(2, "0")}` : ch;
    })
    .join("");
}

export function renderDoctorReport(report: DoctorReport): string {
  const lines: string[] = [
    `${pc.bold("argent doctor")}  v${report.version} · node v${report.node} · ${report.platform}`,
    pc.dim(`project: ${printable(home(report.projectRoot))}`),
  ];
  for (const section of report.sections) {
    if (section.checks.length === 0) continue;
    lines.push("", pc.bold(section.title));
    for (const c of section.checks) {
      lines.push(`  ${MARKS[c.status]} ${printable(c.label)}`);
      if (c.detail) lines.push(`      ${pc.dim(printable(c.detail))}`);
      if (c.fix && c.status !== "ok") lines.push(`      ${pc.cyan("→")} ${printable(c.fix)}`);
    }
  }
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const summary = `${plural(report.errors, "error")}, ${plural(report.warnings, "warning")}`;
  lines.push(
    "",
    report.errors > 0
      ? pc.red(summary)
      : report.warnings > 0
        ? pc.yellow(summary)
        : pc.green(summary)
  );
  return lines.join("\n");
}

const HELP = `Usage: argent doctor [options]

Check that argent is installed and wired up correctly: install topology, editor
MCP entries, skills and rules, the tool-server, and per-platform device
toolchains (Xcode, Android SDK, Vega). Read-only: it prints the command that
fixes each problem but changes nothing.

Options:
  --json       Print the report as JSON
  --offline    Skip the npm registry update check
  -h, --help   Show this help

Exits 1 when any check fails (✗); warnings (!) don't affect the exit code.`;

export function doctorExitCode(report: Pick<DoctorReport, "errors" | "warnings">): number {
  return report.errors > 0 ? 1 : 0;
}

export async function doctor(argv: string[], options: { paths: ToolsServerPaths }): Promise<void> {
  const known = new Set(["--json", "--offline", "--help", "-h"]);
  const unknown = argv.filter((a) => !known.has(a));
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return;
  }
  if (unknown.length > 0) {
    console.error(`Unknown option: ${unknown[0]}\n\n${HELP}`);
    process.exitCode = 1;
    return;
  }

  const report = await collectDoctorReport({
    paths: options.paths,
    offline: argv.includes("--offline"),
  });
  console.log(
    argv.includes("--json") ? JSON.stringify(report, null, 2) : renderDoctorReport(report)
  );
  process.exitCode = doctorExitCode(report);
  // A probe of a host that drops packets leaves a pending connect that would
  // keep the process alive for undici's 10s connect timeout.
  await exitAfterFlush(process.exitCode);
}
