import * as p from "@clack/prompts";
import pc from "picocolors";
import type { TopologyId } from "./topology.js";

// Step-0 install-mode selection. Encapsulates the prompt loop so init.ts
// just receives a final TopologyId (or exits on cancel).

interface PromptArgs {
  /** True if argent is already a project devDep on disk. */
  locallyInstalled: boolean;
}

const PROMPT_MESSAGE = (locallyInstalled: boolean): string =>
  locallyInstalled
    ? "How would you like to configure argent?"
    : "Argent isn't installed yet. How would you like to set it up?";

const LOCAL_CAVEAT =
  "The locally-installed argent will only work if your agent runs from the " +
  "root directory of your project. If a teammate's editor fails to start " +
  "argent, verify they are in the root directory first.";

function buildOptions(locallyInstalled: boolean) {
  return [
    {
      value: "global" as const,
      label: "Global (recommended)",
      hint: "Makes the argent command available everywhere",
    },
    {
      value: "local" as const,
      label: locallyInstalled
        ? "Local (devDependency, already installed)"
        : "Local (devDependency)",
      hint: "Might be used by teams to share configuration",
    },
    { value: "cancel" as const, label: "Cancel installation" },
  ];
}

// Returns the chosen TopologyId. Exits the process on cancel — the prompt
// is interactive only, callers must guard with a nonInteractive check.
export async function promptInstallMode({ locallyInstalled }: PromptArgs): Promise<TopologyId> {
  while (true) {
    const choice = await p.select({
      message: PROMPT_MESSAGE(locallyInstalled),
      initialValue: "global" as const,
      options: buildOptions(locallyInstalled),
    });

    if (p.isCancel(choice) || choice === "cancel") {
      p.cancel("Installation cancelled.");
      process.exit(0);
    }

    if (choice === "global") return "global";

    // Local — surface the caveat as decision context, not noise.
    p.log.warn(LOCAL_CAVEAT);
    p.log.message(pc.dim("  Press y for yes, n for no, enter to confirm."));
    const confirmLocal = await p.confirm({
      message: "Proceed with the Local devDependency install?",
      initialValue: true,
    });
    if (p.isCancel(confirmLocal)) {
      p.cancel("Installation cancelled.");
      process.exit(0);
    }
    if (confirmLocal) return "local";
    // Decline → loop back to the mode select.
  }
}
