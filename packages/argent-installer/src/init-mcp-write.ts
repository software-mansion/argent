import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  getMcpEntry,
  resolveLocalCommandMode,
  type McpConfigAdapter,
  type McpCommandMode,
  type McpServerEntry,
} from "./mcp-configs.js";
import type { InstallMode } from "./install-record.js";
import type { Scope } from "./init-scope.js";

export interface McpWriteResult {
  /** Adapters actually written — local mode drops global-only adapters. */
  adapters: McpConfigAdapter[];
  /** One summary line per adapter. */
  lines: string[];
}

// Step 1c — write the MCP config files. In local mode, drops global-only
// adapters (no project config file) with a note and points the command at the
// repo-local copy (node + relative path / yarn for PnP / npx fallback); global
// mode and global scope keep the bare `argent` command.
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

  // Local mode writes project-scoped entries that run the repo-local argent.
  // Global-only adapters (no project config file) can't carry that, so drop
  // them with a note rather than writing a global `argent` entry that would
  // depend on the global install the user opted out of.
  let localCmdMode: McpCommandMode | null = null;
  if (installMode === "local") {
    localCmdMode = resolveLocalCommandMode(effectiveRoot);
    const unsupported = adapters.filter((a) => a.projectPath(effectiveRoot) == null);
    if (unsupported.length > 0) {
      p.log.warn(
        `Skipping ${unsupported.map((a) => a.name).join(", ")} — ` +
          `no project-level config file (local mode commits project files only).`
      );
      adapters = adapters.filter((a) => a.projectPath(effectiveRoot) != null);
    }
    if (localCmdMode.kind === "local-npx") {
      p.log.warn(
        `Could not resolve a project-local argent binary; committing ` +
          `${pc.cyan("npx --no-install argent mcp")}. Run ${pc.cyan("npm install")} so it resolves.`
      );
    }
  }

  // Global scope (and global install mode) always gets the bare `argent`
  // command; only a local-mode project-scope entry runs the repo-local copy.
  const entryFor = (configScope: "local" | "global"): McpServerEntry =>
    installMode === "local" && configScope === "local" && localCmdMode
      ? getMcpEntry(localCmdMode)
      : getMcpEntry({ kind: "global" });

  const lines: string[] = [];

  for (const adapter of adapters) {
    const configPath =
      scope === "global" ? adapter.globalPath() : adapter.projectPath(effectiveRoot);

    if (!configPath) {
      if (scope === "global" && adapter.projectPath(projectRoot)) {
        const fallback = adapter.projectPath(projectRoot)!;
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

    try {
      adapter.write(configPath, entryFor(normalizedScope));
      lines.push(`${pc.green("+")} ${adapter.name} ${pc.dim(configPath)}`);
    } catch (err) {
      lines.push(`${pc.red("x")} ${adapter.name}: ${pc.dim(String(err))}`);
    }
  }

  return { adapters, lines };
}
