import * as p from "@clack/prompts";
import pc from "picocolors";
import { execSync, spawn } from "node:child_process";
import {
  detectAdapters,
  ALL_ADAPTERS,
  getMcpEntry,
  copyRulesAndAgents,
  type McpConfigAdapter,
} from "./mcp-configs.js";
import {
  SKILLS_DIR,
  RULES_DIR,
  AGENTS_DIR,
  getInstalledVersion,
  getLatestVersion,
  detectPackageManager,
  globalInstallCommand,
} from "./utils.js";
import { PACKAGE_NAME } from "./constants.js";

function isGloballyInstalled(): boolean {
  try {
    const raw = execSync(
      `npm list -g ${PACKAGE_NAME} --depth=0 --json`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const data = JSON.parse(raw) as {
      dependencies?: Record<string, unknown>;
    };
    return !!data?.dependencies?.[PACKAGE_NAME];
  } catch {
    return false;
  }
}

function runShellCommand(cmd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const parts = cmd.split(" ");
    const bin = parts[0]!;
    const args = parts.slice(1);
    const isWin = process.platform === "win32";
    const child = spawn(isWin ? `${bin}.cmd` : bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: isWin,
    });

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `Command exited with code ${code}`));
    });

    child.on("error", reject);
  });
}

function extractFlag(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1]!;
}

export async function init(args: string[]): Promise<void> {
  const nonInteractive = args.includes("--yes") || args.includes("-y");
  const fromTar = extractFlag(args, "--from");

  printBanner();

  p.intro(pc.bgCyan(pc.black(" argent init ")));

  const version = getInstalledVersion() ?? "unknown";
  p.log.info(`${pc.dim("Package:")} ${PACKAGE_NAME}@${version}`);

  // ── Step 0: Install / Update Check ──────────────────────────────────────────

  const globallyInstalled = isGloballyInstalled();

  if (!globallyInstalled) {
    if (!nonInteractive) {
      const installChoice = await p.select({
        message: "argent is not installed globally. Would you like to install it?",
        options: [
          {
            value: "global" as const,
            label: "Install globally",
            hint: "Makes the argent command available everywhere",
          },
          {
            value: "cancel" as const,
            label: "Cancel",
          },
        ],
      });

      if (p.isCancel(installChoice) || installChoice === "cancel") {
        p.cancel("Installation cancelled.");
        process.exit(0);
      }
    }

    const pm = detectPackageManager();
    const installTarget = fromTar ?? PACKAGE_NAME;
    const cmd = globalInstallCommand(pm, installTarget);
    const spinner = p.spinner();
    spinner.start(`Installing ${PACKAGE_NAME} globally...`);
    try {
      await runShellCommand(cmd);
      spinner.stop(pc.green("Installed globally."));
    } catch (err) {
      spinner.stop(pc.red("Installation failed."));
      p.log.error(`${err}`);
      p.log.info(`Install argent manually with: ${pc.cyan(cmd)}`);
      process.exit(1);
    }
  } else {
    let latest: string | null = null;
    const spinner = p.spinner();
    spinner.start("Checking for updates...");
    try {
      latest = getLatestVersion();
    } catch {
      // Registry unreachable — silently skip
    }
    spinner.stop(pc.dim("Version check complete."));

    if (latest && latest !== version) {
      if (!nonInteractive) {
        const updateChoice = await p.select({
          message: `Update available: ${pc.yellow(`v${version}`)} → ${pc.green(`v${latest}`)}`,
          options: [
            {
              value: "update" as const,
              label: `Update to v${latest} (recommended)`,
            },
            {
              value: "skip" as const,
              label: "Skip",
              hint: "Continue with current version",
            },
          ],
        });

        if (!p.isCancel(updateChoice) && updateChoice === "update") {
          const pm = detectPackageManager();
          const cmd = globalInstallCommand(pm, `${PACKAGE_NAME}@${latest}`);
          const updateSpinner = p.spinner();
          updateSpinner.start(`Updating to v${latest}...`);
          try {
            await runShellCommand(cmd);
            updateSpinner.stop(pc.green(`Updated to v${latest}.`));
          } catch (err) {
            updateSpinner.stop(pc.red("Update failed."));
            p.log.error(`${err}`);
            p.log.info(`You can update manually later: ${pc.cyan(cmd)}`);
          }
        }
      }
    }
  }

  // ── Step 1: MCP Server Configuration ────────────────────────────────────────

  p.log.step(pc.bold("Step 1: MCP Server Configuration"));

  const detected = detectAdapters();
  const detectedNames = detected.map((a) => a.name);

  let selectedAdapters: McpConfigAdapter[];

  if (nonInteractive) {
    selectedAdapters = detected.length > 0 ? detected : ALL_ADAPTERS;
  } else {
    const choices = ALL_ADAPTERS.map((a) => ({
      value: a,
      label: a.name,
      hint: detectedNames.includes(a.name) ? "detected" : undefined,
    }));

    p.log.message(
      pc.dim("  Use arrow keys to move, space to toggle, enter to confirm."),
    );

    const selected = await p.multiselect({
      message: "Which editors should argent be configured for?",
      options: choices,
      initialValues: detected,
      required: true,
    });

    if (p.isCancel(selected)) {
      p.cancel("Initialization cancelled.");
      process.exit(0);
    }

    selectedAdapters = selected as McpConfigAdapter[];
  }

  p.log.info(
    `Editors: ${selectedAdapters.map((a) => pc.cyan(a.name)).join(", ")}`,
  );

  // Ask scope: global or local
  let scope: "local" | "global";

  if (nonInteractive) {
    scope = "global";
  } else {
    p.log.message(
      pc.dim("  Use arrow keys to move, enter to confirm."),
    );

    const scopeChoice = await p.select({
      message: "Install MCP server globally or locally?",
      options: [
        {
          value: "global" as const,
          label: "Global",
          hint: "Available across all projects (~/.*/mcp.json)",
        },
        {
          value: "local" as const,
          label: "Local",
          hint: "Current project only (.cursor/mcp.json, .mcp.json, ...)",
        },
      ],
    });

    if (p.isCancel(scopeChoice)) {
      p.cancel("Initialization cancelled.");
      process.exit(0);
    }

    scope = scopeChoice as "local" | "global";
  }

  const projectRoot = process.cwd();
  const mcpEntry = getMcpEntry();
  const mcpResults: string[] = [];

  for (const adapter of selectedAdapters) {
    const configPath =
      scope === "global"
        ? adapter.globalPath()
        : adapter.projectPath(projectRoot);

    if (!configPath) {
      if (scope === "global" && adapter.projectPath(projectRoot)) {
        const fallback = adapter.projectPath(projectRoot)!;
        try {
          adapter.write(fallback, mcpEntry);
          mcpResults.push(
            `${pc.green("+")} ${adapter.name} ${pc.dim(`(local fallback: ${fallback})`)}`,
          );
        } catch (err) {
          mcpResults.push(
            `${pc.red("x")} ${adapter.name}: ${pc.dim(String(err))}`,
          );
        }
      } else {
        mcpResults.push(
          `${pc.yellow("-")} ${adapter.name} ${pc.dim("(no config path for this scope)")}`,
        );
      }
      continue;
    }

    try {
      adapter.write(configPath, mcpEntry);
      mcpResults.push(`${pc.green("+")} ${adapter.name} ${pc.dim(configPath)}`);
    } catch (err) {
      mcpResults.push(`${pc.red("x")} ${adapter.name}: ${pc.dim(String(err))}`);
    }
  }

  p.note(mcpResults.join("\n"), "MCP Configuration");

  // ── Tool Auto-Approval ────────────────────────────────────────────────────

  const adaptersWithAllowlist = selectedAdapters.filter((a) => a.addAllowlist);
  const adaptersWithoutAllowlist = selectedAdapters.filter(
    (a) => !a.addAllowlist,
  );

  let allowlistEnabled = false;

  if (adaptersWithAllowlist.length > 0) {
    p.log.info(
      `By default, editors ask for confirmation before running each MCP tool.\n` +
      `  Adding argent to the auto-approve allowlist lets tools run without\n` +
      `  repeated prompts. This is ${pc.cyan("recommended")} for a smooth experience.`,
    );

    if (nonInteractive) {
      allowlistEnabled = true;
    } else {
      p.log.message(
        pc.dim("  Press y for yes, n for no, enter to confirm."),
      );

      const allowlistChoice = await p.confirm({
        message: "Add argent tools to editor auto-approve lists? (recommended)",
        initialValue: true,
      });

      if (p.isCancel(allowlistChoice)) {
        p.cancel("Initialization cancelled.");
        process.exit(0);
      }

      allowlistEnabled = allowlistChoice as boolean;
    }
  }

  if (allowlistEnabled) {
    const allowlistResults: string[] = [];

    for (const adapter of adaptersWithAllowlist) {
      try {
        adapter.addAllowlist!(projectRoot, scope);
        allowlistResults.push(`${pc.green("+")} ${adapter.name}`);
      } catch (err) {
        allowlistResults.push(
          `${pc.red("x")} ${adapter.name}: ${pc.dim(String(err))}`,
        );
      }
    }

    for (const adapter of adaptersWithoutAllowlist) {
      allowlistResults.push(
        `${pc.yellow("-")} ${adapter.name} ${pc.dim("(no auto-approve API — configure manually)")}`,
      );
    }

    p.note(allowlistResults.join("\n"), "Tool Auto-Approval");
  }

  // ── Step 2: Skills Installation ─────────────────────────────────────────────

  p.log.step(pc.bold("Step 2: Skills Installation"));
  p.log.warn(
    pc.yellow(
      "Skills installation is required for argent to function properly.",
    ),
  );

  type SkillsMethod = "default" | "interactive" | "manual";
  let skillsMethod: SkillsMethod;

  if (nonInteractive) {
    skillsMethod = "default";
  } else {
    p.log.message(
      pc.dim("  Use arrow keys to move, enter to confirm."),
    );

    const choice = await p.select({
      message: "How would you like to install skills?",
      options: [
        {
          value: "default" as const,
          label: "Default (recommended)",
          hint: "Installs all skills automatically with npx skills",
        },
        {
          value: "interactive" as const,
          label: "Interactive",
          hint: "Full npx skills TUI — choose skills, agents, and method",
        },
        {
          value: "manual" as const,
          label: "Manual",
          hint: "Print instructions for manual installation",
        },
      ],
    });

    if (p.isCancel(choice)) {
      p.cancel("Initialization cancelled.");
      process.exit(0);
    }

    skillsMethod = choice as SkillsMethod;
  }

  if (skillsMethod === "manual") {
    p.note(
      [
        `Skills are bundled at:`,
        `  ${pc.cyan(SKILLS_DIR)}`,
        ``,
        `To install manually, copy them to your editor's skills directory:`,
        ``,
        `  ${pc.dim("# Claude Code")}`,
        `  cp -r ${SKILLS_DIR}/* ${scope === "global" ? "~/.claude/skills/" : ".claude/skills/"}`,
        ``,
        `  ${pc.dim("# Cursor")}`,
        `  cp -r ${SKILLS_DIR}/* ${scope === "global" ? "~/.cursor/skills/" : ".cursor/skills/"}`,
        ``,
        `  ${pc.dim("# Or use npx skills directly:")}`,
        `  npx skills add ${SKILLS_DIR}`,
      ].join("\n"),
      "Manual Skills Installation",
    );
  } else {
    const skillsArgs = ["skills", "add", SKILLS_DIR];

    if (scope === "global") {
      skillsArgs.push("-g");
    }

    if (skillsMethod === "default") {
      skillsArgs.push("--skill", "*", "-y");
    }

    p.log.info(
      `Running: ${pc.dim("npx")} ${pc.cyan(skillsArgs.join(" "))}`,
    );

    const spinner = p.spinner();
    if (skillsMethod === "default") {
      spinner.start("Installing skills...");
    }

    try {
      await runNpxSkills(skillsArgs, skillsMethod === "interactive");
      if (skillsMethod === "default") {
        spinner.stop("Skills installed.");
      }
    } catch (err) {
      if (skillsMethod === "default") {
        spinner.stop(pc.red("Skills installation failed."));
      }
      p.log.error(`Failed to run npx skills: ${err}`);
      p.log.info(
        `You can install skills manually:\n  npx ${skillsArgs.join(" ")}`,
      );
    }
  }

  // ── Step 3: Rules and Agents ────────────────────────────────────────────────

  p.log.step(pc.bold("Step 3: Rules & Agents"));

  const copyResults = copyRulesAndAgents(
    selectedAdapters,
    projectRoot,
    scope,
    RULES_DIR,
    AGENTS_DIR,
  );

  if (copyResults.length > 0) {
    p.note(copyResults.join("\n"), "Rules & Agents");
  } else {
    p.log.info(pc.dim("No rules or agents to copy for selected editors."));
  }

  // ── Summary ─────────────────────────────────────────────────────────────────

  const summaryLines = [
    `${pc.green("MCP server")} configured for ${selectedAdapters.map((a) => a.name).join(", ")} (${scope})`,
    `${pc.green("Auto-approve")} ${allowlistEnabled ? "enabled" : "skipped"}`,
    `${pc.green("Skills")} ${skillsMethod === "manual" ? "instructions printed" : "installed"}`,
    `${pc.green("Rules & agents")} ${copyResults.length > 0 ? "copied" : "n/a"}`,
  ];

  p.note(summaryLines.join("\n"), "Summary");
  p.outro(pc.green("argent is ready!"));
}

export function printBanner(): void {
  const lines = [
    " █████╗ ██████╗  ██████╗ ███████╗███╗   ██╗████████╗",
    "██╔══██╗██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝",
    "███████║██████╔╝██║  ███╗█████╗  ██╔██╗ ██║   ██║",
    "██╔══██║██╔══██╗██║   ██║██╔══╝  ██║╚██╗██║   ██║",
    "██║  ██║██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║",
    "╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝",
  ];

  const width = Math.max(...lines.map((l) => l.length));

  console.log();
  for (const line of lines) {
    console.log(line);
  }

  const attribution = "by Software Mansion";
  console.log(" ".repeat(width - attribution.length) + pc.dim(attribution));
  console.log();
}

function runNpxSkills(
  args: string[],
  interactive: boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
    const child = spawn(npxCmd, args, {
      stdio: interactive ? "inherit" : ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    let stdout = "";
    let stderr = "";

    if (!interactive) {
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
    }

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const output = [stderr, stdout].filter(Boolean).join("\n").trim();
        reject(
          new Error(
            output || `npx skills exited with code ${code}`,
          ),
        );
      }
    });

    child.on("error", reject);
  });
}
