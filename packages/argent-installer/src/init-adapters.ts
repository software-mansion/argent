import * as p from "@clack/prompts";
import pc from "picocolors";
import { detectAdapters, ALL_ADAPTERS, type McpConfigAdapter } from "./mcp-configs.js";
import type { TopologyId } from "./topology.js";

// Step 1a — pick which editors get an MCP entry. In local mode the
// adapter universe is filtered to those that have a project-scoped
// config file (Windsurf / Hermes are excluded).

export interface AdapterSelection {
  selected: McpConfigAdapter[];
  universe: McpConfigAdapter[];
  detected: McpConfigAdapter[];
  /** Adapters dropped because of local-mode filtering. */
  droppedForLocal: McpConfigAdapter[];
}

interface SelectArgs {
  topology: TopologyId;
  nonInteractive: boolean;
}

function buildUniverse(topology: TopologyId): {
  universe: McpConfigAdapter[];
  dropped: McpConfigAdapter[];
} {
  if (topology !== "local") return { universe: [...ALL_ADAPTERS], dropped: [] };
  const universe: McpConfigAdapter[] = [];
  const dropped: McpConfigAdapter[] = [];
  for (const a of ALL_ADAPTERS) {
    (a.acceptsLocalInstall === false ? dropped : universe).push(a);
  }
  return { universe, dropped };
}

export async function chooseAdapters({
  topology,
  nonInteractive,
}: SelectArgs): Promise<AdapterSelection> {
  const { universe, dropped: droppedForLocal } = buildUniverse(topology);
  const detected = detectAdapters().filter((a) => universe.includes(a));

  if (topology === "local" && droppedForLocal.length > 0) {
    p.log.info(
      pc.dim(
        `Skipping ${droppedForLocal.map((a) => a.name).join(", ")} ` +
          `(global-only — no project config file to commit).`
      )
    );
  }

  if (nonInteractive) {
    const selected = detected.length > 0 ? detected : universe;
    return { selected, universe, detected, droppedForLocal };
  }

  const detectedNames = new Set(detected.map((a) => a.name));
  const choices = universe.map((a) => {
    const parts: string[] = [];
    if (detectedNames.has(a.name)) parts.push("detected");
    const hasProject = a.projectPath(process.cwd()) != null;
    const hasGlobal = a.globalPath() != null;
    if (!hasProject && hasGlobal) {
      parts.push(pc.italic(pc.cyan(`ⓘ  will be installed into ${a.name}'s global config`)));
    } else if (hasProject && !hasGlobal) {
      parts.push(pc.italic(pc.cyan(`ⓘ  will be installed into ${a.name}'s project config`)));
    }
    return { value: a, label: a.name, hint: parts.length > 0 ? parts.join(", ") : undefined };
  });

  p.log.message(pc.dim("  Use arrow keys to move, space to toggle, enter to confirm."));

  const result = await p.multiselect({
    message: "Which editors should Argent be configured for?",
    options: choices,
    initialValues: detected,
    required: true,
  });

  if (p.isCancel(result)) {
    p.cancel("Initialization cancelled.");
    process.exit(0);
  }

  const selected = result as McpConfigAdapter[];
  return { selected, universe, detected, droppedForLocal };
}
