import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { AUTH_TOKEN_ENV } from "@argent/tools-client";
import {
  ALL_ADAPTERS,
  detectAdapters,
  findConfiguredAdapterScopes,
  isArgentDisabledInClaudeProject,
  isInvalidJson,
  isInvalidToml,
  isSwitchedOffInEditor,
  probeLocalInstall,
  readManifestDeclaration,
  type McpConfigAdapter,
  type McpServerEntry,
} from "@argent/installer";
import {
  type DoctorCheck,
  type DoctorContext,
  type DoctorSection,
  type EntryToolsUrl,
  check,
  home,
  isUnreadable,
  permissionFix,
  realPath,
  samePath,
} from "./doctor-shared.js";
import { probeProjectInstall } from "./doctor-install.js";
import {
  type CwdSupport,
  type EntryContext,
  classifyMcpEntry,
  expandEnvReferences,
  formatEntry,
  hasUnresolvedVariable,
} from "./doctor-entries.js";

// `argent doctor`: the Editors section.

// Checked against each editor's spawn code; the others keep the default.
const CWD_SUPPORT: Record<string, CwdSupport> = {
  "VS Code": "expands",
  "Gemini": "literal",
  "Claude Code": "ignored",
  "Cursor": "ignored",
  "Zed": "ignored",
  "Kiro": "absolute-only",
};

type EntryScope = "local" | "project" | "global";

// The JSON syntax each editor's config loader accepts. The others read their
// config as leniently as argent does.
const JSON_SYNTAX: Record<string, { comments: boolean; trailingCommas: boolean; fix: string }> = {
  "Claude Code": {
    comments: false,
    trailingCommas: false,
    fix: "Fix the JSON syntax (Claude Code allows no comments or trailing commas)",
  },
  "Gemini": {
    comments: true,
    trailingCommas: false,
    fix: "Fix the JSON syntax (Gemini allows comments, but no trailing commas)",
  },
  "opencode": { comments: true, trailingCommas: true, fix: "Fix the JSON syntax" },
};

export function isRejectedJson(editor: string, configPath: string): boolean {
  const syntax = JSON_SYNTAX[editor];
  return !!syntax && isInvalidJson(configPath, syntax);
}

function isYarnBerryProject(root: string): boolean {
  if (fs.existsSync(path.join(root, ".yarnrc.yml"))) return true;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
      packageManager?: unknown;
    };
    return typeof pkg.packageManager === "string" && /^yarn@(?!1\.)\d/.test(pkg.packageManager);
  } catch {
    return false;
  }
}

// These load their project config from cwd up to the git root.
export const GIT_ROOT_EDITORS = new Set(["Codex", "opencode"]);

/**
 * Claude Code reads its .claude dir from the checkout it runs in, Codex and
 * opencode find their project config at the git root; other editors use projectRoot.
 */
export function rootFor(ctx: DoctorContext, adapter: McpConfigAdapter | string | null): string {
  const name = typeof adapter === "string" ? adapter : adapter?.name;
  if (name === "Claude Code") return ctx.claudeRoot ?? ctx.projectRoot;
  if (name && GIT_ROOT_EDITORS.has(name)) return ctx.gitRoot ?? ctx.projectRoot;
  return ctx.projectRoot;
}

/** The ~/.claude.json key of Claude Code's local scope and /mcp toggles for this project. */
export function claudeLocalKey(ctx: DoctorContext): string {
  return ctx.claudeKey ?? rootFor(ctx, "Claude Code");
}

function selfAndAncestors(dir: string): string[] {
  const dirs = [path.resolve(dir)];
  while (path.dirname(dirs.at(-1)!) !== dirs.at(-1)) dirs.push(path.dirname(dirs.at(-1)!));
  return dirs;
}

// Claude Code reads .mcp.json from the directory it starts in and every one
// above it. Other editors' project config is looked up in their own project
// and, when doctor's root is a package inside it, in that package too (init
// may have written it).
function projectRoots(ctx: DoctorContext, adapter: McpConfigAdapter): string[] {
  return adapter.name === "Claude Code"
    ? [...new Set([...selfAndAncestors(ctx.cwd), ctx.projectRoot])]
    : [...new Set([rootFor(ctx, adapter), ctx.projectRoot])];
}

export function configuredScopes(
  ctx: DoctorContext
): ReturnType<typeof findConfiguredAdapterScopes> {
  return ALL_ADAPTERS.flatMap((adapter) => {
    const seen = new Set<string>();
    return projectRoots(ctx, adapter)
      .flatMap((root) => findConfiguredAdapterScopes([adapter], root))
      .filter((c) => !seen.has(realPath(c.configPath)) && seen.add(realPath(c.configPath)));
  });
}

/** home() for every path inside a free-form location such as `~/.claude.json (… for /Users/me/app)`. */
function homeInText(text: string): string {
  const h = homedir();
  if (!h || h === path.sep) return text;
  const escaped = h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`${escaped}(?=[\\\\/)\\s]|$)`, "g"), "~");
}

/** Where each editor starts an entry's command, and how it expands the entry. */
function spawnRules(ctx: DoctorContext, editor: string, scope: "project" | "global") {
  const scopeDir = scope === "project" ? ctx.projectRoot : homedir();
  switch (editor) {
    case "Claude Code":
    case "Codex":
    case "Gemini":
    case "opencode":
      return { spawnDir: ctx.cwd, spawnsInLaunchDir: true };
    case "Cursor":
      return { spawnDir: scopeDir, expandsTilde: true };
    case "VS Code":
      return { spawnDir: scopeDir, expandsTilde: true, appendsPath: true };
    case "Zed":
      return { spawnDir: ctx.projectRoot };
    default:
      return {};
  }
}

interface Found {
  adapter: McpConfigAdapter;
  adapterName: string;
  entry: McpServerEntry;
  scope: "project" | "global";
  location: string;
  /** The scope the editor ranks the entry by, for editors that start only one. */
  rankedScope?: EntryScope;
  /** Higher wins among one editor's ranked entries. */
  rank?: number;
}

// These start one entry per name: Claude Code's local scope over project, a
// closer project config over one further up, project over user.
const RANKED_EDITORS = new Set(["Claude Code", "Gemini", "Codex", "opencode"]);

function rankOf(adapterName: string, scope: EntryScope, configPath?: string): number | undefined {
  if (!RANKED_EDITORS.has(adapterName)) return undefined;
  if (scope === "local") return Number.MAX_SAFE_INTEGER;
  // Every project config is in an ancestor of cwd: the longer path is the closer one.
  return scope === "project" ? 1 + path.dirname(configPath!).length : 0;
}

function unusedLabel(f: Found, winner: Found): string {
  const closer = f.adapterName === "Claude Code" ? "closer .mcp.json" : "closer project config";
  const winnerName =
    f.rankedScope === "project" && winner.rankedScope === "project"
      ? closer
      : `${winner.rankedScope}-scope`;
  return `${f.adapterName}: ${formatEntry(f.entry)} (unused: the ${winnerName} entry wins)`;
}

export function editorsSection(
  ctx: DoctorContext,
  entryToolsUrls: EntryToolsUrl[] = [],
  startedEntries: McpServerEntry[] = []
): DoctorSection {
  const { projectRoot } = ctx;
  const checks: DoctorCheck[] = [];
  // Run from ~, a project config path can be the global one: list it once.
  // Compared by real path: HOME may be a symlink to the directory doctor runs in.
  const seenPaths = new Set<string>();
  const configured = configuredScopes(ctx)
    .map((c) =>
      c.scope === "project" && samePath(c.configPath, c.adapter.globalPath())
        ? { ...c, scope: "global" as const }
        : c
    )
    .filter((c) => !seenPaths.has(realPath(c.configPath)) && seenPaths.add(realPath(c.configPath)));
  const entryCtx = {
    projectRoot,
    cwd: ctx.cwd,
    globalOnPath: ctx.global !== null && !ctx.global.runError,
    globalRunError: ctx.global?.runError ?? null,
    globalBin: ctx.global?.bin ?? null,
    localInstalled: probeProjectInstall(projectRoot).installed,
    localResolvable: probeLocalInstall(projectRoot).installed,
    localDeclared: readManifestDeclaration(projectRoot) !== null,
    argentCmd: ctx.argentCmd,
    installCmd: ctx.installCmd,
    offPathGlobalBin: ctx.offPathGlobalBin,
    npmGlobalHasArgent: ctx.npmGlobalHasArgent,
    yarnBerry: isYarnBerryProject(projectRoot),
  };

  const found: Found[] = [];
  const notes: DoctorCheck[] = [];
  // Configured, but in a file the editor can't parse.
  const unparsed = new Set<string>();
  // A recorded .mcp.json rejection: Claude Code skips the project entry.
  let mcpjsonRejected = false;

  // findConfiguredAdapterScopes reads an unreadable or unparseable TOML file as "no entry".
  for (const adapter of ALL_ADAPTERS) {
    const paths = [
      ...projectRoots(ctx, adapter).map((root) => adapter.projectPath(root)),
      adapter.globalPath(),
    ];
    for (const configPath of paths) {
      if (!configPath || unparsed.has(adapter.name)) continue;
      if (isUnreadable(configPath)) {
        checks.push(
          check("error", `${adapter.name}: can't read its config file`, {
            detail: home(configPath),
            fix: permissionFix(configPath, "u+r"),
          })
        );
        unparsed.add(adapter.name);
      } else if (configPath.endsWith(".toml") && isInvalidToml(configPath)) {
        checks.push(
          check(
            "error",
            `${adapter.name}: the config file is not valid TOML, so ${adapter.name} won't load it`,
            {
              detail: home(configPath),
              fix: "Fix the TOML syntax (argent init leaves the file alone until it parses)",
            }
          )
        );
        unparsed.add(adapter.name);
      }
    }
  }

  for (const { adapter, scope, configPath } of configured) {
    if (isRejectedJson(adapter.name, configPath)) {
      checks.push(
        check(
          "error",
          `${adapter.name}: the config file is not valid JSON, so ${adapter.name} won't load it`,
          { detail: home(configPath), fix: JSON_SYNTAX[adapter.name]!.fix }
        )
      );
      unparsed.add(adapter.name);
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
      adapter,
      adapterName: adapter.name,
      entry,
      scope,
      location: `${home(configPath)} (${scope})`,
      rankedScope: scope,
      rank: rankOf(adapter.name, scope, configPath),
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

  // Claude Code files its local scope under the main checkout's key, but reads
  // a rejection from the .claude dir of the checkout it runs in.
  const shadowingFindings = (adapter: McpConfigAdapter, hasProjectEntry: boolean) => {
    const options = { exactProjectKey: true };
    if (adapter.name !== "Claude Code") {
      return adapter.findShadowingConfigs!(
        rootFor(ctx, adapter),
        hasProjectEntry ? "local" : "global",
        options
      );
    }
    const localScope = adapter.findShadowingConfigs!(claudeLocalKey(ctx), "global", options);
    const rejections = hasProjectEntry
      ? adapter.findShadowingConfigs!(rootFor(ctx, adapter), "local", options).filter(
          (f) => !f.location.startsWith("~/.claude.json")
        )
      : [];
    return [...localScope, ...rejections];
  };

  // Scopes outside the projectPath/globalPath pair: VS Code's user-profile
  // mcp.json, Claude Code's local scope and its recorded .mcp.json rejections.
  for (const adapter of ALL_ADAPTERS) {
    if (!adapter.findShadowingConfigs) continue;
    const isClaude = adapter.name === "Claude Code";
    const hasProjectEntry = configured.some((c) => c.adapter === adapter && c.scope === "project");
    try {
      for (const finding of shadowingFindings(adapter, hasProjectEntry)) {
        const location = isClaude
          ? homeInText(finding.location)
          : `${homeInText(finding.location)} (global)`;
        if (finding.entry) {
          const rankedScope: EntryScope = isClaude ? "local" : "global";
          found.push({
            adapter,
            adapterName: adapter.name,
            entry: finding.entry,
            scope: isClaude ? "project" : "global",
            location,
            rankedScope,
            rank: rankOf(adapter.name, rankedScope),
          });
        }
        const rejection =
          isClaude && !finding.entry && /disabledMcpjsonServers/.test(finding.reason);
        if (rejection) mcpjsonRejected = true;
        if (!finding.entry || (!isClaude && hasProjectEntry)) {
          notes.push(
            check("warn", `${adapter.name}: ${finding.reason}`, {
              detail: location,
              ...(rejection
                ? { fix: `Remove "argent" from disabledMcpjsonServers in ${location}` }
                : {}),
            })
          );
        }
      }
    } catch {
      // A malformed editor config must not abort the report.
    }
  }

  const isRejected = (f: Found) =>
    mcpjsonRejected && f.adapterName === "Claude Code" && f.rankedScope === "project";
  // An entry the editor skips as invalid can't outrank the one it starts.
  const isUnparsed = (f: Found) => f.entry.command === "" && !f.entry.url;
  const winners = new Map<string, Found>();
  for (const f of found) {
    if (f.rank === undefined || isRejected(f) || isUnparsed(f)) continue;
    const best = winners.get(f.adapterName);
    if (!best || f.rank > best.rank!) winners.set(f.adapterName, f);
  }
  for (const f of found) {
    if (isRejected(f)) {
      checks.push(
        check(
          "info",
          `${f.adapterName}: ${formatEntry(f.entry)} (not loaded: rejected, see below)`,
          {
            detail: f.location,
          }
        )
      );
      continue;
    }
    const winner = winners.get(f.adapterName);
    if (winner && winner !== f && !isUnparsed(f)) {
      checks.push(check("info", unusedLabel(f, winner), { detail: f.location }));
      continue;
    }
    // Only the key the editor honours switches the entry off.
    const honoured = f.adapter.switchOffKey;
    const switchedOff = isSwitchedOffInEditor(f.adapter, f.entry);
    const entry = switchedOff
      ? { ...f.entry, switchedOffBy: [honoured!] }
      : { ...f.entry, switchedOffBy: undefined };
    const entryContext: EntryContext = {
      ...entryCtx,
      ...spawnRules(ctx, f.adapterName, f.scope),
      scope: f.scope,
      claudeLocal: f.adapterName === "Claude Code" && f.rankedScope === "local",
      cwdSupport: CWD_SUPPORT[f.adapterName],
    };
    const result = classifyMcpEntry(entry, entryContext);
    checks.push({
      ...result,
      label: `${f.adapterName}: ${result.label}`,
      detail: [f.location, result.detail].filter(Boolean).join(" · "),
    });
    if (switchedOff) continue;
    startedEntries.push(f.entry);
    collectToolsUrl(f, entryToolsUrls);
  }
  checks.push(...notes);

  if (
    winners.has("Claude Code") &&
    isArgentDisabledInClaudeProject(claudeLocalKey(ctx), { exactProjectKey: true })
  ) {
    checks.push(
      check("warn", "Claude Code: argent is switched off for this project", {
        detail: "~/.claude.json disabledMcpServers",
        fix: "Turn it back on under /mcp in Claude Code",
      })
    );
  }

  const configuredNames = new Set([...found.map((f) => f.adapterName), ...unparsed]);
  if (found.length === 0 && !checks.some((c) => c.status === "error")) {
    checks.push(
      check("error", "argent is not configured in any supported editor for this project", {
        detail: "MCP clients set up by hand, outside argent init, are not checked",
        fix: `${ctx.argentCmd} init`,
      })
    );
  }

  const detected = detectAdapters();
  // A local install only writes project configs: editors without one can't be added.
  const globalOnly = detected
    .filter((a) => ctx.mode === "local" && a.projectPath(projectRoot) === null)
    .map((a) => a.name)
    .filter((name) => !configuredNames.has(name));
  if (globalOnly.length > 0) {
    checks.push(
      check("warn", `${globalOnly.join(", ")}: no argent, and a local install can't add it`, {
        detail: "these editors have only a global config, which local mode never writes",
        fix: "npm i -g @swmansion/argent, then argent init --global (or add argent to the editor by hand)",
      })
    );
  }
  const unconfigured = detected
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

/**
 * The remote an entry's server would link to. The server reads ARGENT_TOOLS_URL
 * and the token from its whole environment, the editor's own included, after
 * the editor expands `${VAR}` in the entry's values.
 */
function collectToolsUrl(f: Found, entryToolsUrls: EntryToolsUrl[]): void {
  const rawUrl = f.entry.env?.ARGENT_TOOLS_URL;
  if (!rawUrl) return;
  const url = expandEnvReferences(rawUrl);
  const rawToken = f.entry.env?.[AUTH_TOKEN_ENV];
  const token =
    rawToken === undefined ? process.env[AUTH_TOKEN_ENV] : expandEnvReferences(rawToken);
  const unresolved = hasUnresolvedVariable(url)
    ? "ARGENT_TOOLS_URL"
    : token && hasUnresolvedVariable(token)
      ? AUTH_TOKEN_ENV
      : undefined;
  entryToolsUrls.push({ editor: f.adapterName, url, token, ...(unresolved ? { unresolved } : {}) });
}

/** Whether this shell can tell the entry's server links to a remote tool-server. */
export function linksToRemote(entry: McpServerEntry): boolean {
  const rawUrl = entry.env?.ARGENT_TOOLS_URL;
  return !!rawUrl && !hasUnresolvedVariable(expandEnvReferences(rawUrl));
}

/** The nearest directory at or above `dir` holding `.git`: the repo, worktree or submodule root. */
function findGitTop(dir: string): string | null {
  return selfAndAncestors(dir).find((d) => fs.existsSync(path.join(d, ".git"))) ?? null;
}

/** The top of cwd's git checkout (a linked worktree's own dir), or cwd outside git. */
export function gitToplevel(cwd: string): string {
  return realPath(findGitTop(cwd) ?? cwd);
}

/** The common git dir a linked worktree's `.git` file points at, through its gitdir's `commondir`. */
function linkedCommonDir(dotGit: string): string | null {
  try {
    if (fs.statSync(dotGit).isDirectory()) return null;
    const gitDirLine = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"));
    if (!gitDirLine) return null;
    const gitDir = path.resolve(path.dirname(dotGit), gitDirLine[1]!.trim());
    const commonDir = fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim();
    return realPath(path.resolve(gitDir, commonDir));
  } catch {
    return null;
  }
}

/**
 * The key Claude Code files a directory's local-scope state under in
 * ~/.claude.json: the main checkout for a linked worktree, the bare repo for a
 * worktree of one, the checkout itself for a repo or submodule, and the
 * directory itself outside git. Read from the files rather than by running
 * git: on a Mac without the Command Line Tools, /usr/bin/git opens their
 * install dialog.
 */
export function claudeProjectKey(cwd: string): string {
  const top = findGitTop(cwd);
  if (!top) return realPath(cwd);
  const common = linkedCommonDir(path.join(top, ".git"));
  if (!common) return realPath(top);
  return path.basename(common) === ".git" ? path.dirname(common) : common;
}
