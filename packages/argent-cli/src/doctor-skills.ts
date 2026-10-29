import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import {
  ALL_ADAPTERS,
  findConfiguredAdapterScopes,
  getManagedContentTargets,
  hasCodexRules,
  listBundledSkills,
  probeLocalInstall,
  ARGENT_SKILL_PREFIX,
  RULES_DIR,
  AGENTS_DIR,
  resolveProjectRoot,
  type McpConfigAdapter,
} from "@argent/installer";
import {
  type DoctorCheck,
  type DoctorContext,
  type DoctorSection,
  check,
  home,
  isUnreadable,
  realPath,
  shellPath,
} from "./doctor-shared.js";
import { GIT_ROOT_EDITORS, claudeLocalKey, configuredScopes, rootFor } from "./doctor-editors.js";

// `argent doctor`: the Skills & rules section.

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
    return (
      claude?.findShadowingConfigs?.(projectRoot, "global", { exactProjectKey: true }) ?? []
    ).some((f) => f.entry);
  } catch {
    return false;
  }
}

/** Claude Code loads project skills and rules from cwd and every ancestor below ~. */
function claudeProjectDirs(ctx: DoctorContext): string[] {
  const dirs = new Set([ctx.claudeRoot ?? ctx.projectRoot]);
  const stop = homedir();
  let dir = ctx.cwd;
  while (dir !== stop && path.dirname(dir) !== dir) {
    dirs.add(dir);
    dir = path.dirname(dir);
  }
  return [...dirs];
}

/** Editors whose config can't be read: their entries are invisible, so check their dirs anyway. */
function unreadableAdapters(ctx: DoctorContext): McpConfigAdapter[] {
  return ALL_ADAPTERS.filter((adapter) =>
    [adapter.projectPath(rootFor(ctx, adapter)), adapter.globalPath()].some(
      (file) => file && isUnreadable(file)
    )
  );
}

/** Codex and opencode load project skills from cwd and every dir above it up to the git root. */
function dirsUpTo(cwd: string, top: string): string[] {
  const from = realPath(cwd);
  const rel = path.relative(top, from);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return [top];
  const dirs = [top];
  for (let dir = from; dir !== top; dir = path.dirname(dir)) dirs.push(dir);
  return dirs;
}

/** In a local-mode project, its own argent's copy of `name`, which its entries load. */
function projectShipped(ctx: DoctorContext, name: "skills" | "rules" | "agents"): string | null {
  if (ctx.mode !== "local") return null;
  const { packageDir } = probeLocalInstall(ctx.projectRoot);
  const dir = packageDir ? path.join(packageDir, name) : null;
  return dir && fs.existsSync(dir) ? dir : null;
}

/** The rules dirs, agents dirs and Codex configs `argent update` run from `root` refreshes. */
function targetsUpdateRefreshes(root: string): Set<string> {
  const dirs = findConfiguredAdapterScopes(ALL_ADAPTERS, root).flatMap((c) => {
    const scope = c.scope === "project" ? "local" : "global";
    const targets = getManagedContentTargets([c.adapter], root, scope);
    return [...targets.ruleTargets, ...targets.agentTargets, ...targets.codexConfigTargets].map(
      (t) => realPath(t.targetPath)
    );
  });
  return new Set(dirs);
}

/**
 * `argent update` refreshes only the targets of entries it finds from its
 * project root, so a Claude Code local-scope entry or a package inside a
 * monorepo needs another fix.
 */
function refreshFix(ctx: DoctorContext, target: string, manualFix: string): string {
  const updateRoot = resolveProjectRoot(ctx.cwd);
  if (targetsUpdateRefreshes(updateRoot).has(realPath(target))) return `${ctx.argentCmd} update`;
  const roots = new Set([rootFor(ctx, "Claude Code"), rootFor(ctx, "Codex")]);
  for (const root of roots) {
    if (root !== updateRoot && targetsUpdateRefreshes(root).has(realPath(target))) {
      return `${ctx.argentCmd} update --project-root ${shellPath(root)}`;
    }
  }
  return manualFix;
}

const copyFix = (target: string, sourceDir: string) =>
  `mkdir -p ${shellPath(target)} && cp ${shellPath(sourceDir)}/*.md ${shellPath(target)}/`;

export function skillsSection(ctx: DoctorContext, reinstall: string): DoctorSection {
  const checks: DoctorCheck[] = [];
  const configured = configuredScopes(ctx).map((c) => ({
    adapter: c.adapter,
    scope: c.scope === "project" ? ("local" as const) : ("global" as const),
  }));
  const claude = ALL_ADAPTERS.find((a) => a.name === "Claude Code");
  if (claude && hasClaudeLocalScopeEntry(claudeLocalKey(ctx))) {
    configured.push({ adapter: claude, scope: "local" });
  }
  const adapters = [...new Set(configured.map((c) => c.adapter))];
  const skillAdapters = [...new Set([...adapters, ...unreadableAdapters(ctx)])];

  // Each editor loads skills from its own dirs in either scope, whatever scope
  // its MCP entry is in. The shared .agents/skills is not read by Claude Code.
  const projectDirs = (adapter: McpConfigAdapter | null): string[] => {
    if (adapter?.name === "Claude Code") return claudeProjectDirs(ctx);
    if (adapter && GIT_ROOT_EDITORS.has(adapter.name)) {
      return dirsUpTo(ctx.cwd, rootFor(ctx, adapter));
    }
    return [rootFor(ctx, adapter)];
  };
  const targetsIn = (adapter: McpConfigAdapter | null, scope: "local" | "global") =>
    scope === "global"
      ? [getManagedContentTargets(adapter ? [adapter] : [], rootFor(ctx, adapter), scope)]
      : projectDirs(adapter).map((dir) =>
          getManagedContentTargets(adapter ? [adapter] : [], dir, scope)
        );
  const skillDirs = (adapter: McpConfigAdapter | null): string[] =>
    (["local", "global"] as const).flatMap((scope) =>
      targetsIn(adapter, scope).flatMap((targets) =>
        targets.skillTargets
          .filter((t) => t.editorName !== "skills" || adapter?.name !== "Claude Code")
          .map((t) => t.targetPath)
      )
    );
  const installedIn = (dirs: string[]): Set<string> =>
    new Set(dirs.flatMap((d) => listArgentDirs(d)));
  // Editors that read the same dirs (Gemini and Codex share .agents/skills) get one line.
  const groupBySkillDirs = (list: Array<McpConfigAdapter | null>) => {
    const groups = new Map<string, { names: string[]; dirs: string[] }>();
    for (const adapter of list) {
      const dirs = skillDirs(adapter);
      const key = [...new Set(dirs.map(realPath))].sort().join("\0");
      const group = groups.get(key) ?? { names: [], dirs };
      if (adapter) group.names.push(adapter.name);
      groups.set(key, group);
    }
    return [...groups.values()];
  };

  const bundled = listBundledSkills(projectShipped(ctx, "skills") ?? undefined);
  if (bundled.length === 0) {
    checks.push(
      check("error", "The argent package ships no skills (a partial install)", { fix: reinstall })
    );
  } else {
    const perEditor = groupBySkillDirs(skillAdapters.length > 0 ? skillAdapters : [null]).map(
      ({ names, dirs }) => {
        const installed = installedIn(dirs);
        return { name: names.join(", "), missing: bundled.filter((s) => !installed.has(s)) };
      }
    );
    const noneAnywhere = perEditor.every((e) => e.missing.length === bundled.length);
    const prefix = (name: string) =>
      name && perEditor.length > 1 && !noneAnywhere ? `${name}: ` : "";
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

  const rulesDir = projectShipped(ctx, "rules") ?? RULES_DIR;
  let ruleFiles: string[] = [];
  try {
    ruleFiles = fs.readdirSync(rulesDir).filter((f) => f.endsWith(".md"));
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
    getManagedContentTargets([adapter], rootFor(ctx, adapter), scope).ruleTargets.map(
      (t) => t.targetPath
    );
  const loadedRuleDirs = (adapter: McpConfigAdapter, scope: "local" | "global") =>
    targetsIn(adapter, scope).flatMap((targets) => targets.ruleTargets.map((t) => t.targetPath));
  const ruleTargets = new Set<string>();
  for (const { adapter, scope } of configured) {
    if (adapter.name !== "Claude Code") ruleDirs(adapter, scope).forEach((t) => ruleTargets.add(t));
  }
  const claudeScopes = configured.filter((c) => c.adapter.name === "Claude Code");
  if (claudeScopes.length > 0) {
    // Claude Code loads ~/.claude/rules and the project's .claude/rules alike.
    const [first] = claudeScopes;
    const either = [
      ...loadedRuleDirs(first!.adapter, "local"),
      ...loadedRuleDirs(first!.adapter, "global"),
    ];
    const complete = either.find((d) => absentIn(d).length === 0);
    const fallback = ruleDirs(
      first!.adapter,
      claudeScopes.some((c) => c.scope === "local") ? "local" : "global"
    );
    const target = complete ?? fallback[0];
    if (target) ruleTargets.add(target);
  }
  const seenRuleDirs = new Set<string>();
  for (const target of ruleTargets) {
    if (seenRuleDirs.has(realPath(target))) continue;
    seenRuleDirs.add(realPath(target));
    const absent = absentIn(target);
    checks.push(
      absent.length === 0
        ? check("ok", `Rules present in ${home(target)}`)
        : check("warn", `Rules missing in ${home(target)}`, {
            detail: absent.join(", "),
            fix: refreshFix(ctx, target, copyFix(target, rulesDir)),
          })
    );
  }

  // Codex reads argent's rules from developer_instructions in the config.toml holding its entry.
  for (const { adapter, scope, configPath } of configuredScopes(ctx)) {
    if (adapter.name !== "Codex") continue;
    const updateHere = `${ctx.argentCmd} update --project-root ${shellPath(path.dirname(path.dirname(configPath)))}`;
    checks.push(
      hasCodexRules(configPath)
        ? check("ok", `Rules present in ${home(configPath)} (developer_instructions)`)
        : check("warn", `Rules missing in ${home(configPath)} (developer_instructions)`, {
            fix: refreshFix(
              ctx,
              configPath,
              scope === "project" ? updateHere : `${ctx.argentCmd} update`
            ),
          })
    );
  }

  // Subagents the rules tell the agent to run (argent-environment-inspector).
  const agentsDir = projectShipped(ctx, "agents") ?? AGENTS_DIR;
  let agentFiles: string[] = [];
  try {
    agentFiles = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
  } catch {
    // An older package without agents.
  }
  const agentDirs = (adapter: McpConfigAdapter, scope: "local" | "global") =>
    getManagedContentTargets([adapter], rootFor(ctx, adapter), scope).agentTargets.map(
      (t) => t.targetPath
    );
  const agentsAbsentIn = (dir: string) =>
    agentFiles.filter((f) => !fs.existsSync(path.join(dir, f)));
  const seenAgentDirs = new Set<string>();
  for (const { adapter, scope } of configured) {
    // Editors load agents from either scope, like Claude Code's rules.
    const either = (["local", "global"] as const).flatMap((s) =>
      targetsIn(adapter, s).flatMap((targets) => targets.agentTargets.map((t) => t.targetPath))
    );
    if (either.some((d) => agentsAbsentIn(d).length === 0)) continue;
    for (const target of agentDirs(adapter, scope)) {
      if (seenAgentDirs.has(realPath(target))) continue;
      seenAgentDirs.add(realPath(target));
      checks.push(
        check("warn", `Agents missing in ${home(target)}`, {
          detail: agentsAbsentIn(target).join(", "),
          fix: refreshFix(ctx, target, copyFix(target, agentsDir)),
        })
      );
    }
  }

  return { title: "Skills & rules", checks };
}
