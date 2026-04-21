import * as p from "@clack/prompts";
import pc from "picocolors";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
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
  isNewerVersion,
  isOnline,
  isSkillsCliAvailable,
  detectPackageManager,
  globalInstallCommand,
  formatShellCommand,
  resolveProjectRoot,
  type ShellCommand,
} from "./utils.js";
import { refreshArgentSkills, formatSkillRefreshSummary } from "./skills.js";
import { PACKAGE_NAME, MCP_BINARY_NAME } from "./constants.js";

// Path segments used by temp package runners (npx, pnpm dlx, bunx, yarn dlx).
// When invoked via one of these, the runner prepends its cache .bin/ dir to PATH,
// so `which argent` succeeds even though argent is not permanently installed globally.
const TEMP_RUNNER_MARKERS = [
  "_npx",
  "/dlx-",
  "\\dlx-",
  "bun/install/cache",
  ".bun\\install\\cache",
];

function isGloballyInstalled(): boolean {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const binaryPath = execSync(`${cmd} ${MCP_BINARY_NAME}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return !TEMP_RUNNER_MARKERS.some((marker) => binaryPath.includes(marker));
  } catch {
    return false;
  }
}

function runShellCommand(cmd: ShellCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === "win32";
    const child = spawn(isWin ? `${cmd.bin}.cmd` : cmd.bin, cmd.args, {
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

  let version = getInstalledVersion() ?? "unknown";
  p.log.info(`${pc.dim("Package:")} ${PACKAGE_NAME}@${version}`);

  // ── Step 0: Install / Update Check ──────────────────────────────────────────

  const globallyInstalled = isGloballyInstalled();

  if (!globallyInstalled) {
    if (!nonInteractive) {
      const installChoice = await p.select({
        message: "Argent is not installed globally. Would you like to install it?",
        options: [
          {
            value: "global" as const,
            label: "Install globally",
            hint: "Makes the argent command available everywhere",
          },
          {
            value: "cancel" as const,
            label: "Cancel installation",
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
    const cmdStr = formatShellCommand(cmd);
    const spinner = p.spinner();
    spinner.start(`Installing ${PACKAGE_NAME} globally...`);
    try {
      await runShellCommand(cmd);
      spinner.stop(pc.green("Installed globally."));
      version = getInstalledVersion() ?? version;
    } catch (err) {
      spinner.stop(pc.red("Installation failed."));
      p.log.error(`${err}`);
      p.log.info(`Install Argent manually with: ${pc.cyan(cmdStr)}`);
      process.exit(1);
    }
  } else if (fromTar) {
    // --from flag: reinstall from the specified tarball/path
    const pm = detectPackageManager();
    const cmd = globalInstallCommand(pm, fromTar);
    const cmdStr = formatShellCommand(cmd);
    const spinner = p.spinner();
    spinner.start(`Installing from ${fromTar}...`);
    try {
      await runShellCommand(cmd);
      spinner.stop(pc.green("Installed from tarball."));
      version = getInstalledVersion() ?? version;
    } catch (err) {
      spinner.stop(pc.red("Installation failed."));
      p.log.error(`${err}`);
      p.log.info(`Install manually with: ${pc.cyan(cmdStr)}`);
      process.exit(1);
    }
  } else {
    let latest: string | null = null;
    const spinner = p.spinner();
    spinner.start("Checking for updates...");
    try {
      latest = getLatestVersion();
    } catch {
      // Registry unreachable - silently skip
    }
    spinner.stop(pc.dim("Version check complete."));

    if (latest && isNewerVersion(latest, version)) {
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
          const cmdStr = formatShellCommand(cmd);
          const updateSpinner = p.spinner();
          updateSpinner.start(`Updating to v${latest}...`);
          try {
            await runShellCommand(cmd);
            updateSpinner.stop(pc.green(`Updated to v${latest}.`));
            version = getInstalledVersion() ?? version;

            // The user just bumped to a newer argent. Re-sync and prune
            // argent skills in every scope that already tracks them — this
            // is the only point in init where we can surface orphans
            // (skills removed from a previous argent version) before
            // Step 2's single-scope `skills add`.
            const skillSummary = formatSkillRefreshSummary(
              refreshArgentSkills(resolveProjectRoot(process.cwd()))
            );
            if (skillSummary) {
              p.note(skillSummary, "Skills Updated");
            }
          } catch (err) {
            updateSpinner.stop(pc.red("Update failed."));
            p.log.error(`${err}`);
            p.log.info(`You can update manually later: ${pc.cyan(cmdStr)}`);
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

    if (p.isCancel(selected)) {
      p.cancel("Initialization cancelled.");
      process.exit(0);
    }

    selectedAdapters = selected as McpConfigAdapter[];
  }

  p.log.info(`Editors: ${selectedAdapters.map((a) => pc.cyan(a.name)).join(", ")}`);

  // Ask scope: global, local, or custom path
  let scope: "local" | "global" | "custom";
  let customRoot: string | undefined;

  if (nonInteractive) {
    scope = "local";
  } else {
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

    if (p.isCancel(scopeChoice)) {
      p.cancel("Initialization cancelled.");
      process.exit(0);
    }

    scope = scopeChoice as "local" | "global" | "custom";

    if (scope === "custom") {
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

      customRoot = resolve((customPathInput as string).trim());
    }
  }

  const projectRoot = resolveProjectRoot(process.cwd());
  const effectiveRoot = scope === "custom" ? customRoot! : projectRoot;
  const normalizedScope: "local" | "global" = scope === "global" ? "global" : "local";
  const mcpEntry = getMcpEntry();
  const mcpResults: string[] = [];

  for (const adapter of selectedAdapters) {
    const configPath =
      scope === "global" ? adapter.globalPath() : adapter.projectPath(effectiveRoot);

    if (!configPath) {
      if (scope === "global" && adapter.projectPath(projectRoot)) {
        const fallback = adapter.projectPath(projectRoot)!;
        try {
          adapter.write(fallback, mcpEntry);
          mcpResults.push(
            `${pc.green("+")} ${adapter.name} ${pc.dim(`(local fallback: ${fallback})`)}`
          );
        } catch (err) {
          mcpResults.push(`${pc.red("x")} ${adapter.name}: ${pc.dim(String(err))}`);
        }
      } else if (scope !== "global" && adapter.globalPath()) {
        const fallback = adapter.globalPath()!;
        try {
          adapter.write(fallback, mcpEntry);
          mcpResults.push(
            `${pc.green("+")} ${adapter.name} ${pc.dim(`(global fallback: ${fallback})`)}`
          );
        } catch (err) {
          mcpResults.push(`${pc.red("x")} ${adapter.name}: ${pc.dim(String(err))}`);
        }
      } else {
        mcpResults.push(
          `${pc.yellow("-")} ${adapter.name} ${pc.dim("(no config path for this scope)")}`
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
  const adaptersWithoutAllowlist = selectedAdapters.filter((a) => !a.addAllowlist);

  let allowlistEnabled = false;

  if (adaptersWithAllowlist.length > 0) {
    p.log.info(
      `By default, editors ask for confirmation before running each MCP tool.\n` +
        `  Adding Argent to the auto-approve allowlist lets tools run without\n` +
        `  repeated prompts. This is ${pc.cyan("recommended")} for a smooth experience.`
    );

    if (nonInteractive) {
      allowlistEnabled = true;
    } else {
      p.log.message(pc.dim("  Press y for yes, n for no, enter to confirm."));

      const allowlistChoice = await p.confirm({
        message: "Add Argent tools to editor auto-approve lists? - recommended",
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
      const hasPath =
        normalizedScope === "global" ? adapter.globalPath() : adapter.projectPath(effectiveRoot);
      if (!hasPath) {
        allowlistResults.push(
          `${pc.yellow("-")} ${adapter.name} ${pc.dim("(no config for this scope)")}`
        );
        continue;
      }
      try {
        adapter.addAllowlist!(effectiveRoot, normalizedScope);
        allowlistResults.push(`${pc.green("+")} ${adapter.name}`);
      } catch (err) {
        allowlistResults.push(`${pc.red("x")} ${adapter.name}: ${pc.dim(String(err))}`);
      }
    }

    for (const adapter of adaptersWithoutAllowlist) {
      allowlistResults.push(
        `${pc.yellow("-")} ${adapter.name} ${pc.dim("(no auto-approve API - configure manually)")}`
      );
    }

    p.note(allowlistResults.join("\n"), "Tool Auto-Approval");
  }

  // ── Step 2: Skills Installation ─────────────────────────────────────────────

  p.log.step(pc.bold("Step 2: Skills Installation"));
  p.log.warn(pc.yellow("Skills installation is required for Argent to function properly."));

  type SkillsMethod = "default" | "interactive" | "manual";
  let skillsMethod: SkillsMethod;

  const online = await isOnline();
  const offlineWithCache = !online && isSkillsCliAvailable();
  const skillsCliReady = online || offlineWithCache;

  if (!skillsCliReady) {
    p.log.warn(
      pc.yellow("You appear to be offline. ") +
        "Automatic skills installation requires a network connection."
    );
  }

  if (!skillsCliReady) {
    skillsMethod = "manual";
  } else if (nonInteractive) {
    skillsMethod = "default";
  } else {
    p.log.message(pc.dim("  Use arrow keys to move, enter to confirm."));

    const choice = await p.select({
      message: "How would you like to install skills?",
      options: [
        {
          value: "default" as const,
          label: "Automatic",
          hint: "Installs all skills automatically with npx skills",
        },
        {
          value: "interactive" as const,
          label: "Interactive",
          hint: "Full npx skills TUI - choose skills, agents, and method",
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
        `  cp -r ${SKILLS_DIR}/* ${scope === "global" ? "~/.claude/skills/" : `${scope === "custom" ? customRoot! : "."}/.claude/skills/`}`,
        ``,
        `  ${pc.dim("# Cursor")}`,
        `  cp -r ${SKILLS_DIR}/* ${scope === "global" ? "~/.cursor/skills/" : `${scope === "custom" ? customRoot! : "."}/.cursor/skills/`}`,
        ``,
        `  ${pc.dim("# Or use npx skills directly:")}`,
        `  npx skills add ${SKILLS_DIR}`,
      ].join("\n"),
      "Manual Skills Installation"
    );
  } else {
    const skillsArgs = ["skills", "add", SKILLS_DIR];

    if (scope === "global") {
      skillsArgs.push("-g");
    }

    if (skillsMethod === "default") {
      skillsArgs.push("--skill", "*", "-y");
    }

    const npxArgs = offlineWithCache ? ["--no-install", ...skillsArgs] : skillsArgs;

    p.log.info(`Running: ${pc.dim("npx")} ${pc.cyan(npxArgs.join(" "))}`);

    const spinner = p.spinner();
    if (skillsMethod === "default") {
      spinner.start("Installing skills...");
    }

    try {
      const skillsCwd = scope === "custom" ? customRoot : undefined;
      await runNpxSkills(npxArgs, skillsMethod === "interactive", skillsCwd);
      if (skillsMethod === "default") {
        spinner.stop("Skills installed.");
      }
    } catch (err) {
      if (skillsMethod === "default") {
        spinner.stop(pc.red("Skills installation failed."));
      }
      p.log.error(`Failed to run npx skills: ${err}`);
      p.log.info(`You can install skills manually:\n  npx ${skillsArgs.join(" ")}`);
    }
  }

  // ── Step 3: Rules and Agents ────────────────────────────────────────────────

  p.log.step(pc.bold("Step 3: Rules & Agents"));

  const copyResults = copyRulesAndAgents(
    selectedAdapters,
    effectiveRoot,
    normalizedScope,
    RULES_DIR,
    AGENTS_DIR
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

  p.note(
    [
      pc.bold(pc.green("Argent is ready!")),
      "",
      `${pc.bold("Get started")} by asking your assistant:`,
      "",
      `   ${pc.bold(pc.cyan(`"What can Argent do?"`))}`,
      "",
      pc.dim("It will walk you through all capabilities available."),
    ].join("\n"),
    pc.bgGreen(pc.black(" Get Started "))
  );
  p.outro("");
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

function runNpxSkills(args: string[], interactive: boolean, cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
    const child = spawn(npxCmd, args, {
      stdio: interactive ? "inherit" : ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      ...(cwd ? { cwd } : {}),
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
        reject(new Error(output || `npx skills exited with code ${code}`));
      }
    });

    child.on("error", reject);
  });
}
