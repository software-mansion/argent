import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  getMcpEntryForScope,
  isArgentManagedEntry,
  resolveLocalCommandMode,
  type McpConfigAdapter,
  type McpCommandMode,
  type McpServerEntry,
} from "./mcp-configs.js";
import { MCP_BINARY_NAME } from "./constants.js";
import { isDeclaredLocally, readInstallRecord } from "./utils.js";
import type { InstallMode } from "./install-record.js";
import type { Scope } from "./init-scope.js";

export interface McpWriteResult {
  /** Adapters actually written — local mode drops global-only adapters. */
  adapters: McpConfigAdapter[];
  /** One summary line per adapter. */
  lines: string[];
}

// Step 1c — write the MCP config files. Local mode points the command at the
// repo-local copy (node + relative path / yarn for PnP / npx fallback) and
// drops global-only adapters; global mode/scope keep the bare `argent` command.
export function writeMcpConfigs(args: {
  selectedAdapters: McpConfigAdapter[];
  installMode: InstallMode;
  scope: Scope;
  effectiveRoot: string;
  projectRoot: string;
}): McpWriteResult {
  const { installMode, scope, effectiveRoot, projectRoot } = args;
  let adapters = args.selectedAdapters;
  const normalizedScope: "local" | "global" = scope === "global" ? "global" : "local";

  // Global-only adapters (no project config file) can't carry a project-scoped
  // entry, so drop them with a note rather than writing a global `argent` entry
  // that would depend on the global install the user opted out of.
  let localCmdMode: McpCommandMode | null = null;
  if (installMode === "local") {
    localCmdMode = resolveLocalCommandMode(effectiveRoot);
    // Backstop for the eligibility filter in chooseAdapters (a custom root can
    // change which adapters have a project path).
    const unsupported = adapters.filter((a) => a.projectPath(effectiveRoot) == null);
    if (unsupported.length > 0) {
      p.log.warn(
        `Skipping ${unsupported.map((a) => a.name).join(", ")} — ` +
          `no project-level config file (local mode commits project files only).`
      );
      adapters = adapters.filter((a) => a.projectPath(effectiveRoot) != null);
    }
    if (adapters.length === 0) {
      // Without this, init would report success while no editor was wired up
      // anywhere — the committed devDependency would do nothing.
      p.log.warn(
        pc.yellow(
          `No MCP config was written: none of the selected editors supports a ` +
            `project-level config. Re-run ${pc.cyan("argent init")} and select a ` +
            `different editor, or use ${pc.cyan("argent init --global")}.`
        )
      );
    }
    if (localCmdMode.kind === "local-npx") {
      p.log.warn(
        `Could not resolve a project-local argent binary; committing ` +
          `${pc.cyan("npx --no-install argent mcp")}. Run ${pc.cyan("npm install")} so it resolves.`
      );
    }
  }

  const entryFor = (configScope: "local" | "global"): McpServerEntry =>
    getMcpEntryForScope(installMode, configScope, localCmdMode);

  // The project is still in local mode when its committed record says so or
  // its manifest still declares the dep — the same signal init.ts uses to keep
  // vs. clear the .argent marker in this run.
  const stillLocalMode = (root: string): boolean =>
    readInstallRecord(root)?.mode === "local" || isDeclaredLocally(root);

  // A committed local-mode entry in a PROJECT config must survive a coexisting
  // `init --global` run: the same run keeps .argent/install.json and reports
  // the project stays in local mode, so clobbering the team's committed
  // node-path command with the bare `argent` one (dead for every teammate
  // without a global install) would contradict that — the same committed-file
  // protection update's refresh applies. But only while the project is STILL
  // local: one that abandoned local mode (devDependency removed) must have its
  // now-dead node-path entry rewritten to bare `argent`, matching init's own
  // "Removed stale .argent/install.json" cleanup in the same run.
  const keepsCommittedLocalEntry = (
    adapter: McpConfigAdapter,
    configPath: string,
    root: string
  ): boolean => {
    if (installMode !== "global") return false;
    if (!stillLocalMode(root)) return false;
    let existing: McpServerEntry | null;
    try {
      existing = adapter.getArgentEntry(configPath);
    } catch {
      return false;
    }
    return (
      existing !== null && existing.command !== MCP_BINARY_NAME && isArgentManagedEntry(existing)
    );
  };

  const lines: string[] = [];

  for (const adapter of adapters) {
    const configPath =
      scope === "global" ? adapter.globalPath() : adapter.projectPath(effectiveRoot);

    if (!configPath) {
      if (scope === "global" && adapter.projectPath(projectRoot)) {
        const fallback = adapter.projectPath(projectRoot)!;
        if (keepsCommittedLocalEntry(adapter, fallback, projectRoot)) {
          lines.push(
            `${pc.yellow("!")} ${adapter.name} kept the committed local-mode entry ${pc.dim(fallback)}`
          );
          continue;
        }
        try {
          adapter.write(fallback, entryFor("local"));
          lines.push(`${pc.green("+")} ${adapter.name} ${pc.dim(`(local fallback: ${fallback})`)}`);
        } catch (err) {
          lines.push(`${pc.red("x")} ${adapter.name}: ${pc.dim(String(err))}`);
        }
      } else if (scope !== "global" && adapter.globalPath()) {
        const fallback = adapter.globalPath()!;
        try {
          adapter.write(fallback, entryFor("global"));
          lines.push(
            `${pc.green("+")} ${adapter.name} ${pc.dim(`(global fallback: ${fallback})`)}`
          );
        } catch (err) {
          lines.push(`${pc.red("x")} ${adapter.name}: ${pc.dim(String(err))}`);
        }
      } else {
        lines.push(
          `${pc.yellow("-")} ${adapter.name} ${pc.dim("(no config path for this scope)")}`
        );
      }
      continue;
    }

    if (scope !== "global" && keepsCommittedLocalEntry(adapter, configPath, effectiveRoot)) {
      lines.push(
        `${pc.yellow("!")} ${adapter.name} kept the committed local-mode entry ${pc.dim(configPath)}`
      );
      continue;
    }
    try {
      adapter.write(configPath, entryFor(normalizedScope));
      lines.push(`${pc.green("+")} ${adapter.name} ${pc.dim(configPath)}`);
    } catch (err) {
      lines.push(`${pc.red("x")} ${adapter.name}: ${pc.dim(String(err))}`);
    }
  }

  return { adapters, lines };
}
