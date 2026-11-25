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
  detectGlobalPackageManager,
  detectProjectPackageManager,
  findConfiguredAdapterScopes,
  findConfigSyntaxErrorLine,
  formatShellCommand,
  getGloballyInstalledVersion,
  getInstalledVersion,
  getManagedContentTargets,
  globalInstallCommand,
  isGloballyInstalled,
  isPinnedGlobalEntry,
  listBundledSkills,
  probeLocalInstall,
  projectInstallCommand,
  resolveInstallMode,
  resolveProjectRoot,
  MCP_BINARY_NAME,
  MCP_SERVER_KEY,
  PACKAGE_NAME,
  RULES_DIR,
  type McpServerEntry,
} from "@argent/installer";

const execFileAsync = promisify(execFile);

const CHECK_DEPS_TIMEOUT_MS = 30_000;
type ConfiguredAdapterScope = ReturnType<typeof findConfiguredAdapterScopes>[number];

const RUNNER_PACKAGES: Record<string, string> = {
  npx: "Node.js",
  yarn: "Yarn",
  pnpm: "pnpm",
  bunx: "Bun",
};
const LAUNCH_DIR_EDITORS = new Set(["Claude Code", "opencode", "Codex"]);
const JSONC_OPTIONS = { allowTrailingComma: true };
const EDITOR_JSON_OPTIONS: Record<string, Parameters<typeof findConfigSyntaxErrorLine>[1]> = {
  "Claude Code": { disallowComments: true },
  "Gemini": {},
};

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
  xcode: { developerDir: string | null; simctl: boolean; firstLaunch: string | null } | null;
}

interface DoctorContext {
  projectRoot: string;
  cwd: string;
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
  | "cwd"
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
  if (entry.args[0] !== "mcp") {
    return entryCheck("error", entry, "expected `argent mcp`", {
      fix: `${ctx.argentCommand} init`,
    });
  }
  if (ctx.globalOnPath) return entryCheck("ok", entry);
  return entryCheck("error", entry, "`argent` is not on PATH, so this entry cannot start", {
    fix: ctx.globalInstallFix,
  });
}

function classifyNodeScript(entry: McpServerEntry, ctx: EntryContext): DoctorCheck {
  const script = entry.args.find((arg) => !arg.startsWith("-"));
  if (!script) return entryCheck("info", entry, "custom command, not checked");
  if (path.isAbsolute(script)) {
    return fs.existsSync(script)
      ? entryCheck("ok", entry)
      : entryCheck("error", entry, `${script} does not exist`, {
          fix: `${ctx.argentCommand} init`,
        });
  }
  if (!fs.existsSync(path.resolve(ctx.projectRoot, script))) {
    return entryCheck("error", entry, `${script} does not exist`, { fix: ctx.projectInstallFix });
  }
  if (!fs.existsSync(path.resolve(ctx.cwd, script))) {
    return entryCheck("error", entry, `${script} is relative to ${home(ctx.projectRoot)}`, {
      detail: "an editor started in this folder cannot find it",
      fix: `Start the editor in ${home(ctx.projectRoot)}`,
    });
  }
  return entryCheck("ok", entry);
}

function classifyPinnedEntry(entry: McpServerEntry, initFix: string): DoctorCheck {
  const missing = [entry.command, entry.args[0]].find((p) => !fs.existsSync(p));
  return missing
    ? entryCheck("error", entry, `${missing} does not exist`, { fix: initFix })
    : entryCheck("ok", entry);
}

function isRunnableFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (process.platform !== "win32") fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isOnPath(command: string): boolean {
  const names =
    process.platform === "win32" ? [".cmd", ".exe"].map((ext) => command + ext) : [command];
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .some((dir) => dir !== "" && names.some((name) => isRunnableFile(path.join(dir, name))));
}

function classifyPackageRunner(entry: McpServerEntry, ctx: EntryContext): DoctorCheck {
  if (!isOnPath(entry.command)) {
    return entryCheck(
      "error",
      entry,
      `\`${entry.command}\` is not on PATH, so this entry cannot start`,
      {
        fix: `Install ${RUNNER_PACKAGES[entry.command]}, or put \`${entry.command}\` on the PATH the entry runs with`,
      }
    );
  }
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
    return check("warn", "The argent entry has no command", { fix: initFix });
  }
  if (entry.command === "node") return classifyNodeScript(entry, ctx);
  const resolvedOnPath =
    entry.command === MCP_BINARY_NAME || Object.hasOwn(RUNNER_PACKAGES, entry.command);
  if (resolvedOnPath && entry.env?.PATH !== undefined) {
    return entryCheck("info", entry, "sets its own PATH, not checked");
  }
  if (entry.command === MCP_BINARY_NAME) return classifyArgentOnPath(entry, ctx);
  if (Object.hasOwn(RUNNER_PACKAGES, entry.command)) return classifyPackageRunner(entry, ctx);
  if (isPinnedGlobalEntry(entry)) return classifyPinnedEntry(entry, initFix);
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

function syntaxCheck(adapterName: string, configPath: string): DoctorCheck | null {
  const line = findConfigSyntaxErrorLine(
    configPath,
    EDITOR_JSON_OPTIONS[adapterName] ?? JSONC_OPTIONS
  );
  if (line === null) return null;
  const format = path.extname(configPath).slice(1).toUpperCase();
  return check("error", `the config has a ${format} syntax error on line ${line}`, {
    fix: `Fix line ${line} of ${home(configPath)}. The editor loads no MCP servers from it until then`,
  });
}

function globalScopeFix(fix: string | undefined, initFix: string): string | undefined {
  return fix === initFix
    ? `${initFix}, and choose Global at "Install MCP server globally or locally?"`
    : fix;
}

function editorCheck(
  result: DoctorCheck,
  { adapter, scope, configPath }: ConfiguredAdapterScope,
  initFix: string
): DoctorCheck {
  return {
    ...result,
    label: `${adapter.name}: ${result.label}`,
    fix: scope === "global" ? globalScopeFix(result.fix, initFix) : result.fix,
    detail: [`${home(configPath)} (${scope})`, result.detail].filter(Boolean).join(", "),
  };
}

function brokenUnconfiguredConfigs(
  { projectRoot, cwd }: Pick<EntryContext, "projectRoot" | "cwd">,
  configured: ConfiguredAdapterScope[]
): Array<ConfiguredAdapterScope & { result: DoctorCheck }> {
  const seen = new Set(configured.map((c) => path.resolve(c.configPath)));
  const aboveRepo = crossesGitRoot(cwd, projectRoot);
  return ALL_ADAPTERS.flatMap((adapter) =>
    (["project", "global"] as const).flatMap((scope) => {
      if (scope === "project" && !readsConfigAt(adapter.name, aboveRepo)) return [];
      const configPath =
        scope === "project" ? adapter.projectPath(projectRoot) : adapter.globalPath();
      if (!configPath || seen.has(path.resolve(configPath))) return [];
      seen.add(path.resolve(configPath));
      const result = syntaxCheck(adapter.name, configPath);
      return result ? [{ adapter, scope, configPath, result }] : [];
    })
  );
}

function mayHoldArgentEntry({ scope, configPath }: ConfiguredAdapterScope): boolean {
  if (scope === "project") return true;
  try {
    return fs.readFileSync(configPath, "utf8").includes(MCP_SERVER_KEY);
  } catch {
    return false;
  }
}

function editorEntryContext(ctx: EntryContext, editor: string): EntryContext {
  return { ...ctx, cwd: LAUNCH_DIR_EDITORS.has(editor) ? ctx.cwd : ctx.projectRoot };
}

export function editorsSection(
  ctx: EntryContext & Pick<DoctorContext, "configured">
): DoctorSection {
  const checks: DoctorCheck[] = [];
  const { configured } = ctx;
  const initFix = `${ctx.argentCommand} init`;

  for (const entry of configured) {
    const result =
      syntaxCheck(entry.adapter.name, entry.configPath) ??
      classifyMcpEntry(
        readEntry(entry.adapter, entry.configPath),
        editorEntryContext(ctx, entry.adapter.name)
      );
    checks.push(editorCheck(result, entry, initFix));
  }

  const broken = brokenUnconfiguredConfigs(ctx, configured);
  for (const { result, ...entry } of broken) checks.push(editorCheck(result, entry, initFix));
  if (configured.length === 0 && !broken.some(mayHoldArgentEntry)) {
    checks.push(
      check("error", "No editor has an argent MCP entry for this project", { fix: initFix })
    );
  }

  const configuredNames = new Set([...configured, ...broken].map((c) => c.adapter.name));
  const localMode = resolveInstallMode(ctx.projectRoot) === "local";
  const unconfigured = detectAdapters()
    .filter((a) => !configuredNames.has(a.name))
    .filter((a) => !localMode || a.projectPath(ctx.projectRoot) !== null)
    .map((a) => a.name);
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

export function managedTargets(ctx: Pick<DoctorContext, "configured" | "projectRoot">) {
  const adaptersIn = (scope: "project" | "global") =>
    ctx.configured.filter((c) => c.scope === scope).map((c) => c.adapter);
  const local = getManagedContentTargets(adaptersIn("project"), ctx.projectRoot, "local");
  const global = getManagedContentTargets(adaptersIn("global"), ctx.projectRoot, "global");
  return {
    skillDirs: [...local.skillTargets, ...global.skillTargets].map((t) => t.targetPath),
    ruleDirs: [...new Set(local.ruleTargets.map((t) => t.targetPath))],
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

export function xcodesIn(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => /^Xcode(?:[-_ ].*)?\.app$/.test(name))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

function installedXcodes(): string[] {
  return [...xcodesIn("/Applications"), ...xcodesIn(path.join(homedir(), "Applications"))];
}

function selectXcodeFix(xcodeApps: string[]): string {
  const app = xcodeApps.find((p) => path.basename(p) === "Xcode.app") ?? xcodeApps[0];
  const developerDir = `${app ?? "/Applications/Xcode.app"}/Contents/Developer`;
  const select = formatShellCommand({ bin: "sudo", args: ["xcode-select", "-s", developerDir] });
  const run = process.env.DEVELOPER_DIR
    ? `unset DEVELOPER_DIR (it overrides xcode-select), then run ${select}`
    : `run ${select}`;
  return app
    ? run.charAt(0).toUpperCase() + run.slice(1)
    : `Install Xcode from the App Store, open it once, then ${run}`;
}

function iosCheck(xcode: HostDepsReport["xcode"], xcodeApps: string[]): DoctorCheck {
  if (!xcode) return check("info", "iOS simulators: need a macOS host");
  if (xcode.simctl && xcode.firstLaunch) {
    return check("warn", "iOS simulators: Xcode has not finished installing its components", {
      detail: xcode.developerDir ?? undefined,
      fix: xcode.firstLaunch.charAt(0).toUpperCase() + xcode.firstLaunch.slice(1),
    });
  }
  if (xcode.simctl)
    return check("ok", "iOS simulators", { detail: `Xcode at ${xcode.developerDir}` });
  if (!xcode.developerDir) {
    return check("warn", "iOS simulators: Xcode not found", { fix: selectXcodeFix(xcodeApps) });
  }
  return check("warn", "iOS simulators: the active developer directory has no simctl", {
    detail: xcode.developerDir,
    fix: selectXcodeFix(xcodeApps),
  });
}

function androidCheck(adb: string | null): DoctorCheck {
  if (adb) return check("ok", "Android", { detail: `adb at ${home(adb)}` });
  const sdkVar = ["ANDROID_HOME", "ANDROID_SDK_ROOT"].find((name) => process.env[name]);
  return check("warn", "Android: adb not found", {
    detail: sdkVar && `${sdkVar} is ${process.env[sdkVar]}, which has no platform-tools/adb`,
    fix: "Install Android SDK Platform Tools (Android Studio > SDK Manager), or set ANDROID_HOME to the SDK root",
  });
}

export function toolchainChecks(
  report: HostDepsReport,
  xcodeApps: string[] = installedXcodes()
): DoctorCheck[] {
  return [iosCheck(report.xcode, xcodeApps), androidCheck(report.adb)];
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

function hasClaudeProjectConfig(dir: string): boolean {
  return findConfigured(dir).some(
    (entry) => entry.scope === "project" && entry.adapter.name === "Claude Code"
  );
}

function ancestorsInRepo(dir: string, homeDir: string): string[] {
  const ancestors = ancestorsBelowHome(dir, homeDir);
  const repoIndex = [dir, ...ancestors].findIndex((d) => fs.existsSync(path.join(d, ".git")));
  return repoIndex === -1 ? ancestors : ancestors.slice(0, repoIndex);
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
  const resolvedHome = path.resolve(homeDir);
  if (projectRoot === resolvedHome || hasProjectConfig(projectRoot)) return projectRoot;
  return (
    ancestorsInRepo(projectRoot, resolvedHome).find(hasProjectConfig) ??
    ancestorsBelowHome(projectRoot, resolvedHome).find(hasClaudeProjectConfig) ??
    projectRoot
  );
}

function crossesGitRoot(cwd: string, projectRoot: string): boolean {
  const dirs = [cwd, ...ancestorsBelowHome(cwd, path.resolve(homedir()))];
  const rootIndex = dirs.indexOf(projectRoot);
  return rootIndex > 0 && dirs.slice(0, rootIndex).some((d) => fs.existsSync(path.join(d, ".git")));
}

function readsConfigAt(editor: string, aboveRepo: boolean): boolean {
  return !aboveRepo || editor === "Claude Code";
}

export function configuredFor(projectRoot: string, cwd: string): ConfiguredAdapterScope[] {
  const aboveRepo = crossesGitRoot(cwd, projectRoot);
  return findConfigured(projectRoot).filter(
    (entry) => entry.scope === "global" || readsConfigAt(entry.adapter.name, aboveRepo)
  );
}

function offPathBinDir(): string | null {
  const bin = process.argv[1];
  if (!bin || path.basename(bin) !== MCP_BINARY_NAME) return null;
  const dir = path.dirname(bin);
  if (path.basename(dir) === ".bin") return null;
  return (process.env.PATH ?? "").split(path.delimiter).includes(dir) ? null : dir;
}

export function globalInstallFix(): string {
  const binDir = offPathBinDir();
  if (binDir) return `Add ${binDir} to PATH`;
  return formatShellCommand(globalInstallCommand(detectGlobalPackageManager(), PACKAGE_NAME));
}

function buildContext(paths: ToolsServerPaths, cwd: string): DoctorContext {
  const projectRoot = resolveDoctorRoot(cwd);
  const globalOnPath = isGloballyInstalled();
  const local = probeLocalInstall(projectRoot);
  return {
    projectRoot,
    cwd,
    configured: configuredFor(projectRoot, cwd),
    running: paths.version ?? getInstalledVersion() ?? "unknown",
    paths,
    globalOnPath,
    localInstalled: local.installed,
    localPackageDir: resolveInstallMode(projectRoot) === "local" ? local.packageDir : null,
    argentCommand: globalOnPath ? MCP_BINARY_NAME : `npx ${PACKAGE_NAME}`,
    globalInstallFix: globalInstallFix(),
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

function failureSummary(failed: DoctorCheck[]): string {
  const errors = failed.filter((c) => c.status === "error").length;
  const warnings = failed.length - errors;
  const parts: string[] = [];
  if (errors > 0) parts.push(`${plural(errors, "check")} failed`);
  if (warnings > 0) parts.push(plural(warnings, "warning"));
  return parts.join(" and ");
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
    `${passedCount}/${scored.length} checks passed. ${failureSummary(failed)}. Possible issues detected:`,
  ];
  if (!verbose && passedCount > 0) lines.push(pc.dim("Use --verbose to see the passed checks."));
  lines.push(...passedDetails);
  for (const c of failed) lines.push("", ...failedBlock(c));
  lines.push("", `${failureSummary(failed)}, indicating possible issues with your setup.`);
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

  const report = await collectDoctorReport(options.paths, process.cwd());
  console.log(renderDoctorReport(report, argv.includes("--verbose")));
  if (countStatus(report, "error") > 0) process.exitCode = 1;
}
