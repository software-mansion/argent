import { execFileSync } from "node:child_process";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { track } from "@argent/telemetry";
import { FAILURE_CODES, type FailureSignal } from "@argent/registry";
import type { InstallMode } from "./utils.js";
import {
  buildArgentSkillsSource,
  getGlobalSkillLockPath,
  getInstalledVersion,
  getProjectSkillLockPath,
  compareVersions,
  listArgentSkillsInLock,
  listBundledSkills,
  lockedArgentSkillVersion,
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

export interface SkillRefreshTelemetrySummary {
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

function getScopeSpecs(projectRoot: string, scopes: readonly SkillScope[]): ScopeSpec[] {
  const wanted = new Set(scopes);
  return allScopeSpecs(projectRoot).filter((spec) => wanted.has(spec.scope));
}

function allScopeSpecs(projectRoot: string): ScopeSpec[] {
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

/**
 * Which skill stores a command may rewrite, given the installs it updated.
 *
 * A store is owned by exactly one install: the global lock always belongs to the
 * binary on PATH, and a project's lock belongs to whichever install serves that
 * project. Only the install that moved may rewrite the store that tracks it —
 * otherwise a project-scoped update re-pins the machine-wide skills every other
 * project uses.
 *
 * Note the project scope is not "the local install's scope": a non-interactive
 * global install also writes a project lock, and that lock tracks the global
 * binary. `installMode` is what distinguishes them.
 */
export function skillScopesForTargets(
  targets: readonly InstallMode[],
  installMode: InstallMode
): SkillScope[] {
  const scopes = new Set<SkillScope>();
  if (targets.includes("local")) scopes.add("project");
  if (targets.includes("global")) {
    scopes.add("global");
    // A global bump moves the binary this project runs, so its lock follows.
    if (installMode === "global") scopes.add("project");
  }
  return (["project", "global"] as const).filter((scope) => scopes.has(scope));
}

/**
 * Whether this package may decide which of a store's argent skills are obsolete.
 *
 * The obsolete set is the difference against THIS package's bundled skills, so a
 * package older than the one that filled the store would classify everything
 * added since as orphaned and delete it. Judging is allowed only when the store
 * was last written by a version no newer than ours; an unreadable or unversioned
 * lock means we cannot tell, so we do not prune.
 */
function mayPruneScope(lockPath: string): boolean {
  const lockedVersion = lockedArgentSkillVersion(lockPath);
  if (lockedVersion === null) return false;
  const running = getInstalledVersion();
  if (!running) return false;
  return compareVersions(running, lockedVersion) >= 0;
}

// Re-syncs bundled argent skills into the caller's chosen scopes, and prunes
// argent-prefixed entries that are no longer part of the bundled set.
//
// Two filters apply, and both matter. The caller names the scopes, because only
// the install that moved may rewrite the store that tracks it. A named scope is
// then skipped if it tracks no argent skill, so this never creates a
// `skills-lock.json` in an unrelated working directory.
//
// Pruning has a third condition — see `mayPruneScope`. Sync is idempotent and
// additive, so re-syncing a store from a slightly different version is
// recoverable; a prune deletes, and is not.
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
export function refreshArgentSkills(opts: {
  projectRoot: string;
  scopes: readonly SkillScope[];
}): SkillScopeResult[] {
  const { projectRoot, scopes } = opts;
  const bundled = new Set(listBundledSkills());
  // An empty bundled set means THIS package's skills dir is unreadable — a
  // pruned pnpm store dir mid-update, a broken install — never "argent ships
  // no skills". Acting on it would classify every tracked skill as orphaned
  // and prune them all from both scopes; skip the refresh entirely instead.
  if (bundled.size === 0) return [];
  const results: SkillScopeResult[] = [];
  const primarySource = buildArgentSkillsSource(getInstalledVersion());
  // Project-scope `skills` commands act on their cwd, and this can run as a
  // detached updater whose inherited cwd is the tool-server's editor-chosen
  // one (often `/` or `$HOME`) — pin every run to the project.
  const execOpts = { stdio: ["ignore", "pipe", "pipe"] as const, cwd: projectRoot } as {
    stdio: ["ignore", "pipe", "pipe"];
    cwd: string;
  };

  for (const spec of getScopeSpecs(projectRoot, scopes)) {
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

    if (orphaned.length > 0 && mayPruneScope(spec.lockPath)) {
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

export function summarizeSkillRefreshForTelemetry(
  results: readonly SkillScopeResult[]
): SkillRefreshTelemetrySummary {
  return {
    scope_count: results.length,
    synced_count: results.reduce((sum, result) => sum + result.synced, 0),
    pruned_count: results.reduce((sum, result) => sum + result.pruned.length, 0),
    failed_count: results.filter((result) => result.syncError || result.pruneError).length,
  };
}

// ── Refresh + report ──────────────────────────────────────────────────────────

// Single owner of the "Skills Updated" note, the skill_refresh_result event,
// and the INSTALL_SKILLS_REFRESH_FAILED signal for both post-bump re-sync
// flows — init-triggered update and `argent update` — which differ only in
// the failure_stage naming the flow.
export type SkillRefreshStage = "installer_skills_refresh" | "installer_update_skills_refresh";

export function reportSkillRefresh(opts: {
  projectRoot: string;
  scopes: readonly SkillScope[];
  stage: SkillRefreshStage;
}): void {
  const { projectRoot, scopes, stage } = opts;
  const results = refreshArgentSkills({ projectRoot, scopes });
  const summary = formatSkillRefreshSummary(results);
  if (summary) {
    p.note(summary, "Skills Updated");
  }
  // A store this command did not update stays on its old version. Say so once,
  // rather than letting it quietly drift.
  if (!scopes.includes("global") && listArgentSkillsInLock(getGlobalSkillLockPath()).length > 0) {
    p.log.info(
      pc.dim(
        "Left the machine-wide skills alone — they track the global install. " +
          "Run `argent update --global` to refresh them."
      )
    );
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
