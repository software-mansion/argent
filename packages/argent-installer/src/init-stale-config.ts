import pc from "picocolors";
import { MCP_BINARY_NAME } from "./constants.js";
import { isGloballyInstalled } from "./utils.js";
import { hasCustomizingEnv, type McpConfigAdapter, type McpServerEntry } from "./mcp-configs.js";

export interface StaleConfigCleanupResult {
  /** One summary line per removed entry or warning; empty when nothing found. */
  lines: string[];
  removedCount: number;
  warnedCount: number;
}

// A planned removal that reaches beyond this project (a dead entry in a
// GLOBAL config file). Collected first, executed only after the caller's
// one-shot confirmation — the "dead" verdict is a PATH probe in this shell,
// which version managers (nvm) can fool.
interface PendingCrossProjectRemoval {
  adapterName: string;
  location: string;
  what: string;
  exec(): boolean;
}

// Step 1d — sweep for argent config the entries just written do NOT replace:
// same-named entries in other scopes from a previous install, plus
// hidden-scope state only the adapter knows about (Claude Code's local scope,
// VS Code's user-profile mcp.json, recorded .mcp.json rejections).
//
// Scope precedence can't be trusted to make the fresh entry win: Claude
// Code's local scope outranks everything init can write; Cursor and VS Code
// leave same-name precedence undocumented; Codex and opencode deep-merge per
// KEY, leaking a stale entry's fields (env, enabled, timeouts) even when the
// project command wins; Zed ignores project settings until the worktree is
// trusted.
//
// Policy, most conservative that still fixes the failure: remove hidden-scope
// findings the adapter marks autoRemove; remove bare-`argent` entries when no
// global argent is on PATH, behind one confirmation (see
// confirmCrossProjectRemovals); warn with the exact location about anything
// else, never touch it (may be hand-tuned or backed by a working global
// install).
export async function cleanupStaleMcpConfigs(args: {
  /** Adapters whose configs this run wrote (shadow findings target these). */
  writtenAdapters: McpConfigAdapter[];
  /**
   * Adapters detected on this machine — the dead-global sweep covers these
   * too, so a client with no project config (Windsurf, Hermes) still gets its
   * dead `argent` entry pruned.
   */
  detectedAdapters: McpConfigAdapter[];
  installMode: "global" | "local";
  scope: "local" | "global";
  effectiveRoot: string;
  /**
   * Asked ONCE, with one "<client>: <path>" line per planned removal that
   * reaches beyond this project (dead entries in global config files), before
   * any is executed; project-confined removals never prompt. Omit for
   * non-interactive runs — those removals are then SKIPPED and reported as
   * warnings: the "dead" verdict is a PATH probe in this shell, which a
   * version manager (nvm) can fool, and a --yes run gives no human the chance
   * to catch that. Returning false likewise leaves every listed entry in
   * place.
   */
  confirmCrossProjectRemovals?: (items: string[]) => Promise<boolean>;
}): Promise<StaleConfigCleanupResult> {
  const { writtenAdapters, detectedAdapters, installMode, scope, effectiveRoot } = args;
  const lines: string[] = [];
  let removedCount = 0;
  let warnedCount = 0;
  // One PATH probe per run; entries running the bare command are dead iff this
  // is false.
  const globalArgentOnPath = isGloballyInstalled();

  // Bare `argent` command, nothing on PATH, and no CUSTOMIZING env vars that
  // could make it resolvable inside the client (a custom PATH is exactly what
  // an nvm user adds) — dead in every environment that resolves PATH like
  // this shell. A legacy argent-authored ARGENT_MCP_LOG env doesn't count
  // (see hasCustomizingEnv).
  const isProvablyDead = (entry: McpServerEntry | null): boolean =>
    entry !== null &&
    entry.command === MCP_BINARY_NAME &&
    !globalArgentOnPath &&
    !hasCustomizingEnv(entry);

  const removed = (adapterName: string, location: string, what: string): void => {
    removedCount += 1;
    lines.push(`${pc.green("+")} ${adapterName}: removed ${what} ${pc.dim(`(${location})`)}`);
  };
  const warned = (adapterName: string, location: string, why: string): void => {
    warnedCount += 1;
    lines.push(`${pc.yellow("!")} ${adapterName}: ${why} ${pc.dim(`(${location})`)}`);
  };

  const pending: PendingCrossProjectRemoval[] = [];

  // ── Hidden scopes the adapters know about ──────────────────────────────────
  // A malformed config file must not abort init (same stance as
  // findConfiguredAdapterScopes) — a throwing probe is reported and skipped.
  for (const adapter of writtenAdapters) {
    if (!adapter.findShadowingConfigs) continue;
    let findings;
    try {
      findings = adapter.findShadowingConfigs(effectiveRoot, scope);
    } catch (err) {
      warned(adapter.name, "shadow check", `could not inspect for stale entries: ${err}`);
      continue;
    }
    for (const finding of findings) {
      if (finding.autoRemove) {
        try {
          if (finding.remove()) {
            removed(adapter.name, finding.location, "a stale entry that would shadow this install");
          }
        } catch (err) {
          warned(
            adapter.name,
            finding.location,
            `found a shadowing entry but could not remove it: ${err}`
          );
        }
      } else if (isProvablyDead(finding.entry)) {
        // Dead, but living outside the project (e.g. VS Code's user-profile
        // mcp.json) — queue behind the one-shot confirmation.
        pending.push({
          adapterName: adapter.name,
          location: finding.location,
          what: "a dead entry that could shadow this install",
          exec: () => finding.remove(),
        });
      } else {
        warned(adapter.name, finding.location, finding.reason);
      }
    }
  }

  // ── Cross-scope leftovers of a previous install ─────────────────────────────
  if (installMode === "local" && scope === "local") {
    // Migrating to a committable install leaves the previous global-scope
    // `argent` entry behind in every client. Sweep the DETECTED set, not just
    // the written one — clients without a project config hold dead entries too.
    const sweep = new Map<string, McpConfigAdapter>();
    for (const adapter of [...writtenAdapters, ...detectedAdapters]) {
      sweep.set(adapter.name, adapter);
    }
    for (const adapter of sweep.values()) {
      const globalPath = adapter.globalPath();
      if (!globalPath) continue;
      let entry: McpServerEntry | null;
      try {
        entry = adapter.getArgentEntry(globalPath);
      } catch {
        continue;
      }
      if (entry === null) continue;
      if (isProvablyDead(entry)) {
        pending.push({
          adapterName: adapter.name,
          location: globalPath,
          what: `a dead global entry (runs \`${MCP_BINARY_NAME}\`, which is no longer on PATH)`,
          exec: () => adapter.remove(globalPath),
        });
      } else if (entry.command !== MCP_BINARY_NAME) {
        // A custom global entry may be a hand-tuned dev setup or a leftover
        // from another project — not ours to judge, but some clients (Codex,
        // opencode) merge its fields into the project entry, so surface it.
        warned(
          adapter.name,
          globalPath,
          "a global-scope argent entry with a custom command also exists; " +
            "if it is a leftover, remove it or its settings may leak into this install"
        );
      } else if (!globalArgentOnPath) {
        // Bare `argent` with env vars, not on PATH here: the env (an nvm
        // PATH, classically) may make it work inside the client, so never
        // remove it — just say what it is accurately.
        warned(
          adapter.name,
          globalPath,
          "a global-scope argent entry with custom env vars also exists; its env may make " +
            "it work in your client even though `argent` is not on this shell's PATH — " +
            "if it is a leftover, remove it"
        );
      }
      // entry.command === argent && argent on PATH: a working global install
      // the user kept (env-tuned or not) — legitimate coexistence, stay quiet.
    }
  } else if (scope === "global") {
    // Writing global scope while a project-scope entry exists at this root:
    // in every dual-scope client the project entry outranks the global one
    // here. It may be a committed team file, so never auto-remove.
    for (const adapter of writtenAdapters) {
      const projectPath = adapter.projectPath(effectiveRoot);
      if (!projectPath) continue;
      let entry: McpServerEntry | null;
      try {
        entry = adapter.getArgentEntry(projectPath);
      } catch {
        continue;
      }
      // An identical bare-command entry is a harmless duplicate; anything else
      // (a local-mode `node …` command) will keep winning over the global
      // entry the user just asked for.
      if (entry !== null && entry.command !== MCP_BINARY_NAME) {
        warned(
          adapter.name,
          projectPath,
          "a project-scope entry takes precedence over the global entry in this project; " +
            "if you are migrating away from a local install, remove it (argent uninstall)"
        );
      }
    }
  }

  // ── Execute the cross-project removals ──────────────────────────────────────
  // Only ever with explicit confirmation — deleting cross-project state on a
  // fallible PATH probe is not a decision --yes may make on the user's
  // behalf. A run with no confirmer reports the findings and touches nothing.
  if (pending.length > 0) {
    if (!args.confirmCrossProjectRemovals) {
      for (const item of pending) {
        warned(
          item.adapterName,
          item.location,
          `found ${item.what}; skipped in non-interactive mode — ` +
            `re-run \`argent init\` without --yes to review and remove it`
        );
      }
      return { lines, removedCount, warnedCount };
    }
    const proceed = await args.confirmCrossProjectRemovals(
      pending.map((item) => `${item.adapterName}: ${item.location}`)
    );
    for (const item of pending) {
      if (!proceed) {
        warned(item.adapterName, item.location, `kept ${item.what} at your request`);
        continue;
      }
      try {
        if (item.exec()) {
          removed(item.adapterName, item.location, item.what);
        }
      } catch (err) {
        warned(
          item.adapterName,
          item.location,
          `found ${item.what} but could not remove it: ${err}`
        );
      }
    }
  }

  return { lines, removedCount, warnedCount };
}
