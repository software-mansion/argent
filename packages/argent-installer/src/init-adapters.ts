import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  detectAdapters,
  findConfiguredAdapterScopes,
  ALL_ADAPTERS,
  type McpConfigAdapter,
} from "./mcp-configs.js";
import type { InstallMode } from "./install-record.js";
import { InitCancelled } from "./init-args.js";

export interface AdapterSelection {
  selected: McpConfigAdapter[];
  detected: McpConfigAdapter[];
}

// Editors whose config (in the scope this init writes) already carries an
// argent entry. The evidence-based detect() deliberately ignores argent's own
// artifacts, so this is a separate signal with two jobs: a re-run keeps
// maintaining every config a previous init wrote (instead of orphaning the
// editors detect() no longer surfaces), and a teammate cloning a repo whose
// only editor trace is a committed argent config gets exactly that editor —
// not the nothing-detected → configure-everything fallback.
function previouslyConfiguredAdapters(
  eligible: McpConfigAdapter[],
  installMode: InstallMode
): McpConfigAdapter[] {
  const wantedScope = installMode === "local" ? "project" : "global";
  const scopes = findConfiguredAdapterScopes(eligible, process.cwd());
  const configured = new Set(scopes.filter((s) => s.scope === wantedScope).map((s) => s.adapter));
  return eligible.filter((a) => configured.has(a));
}

// Step 1a — choose which editors to configure. Local mode commits project
// files only, so editors without a project-level config are excluded up front
// rather than silently dropped at write time. Non-interactive falls back to
// the union of detected and previously-configured editors, or all eligible
// when both are empty. Throws InitCancelled("editors") on cancel.
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
  const previouslyConfigured = previouslyConfiguredAdapters(eligible, opts.installMode);
  const previouslyConfiguredNames = previouslyConfigured.map((a) => a.name);
  const preselected = [...detected, ...previouslyConfigured.filter((a) => !detected.includes(a))];

  if (opts.nonInteractive) {
    return { selected: preselected.length > 0 ? preselected : eligible, detected };
  }

  const choices = eligible.map((a) => {
    const parts: string[] = [];
    if (detectedNames.includes(a.name)) parts.push("detected");
    else if (previouslyConfiguredNames.includes(a.name)) parts.push("already configured");
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
    initialValues: preselected,
    required: true,
  });

  if (p.isCancel(selected)) throw new InitCancelled("editors");
  return { selected: selected as McpConfigAdapter[], detected };
}
