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
  PACKAGE_NAME,
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
  runGlobalShim,
} from "./doctor-install.js";
import { claudeProjectKey, editorsSection } from "./doctor-editors.js";
import { skillsSection } from "./doctor-skills.js";
import { entryRemoteChecks, toolServerSection } from "./doctor-tool-server.js";
import { platformsSection } from "./doctor-platforms.js";
import { otherSection } from "./doctor-other.js";

const execFileAsync = promisify(execFile);

// `argent doctor`: a read-only health report. Every check reuses the probe the
// real code path runs (install topology, MCP entries, tool-server state, the
// tool-server's own dependency resolvers), so doctor and the failure it
// explains can't disagree. It never repairs anything: each problem names the
// command that does (`argent init`, `argent update`, an installer).

/**
 * PATH as an editor sees it. `npx argent doctor` and npm scripts prepend the
 * `node_modules/.bin` of the project and its ancestors, which would make the
 * project-local copy pass for a global install (and a bare `argent mcp` entry
 * look startable). Editors don't see those dirs. A `node_modules/.bin` outside
 * cwd's ancestry is a real global bin (Yarn classic's) and stays.
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

/**
 * resolveProjectRoot counts ~/.claude, ~/.cursor and the like as project
 * markers, so a project under ~ without markers of its own resolves to ~.
 * Those are global config dirs: use the project's git root, or cwd.
 */
function doctorProjectRoot(cwd: string): string {
  const resolved = resolveProjectRoot(cwd);
  if (!samePath(resolved, homedir()) || samePath(cwd, homedir())) return resolved;
  const key = claudeProjectKey(cwd);
  return samePath(key, homedir()) ? cwd : key;
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
  const ctx: DoctorContext = {
    projectRoot,
    claudeRoot: claudeProjectKey(cwd),
    cwd,
    mode,
    global,
    argentCmd:
      global && !global.runError ? "argent" : mode === "local" ? localCmd : "npx @swmansion/argent",
    installCmd: formatShellCommand(projectInstallCommand(projectPm)),
    offPathGlobalBin: !global && !runningLocal ? globalBinDirOf(packageRoot) : null,
    guiPath: await launchdPath(),
  };
  const running = options.paths.version ?? getInstalledVersion() ?? "unknown";
  const globalPm = globalPackageManagerOf(packageRoot);
  // `argent update` only installs when a newer version exists, so it can't
  // repair a broken copy of the current one.
  const reinstall = runningLocal
    ? projectPm === "pnpm"
      ? "Reinstall argent: pnpm install --force"
      : `Reinstall argent: delete ${home(packageRoot)}, then ${ctx.installCmd}`
    : `Reinstall argent: ${formatShellCommand(globalInstallCommand(globalPm, PACKAGE_NAME))}`;
  const updateCmd = updateCommand(runningLocal, globalPm, ctx.argentCmd);
  const linked = await getResolvedToolsUrl();
  const entryToolsUrls: EntryToolsUrl[] = [];
  const editors = editorsSection(ctx, entryToolsUrls);

  // Sections that touch the network or spawn a process run concurrently.
  const [toolServer, entryRemotes, platforms, other] = await Promise.all([
    toolServerSection(ctx, running, options.paths, linked),
    entryRemoteChecks(entryToolsUrls),
    platformsSection(ctx, options.paths, linked, reinstall),
    otherSection(ctx, running, options.offline, updateCmd, runningLocal ? projectPm : globalPm),
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

export function renderDoctorReport(report: DoctorReport): string {
  const lines: string[] = [
    `${pc.bold("argent doctor")}  v${report.version} · node v${report.node} · ${report.platform}`,
    pc.dim(`project: ${home(report.projectRoot)}`),
  ];
  for (const section of report.sections) {
    if (section.checks.length === 0) continue;
    lines.push("", pc.bold(section.title));
    for (const c of section.checks) {
      lines.push(`  ${MARKS[c.status]} ${c.label}`);
      if (c.detail) lines.push(`      ${pc.dim(c.detail)}`);
      if (c.fix && c.status !== "ok") lines.push(`      ${pc.cyan("→")} ${c.fix}`);
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
  if (report.errors > 0) process.exitCode = 1;
}
