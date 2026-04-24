import { execFileSync } from "node:child_process";
import pc from "picocolors";
import {
  getGlobalSkillLockPath,
  getProjectSkillLockPath,
  listArgentSkillsInLock,
  listBundledSkills,
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
  addArgs: string[];
  removeArgs: string[];
}

function getScopeSpecs(projectRoot: string): ScopeSpec[] {
  return [
    {
      scope: "project",
      lockPath: getProjectSkillLockPath(projectRoot),
      addArgs: ["skills", "add", SKILLS_DIR, "--skill", "*", "-y"],
      removeArgs: ["skills", "remove", "-y"],
    },
    {
      scope: "global",
      lockPath: getGlobalSkillLockPath(),
      addArgs: ["skills", "add", SKILLS_DIR, "--skill", "*", "-y", "-g"],
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
// The choice of `skills add` rather than `skills update` is deliberate:
// argent ships skills with sourceType="local", and the skills CLI's update
// command silently skips every local-sourced entry. `skills add` hashes the
// source on disk and reinstalls anything that changed, which is exactly the
// behavior we want after `npm i -g @swmansion/argent@new`.
export function refreshArgentSkills(projectRoot: string): SkillScopeResult[] {
  const bundled = new Set(listBundledSkills());
  const results: SkillScopeResult[] = [];

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
        execFileSync("npx", spec.addArgs, { stdio: ["ignore", "pipe", "pipe"] });
        result.synced = bundled.size;
      } catch (err) {
        result.syncError = err instanceof Error ? err.message.split("\n")[0] : String(err);
      }
    }

    if (orphaned.length > 0) {
      try {
        execFileSync("npx", [...spec.removeArgs, ...orphaned], {
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
