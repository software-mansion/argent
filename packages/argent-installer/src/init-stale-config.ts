import pc from "picocolors";
import { MCP_BINARY_NAME } from "./constants.js";
import { isGloballyInstalled } from "./utils.js";
import type { McpConfigAdapter, McpServerEntry } from "./mcp-configs.js";

export interface StaleConfigCleanupResult {
  /** One summary line per removed entry or warning; empty when nothing found. */
  lines: string[];
  removedCount: number;
  warnedCount: number;
}

// Step 1d — sweep for argent config the entries just written do NOT replace:
// same-named entries in other scopes left behind by a previous install (most
// often a global-mode install this project just migrated away from), and
// hidden-scope state only the adapter knows about (Claude Code's local scope,
// VS Code's user-profile mcp.json, recorded .mcp.json rejections).
//
// Why removal instead of trusting scope precedence: no client guarantees the
// fresh entry wins. Claude Code's local scope outranks everything init can
// write; Cursor and VS Code don't document same-name precedence at all; Codex
// and opencode deep-merge per KEY, so fields of a stale entry (env, enabled,
// timeouts) leak into the merged server even when the project command wins;
// Zed ignores project settings entirely until the worktree is trusted.
//
// Removal policy, most conservative that still fixes the failure:
//   - hidden-scope findings marked autoRemove by the adapter (state keyed to
//     this project, or state whose removal only re-enables prompting) — remove;
//   - any entry that runs the bare `argent` command when no global argent is
//     on PATH — provably dead everywhere, for every project — remove;
//   - anything else that could interfere — warn with the exact location, never
//     touch it (it may be hand-tuned or backed by a working global install).
export function cleanupStaleMcpConfigs(args: {
  /** Adapters whose configs this run wrote (shadow findings target these). */
  writtenAdapters: McpConfigAdapter[];
  /**
   * Adapters detected on this machine — the dead-global sweep covers these
   * too, so a client dropped from a local-mode install (Windsurf, Hermes have
   * no project config) still gets its dead `argent` entry pruned.
   */
  detectedAdapters: McpConfigAdapter[];
  installMode: "global" | "local";
  scope: "local" | "global";
  effectiveRoot: string;
}): StaleConfigCleanupResult {
  const { writtenAdapters, detectedAdapters, installMode, scope, effectiveRoot } = args;
  const lines: string[] = [];
  let removedCount = 0;
  let warnedCount = 0;
  // One PATH probe per run; entries running the bare command are dead iff this
  // is false.
  const globalArgentOnPath = isGloballyInstalled();

  const isProvablyDead = (entry: McpServerEntry | null): boolean =>
    entry !== null && entry.command === MCP_BINARY_NAME && !globalArgentOnPath;

  const removed = (adapterName: string, location: string, what: string): void => {
    removedCount += 1;
    lines.push(`${pc.green("+")} ${adapterName}: removed ${what} ${pc.dim(`(${location})`)}`);
  };
  const warned = (adapterName: string, location: string, why: string): void => {
    warnedCount += 1;
    lines.push(`${pc.yellow("!")} ${adapterName}: ${why} ${pc.dim(`(${location})`)}`);
  };

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
      if (finding.autoRemove || isProvablyDead(finding.entry)) {
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
      } else {
        warned(adapter.name, finding.location, finding.reason);
      }
    }
  }

  // ── Cross-scope leftovers of a previous install ─────────────────────────────
  if (installMode === "local" && scope === "local") {
    // Migrating to a committable install: a global-scope `argent` entry from
    // the previous global install stays behind in every client. Sweep the
    // DETECTED set, not just the written one — clients without a project
    // config (dropped from local mode) hold dead entries too.
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
        try {
          if (adapter.remove(globalPath)) {
            removed(
              adapter.name,
              globalPath,
              `a dead global entry (runs \`${MCP_BINARY_NAME}\`, which is no longer on PATH)`
            );
          }
        } catch (err) {
          warned(
            adapter.name,
            globalPath,
            `found a dead global entry but could not remove it: ${err}`
          );
        }
      } else if (entry.command !== MCP_BINARY_NAME) {
        // A custom or unrecognizable global entry — possibly a hand-tuned dev
        // setup, possibly a leftover local-command entry from another project.
        // Not ours to judge: several clients (Codex, opencode) merge its
        // fields into the project entry, so surface it.
        warned(
          adapter.name,
          globalPath,
          "a global-scope argent entry with a custom command also exists; " +
            "if it is a leftover, remove it or its settings may leak into this install"
        );
      }
      // entry.command === argent && argent on PATH: a working global install
      // the user kept — legitimate coexistence, stay quiet.
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

  return { lines, removedCount, warnedCount };
}
