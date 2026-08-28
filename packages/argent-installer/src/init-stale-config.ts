import pc from "picocolors";
import { MCP_BINARY_NAME } from "./constants.js";
import { isGloballyInstalled } from "./utils.js";
import { hasCustomizingEnv, type McpConfigAdapter, type McpServerEntry } from "./mcp-configs.js";

interface StaleConfigCleanupResult {
  /** One line per removed entry or warning. */
  lines: string[];
  removedCount: number;
  warnedCount: number;
}

// A removal in a GLOBAL config file, executed only after the caller's
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
// Scope precedence can't be trusted to make the fresh entry win, so: remove
// hidden-scope findings the adapter marks autoRemove; remove bare-`argent`
// entries when no global argent is on PATH, behind one confirmation (see
// confirmCrossProjectRemovals); warn with the exact location about anything
// else, never touch it (may be hand-tuned or backed by a working global
// install).
export async function cleanupStaleMcpConfigs(args: {
  /** Shadow findings are looked for under these. */
  writtenAdapters: McpConfigAdapter[];
  /**
   * Also swept for dead global entries, so a client with no project config
   * (Windsurf, Hermes) gets its stale `argent` entry pruned too.
   */
  detectedAdapters: McpConfigAdapter[];
  installMode: "global" | "local";
  scope: "local" | "global";
  effectiveRoot: string;
  /**
   * Asked ONCE, with one "<client>: <path>" line per planned removal in a
   * global config file, before any is executed; project-confined removals
   * never prompt. Omit for non-interactive runs — those removals are then
   * skipped and reported as warnings, since no human is there to catch a PATH
   * probe an nvm-style split fooled. Returning false also keeps every listed
   * entry.
   */
  confirmCrossProjectRemovals?: (items: string[]) => Promise<boolean>;
}): Promise<StaleConfigCleanupResult> {
  const { writtenAdapters, detectedAdapters, installMode, scope, effectiveRoot } = args;
  const lines: string[] = [];
  let removedCount = 0;
  let warnedCount = 0;
  // Hoisted: one PATH probe (a `which`/`where` subprocess) per run.
  const globalArgentOnPath = isGloballyInstalled();

  // No env that could make it resolvable inside the client (a custom PATH is
  // exactly what an nvm user adds) — so it is dead in every environment that
  // resolves PATH like this shell. Legacy argent-authored env doesn't count
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

  // Hidden scopes the adapters know about. A malformed config file must not
  // abort init (same stance as findConfiguredAdapterScopes).
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
        // Outside the project (e.g. VS Code's user-profile mcp.json), so it
        // waits for the confirmation.
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

  // Cross-scope leftovers of a previous install.
  if (installMode === "local" && scope === "local") {
    // Migrating to a committable install leaves the previous global-scope
    // entry behind in every client, including those with no project config.
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
        // May be a hand-tuned dev setup rather than a leftover — warn, never
        // remove.
        warned(
          adapter.name,
          globalPath,
          "a global-scope argent entry with a custom command also exists; " +
            "if it is a leftover, remove it or its settings may leak into this install"
        );
      } else if (!globalArgentOnPath) {
        // The env (an nvm PATH, classically) may make it resolve inside the
        // client even though this shell can't, so never remove it.
        warned(
          adapter.name,
          globalPath,
          "a global-scope argent entry with custom env vars also exists; its env may make " +
            "it work in your client even though `argent` is not on this shell's PATH — " +
            "if it is a leftover, remove it"
        );
      }
      // Bare `argent` that IS on PATH: a working global install the user
      // kept — legitimate coexistence, stay quiet.
    }
  } else if (scope === "global") {
    // A project-scope entry at this root can outrank the global entry just
    // written, but it may be a committed team file — never auto-remove.
    for (const adapter of writtenAdapters) {
      const projectPath = adapter.projectPath(effectiveRoot);
      if (!projectPath) continue;
      let entry: McpServerEntry | null;
      try {
        entry = adapter.getArgentEntry(projectPath);
      } catch {
        continue;
      }
      // A bare-command entry duplicates the global one harmlessly; a
      // local-mode `node …` command does not.
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

  // Execute the cross-project removals, only ever with explicit confirmation
  // — deleting cross-project state on a fallible PATH probe is not a decision
  // --yes may make on the user's behalf.
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
