import pc from "picocolors";
import { getMcpEntry, type McpConfigAdapter, type McpEntryMode } from "./mcp-configs.js";
import type { TopologyId } from "./topology.js";
import type { Scope } from "./init-scope.js";

// Step 1c — write the MCP config files for the selected adapters.
// Returns one line per adapter for the summary note.

interface WriteArgs {
  adapters: McpConfigAdapter[];
  topology: TopologyId;
  scope: Scope;
  /** projectRoot OR customRoot, depending on scope. */
  effectiveRoot: string;
  /** Always projectRoot (for "fallback to project" message paths). */
  projectRoot: string;
}

function entryModeFor(topology: TopologyId, effectiveRoot: string): McpEntryMode {
  return topology === "local" ? { kind: "local", projectRoot: effectiveRoot } : { kind: "global" };
}

function configPathFor(
  adapter: McpConfigAdapter,
  scope: Scope,
  effectiveRoot: string
): string | null {
  return scope === "global" ? adapter.globalPath() : adapter.projectPath(effectiveRoot);
}

function safeWrite(adapter: McpConfigAdapter, configPath: string, mode: McpEntryMode): string {
  try {
    adapter.write(configPath, getMcpEntry(mode, adapter));
    return `${pc.green("+")} ${adapter.name} ${pc.dim(configPath)}`;
  } catch (err) {
    return `${pc.red("x")} ${adapter.name}: ${pc.dim(String(err))}`;
  }
}

function fallbackLine(
  adapter: McpConfigAdapter,
  fallback: string,
  mode: McpEntryMode,
  label: "local" | "global"
): string {
  try {
    adapter.write(fallback, getMcpEntry(mode, adapter));
    return `${pc.green("+")} ${adapter.name} ${pc.dim(`(${label} fallback: ${fallback})`)}`;
  } catch (err) {
    return `${pc.red("x")} ${adapter.name}: ${pc.dim(String(err))}`;
  }
}

export function writeMcpConfigs({
  adapters,
  topology,
  scope,
  effectiveRoot,
  projectRoot,
}: WriteArgs): string[] {
  const mode = entryModeFor(topology, effectiveRoot);
  const results: string[] = [];

  for (const adapter of adapters) {
    const configPath = configPathFor(adapter, scope, effectiveRoot);
    if (configPath) {
      results.push(safeWrite(adapter, configPath, mode));
      continue;
    }

    // No path for the requested scope — try the other scope as a fallback.
    if (scope === "global") {
      const projectFallback = adapter.projectPath(projectRoot);
      if (projectFallback) {
        results.push(fallbackLine(adapter, projectFallback, mode, "local"));
        continue;
      }
    } else {
      const globalFallback = adapter.globalPath();
      if (globalFallback) {
        results.push(fallbackLine(adapter, globalFallback, mode, "global"));
        continue;
      }
    }
    results.push(`${pc.yellow("-")} ${adapter.name} ${pc.dim("(no config path for this scope)")}`);
  }

  return results;
}
