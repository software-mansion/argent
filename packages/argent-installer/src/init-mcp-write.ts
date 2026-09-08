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

interface McpWriteResult {
  /** Selected adapters minus the global-only ones local mode drops. */
  adapters: McpConfigAdapter[];
  /** One summary line per adapter. */
  lines: string[];
}

// Step 1c — write the MCP config files. Local mode points project-scope
// entries at the repo-local copy and drops global-only adapters; everything
// else keeps the bare `argent` command.
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

  let localCmdMode: McpCommandMode | null = null;
  if (installMode === "local") {
    localCmdMode = resolveLocalCommandMode(effectiveRoot);
    // Without this drop, the global-fallback branch below would write a global
    // `argent` entry depending on the global install the user opted out of.
    const unsupported = adapters.filter((a) => a.projectPath(effectiveRoot) == null);
    if (unsupported.length > 0) {
      p.log.warn(
        `Skipping ${unsupported.map((a) => a.name).join(", ")} — ` +
          `no project-level config file (local mode commits project files only).`
      );
      adapters = adapters.filter((a) => a.projectPath(effectiveRoot) != null);
    }
    if (adapters.length === 0) {
      // Without this, init would report success with nothing wired up anywhere.
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

  const stillLocalMode = (root: string): boolean =>
    readInstallRecord(root)?.mode === "local" || isDeclaredLocally(root);

  // Clobbering a team's committed node-path command with the bare `argent` one
  // would break every teammate without a global install, so a project still in
  // local mode keeps it even under `init --global`.
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
