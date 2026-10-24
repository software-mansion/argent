import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { AUTH_TOKEN_ENV } from "@argent/tools-client";
import {
  ALL_ADAPTERS,
  detectAdapters,
  findConfiguredAdapterScopes,
  isArgentDisabledInClaudeProject,
  isSwitchedOffInEditor,
  probeLocalInstall,
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
  realPath,
  samePath,
} from "./doctor-shared.js";
import { probeProjectInstall } from "./doctor-install.js";
import { classifyMcpEntry, formatEntry } from "./doctor-entries.js";

// `argent doctor`: the Editors section.

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

/** Claude Code has its own idea of the project (claudeProjectKey); other editors use projectRoot. */
export function rootFor(ctx: DoctorContext, adapter: McpConfigAdapter | string | null): string {
  const name = typeof adapter === "string" ? adapter : adapter?.name;
  return name === "Claude Code" ? (ctx.claudeRoot ?? ctx.projectRoot) : ctx.projectRoot;
}

// Claude Code's .mcp.json is looked up in its own project and, when doctor's
// root is a package inside it, in that package too (init may have written it).
export function configuredScopes(
  ctx: DoctorContext
): ReturnType<typeof findConfiguredAdapterScopes> {
  return ALL_ADAPTERS.flatMap((adapter) => {
    const roots = [...new Set([rootFor(ctx, adapter), ctx.projectRoot])];
    const seen = new Set<string>();
    return roots
      .flatMap((root) => findConfiguredAdapterScopes([adapter], root))
      .filter((c) => !seen.has(realPath(c.configPath)) && seen.add(realPath(c.configPath)));
  });
}

export function editorsSection(
  ctx: DoctorContext,
  entryToolsUrls: EntryToolsUrl[] = []
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
    argentCmd: ctx.argentCmd,
    installCmd: ctx.installCmd,
    offPathGlobalBin: ctx.offPathGlobalBin,
  };

  interface Found {
    adapter: McpConfigAdapter;
    adapterName: string;
    entry: McpServerEntry;
    scope: "project" | "global";
    location: string;
    claudeScope?: ClaudeScope;
  }
  const found: Found[] = [];
  const notes: DoctorCheck[] = [];
  // Configured, but in a file the editor can't parse.
  const unparsed = new Set<string>();
  // A recorded .mcp.json rejection: Claude Code skips the project entry.
  let mcpjsonRejected = false;

  // findConfiguredAdapterScopes reads an unreadable file as "no entry".
  for (const adapter of ALL_ADAPTERS) {
    for (const configPath of [adapter.projectPath(projectRoot), adapter.globalPath()]) {
      if (!configPath || !isUnreadable(configPath) || unparsed.has(adapter.name)) continue;
      checks.push(
        check("error", `${adapter.name}: can't read its config file`, {
          detail: home(configPath),
          fix: `sudo chown "$USER" ${configPath}`,
        })
      );
      unparsed.add(adapter.name);
    }
  }

  for (const { adapter, scope, configPath } of configured) {
    if (adapter.name === "Claude Code" && !isStrictJson(configPath)) {
      checks.push(
        check("error", "Claude Code: the config file is not valid JSON, so Claude Code skips it", {
          detail: home(configPath),
          fix: "Fix the JSON syntax (Claude Code allows no comments or trailing commas)",
        })
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
        rootFor(ctx, adapter),
        hasProjectEntry ? "local" : "global",
        { exactProjectKey: true }
      )) {
        if (finding.entry) {
          found.push({
            adapter,
            adapterName: adapter.name,
            entry: finding.entry,
            scope: isClaude ? "project" : "global",
            location: finding.location,
            ...(isClaude ? { claudeScope: "local" as const } : {}),
          });
        }
        const rejection =
          isClaude && !finding.entry && /disabledMcpjsonServers/.test(finding.reason);
        if (rejection) mcpjsonRejected = true;
        if (!finding.entry || (!isClaude && hasProjectEntry)) {
          notes.push(
            check("warn", `${adapter.name}: ${finding.reason}`, {
              detail: finding.location,
              ...(rejection
                ? { fix: `Remove "argent" from disabledMcpjsonServers in ${finding.location}` }
                : {}),
            })
          );
        }
      }
    } catch {
      // A malformed editor config must not abort the report.
    }
  }

  const isRejected = (f: Found) => mcpjsonRejected && f.claudeScope === "project";
  const claudeRanks = found.flatMap((f) =>
    f.claudeScope && !isRejected(f) ? [CLAUDE_SCOPE_RANK[f.claudeScope]] : []
  );
  const claudeWinner = claudeRanks.length > 0 ? Math.max(...claudeRanks) : null;
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
    // Only the key the editor honours switches the entry off.
    const honoured = f.adapter.switchOffKey;
    const entry = isSwitchedOffInEditor(f.adapter, f.entry)
      ? { ...f.entry, switchedOffBy: [honoured!] }
      : { ...f.entry, switchedOffBy: undefined };
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
    const url = f.entry.env?.ARGENT_TOOLS_URL;
    if (url) {
      entryToolsUrls.push({ editor: f.adapterName, url, token: f.entry.env?.[AUTH_TOKEN_ENV] });
    }
  }
  checks.push(...notes);

  if (
    claudeWinner !== null &&
    isArgentDisabledInClaudeProject(rootFor(ctx, "Claude Code"), { exactProjectKey: true })
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
 * The key Claude Code files a directory's local-scope state under in
 * ~/.claude.json, and the project whose .mcp.json it loads: the main checkout
 * of its git repo (linked worktrees and monorepo packages share it), or the
 * directory itself outside git.
 */
export function claudeProjectKey(cwd: string): string {
  try {
    const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const absolute = realPath(path.resolve(cwd, commonDir));
    if (path.basename(absolute) === ".git") return path.dirname(absolute);
  } catch {
    // Not a git repo, or no git.
  }
  return realPath(cwd);
}
