import * as p from "@clack/prompts";
import pc from "picocolors";
import { detectAdapters, ALL_ADAPTERS, type McpConfigAdapter } from "./mcp-configs.js";
import type { InstallMode } from "./install-record.js";
import { InitCancelled } from "./init-args.js";

export interface AdapterSelection {
  selected: McpConfigAdapter[];
  detected: McpConfigAdapter[];
}

// Step 1a — choose which editors to configure. Local mode commits project
// files only, so editors without a project-level config are excluded up front
// rather than silently dropped at write time. Non-interactive falls back to
// the detected set, or all eligible. Throws InitCancelled("editors") on cancel.
export async function chooseAdapters(opts: {
  nonInteractive: boolean;
  installMode: InstallMode;
}): Promise<AdapterSelection> {
  let eligible = ALL_ADAPTERS;
  if (opts.installMode === "local") {
    const globalOnly = ALL_ADAPTERS.filter((a) => a.projectPath(process.cwd()) == null);
    if (globalOnly.length > 0) {
      eligible = ALL_ADAPTERS.filter((a) => a.projectPath(process.cwd()) != null);
      p.log.info(
        pc.dim(
          `Local mode configures project files only — ` +
            `${globalOnly.map((a) => a.name).join(", ")} (global-only config) not offered.`
        )
      );
    }
  }

  const detected = detectAdapters().filter((a) => eligible.includes(a));
  const detectedNames = detected.map((a) => a.name);

  if (opts.nonInteractive) {
    return { selected: detected.length > 0 ? detected : eligible, detected };
  }

  const choices = eligible.map((a) => {
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
