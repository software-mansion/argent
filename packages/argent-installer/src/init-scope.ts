import * as p from "@clack/prompts";
import pc from "picocolors";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { TopologyId } from "./topology.js";

// Step 1b — pick the MCP config scope (local / global / custom path).
// Local mode locks scope=local since the committed config must live next
// to package.json.

export type Scope = "local" | "global" | "custom";

export interface ScopeChoice {
  scope: Scope;
  customRoot?: string;
}

interface ChooseArgs {
  topology: TopologyId;
  nonInteractive: boolean;
}

export async function chooseScope({ topology, nonInteractive }: ChooseArgs): Promise<ScopeChoice> {
  if (topology === "local") return { scope: "local" };
  if (nonInteractive) return { scope: "local" };

  p.log.message(pc.dim("  Use arrow keys to move, enter to confirm."));

  const choice = await p.select({
    message: "Install MCP server globally or locally?",
    options: [
      {
        value: "local" as const,
        label: "Local",
        hint: "Current project only - .cursor/mcp.json, .mcp.json, ...",
      },
      {
        value: "global" as const,
        label: "Global",
        hint: "Available across all projects - ~/.*/mcp.json",
      },
      {
        value: "custom" as const,
        label: "Specify installation directory",
        hint: "Specify a directory to use as the project root",
      },
    ],
  });

  if (p.isCancel(choice)) {
    p.cancel("Initialization cancelled.");
    process.exit(0);
  }

  const scope = choice as Scope;
  if (scope !== "custom") return { scope };

  const customPathInput = await p.text({
    message: "Enter the path to use as the project root for MCP config:",
    placeholder: process.cwd(),
    validate(value) {
      if (!value?.trim()) return "Path cannot be empty.";
      const resolved = resolve(value.trim());
      if (!existsSync(resolved))
        return `Path does not exist: ${resolved}. Please verify and enter a valid path.`;
    },
  });

  if (p.isCancel(customPathInput)) {
    p.cancel("Initialization cancelled.");
    process.exit(0);
  }

  return { scope: "custom", customRoot: resolve((customPathInput as string).trim()) };
}
