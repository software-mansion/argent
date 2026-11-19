import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import pc from "picocolors";
import type { ToolsServerPaths } from "@argent/tools-client";
import {
  ALL_ADAPTERS,
  detectAdapters,
  detectPackageManager,
  detectProjectPackageManager,
  findConfiguredAdapterScopes,
  formatShellCommand,
  getGloballyInstalledVersion,
  getInstalledVersion,
  getManagedContentTargets,
  globalInstallCommand,
  hasCustomizingEnv,
  isGloballyInstalled,
  listBundledSkills,
  probeLocalInstall,
  projectInstallCommand,
  resolveInstallMode,
  resolveProjectRoot,
  MCP_BINARY_NAME,
  PACKAGE_NAME,
  RULES_DIR,
  type McpServerEntry,
} from "@argent/installer";

const execFileAsync = promisify(execFile);

const CHECK_DEPS_TIMEOUT_MS = 30_000;
type ConfiguredAdapterScope = ReturnType<typeof findConfiguredAdapterScopes>[number];

const PACKAGE_RUNNERS = new Set(["npx", "yarn", "pnpm", "bunx"]);

type CheckStatus = "ok" | "warn" | "error" | "info";

export interface DoctorCheck {
  status: CheckStatus;
  label: string;
  detail?: string;
  fix?: string;
}

interface DoctorSection {
  title: string;
  checks: DoctorCheck[];
}

interface DoctorReport {
  version: string;
  projectRoot: string;
  sections: DoctorSection[];
}

interface HostDepsReport {
  adb: string | null;
  xcode: { developerDir: string | null; simctl: boolean } | null;
}

interface DoctorContext {
  projectRoot: string;
  configured: ConfiguredAdapterScope[];
  running: string;
  paths: ToolsServerPaths;
  globalOnPath: boolean;
  localInstalled: boolean;
  localPackageDir: string | null;
  argentCommand: string;
  globalInstallFix: string;
  projectInstallFix: string;
}

export type EntryContext = Pick<
  DoctorContext,
  | "projectRoot"
  | "globalOnPath"
  | "localInstalled"
  | "argentCommand"
  | "globalInstallFix"
  | "projectInstallFix"
>;

function check(status: CheckStatus, label: string, extra: Partial<DoctorCheck> = {}): DoctorCheck {
  return { status, label, ...extra };
}

function home(p: string): string {
  const h = homedir();
  return p === h || p.startsWith(h + path.sep) ? `~${p.slice(h.length)}` : p;
}

export function stripPackageBinDirs(pathValue: string): string {
  return pathValue
    .split(path.delimiter)
    .filter((dir) => !/[\\/]node_modules[\\/]\.bin[\\/]?$/.test(dir))
    .join(path.delimiter);
}

function installSection(ctx: DoctorContext): DoctorSection {
  const packageRoot = path.dirname(path.dirname(ctx.paths.bundlePath));
  const checks = [check("info", `Running v${ctx.running}`, { detail: home(packageRoot) })];
  const mode = resolveInstallMode(ctx.projectRoot);

  if (ctx.globalOnPath) {
    const version = getGloballyInstalledVersion();
    checks.push(check("ok", `\`argent\`${version ? ` v${version}` : ""} is on PATH`));
  } else if (mode === "global") {
    checks.push(
      check("error", "`argent` is not on PATH", {
        fix: ctx.globalInstallFix,
      })
    );
  }

  if (mode === "local") {
    const local = probeLocalInstall(ctx.projectRoot);
    checks.push(
      local.installed
        ? check("ok", `Local install v${local.version ?? "?"} in this project`)
        : check(
            "error",
            `This project uses a local install, but ${PACKAGE_NAME} is not installed`,
            {
              fix: ctx.projectInstallFix,
            }
          )
    );
  }

  return { title: "Install", checks };
}

function entryCheck(
  status: CheckStatus,
  entry: McpServerEntry,
  reason?: string,
  extra: Partial<DoctorCheck> = {}
): DoctorCheck {
  const cmd = [entry.command, ...entry.args].join(" ");
  return check(status, reason ? `${cmd} (${reason})` : cmd, extra);
}

function classifyArgentOnPath(entry: McpServerEntry, ctx: EntryContext): DoctorCheck {
  if (ctx.globalOnPath) return entryCheck("ok", entry);
  if (hasCustomizingEnv(entry)) {
    return entryCheck("warn", entry, "`argent` is not on this shell's PATH", {
      detail: "the entry sets its own env, which may still let the editor find it",
      fix: ctx.globalInstallFix,
    });
  }
  return entryCheck("error", entry, "`argent` is not on PATH, so this entry cannot start", {
    fix: ctx.globalInstallFix,
  });
}

function classifyNodeScript(entry: McpServerEntry, ctx: EntryContext): DoctorCheck {
  const script = entry.args.find((arg) => !arg.startsWith("-"));
  if (!script) return entryCheck("info", entry, "custom command, not checked");
  return fs.existsSync(path.resolve(ctx.projectRoot, script))
    ? entryCheck("ok", entry)
    : entryCheck("error", entry, `${script} does not exist`, { fix: ctx.projectInstallFix });
}

function classifyPackageRunner(entry: McpServerEntry, ctx: EntryContext): DoctorCheck {
  const fetchesPackage = entry.args.some(
    (arg) => arg === PACKAGE_NAME || arg.startsWith(`${PACKAGE_NAME}@`)
  );
  const npxFindsGlobal = entry.command === "npx" && ctx.globalOnPath;
  if (fetchesPackage || ctx.localInstalled || npxFindsGlobal) return entryCheck("ok", entry);
  return entryCheck("error", entry, `${PACKAGE_NAME} is not installed in this project`, {
    fix: ctx.projectInstallFix,
  });
}

export function classifyMcpEntry(entry: McpServerEntry, ctx: EntryContext): DoctorCheck {
  const initFix = `${ctx.argentCommand} init`;
  if (entry.command === "") {
    return check("warn", "The argent entry could not be read", { fix: initFix });
  }
  if (entry.command === MCP_BINARY_NAME) return classifyArgentOnPath(entry, ctx);
  if (entry.command === "node") return classifyNodeScript(entry, ctx);
  if (PACKAGE_RUNNERS.has(entry.command)) return classifyPackageRunner(entry, ctx);
  if (path.isAbsolute(entry.command) && !fs.existsSync(entry.command)) {
    return entryCheck("error", entry, `${entry.command} does not exist`, { fix: initFix });
  }
  return entryCheck("info", entry, "custom command, not checked");
}

function readEntry(adapter: (typeof ALL_ADAPTERS)[number], configPath: string): McpServerEntry {
  try {
    return adapter.getArgentEntry(configPath) ?? { command: "", args: [] };
  } catch {
    return { command: "", args: [] };
  }
}

function editorsSection(ctx: DoctorContext): DoctorSection {
  const checks: DoctorCheck[] = [];
  const { configured } = ctx;

  for (const { adapter, scope, configPath } of configured) {
    const result = classifyMcpEntry(readEntry(adapter, configPath), ctx);
    checks.push({
      ...result,
      label: `${adapter.name}: ${result.label}`,
      detail: [`${home(configPath)} (${scope})`, result.detail].filter(Boolean).join(", "),
    });
  }

  if (configured.length === 0) {
    checks.push(
      check("error", "No editor has an argent MCP entry for this project", {
        fix: `${ctx.argentCommand} init`,
      })
    );
  }

  const configuredNames = new Set(configured.map((c) => c.adapter.name));
  const unconfigured = detectAdapters()
    .map((a) => a.name)
    .filter((name) => !configuredNames.has(name));
  if (unconfigured.length > 0) {
    checks.push(
      check("info", `Detected without argent: ${unconfigured.join(", ")}`, {
        detail: `run ${ctx.argentCommand} init to add them`,
      })
    );
  }

  return { title: "Editors (MCP config)", checks };
}

function listRuleFiles(rulesDir: string = RULES_DIR): string[] {
  try {
    return fs.readdirSync(rulesDir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
}

function managedTargets(ctx: DoctorContext) {
  const adaptersIn = (scope: "project" | "global") =>
    ctx.configured.filter((c) => c.scope === scope).map((c) => c.adapter);
  const local = getManagedContentTargets(adaptersIn("project"), ctx.projectRoot, "local");
  const global = getManagedContentTargets(adaptersIn("global"), ctx.projectRoot, "global");
  return {
    skillDirs: [...local.skillTargets, ...global.skillTargets].map((t) => t.targetPath),
    ruleDirs: [...new Set([...local.ruleTargets, ...global.ruleTargets].map((t) => t.targetPath))],
  };
}

function summarizeList(items: string[], shown = 5): string {
  const head = items.slice(0, shown).join(", ");
  return items.length > shown ? `${head} and ${items.length - shown} more` : head;
}

function localContentDir(ctx: DoctorContext, name: "skills" | "rules"): string | undefined {
  if (!ctx.localPackageDir) return undefined;
  const dir = path.join(ctx.localPackageDir, name);
  return fs.existsSync(dir) ? dir : undefined;
}

function skillsSection(ctx: DoctorContext): DoctorSection {
  const checks: DoctorCheck[] = [];
  const { skillDirs, ruleDirs } = managedTargets(ctx);
  const initFix = `${ctx.argentCommand} init`;

  const bundled = listBundledSkills(localContentDir(ctx, "skills"));
  const missing = bundled.filter(
    (skill) => !skillDirs.some((dir) => fs.existsSync(path.join(dir, skill)))
  );
  if (bundled.length > 0 && missing.length === bundled.length) {
    checks.push(check("warn", "No argent skills installed", { fix: initFix }));
  } else if (missing.length > 0) {
    checks.push(
      check(
        "warn",
        `${bundled.length - missing.length}/${bundled.length} argent skills installed`,
        {
          detail: `missing: ${summarizeList(missing)}`,
          fix: initFix,
        }
      )
    );
  } else if (bundled.length > 0) {
    checks.push(check("ok", `${bundled.length}/${bundled.length} argent skills installed`));
  }

  const ruleFiles = listRuleFiles(localContentDir(ctx, "rules"));
  for (const dir of ruleDirs) {
    const absent = ruleFiles.filter((f) => !fs.existsSync(path.join(dir, f)));
    checks.push(
      absent.length === 0
        ? check("ok", `Rules present in ${home(dir)}`)
        : check("warn", `Rules missing in ${home(dir)}`, {
            detail: absent.join(", "),
            fix: initFix,
          })
    );
  }

  return { title: "Skills & rules", checks };
}

function firstErrorLine(err: unknown): string {
  const stderr = (err as { stderr?: unknown }).stderr;
  const line = typeof stderr === "string" ? stderr.trim().split("\n")[0] : "";
  return line || (err instanceof Error ? err.message.split("\n")[0]! : String(err));
}

async function probeHostDeps(paths: ToolsServerPaths): Promise<HostDepsReport | string> {
  try {
    const { stdout } = await execFileAsync(process.execPath, [paths.bundlePath, "--check-deps"], {
      timeout: CHECK_DEPS_TIMEOUT_MS,
    });
    return JSON.parse(stdout) as HostDepsReport;
  } catch (err) {
    return firstErrorLine(err);
  }
}

function iosCheck(xcode: HostDepsReport["xcode"]): DoctorCheck {
  if (!xcode) return check("info", "iOS simulators: need a macOS host");
  if (xcode.simctl)
    return check("ok", "iOS simulators", { detail: `Xcode at ${xcode.developerDir}` });
  if (!xcode.developerDir) {
    return check("warn", "iOS simulators: Xcode not found", {
      fix: "Install Xcode from the App Store and open it once",
    });
  }
  return check("warn", "iOS simulators: the active developer directory has no simctl", {
    detail: xcode.developerDir,
    fix: "Install Xcode from the App Store, then run sudo xcode-select -s /Applications/Xcode.app/Contents/Developer",
  });
}

function androidCheck(adb: string | null): DoctorCheck {
  if (adb) return check("ok", "Android", { detail: `adb at ${home(adb)}` });
  return check("warn", "Android: adb not found", {
    fix: "Install Android SDK Platform Tools (Android Studio > SDK Manager), or set ANDROID_HOME to the SDK root",
  });
}

export function toolchainChecks(report: HostDepsReport): DoctorCheck[] {
  return [iosCheck(report.xcode), androidCheck(report.adb)];
}

async function toolchainSection(ctx: DoctorContext): Promise<DoctorSection> {
  const report = await probeHostDeps(ctx.paths);
  const checks =
    typeof report === "string"
      ? [
          check("warn", "Could not check the device toolchains", {
            detail: report,
            fix: `${ctx.argentCommand} update`,
          }),
        ]
      : toolchainChecks(report);
  return { title: "Device toolchains", checks };
}

function isGlobalConfigPath(entry: ConfiguredAdapterScope): boolean {
  const globalPath = entry.adapter.globalPath();
  return globalPath !== null && path.resolve(globalPath) === path.resolve(entry.configPath);
}

export function findConfigured(projectRoot: string): ConfiguredAdapterScope[] {
  return findConfiguredAdapterScopes(ALL_ADAPTERS, projectRoot).filter(
    (entry) => entry.scope === "global" || !isGlobalConfigPath(entry)
  );
}

function hasProjectConfig(dir: string): boolean {
  return findConfigured(dir).some((entry) => entry.scope === "project");
}

function ancestorsBelowHome(dir: string, homeDir: string): string[] {
  const ancestors: string[] = [];
  let current = path.dirname(dir);
  while (current !== homeDir && current !== path.dirname(current)) {
    ancestors.push(current);
    current = path.dirname(current);
  }
  return ancestors;
}

export function resolveDoctorRoot(cwd: string, homeDir: string = homedir()): string {
  const projectRoot = resolveProjectRoot(cwd, homeDir);
  if (projectRoot === path.resolve(homeDir) || hasProjectConfig(projectRoot)) return projectRoot;
  return (
    ancestorsBelowHome(projectRoot, path.resolve(homeDir)).find(hasProjectConfig) ?? projectRoot
  );
}

function buildContext(paths: ToolsServerPaths, cwd: string): DoctorContext {
  const projectRoot = resolveDoctorRoot(cwd);
  const globalOnPath = isGloballyInstalled();
  const local = probeLocalInstall(projectRoot);
  return {
    projectRoot,
    configured: findConfigured(projectRoot),
    running: paths.version ?? getInstalledVersion() ?? "unknown",
    paths,
    globalOnPath,
    localInstalled: local.installed,
    localPackageDir: resolveInstallMode(projectRoot) === "local" ? local.packageDir : null,
    argentCommand: globalOnPath ? MCP_BINARY_NAME : `npx ${PACKAGE_NAME}`,
    globalInstallFix: formatShellCommand(
      globalInstallCommand(detectPackageManager(), PACKAGE_NAME)
    ),
    projectInstallFix: formatShellCommand(
      projectInstallCommand(detectProjectPackageManager(projectRoot))
    ),
  };
}

async function collectDoctorReport(paths: ToolsServerPaths, cwd: string): Promise<DoctorReport> {
  const ctx = buildContext(paths, cwd);
  const toolchains = toolchainSection(ctx);
  return {
    version: ctx.running,
    projectRoot: ctx.projectRoot,
    sections: [installSection(ctx), editorsSection(ctx), skillsSection(ctx), await toolchains],
  };
}

const MARKS: Record<CheckStatus, string> = {
  ok: pc.green("✔"),
  warn: pc.yellow("⚠"),
  error: pc.red("✖"),
  info: pc.dim("·"),
};

function allChecks(report: DoctorReport): DoctorCheck[] {
  return report.sections.flatMap((s) => s.checks);
}

function countStatus(report: DoctorReport, status: CheckStatus): number {
  return allChecks(report).filter((c) => c.status === status).length;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function isFailed(c: DoctorCheck): boolean {
  return c.status === "error" || c.status === "warn";
}

function header(report: DoctorReport): string {
  const runtime = `node v${process.versions.node}, ${process.platform} ${process.arch}`;
  return `${pc.bold("argent doctor")} v${report.version} (${runtime}) in ${home(report.projectRoot)}`;
}

function failedBlock(c: DoctorCheck): string[] {
  const lines = [`${MARKS[c.status]} ${pc.bold(c.label)}`];
  if (c.detail) lines.push(`  ${c.detail}`);
  if (c.fix) lines.push("Advice:", c.fix);
  return lines;
}

function passedList(report: DoctorReport): string[] {
  const lines: string[] = [];
  for (const section of report.sections) {
    const passed = section.checks.filter((c) => !isFailed(c));
    if (passed.length === 0) continue;
    lines.push("", pc.bold(section.title));
    for (const c of passed) {
      lines.push(`${MARKS[c.status]} ${c.label}`);
      if (c.detail) lines.push(pc.dim(`  ${c.detail}`));
    }
  }
  return lines;
}

export function renderDoctorReport(report: DoctorReport, verbose = false): string {
  const scored = allChecks(report).filter((c) => c.status !== "info");
  const failed = [
    ...scored.filter((c) => c.status === "error"),
    ...scored.filter((c) => c.status === "warn"),
  ];
  const passedCount = scored.length - failed.length;
  const passedDetails = verbose ? passedList(report) : [];

  if (failed.length === 0) {
    const summary = pc.green(`✔ All ${plural(passedCount, "check")} passed. Argent looks good.`);
    return [header(report), summary, ...passedDetails].join("\n");
  }

  const lines = [
    header(report),
    `${passedCount}/${scored.length} checks passed. ${plural(failed.length, "check")} failed. Possible issues detected:`,
  ];
  if (!verbose && passedCount > 0) lines.push(pc.dim("Use --verbose to see the passed checks."));
  lines.push(...passedDetails);
  for (const c of failed) lines.push("", ...failedBlock(c));
  lines.push(
    "",
    `${plural(failed.length, "check")} failed, indicating possible issues with your setup.`
  );
  return lines.join("\n");
}

const HELP = `Usage: argent doctor [--verbose]

Check why argent might not work in this project: the install, the editor MCP
entries, the skills and rules, and the Xcode and Android toolchains. The command
changes nothing. It prints advice for each failed check.

Options:
  --verbose    Also list the checks that passed
  -h, --help   Show this help

Exits 1 when a check fails (✖). Warnings (⚠) do not change the exit code.`;

export async function doctor(argv: string[], options: { paths: ToolsServerPaths }): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return;
  }
  const unknown = argv.find((arg) => arg !== "--verbose");
  if (unknown) {
    console.error(`Unknown option: ${unknown}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }

  if (process.env.PATH) process.env.PATH = stripPackageBinDirs(process.env.PATH);
  const report = await collectDoctorReport(options.paths, process.cwd());
  console.log(renderDoctorReport(report, argv.includes("--verbose")));
  if (countStatus(report, "error") > 0) process.exitCode = 1;
}
