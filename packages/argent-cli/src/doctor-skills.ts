import * as fs from "node:fs";
import * as path from "node:path";
import {
  ALL_ADAPTERS,
  getManagedContentTargets,
  hasCodexRules,
  listBundledSkills,
  ARGENT_SKILL_PREFIX,
  RULES_DIR,
  AGENTS_DIR,
  type McpConfigAdapter,
} from "@argent/installer";
import {
  type DoctorCheck,
  type DoctorContext,
  type DoctorSection,
  check,
  home,
  realPath,
} from "./doctor-shared.js";
import { configuredScopes, rootFor } from "./doctor-editors.js";

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

export function skillsSection(ctx: DoctorContext, reinstall: string): DoctorSection {
  const checks: DoctorCheck[] = [];
  const configured = configuredScopes(ctx).map((c) => ({
    adapter: c.adapter,
    scope: c.scope === "project" ? ("local" as const) : ("global" as const),
  }));
  const claude = ALL_ADAPTERS.find((a) => a.name === "Claude Code");
  if (claude && hasClaudeLocalScopeEntry(rootFor(ctx, claude))) {
    configured.push({ adapter: claude, scope: "local" });
  }
  const adapters = [...new Set(configured.map((c) => c.adapter))];

  // Each editor loads skills from its own dirs in either scope, whatever scope
  // its MCP entry is in. The shared .agents/skills is not read by Claude Code.
  const skillDirs = (adapter: McpConfigAdapter | null): string[] =>
    (["local", "global"] as const).flatMap((scope) =>
      getManagedContentTargets(adapter ? [adapter] : [], rootFor(ctx, adapter), scope)
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
    getManagedContentTargets([adapter], rootFor(ctx, adapter), scope).ruleTargets.map(
      (t) => t.targetPath
    );
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
            fix: `${ctx.argentCmd} update`,
          })
    );
  }

  // Codex reads argent's rules from developer_instructions in its config.toml.
  for (const { adapter, scope } of configured) {
    for (const target of getManagedContentTargets([adapter], rootFor(ctx, adapter), scope)
      .codexConfigTargets) {
      checks.push(
        hasCodexRules(target.targetPath)
          ? check("ok", `Rules present in ${home(target.targetPath)} (developer_instructions)`)
          : check("warn", `Rules missing in ${home(target.targetPath)} (developer_instructions)`, {
              fix: `${ctx.argentCmd} update`,
            })
      );
    }
  }

  // Subagents the rules tell the agent to run (argent-environment-inspector).
  let agentFiles: string[] = [];
  try {
    agentFiles = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md"));
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
    const either = [...agentDirs(adapter, "local"), ...agentDirs(adapter, "global")];
    if (either.some((d) => agentsAbsentIn(d).length === 0)) continue;
    for (const target of agentDirs(adapter, scope)) {
      if (seenAgentDirs.has(realPath(target))) continue;
      seenAgentDirs.add(realPath(target));
      checks.push(
        check("warn", `Agents missing in ${home(target)}`, {
          detail: agentsAbsentIn(target).join(", "),
          fix: `${ctx.argentCmd} update`,
        })
      );
    }
  }

  return { title: "Skills & rules", checks };
}
