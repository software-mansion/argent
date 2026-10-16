import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import pc from "picocolors";
import { getConsentState } from "@argent/telemetry";
import {
  getResolvedToolsUrl,
  isToolsServerHealthy,
  isToolsServerProcessAlive,
  readAllToolsServerStates,
  readToolsServerState,
  formatToolsServerUrl,
  LINK_URL_SCHEME,
  type ToolsServerPaths,
} from "@argent/tools-client";
import {
  ALL_ADAPTERS,
  detectAdapters,
  detectProjectPackageManager,
  findConfiguredAdapterScopes,
  formatShellCommand,
  getInstalledVersion,
  getManagedContentTargets,
  globalInstallCommand,
  hasCustomizingEnv,
  isArgentDisabledInClaudeProject,
  isNewerVersion,
  isTempRunnerPath,
  isYarnPnp,
  listBundledSkills,
  nodeSatisfiesEngines,
  probeLocalInstall,
  projectInstallCommand,
  readCliRecord,
  readInstallRecord,
  resolveInstallMode,
  resolveProjectRoot,
  ARGENT_SKILL_PREFIX,
  MCP_BINARY_NAME,
  NPM_REGISTRY,
  PACKAGE_NAME,
  RULES_DIR,
  type McpConfigAdapter,
  type McpServerEntry,
} from "@argent/installer";

const execFileAsync = promisify(execFile);

// `argent doctor`: a read-only health report. Every check reuses the probe the
// real code path runs (install topology, MCP entries, tool-server state, the
// tool-server's own dependency resolvers), so doctor and the failure it
// explains can't disagree. It never repairs anything: each problem names the
// command that does (`argent init`, `argent update`, an installer).

type CheckStatus = "ok" | "warn" | "error" | "info";

interface DoctorCheck {
  status: CheckStatus;
  label: string;
  detail?: string;
  /** The command or action that resolves a warn/error. */
  fix?: string;
}

export interface DoctorSection {
  title: string;
  checks: DoctorCheck[];
}

export interface DoctorReport {
  version: string;
  node: string;
  platform: string;
  projectRoot: string;
  sections: DoctorSection[];
  errors: number;
  warnings: number;
}

// Mirrors `tool-server --check-deps` (tool-server/src/utils/host-deps-report.ts).
interface HostDepsReport {
  platform: NodeJS.Platform;
  deps: Array<{ dep: string; path: string | null; hint: string }>;
  bundled: Array<{ name: string; path: string | null; error?: string }>;
  signing: { teamIdEnv: string | null; detectedTeams: number } | null;
  /** Absent from reports of builds that predate the field. */
  xcode?: { developerDir: string | null; simctl: boolean; fromEnv?: boolean } | null;
  chromiumPorts?: number[];
}

type ResolvedToolsUrl = Awaited<ReturnType<typeof getResolvedToolsUrl>>;

/** Facts every section shares, probed once per run. */
export interface DoctorContext {
  projectRoot: string;
  /** Where doctor runs: global-scope `node <relative>` entries resolve from here. */
  cwd: string;
  mode: "global" | "local";
  global: GlobalInstall | null;
  /** How to spell an argent command in a fix line (`argent`, or via npx when not on PATH). */
  argentCmd: string;
  /** The project's own install command (`pnpm install`, …). */
  installCmd: string;
  /** Bin dir of the running global install when it is not on PATH. */
  offPathGlobalBin: string | null;
}

const UPDATE_CHECK_TIMEOUT_MS = 2_500;
const DEPS_PROBE_TIMEOUT_MS = 30_000;

function check(
  status: CheckStatus,
  label: string,
  extra: Omit<DoctorCheck, "status" | "label"> = {}
): DoctorCheck {
  return { status, label, ...extra };
}

function home(p: string): string {
  const h = homedir();
  if (h === path.sep || !h) return p;
  return p === h || p.startsWith(h + path.sep) ? `~${p.slice(h.length)}` : p;
}

// MARK: Global install probe

interface GlobalInstall {
  bin: string;
  /** Package root, when the bin links into one (npm). Null for script shims (pnpm, Yarn). */
  root: string | null;
  version: string | null;
}

function isExecutableFile(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (process.platform !== "win32") fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
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

/** Where a global install's `argent` would be: `<prefix>/bin`, or `<prefix>` on Windows. */
export function globalBinDirOf(packageRoot: string): string | null {
  const nodeModules = path.dirname(path.dirname(packageRoot));
  if (path.basename(nodeModules) !== "node_modules") return null;
  const prefixDir = path.dirname(nodeModules);
  const candidates =
    path.basename(prefixDir) === "lib" ? [path.join(path.dirname(prefixDir), "bin")] : [prefixDir];
  return candidates.find((dir) => findGlobalArgent(dir) !== null) ?? null;
}

type PackageManager = "npm" | "yarn" | "pnpm" | "bun";

/** The package manager that owns a global install, from where it lives. */
export function globalPackageManagerOf(packageRoot: string): PackageManager {
  const p = packageRoot.replace(/\\/g, "/");
  if (p.includes("/.bun/")) return "bun";
  if (/\/pnpm\//i.test(p)) return "pnpm";
  if (/\/yarn\/(global|data\/global)\//i.test(p) || p.includes("/.yarn/")) return "yarn";
  return "npm";
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
  for (const dir of (pathValue ?? "").split(path.delimiter)) {
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

// MARK: Install

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

function installSection(
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
    !global && ctx.offPathGlobalBin
      ? check("warn", "Installed globally, but its bin dir is not on PATH", {
          detail: home(ctx.offPathGlobalBin),
          fix: `Add ${home(ctx.offPathGlobalBin)} to PATH`,
        })
      : !global
        ? check("info", "No global install on PATH")
        : global.root
          ? check("ok", `Global install v${global.version ?? "?"} on PATH`, {
              detail: home(global.root),
            })
          : check("ok", "Global install on PATH", {
              detail: `${home(global.bin)} (a script shim, so its version can't be read)`,
            })
  );

  if (ctx.mode === "local") {
    const local = probeLocalInstall(projectRoot);
    const source = readInstallRecord(projectRoot) ? ".argent/install.json" : "package.json";
    if (!local.installed) {
      checks.push(
        check("error", `Project uses a local install (${source}) but it is not installed`, {
          fix: ctx.installCmd,
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

// MARK: Editors

export interface EntryContext {
  scope: "project" | "global";
  projectRoot: string;
  cwd: string;
  globalOnPath: boolean;
  localInstalled: boolean;
  argentCmd: string;
  installCmd: string;
  /** Claude Code's local scope, which `argent init` never writes or clears. */
  claudeLocal?: boolean;
  /** Bin dir of a global install that is not on PATH. */
  offPathGlobalBin?: string | null;
}

function formatEntry(entry: McpServerEntry): string {
  return [entry.command, ...entry.args].join(" ");
}

// `npx -y @swmansion/argent@latest mcp`: fetched on start, needs no local copy.
const ON_DEMAND_PACKAGE = /^@swmansion\/argent(@.+)?$/;
const ARGENT_PACKAGE_ARG = /^(@swmansion\/)?argent(@.+)?$/;
const NPX_NO_INSTALL = new Set(["--no-install", "--no"]);

/**
 * Will this MCP entry start? Mirrors the "provably dead" rule `init` uses to
 * prune stale entries (init-stale-config.ts): a command that resolves in this
 * shell is fine; one that doesn't is dead unless custom env may fix it in the
 * client (an nvm PATH, classically). The CLI dispatches on its first argument,
 * so `mcp` must follow the argent binary, script or package.
 */
export function classifyMcpEntry(entry: McpServerEntry, ctx: EntryContext): DoctorCheck {
  const cmd = formatEntry(entry);
  const result = classifyCommand(entry, ctx);
  if (entry.switchedOffBy && (result.status === "ok" || result.status === "info")) {
    return check("warn", `${cmd} — switched off in the editor`, {
      detail: `\`${entry.switchedOffBy === "enabled" ? "enabled: false" : "disabled: true"}\``,
      fix: "Turn the argent server back on in the editor's MCP settings",
    });
  }
  return result;
}

function classifyCommand(entry: McpServerEntry, ctx: EntryContext): DoctorCheck {
  const cmd = formatEntry(entry);
  const reinit = ctx.claudeLocal
    ? `claude mcp remove -s local argent, then ${ctx.argentCmd} init`
    : `${ctx.argentCmd} init`;
  if (entry.command === "") {
    return check("warn", "argent entry exists but could not be parsed", { fix: reinit });
  }
  const badArgs = (): DoctorCheck =>
    check("error", `${cmd} — doesn't start the MCP server (argent's command must be \`mcp\`)`, {
      fix: reinit,
    });
  const deadPath = (p: string): DoctorCheck =>
    check("error", `${cmd} — ${p} does not exist`, {
      fix: ctx.claudeLocal
        ? `Point the entry at an existing argent, or run ${reinit}`
        : `Point the entry at an existing argent, or remove it and run ${ctx.argentCmd} init`,
    });
  const base = ctx.scope === "project" ? ctx.projectRoot : ctx.cwd;
  const absolute = path.isAbsolute(entry.command);
  const pathLike = absolute || /[\\/]/.test(entry.command);
  const fileName = path.basename(entry.command);
  const bare = process.platform === "win32" ? fileName.replace(/\.(cmd|exe)$/i, "") : fileName;

  if (pathLike && !fs.existsSync(path.resolve(base, entry.command))) {
    return deadPath(entry.command);
  }
  if (bare === MCP_BINARY_NAME) {
    if (entry.args[0] !== "mcp") return badArgs();
    if (pathLike || ctx.globalOnPath) return check("ok", cmd);
    if (hasCustomizingEnv(entry)) {
      return check("warn", `${cmd} — \`argent\` is not on this shell's PATH`, {
        detail: "its custom env may still make it resolve inside the editor",
      });
    }
    return check("error", `${cmd} — \`argent\` is not on PATH, so this entry can't start`, {
      fix: ctx.offPathGlobalBin
        ? `Add ${home(ctx.offPathGlobalBin)} to PATH`
        : "npm i -g @swmansion/argent (or npx @swmansion/argent init)",
    });
  }
  if (bare === "node") {
    // Node's own flags (`--no-warnings`) come before the script.
    const at = entry.args.findIndex((a) => !a.startsWith("-"));
    const script = at === -1 ? undefined : entry.args[at];
    if (!script || entry.args[at + 1] !== "mcp") return badArgs();
    if (script.includes("${")) {
      return check("info", `${cmd} (uses an editor variable, not verified)`);
    }
    if (fs.existsSync(path.resolve(base, script))) return check("ok", cmd);
    const inProjectDeps =
      !path.isAbsolute(script) &&
      /node_modules[\\/]/.test(script) &&
      fs.existsSync(path.join(ctx.projectRoot, "package.json"));
    return inProjectDeps
      ? check("error", `${cmd} — ${script} does not exist`, { fix: ctx.installCmd })
      : deadPath(script);
  }
  if (bare === "npx" || bare === "yarn") {
    const startsMcp = entry.args.some(
      (a, i) => ARGENT_PACKAGE_ARG.test(a) && entry.args[i + 1] === "mcp"
    );
    if (!startsMcp) return badArgs();
    const onDemand =
      bare === "npx" &&
      !entry.args.some((a) => NPX_NO_INSTALL.has(a)) &&
      entry.args.some((a) => ON_DEMAND_PACKAGE.test(a));
    if (onDemand) {
      return check("ok", cmd, { detail: "fetched from npm when the editor starts it" });
    }
    return ctx.localInstalled
      ? check("ok", cmd)
      : check("error", `${cmd} — no local @swmansion/argent to run`, { fix: ctx.installCmd });
  }
  return check("info", `${cmd} (custom command, not verified)`);
}

// Which editor honours which switch-off key; the rest start the entry anyway.
const SWITCH_OFF_KEY: Record<string, McpServerEntry["switchedOffBy"]> = {
  Cursor: "disabled",
  Windsurf: "disabled",
  Kiro: "disabled",
  Codex: "enabled",
  Hermes: "enabled",
  opencode: "enabled",
};

// Claude Code starts one entry per name: local scope wins over project, project over user.
const CLAUDE_SCOPE_RANK = { local: 2, project: 1, global: 0 } as const;
type ClaudeScope = keyof typeof CLAUDE_SCOPE_RANK;

/** Claude Code rejects a config file that is not strict JSON (comments, trailing commas). */
export function isStrictJson(configPath: string): boolean {
  try {
    let text = fs.readFileSync(configPath, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export function editorsSection(ctx: DoctorContext): DoctorSection {
  const { projectRoot } = ctx;
  const checks: DoctorCheck[] = [];
  // Run from ~, a project config path can be the global one: list it once.
  const seenPaths = new Set<string>();
  const configured = findConfiguredAdapterScopes(ALL_ADAPTERS, projectRoot)
    .map((c) =>
      c.scope === "project" && c.configPath === c.adapter.globalPath()
        ? { ...c, scope: "global" as const }
        : c
    )
    .filter((c) => !seenPaths.has(c.configPath) && seenPaths.add(c.configPath));
  const entryCtx = {
    projectRoot,
    cwd: ctx.cwd,
    globalOnPath: ctx.global !== null,
    localInstalled: probeLocalInstall(projectRoot).installed,
    argentCmd: ctx.argentCmd,
    installCmd: ctx.installCmd,
    offPathGlobalBin: ctx.offPathGlobalBin,
  };

  interface Found {
    adapterName: string;
    entry: McpServerEntry;
    scope: "project" | "global";
    location: string;
    claudeScope?: ClaudeScope;
  }
  const found: Found[] = [];
  const notes: DoctorCheck[] = [];

  for (const { adapter, scope, configPath } of configured) {
    if (adapter.name === "Claude Code" && !isStrictJson(configPath)) {
      checks.push(
        check("error", "Claude Code: the config file is not valid JSON, so Claude Code skips it", {
          detail: home(configPath),
          fix: "Fix the JSON syntax (Claude Code allows no comments or trailing commas)",
        })
      );
      continue;
    }
    let entry: McpServerEntry | null;
    try {
      entry = adapter.getArgentEntry(configPath);
    } catch {
      entry = { command: "", args: [] };
    }
    if (!entry) continue;
    found.push({
      adapterName: adapter.name,
      entry,
      scope,
      location: `${home(configPath)} (${scope})`,
      ...(adapter.name === "Claude Code" ? { claudeScope: scope } : {}),
    });
    if (
      adapter.name === "Gemini" &&
      scope === "project" &&
      path.resolve(ctx.cwd) !== path.resolve(projectRoot)
    ) {
      notes.push(
        check(
          "warn",
          "Gemini: reads the project's .gemini/settings.json only when started from it",
          {
            detail: home(projectRoot),
            fix: `Start Gemini from ${home(projectRoot)}`,
          }
        )
      );
    }
  }

  // Scopes outside the projectPath/globalPath pair: VS Code's user-profile
  // mcp.json, Claude Code's local scope and its recorded .mcp.json rejections.
  for (const adapter of ALL_ADAPTERS) {
    if (!adapter.findShadowingConfigs) continue;
    const isClaude = adapter.name === "Claude Code";
    const hasProjectEntry = configured.some((c) => c.adapter === adapter && c.scope === "project");
    try {
      for (const finding of adapter.findShadowingConfigs(
        projectRoot,
        hasProjectEntry ? "local" : "global"
      )) {
        if (finding.entry) {
          found.push({
            adapterName: adapter.name,
            entry: finding.entry,
            scope: isClaude ? "project" : "global",
            location: finding.location,
            ...(isClaude ? { claudeScope: "local" as const } : {}),
          });
        }
        if (!finding.entry || (!isClaude && hasProjectEntry)) {
          notes.push(
            check("warn", `${adapter.name}: ${finding.reason}`, { detail: finding.location })
          );
        }
      }
    } catch {
      // A malformed editor config must not abort the report.
    }
  }

  const claudeRanks = found.flatMap((f) =>
    f.claudeScope ? [CLAUDE_SCOPE_RANK[f.claudeScope]] : []
  );
  const claudeWinner = claudeRanks.length > 0 ? Math.max(...claudeRanks) : null;
  for (const f of found) {
    if (f.claudeScope && CLAUDE_SCOPE_RANK[f.claudeScope] < claudeWinner!) {
      const winner = (Object.keys(CLAUDE_SCOPE_RANK) as ClaudeScope[]).find(
        (k) => CLAUDE_SCOPE_RANK[k] === claudeWinner
      );
      checks.push(
        check(
          "info",
          `${f.adapterName}: ${formatEntry(f.entry)} (unused: the ${winner}-scope entry wins)`,
          {
            detail: f.location,
          }
        )
      );
      continue;
    }
    const honoured = SWITCH_OFF_KEY[f.adapterName];
    const entry =
      f.entry.switchedOffBy && f.entry.switchedOffBy !== honoured
        ? { ...f.entry, switchedOffBy: undefined }
        : f.entry;
    const result = classifyMcpEntry(entry, {
      ...entryCtx,
      scope: f.scope,
      claudeLocal: f.claudeScope === "local",
    });
    checks.push({
      ...result,
      label: `${f.adapterName}: ${result.label}`,
      detail: [f.location, result.detail].filter(Boolean).join(" · "),
    });
  }
  checks.push(...notes);

  if (claudeWinner !== null && isArgentDisabledInClaudeProject(projectRoot)) {
    checks.push(
      check("warn", "Claude Code: argent is switched off for this project", {
        detail: "~/.claude.json disabledMcpServers",
        fix: "Turn it back on under /mcp in Claude Code",
      })
    );
  }

  const configuredNames = new Set(found.map((f) => f.adapterName));
  if (found.length === 0 && !checks.some((c) => c.status === "error")) {
    checks.push(
      check("error", "argent is not configured in any supported editor for this project", {
        detail: "MCP clients set up by hand, outside argent init, are not checked",
        fix: `${ctx.argentCmd} init`,
      })
    );
  }

  const unconfigured = detectAdapters()
    // A local install only writes project configs: editors without one can't be added.
    .filter((a) => ctx.mode === "global" || a.projectPath(projectRoot) !== null)
    .map((a) => a.name)
    .filter((name) => !configuredNames.has(name));
  if (unconfigured.length > 0) {
    checks.push(
      check("info", `Detected without argent: ${unconfigured.join(", ")}`, {
        detail: `run ${ctx.argentCmd} init to add them`,
      })
    );
  }

  return { title: "Editors (MCP config)", checks };
}

// MARK: Skills & rules

// A skill counts only when its directory resolves: a symlink into a missing
// `.agents/` (a fresh clone) is no skill to the agent, and neither is a name
// that is only in a lock file.
function listArgentDirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((name) => {
      if (!name.startsWith(ARGENT_SKILL_PREFIX)) return false;
      try {
        return fs.statSync(path.join(dir, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function hasClaudeLocalScopeEntry(projectRoot: string): boolean {
  const claude = ALL_ADAPTERS.find((a) => a.name === "Claude Code");
  try {
    return (claude?.findShadowingConfigs?.(projectRoot, "global") ?? []).some((f) => f.entry);
  } catch {
    return false;
  }
}

export function skillsSection(ctx: DoctorContext, reinstall: string): DoctorSection {
  const { projectRoot } = ctx;
  const checks: DoctorCheck[] = [];
  const configured = findConfiguredAdapterScopes(ALL_ADAPTERS, projectRoot).map((c) => ({
    adapter: c.adapter,
    scope: c.scope === "project" ? ("local" as const) : ("global" as const),
  }));
  const claude = ALL_ADAPTERS.find((a) => a.name === "Claude Code");
  if (claude && hasClaudeLocalScopeEntry(projectRoot)) {
    configured.push({ adapter: claude, scope: "local" });
  }
  const adapters = [...new Set(configured.map((c) => c.adapter))];

  // Each editor loads skills from its own dirs in either scope, whatever scope
  // its MCP entry is in. The shared .agents/skills is not read by Claude Code.
  const skillDirs = (adapter: McpConfigAdapter | null): string[] =>
    (["local", "global"] as const).flatMap((scope) =>
      getManagedContentTargets(adapter ? [adapter] : [], projectRoot, scope)
        .skillTargets.filter((t) => t.editorName !== "skills" || adapter?.name !== "Claude Code")
        .map((t) => t.targetPath)
    );
  const installedIn = (dirs: string[]): Set<string> =>
    new Set(dirs.flatMap((d) => listArgentDirs(d)));

  const bundled = listBundledSkills();
  if (bundled.length === 0) {
    checks.push(
      check("error", "The argent package ships no skills (a partial install)", { fix: reinstall })
    );
  } else {
    const perEditor = (adapters.length > 0 ? adapters : [null]).map((adapter) => {
      const installed = installedIn(skillDirs(adapter));
      return { name: adapter?.name, missing: bundled.filter((s) => !installed.has(s)) };
    });
    const noneAnywhere = perEditor.every((e) => e.missing.length === bundled.length);
    const prefix = (name: string | undefined) =>
      name && adapters.length > 1 && !noneAnywhere ? `${name}: ` : "";
    if (perEditor.every((e) => e.missing.length === 0)) {
      checks.push(check("ok", `${bundled.length}/${bundled.length} argent skills installed`));
    }
    for (const { name, missing } of noneAnywhere ? perEditor.slice(0, 1) : perEditor) {
      if (missing.length === bundled.length) {
        checks.push(
          check("error", `${prefix(name)}No argent skills installed`, {
            fix: `${ctx.argentCmd} init`,
          })
        );
      } else if (missing.length > 0) {
        checks.push(
          check(
            "warn",
            `${prefix(name)}${bundled.length - missing.length}/${bundled.length} argent skills installed`,
            { detail: `missing: ${missing.join(", ")}`, fix: `${ctx.argentCmd} update` }
          )
        );
      }
    }
  }

  let ruleFiles: string[] = [];
  try {
    ruleFiles = fs.readdirSync(RULES_DIR).filter((f) => f.endsWith(".md"));
  } catch {
    // Reported below.
  }
  if (ruleFiles.length === 0) {
    checks.push(
      check("error", "The argent package ships no rules (a partial install)", { fix: reinstall })
    );
    return { title: "Skills & rules", checks };
  }
  const absentIn = (dir: string) => ruleFiles.filter((f) => !fs.existsSync(path.join(dir, f)));
  const ruleDirs = (adapter: McpConfigAdapter, scope: "local" | "global") =>
    getManagedContentTargets([adapter], projectRoot, scope).ruleTargets.map((t) => t.targetPath);
  const ruleTargets = new Set<string>();
  for (const { adapter, scope } of configured) {
    if (adapter.name !== "Claude Code") ruleDirs(adapter, scope).forEach((t) => ruleTargets.add(t));
  }
  const claudeScopes = configured.filter((c) => c.adapter.name === "Claude Code");
  if (claudeScopes.length > 0) {
    // Claude Code loads ~/.claude/rules and the project's .claude/rules alike.
    const [first] = claudeScopes;
    const either = [...ruleDirs(first!.adapter, "local"), ...ruleDirs(first!.adapter, "global")];
    const complete = either.find((d) => absentIn(d).length === 0);
    const fallback = ruleDirs(
      first!.adapter,
      claudeScopes.some((c) => c.scope === "local") ? "local" : "global"
    );
    const target = complete ?? fallback[0];
    if (target) ruleTargets.add(target);
  }
  for (const target of ruleTargets) {
    const absent = absentIn(target);
    checks.push(
      absent.length === 0
        ? check("ok", `Rules present in ${home(target)}`)
        : check("warn", `Rules missing in ${home(target)}`, {
            detail: absent.join(", "),
            fix: `${ctx.argentCmd} update`,
          })
    );
  }

  return { title: "Skills & rules", checks };
}

// MARK: Tool-server

/** What a linked tool-server's `/tools` answer means; null status = no answer. */
export function remoteCheck(
  status: number | null,
  url: string,
  source: ResolvedToolsUrl["source"]
): DoctorCheck {
  const where = `${redactUrl(url)} (${source === "env" ? "ARGENT_TOOLS_URL" : "~/.argent/link.json"})`;
  if (status !== null && status >= 200 && status < 300) {
    return check("ok", `Linked to ${where}, reachable`);
  }
  if (status === 401 || status === 403) {
    return check("error", `Linked to ${where}, which rejects the token (HTTP ${status})`, {
      fix:
        source === "env"
          ? "Set ARGENT_AUTH_TOKEN to the token the remote server printed"
          : "Pair again: argent link <the argent:// string argent server start printed>",
    });
  }
  return check(
    "error",
    `Linked to ${where}, ${status === null ? "unreachable" : `HTTP ${status}`}`,
    {
      fix:
        source === "env"
          ? "Start the remote server, or unset ARGENT_TOOLS_URL"
          : "Start the remote server, or run argent unlink",
    }
  );
}

/** The URL without its credentials, which users paste into bug reports. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    parsed.username = "***";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

// The tools client appends `/tools` to the URL as given, so probe the same URL.
async function remoteStatus(url: string, token?: string): Promise<number | null> {
  try {
    const res = await fetch(`${url}/tools`, {
      signal: AbortSignal.timeout(2_000),
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    // An unread body keeps the keep-alive socket (and the process) alive.
    await res.body?.cancel();
    return res.status;
  } catch {
    return null;
  }
}

async function toolServerSection(
  ctx: DoctorContext,
  running: string,
  paths: ToolsServerPaths,
  linked: ResolvedToolsUrl
): Promise<DoctorSection> {
  const checks: DoctorCheck[] = [];

  if (linked.url?.startsWith(LINK_URL_SCHEME)) {
    checks.push(
      check("error", "ARGENT_TOOLS_URL holds an argent:// pairing string, not a server URL", {
        detail: redactUrl(linked.url),
        fix: "Unset ARGENT_TOOLS_URL and run argent link <the argent:// string>",
      })
    );
    return { title: "Tool-server", checks };
  }
  if (linked.url) {
    checks.push(
      remoteCheck(await remoteStatus(linked.url, linked.token), linked.url, linked.source)
    );
    return { title: "Tool-server", checks };
  }

  const state = await readToolsServerState(paths.bundlePath);
  if (!state) {
    checks.push(check("info", "Not running (starts on the first tool call)"));
  } else {
    const host = state.host ?? "127.0.0.1";
    const url = formatToolsServerUrl(host, state.port);
    const alive = isToolsServerProcessAlive(state.pid);
    const healthy = alive && (await isToolsServerHealthy(state.port, host, 2_000, state.token));
    if (healthy) {
      const stale = state.version && state.version !== running;
      checks.push(
        stale
          ? check("warn", `Running ${url} (pid ${state.pid}) from v${state.version}`, {
              fix: `${ctx.argentCmd} server stop (the next tool call starts the current version)`,
            })
          : check("ok", `Running ${url} (pid ${state.pid})`)
      );
    } else {
      checks.push(
        check("info", `Stale state file (pid ${state.pid} ${alive ? "unhealthy" : "gone"})`, {
          detail: "the next tool call respawns it",
        })
      );
    }
  }

  const foreign = (await readAllToolsServerStates()).filter(
    ({ state: s }) => s.bundlePath !== paths.bundlePath && isToolsServerProcessAlive(s.pid)
  );
  if (foreign.length > 0) {
    checks.push(
      check("info", `${foreign.length} tool-server(s) from other argent installs running`, {
        detail: foreign.map(({ state: s }) => `pid ${s.pid}`).join(", "),
      })
    );
  }

  return { title: "Tool-server", checks };
}

// MARK: Platforms

async function probeHostDeps(paths: ToolsServerPaths): Promise<HostDepsReport | string> {
  try {
    const { stdout } = await execFileAsync(process.execPath, [paths.bundlePath, "--check-deps"], {
      timeout: DEPS_PROBE_TIMEOUT_MS,
      env: {
        ...process.env,
        ARGENT_SIMULATOR_SERVER_DIR: paths.simulatorServerDir,
        ARGENT_NATIVE_DEVTOOLS_DIR: paths.nativeDevtoolsDir,
      },
    });
    return JSON.parse(stdout) as HostDepsReport;
  } catch (err) {
    return depsProbeFailure(err);
  }
}

/** Why `--check-deps` failed. Only execFile's own timeout kill sets `killed`. */
export function depsProbeFailure(err: unknown): string {
  const { stderr, killed, signal } = err as {
    stderr?: unknown;
    killed?: boolean;
    signal?: string | null;
  };
  if (killed) {
    return `timed out after ${DEPS_PROBE_TIMEOUT_MS / 1000}s (${signal ?? "killed"})`;
  }
  const fallback = err instanceof Error ? err.message.split("\n")[0]! : String(err);
  const reason = childFailureReason(typeof stderr === "string" ? stderr : "", fallback);
  return signal ? `killed by ${signal}: ${reason}` : reason;
}

/**
 * The cause of a failed `--check-deps` run. execFile's message starts with a
 * bare "Command failed: <cmd>"; the reason is in stderr. A crash on load
 * prints a code frame and a stack around the error line, so pick that line.
 */
export function childFailureReason(stderr: string, fallback: string): string {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.find((l) => /^[\w.]*Error\b/.test(l)) ?? lines[0] ?? fallback;
}

export function platformChecks(report: HostDepsReport, reinstall: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const dep = (name: string) => report.deps.find((d) => d.dep === name);
  const brokenBundle = report.bundled.filter((b) => b.error);
  for (const b of brokenBundle) {
    const broken = b.error?.startsWith("not executable") ? "is not executable" : "is missing";
    checks.push(
      check("error", `Bundled ${b.name} ${broken}`, {
        detail: b.error,
        fix: reinstall,
      })
    );
  }
  const bundleOk = (names: string[]) => !brokenBundle.some((b) => names.includes(b.name));
  let usable = 0;

  if (report.platform !== "darwin") {
    checks.push(check("info", "iOS simulator: requires a macOS host"));
  } else {
    const xcrun = dep("xcrun");
    // /usr/bin/xcrun is a shim on every Mac: simulators need a developer dir
    // with simctl (full Xcode, not just the Command Line Tools).
    const noSimctl = report.xcode != null && !report.xcode.simctl;
    const fromEnv = report.xcode?.fromEnv === true;
    if (xcrun?.path && noSimctl) {
      const dir = report.xcode?.developerDir ?? "xcode-select -p failed";
      checks.push(
        check("info", "iOS simulator: Xcode not found (no simctl in the active developer dir)", {
          detail: fromEnv ? `${dir} (from DEVELOPER_DIR)` : dir,
          fix: fromEnv
            ? "Unset DEVELOPER_DIR, or point it at /Applications/Xcode.app/Contents/Developer"
            : "Install Xcode, then sudo xcode-select -s /Applications/Xcode.app",
        })
      );
    } else if (xcrun?.path && bundleOk(["simulator-server", "ax-service"])) {
      usable++;
      checks.push(
        check("ok", "iOS simulator", {
          detail: report.xcode?.developerDir ?? `xcrun at ${xcrun.path}`,
        })
      );
    } else if (!xcrun?.path) {
      checks.push(
        check("info", "iOS simulator: Xcode command-line tools not found", { fix: xcrun?.hint })
      );
    }

    const signing = report.signing;
    if (noSimctl) {
      checks.push(
        check("info", "Physical iPhone: needs full Xcode (devicectl and xcodebuild)", {
          fix: "Install Xcode and select it as the developer dir (see iOS simulator above)",
        })
      );
    } else if (signing?.teamIdEnv) {
      checks.push(
        check("ok", `Physical iPhone: signing team ${signing.teamIdEnv} (ARGENT_IOS_TEAM_ID)`)
      );
    } else if (signing && signing.detectedTeams > 0) {
      checks.push(
        check("ok", `Physical iPhone: ${signing.detectedTeams} signing team(s) in keychain`)
      );
    } else {
      checks.push(
        check("info", "Physical iPhone: no Apple Development certificate in the keychain", {
          fix: "In Xcode > Settings > Accounts, sign in, then Manage Certificates > + > Apple Development; or set ARGENT_IOS_TEAM_ID",
        })
      );
    }
  }

  const adb = dep("adb");
  const emulator = dep("emulator");
  if (adb?.path) {
    usable++;
    checks.push(check("ok", "Android", { detail: `adb at ${home(adb.path)}` }));
    if (!emulator?.path) {
      checks.push(
        check("info", "Android emulator binary not found (can't boot AVDs)", {
          fix: emulator?.hint,
        })
      );
    }
  } else {
    checks.push(check("info", "Android: adb not found", { fix: adb?.hint }));
  }

  const vega = dep("vega");
  if (vega?.path && adb?.path) {
    usable++;
    checks.push(check("ok", "Vega (Fire TV)", { detail: `vega at ${home(vega.path)}` }));
  } else if (vega?.path) {
    // The Vega SDK does not ship adb, and most Vega tools need it.
    checks.push(
      check("warn", "Vega (Fire TV): adb not found, which Vega tools need too", {
        fix: adb?.hint,
      })
    );
  } else {
    checks.push(check("info", "Vega (Fire TV): vega CLI not found", { fix: vega?.hint }));
  }

  const ports = report.chromiumPorts ?? [9222];
  checks.push(
    check("info", `Chromium: probes CDP port${ports.length === 1 ? "" : "s"} ${ports.join(", ")}`, {
      detail: "launch with --remote-debugging-port, or set ARGENT_CHROMIUM_PORTS",
    })
  );

  // Chromium / Electron need nothing installed, so this is not a failure.
  if (usable === 0) {
    checks.unshift(
      check("warn", "No mobile platform toolchain found: only Chromium / Electron apps work", {
        fix:
          report.platform === "darwin"
            ? "Install Xcode (iOS) or Android platform-tools (Android, and Vega with the Vega SDK)"
            : "Install Android platform-tools (Android, and Vega with the Vega SDK)",
      })
    );
  }
  return checks;
}

async function platformsSection(
  paths: ToolsServerPaths,
  linked: ResolvedToolsUrl,
  reinstall: string
): Promise<DoctorSection> {
  if (linked.url) {
    return {
      title: "Platforms",
      checks: [check("info", "Skipped: device tools run on the linked tool-server's host")],
    };
  }
  const report = await probeHostDeps(paths);
  if (typeof report === "string") {
    return {
      title: "Platforms",
      checks: [
        check("error", "Could not run the bundled tool-server's dependency check", {
          detail: report,
          fix: reinstall,
        }),
      ],
    };
  }
  return { title: "Platforms", checks: platformChecks(report, reinstall) };
}

// MARK: Other

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(`${NPM_REGISTRY}/${PACKAGE_NAME}/latest`, {
      signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  }
}

async function otherSection(
  ctx: DoctorContext,
  running: string,
  offline: boolean,
  updateCmd: string
): Promise<DoctorSection> {
  const checks: DoctorCheck[] = [];
  const consent = getConsentState(process.env, ctx.projectRoot);
  const source = consent.source.detail ?? consent.source.source;
  checks.push(
    check("info", `Telemetry ${consent.enabled ? "enabled" : "disabled"} (${source})`, {
      detail: consent.enabled ? "argent telemetry disable to opt out" : undefined,
    })
  );

  if (offline) {
    checks.push(check("info", "Update check skipped (--offline)"));
  } else {
    const latest = await fetchLatestVersion();
    if (!latest) {
      checks.push(check("info", "Update check skipped (npm registry unreachable)"));
    } else if (isNewerVersion(latest, running)) {
      checks.push(check("warn", `Update available: v${running} → v${latest}`, { fix: updateCmd }));
    } else {
      checks.push(check("ok", `Up to date (latest v${latest})`));
    }
  }
  return { title: "Other", checks };
}

// MARK: Report

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

function currentDir(): string {
  try {
    return process.cwd();
  } catch {
    // The shell's directory was deleted (a removed worktree).
    return homedir();
  }
}

async function collectDoctorReport(options: {
  paths: ToolsServerPaths;
  offline: boolean;
}): Promise<DoctorReport> {
  const cwd = currentDir();
  const projectRoot = resolveProjectRoot(cwd);
  const mode = resolveInstallMode(projectRoot);
  const global = findGlobalArgent(stripPackageBinDirs(process.env.PATH ?? "", cwd));
  const packageRoot = path.dirname(path.dirname(options.paths.bundlePath));
  const runningLocal = options.paths.installKind === "local";
  const projectPm = detectProjectPackageManager(projectRoot);
  const localCmd = isYarnPnp(projectRoot) ? "yarn argent" : "npx argent";
  const ctx: DoctorContext = {
    projectRoot,
    cwd,
    mode,
    global,
    argentCmd: global ? "argent" : mode === "local" ? localCmd : "npx @swmansion/argent",
    installCmd: formatShellCommand(projectInstallCommand(projectPm)),
    offPathGlobalBin: !global && !runningLocal ? globalBinDirOf(packageRoot) : null,
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
  // `argent update` installs through npm unless launched by another package manager.
  const updateCmd =
    !runningLocal && globalPm !== "npm"
      ? formatShellCommand(globalInstallCommand(globalPm, `${PACKAGE_NAME}@latest`))
      : `${ctx.argentCmd} update`;
  const linked = await getResolvedToolsUrl();

  // Sections that touch the network or spawn a process run concurrently.
  const [toolServer, platforms, other] = await Promise.all([
    toolServerSection(ctx, running, options.paths, linked),
    platformsSection(options.paths, linked, reinstall),
    otherSection(ctx, running, options.offline, updateCmd),
  ]);
  const sections = [
    installSection(ctx, running, options.paths),
    editorsSection(ctx),
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
