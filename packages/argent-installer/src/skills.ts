import { execFileSync } from "node:child_process";
import pc from "picocolors";
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

export type SkillScope = "project" | "global";

export interface SkillScopeResult {
  scope: SkillScope;
  /** Number of bundled skills that were re-synced into this scope. */
  synced: number;
  /** First line of the sync error, or null on success. */
  syncError: string | null;
  /** Names of argent-owned skills that were pruned from this scope. */
  pruned: string[];
  /** First line of the prune error, or null on success. */
  pruneError: string | null;
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

// Re-syncs bundled argent skills into every scope that already tracks at
// least one argent-owned skill, and prunes any argent-prefixed entry that is
// no longer part of the bundled set. Safe to call from any command — a scope
// with nothing tracked is skipped, so this never creates a
// `skills-lock.json` in an unrelated working directory.
//
// Sync prefers the GitHub-pinned source (`<repo>/packages/skills/skills#v<ver>`)
// so the lockfile entry stays portable across machines. If the
// network install fails, it retries with the bundled SKILLS_DIR so offline
// users still get re-synced.
//
// The choice of `skills add` rather than `skills update` is deliberate:
// `skills update` silently skips any entry with sourceType="local", so a
// previous-version lock written from SKILLS_DIR would never refresh. `skills
// add` rewrites the entry from the source we pass, which is exactly the
// behavior we want after `npm i -g @swmansion/argent@new`.
export function refreshArgentSkills(projectRoot: string): SkillScopeResult[] {
  const bundled = new Set(listBundledSkills());
  const results: SkillScopeResult[] = [];
  const primarySource = buildArgentSkillsSource(getInstalledVersion());

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

    if (bundled.size > 0) {
      try {
        execFileSync("npx", withNpmForce(spec.buildAddArgs(primarySource)), {
          stdio: ["ignore", "pipe", "pipe"],
        });
        result.synced = bundled.size;
      } catch (primaryErr) {
        if (primarySource === SKILLS_DIR) {
          result.syncError =
            primaryErr instanceof Error ? primaryErr.message.split("\n")[0] : String(primaryErr);
        } else {
          try {
            execFileSync("npx", withNpmForce(spec.buildAddArgs(SKILLS_DIR)), {
              stdio: ["ignore", "pipe", "pipe"],
            });
            result.synced = bundled.size;
          } catch (fallbackErr) {
            result.syncError =
              fallbackErr instanceof Error
                ? fallbackErr.message.split("\n")[0]
                : String(fallbackErr);
          }
        }
      }
    }

    if (orphaned.length > 0) {
      try {
        execFileSync("npx", withNpmForce([...spec.removeArgs, ...orphaned]), {
          stdio: ["ignore", "pipe", "pipe"],
        });
        result.pruned = orphaned;
      } catch (err) {
        result.pruneError = err instanceof Error ? err.message.split("\n")[0] : String(err);
      }
    }

    results.push(result);
  }

  return results;
}

// Renders a `refreshArgentSkills` summary as a multiline string suitable for
// `p.note(...)`. Returns null when nothing happened so the caller can skip
// printing an empty block.
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
