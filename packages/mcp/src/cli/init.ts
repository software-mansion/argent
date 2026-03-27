import * as p from "@clack/prompts";
import pc from "picocolors";
import { execSync, spawn } from "node:child_process";
import {
  detectAdapters,
  ALL_ADAPTERS,
  getMcpEntry,
  addClaudePermission,
  copyRulesAndAgents,
  type McpConfigAdapter,
} from "./mcp-configs.js";
import { SKILLS_DIR, RULES_DIR, AGENTS_DIR, getInstalledVersion } from "./utils.js";
import { PACKAGE_NAME } from "./constants.js";

export async function init(args: string[]): Promise<void> {
  const nonInteractive = args.includes("--yes") || args.includes("-y");

  printBanner();

  p.intro(pc.bgCyan(pc.black(" argent init ")));

  const version = getInstalledVersion() ?? "unknown";
  p.log.info(`${pc.dim("Package:")} ${PACKAGE_NAME}@${version}`);

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

  // Claude permissions
  const hasClaudeCode = selectedAdapters.some((a) => a.name === "Claude Code");
  if (hasClaudeCode) {
    try {
      addClaudePermission(projectRoot, scope);
      mcpResults.push(
        `${pc.green("+")} Claude Code permissions ${pc.dim("(mcp__argent)")}`,
      );
    } catch (err) {
      mcpResults.push(
        `${pc.red("x")} Claude permissions: ${pc.dim(String(err))}`,
      );
    }
  }

  p.note(mcpResults.join("\n"), "MCP Configuration");

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
    `${pc.green("Skills")} ${skillsMethod === "manual" ? "instructions printed" : "installed"}`,
    `${pc.green("Rules & agents")} ${copyResults.length > 0 ? "copied" : "n/a"}`,
  ];

  p.note(summaryLines.join("\n"), "Summary");
  p.outro(pc.green("argent is ready!"));
}

function printBanner(): void {
  const lines = [
    " █████  ██████   ██████  ███████ ███    ██ ████████",
    "██   ██ ██   ██ ██       ██      ████   ██    ██   ",
    "███████ ██████  ██   ███ █████   ██ ██  ██    ██   ",
    "██   ██ ██   ██ ██    ██ ██      ██  ██ ██    ██   ",
    "██   ██ ██   ██  ██████  ███████ ██   ████    ██   ",
  ];

  const width = Math.max(...lines.map((l) => l.length));
  const from = [232, 160, 72] as const;
  const to = [180, 72, 40] as const;

  console.log();
  for (let y = 0; y < lines.length; y++) {
    const line = lines[y];
    let output = "";
    for (let x = 0; x < line.length; x++) {
      if (line[x] === " ") {
        output += " ";
        continue;
      }
      const t = width > 1 ? (x / (width - 1) + y / (lines.length - 1)) / 2 : 0;
      const r = Math.round(from[0] + (to[0] - from[0]) * t);
      const g = Math.round(from[1] + (to[1] - from[1]) * t);
      const b = Math.round(from[2] + (to[2] - from[2]) * t);
      output += `\x1b[38;2;${r};${g};${b}m${line[x]}`;
    }
    console.log(output + "\x1b[0m");
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
