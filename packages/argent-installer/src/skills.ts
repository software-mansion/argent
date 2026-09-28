import { execFileSync } from "node:child_process";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { track } from "@argent/telemetry";
import { FAILURE_CODES, type FailureSignal } from "@argent/registry";
import {
  buildArgentSkillsSource,
  getGlobalSkillLockPath,
  getInstalledVersion,
  getProjectSkillLockPath,
  listArgentSkillsInLock,
  listBundledSkills,
  withNpmForce,
  SKILLS_DIR,
} from "./utils.js";

type SkillScope = "project" | "global";

interface SkillScopeResult {
  scope: SkillScope;
  /** Count of bundled skills re-synced into this scope. */
  synced: number;
  /** First line of the sync error, or null on success. */
  syncError: string | null;
  /** Argent-owned skills pruned from this scope. */
  pruned: string[];
  /** First line of the prune error, or null on success. */
  pruneError: string | null;
}

interface SkillRefreshTelemetrySummary {
  scope_count: number;
  synced_count: number;
  pruned_count: number;
  failed_count: number;
}

interface ScopeSpec {
  scope: SkillScope;
  lockPath: string;
  buildAddArgs: (source: string) => string[];
  removeArgs: string[];
}

function getScopeSpecs(projectRoot: string): ScopeSpec[] {
  return [
    {
      scope: "project",
      lockPath: getProjectSkillLockPath(projectRoot),
      buildAddArgs: (source) => ["skills", "add", source, "--skill", "*", "-y"],
      removeArgs: ["skills", "remove", "-y"],
    },
    {
      scope: "global",
      lockPath: getGlobalSkillLockPath(),
      buildAddArgs: (source) => ["skills", "add", source, "--skill", "*", "-y", "-g"],
      removeArgs: ["skills", "remove", "-y", "-g"],
    },
  ];
}

// Re-syncs bundled argent skills into every scope that already tracks an
// argent-owned skill, and prunes argent-prefixed entries no longer in the
// bundled set. A scope tracking nothing is skipped, so this never creates a
// `skills-lock.json` in an unrelated working directory.
//
// Sync prefers the GitHub-pinned source so the lockfile entry stays portable
// across machines, and retries with the bundled SKILLS_DIR when that fails.
export function refreshArgentSkills(projectRoot: string): SkillScopeResult[] {
  const bundled = new Set(listBundledSkills());
  // An empty bundled set means this package's skills dir is unreadable (broken
  // or mid-update install), not that argent ships no skills — acting on it
  // would prune every tracked skill from both scopes.
  if (bundled.size === 0) return [];
  const results: SkillScopeResult[] = [];
  const primarySource = buildArgentSkillsSource(getInstalledVersion());
  // Project-scope `skills` commands act on their cwd, and this can run from a
  // detached updater that inherited the tool-server's editor-chosen cwd (often
  // `/` or `$HOME`) — pin every run to the project.
  const execOpts = { stdio: ["ignore", "pipe", "pipe"] as const, cwd: projectRoot } as {
    stdio: ["ignore", "pipe", "pipe"];
    cwd: string;
  };

  for (const spec of getScopeSpecs(projectRoot)) {
    const tracked = listArgentSkillsInLock(spec.lockPath);
    if (tracked.length === 0) continue;

    const orphaned = tracked.filter((name) => !bundled.has(name));
    const result: SkillScopeResult = {
      scope: spec.scope,
      synced: 0,
      syncError: null,
      pruned: [],
      pruneError: null,
    };

    try {
      execFileSync("npx", withNpmForce(spec.buildAddArgs(primarySource)), execOpts);
      result.synced = bundled.size;
    } catch (primaryErr) {
      if (primarySource === SKILLS_DIR) {
        result.syncError =
          primaryErr instanceof Error ? primaryErr.message.split("\n")[0] : String(primaryErr);
      } else {
        try {
          execFileSync("npx", withNpmForce(spec.buildAddArgs(SKILLS_DIR)), execOpts);
          result.synced = bundled.size;
        } catch (fallbackErr) {
          result.syncError =
            fallbackErr instanceof Error ? fallbackErr.message.split("\n")[0] : String(fallbackErr);
        }
      }
    }

    if (orphaned.length > 0) {
      try {
        execFileSync("npx", withNpmForce([...spec.removeArgs, ...orphaned]), execOpts);
        result.pruned = orphaned;
      } catch (err) {
        result.pruneError = err instanceof Error ? err.message.split("\n")[0] : String(err);
      }
    }

    results.push(result);
  }

  return results;
}

// Returns null when nothing happened, so the caller can skip printing an empty
// block.
export function formatSkillRefreshSummary(results: readonly SkillScopeResult[]): string | null {
  const lines: string[] = [];
  for (const r of results) {
    const parts: string[] = [];
    if (r.syncError) {
      parts.push(`${pc.red("sync failed")} ${pc.dim(`(${r.syncError})`)}`);
    } else if (r.synced > 0) {
      parts.push(`synced ${r.synced}`);
    }

    if (r.pruneError) {
      parts.push(`${pc.red("prune failed")} ${pc.dim(`(${r.pruneError})`)}`);
    } else if (r.pruned.length > 0) {
      parts.push(`pruned ${r.pruned.length} (${r.pruned.join(", ")})`);
    }

    if (parts.length > 0) {
      lines.push(`${pc.green("+")} ${r.scope}: ${parts.join(", ")}`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

function summarizeSkillRefreshForTelemetry(
  results: readonly SkillScopeResult[]
): SkillRefreshTelemetrySummary {
  return {
    scope_count: results.length,
    synced_count: results.reduce((sum, result) => sum + result.synced, 0),
    pruned_count: results.reduce((sum, result) => sum + result.pruned.length, 0),
    failed_count: results.filter((result) => result.syncError || result.pruneError).length,
  };
}

// The two post-bump re-sync flows — init-triggered update and `argent update` —
// differ only in this stage name.
type SkillRefreshStage = "installer_skills_refresh" | "installer_update_skills_refresh";

export function reportSkillRefresh(projectRoot: string, stage: SkillRefreshStage): void {
  const results = refreshArgentSkills(projectRoot);
  const summary = formatSkillRefreshSummary(results);
  if (summary) {
    p.note(summary, "Skills Updated");
  }
  const telemetrySummary = summarizeSkillRefreshForTelemetry(results);
  if (telemetrySummary.scope_count > 0) {
    const failureSignal: FailureSignal & { failure_area: "installer" } = {
      error_code: FAILURE_CODES.INSTALL_SKILLS_REFRESH_FAILED,
      failure_stage: stage,
      failure_area: "installer",
      error_kind: "subprocess",
    };
    track("installation:skill_refresh_result", {
      is_success: telemetrySummary.failed_count === 0,
      ...telemetrySummary,
      ...(telemetrySummary.failed_count > 0 ? failureSignal : {}),
    });
  }
}
