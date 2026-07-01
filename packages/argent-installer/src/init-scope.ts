import * as p from "@clack/prompts";
import pc from "picocolors";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { InitCancelled } from "./init-args.js";
import type { InstallMode } from "./install-record.js";

export type Scope = "local" | "global" | "custom";

export interface ScopeChoice {
  scope: Scope;
  customRoot?: string;
}

// Step 1b — choose where the MCP config is written. Local install mode always
// commits project-scoped files, so it forces "local" without prompting;
// non-interactive also defaults to "local". Throws InitCancelled("scope") on
// cancel.
export async function chooseScope(opts: {
  installMode: InstallMode;
  nonInteractive: boolean;
}): Promise<ScopeChoice> {
  if (opts.installMode === "local") {
    // Local mode commits project files; a global-scope MCP config makes no
    // sense for a repo-local install, so the project root is always the target.
    return { scope: "local" };
  }
  if (opts.nonInteractive) {
    return { scope: "local" };
  }

  p.log.message(pc.dim("  Use arrow keys to move, enter to confirm."));

  const scopeChoice = await p.select({
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

  if (p.isCancel(scopeChoice)) throw new InitCancelled("scope");

  const scope = scopeChoice as Scope;
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

  if (p.isCancel(customPathInput)) throw new InitCancelled("scope");

  return { scope: "custom", customRoot: resolve((customPathInput as string).trim()) };
}
