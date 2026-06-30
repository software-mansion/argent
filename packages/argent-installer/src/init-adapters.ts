import * as p from "@clack/prompts";
import pc from "picocolors";
import { detectAdapters, ALL_ADAPTERS, type McpConfigAdapter } from "./mcp-configs.js";
import { InitCancelled } from "./init-args.js";

export interface AdapterSelection {
  selected: McpConfigAdapter[];
  detected: McpConfigAdapter[];
}

// Step 1a — choose which editors to configure. Non-interactive falls back to the
// detected set (or all adapters when nothing is detected). Throws
// InitCancelled("editors") on cancel.
export async function chooseAdapters(opts: { nonInteractive: boolean }): Promise<AdapterSelection> {
  const detected = detectAdapters();
  const detectedNames = detected.map((a) => a.name);

  if (opts.nonInteractive) {
    return { selected: detected.length > 0 ? detected : ALL_ADAPTERS, detected };
  }

  const choices = ALL_ADAPTERS.map((a) => {
    const parts: string[] = [];
    if (detectedNames.includes(a.name)) parts.push("detected");
    const hasProject = a.projectPath(process.cwd()) != null;
    const hasGlobal = a.globalPath() != null;
    if (!hasProject && hasGlobal) {
      parts.push(pc.italic(pc.cyan(`ⓘ  will be installed into ${a.name}'s global config`)));
    } else if (hasProject && !hasGlobal) {
      parts.push(pc.italic(pc.cyan(`ⓘ  will be installed into ${a.name}'s project config`)));
    }
    return {
      value: a,
      label: a.name,
      hint: parts.length > 0 ? parts.join(", ") : undefined,
    };
  });

  p.log.message(pc.dim("  Use arrow keys to move, space to toggle, enter to confirm."));

  const selected = await p.multiselect({
    message: "Which editors should Argent be configured for?",
    options: choices,
    initialValues: detected,
    required: true,
  });

  if (p.isCancel(selected)) throw new InitCancelled("editors");
  return { selected: selected as McpConfigAdapter[], detected };
}
