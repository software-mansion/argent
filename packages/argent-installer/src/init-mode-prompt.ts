import * as p from "@clack/prompts";
import { InitCancelled } from "./init-args.js";
import type { InstallMode } from "./install-record.js";

// Step-0 interactive selector: global (default) vs local (committable
// devDependency). Used only when neither --local/--global nor --yes fixed the
// mode. Throws InitCancelled("install_mode") on cancel.
export async function promptInstallMode(): Promise<InstallMode> {
  const modeChoice = await p.select({
    message: "How should argent be installed?",
    options: [
      {
        value: "global" as const,
        label: "Globally (recommended)",
        hint: "Installs the argent command on your PATH; shared across every project",
      },
      {
        value: "local" as const,
        label: "This project only",
        hint: "Adds @swmansion/argent to devDependencies and commits MCP config that runs the local copy — best for teams",
      },
    ],
    initialValue: "global",
  });

  if (p.isCancel(modeChoice)) throw new InitCancelled("install_mode");
  return modeChoice as InstallMode;
}
