import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  getMcpEntryForScope,
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
