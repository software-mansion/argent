import * as p from "@clack/prompts";
import pc from "picocolors";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  detectAdapters,
  ALL_ADAPTERS,
  getMcpEntry,
  copyRulesAndAgents,
  type McpConfigAdapter,
  type McpEntryMode,
} from "./mcp-configs.js";
import {
  SKILLS_DIR,
  RULES_DIR,
  AGENTS_DIR,
  getInstalledVersion,
  getLatestVersion,
  getLocallyInstalledVersion,
  isGloballyInstalled,
  isLocallyInstalled,
  isYarnPnp,
  hasPackageJson,
  isNewerVersion,
  isOnline,
  isSkillsCliAvailable,
  detectPackageManager,
  globalInstallCommand,
  localDevInstallCommand,
  formatShellCommand,
  resolveProjectRoot,
  type ShellCommand,
} from "./utils.js";
import { refreshArgentSkills, formatSkillRefreshSummary } from "./skills.js";
import { PACKAGE_NAME } from "./constants.js";

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

// Discriminates the install topology chosen at Step 0 — drives MCP entry
// shape, scope override, and adapter filtering for the rest of the flow.
type InstallMode = "global" | "local";

export async function init(args: string[]): Promise<void> {
  const nonInteractive = args.includes("--yes") || args.includes("-y");
  const fromTar = extractFlag(args, "--from");
  // `--devdep` (alias `--local-install`) selects the "local devDependency"
  // install topology non-interactively. Designed for teams that want to
  // commit their MCP config alongside the package.json change so every
  // teammate gets the same argent version after `npm install`.
  const devdepFlagRequested = args.includes("--devdep") || args.includes("--local-install");
  const explicitGlobalScope = (() => {
    const idx = args.indexOf("--scope");
    if (idx === -1 || idx + 1 >= args.length) return false;
    return args[idx + 1] === "global";
  })();
  if (devdepFlagRequested && explicitGlobalScope) {
    process.stderr.write(
      `${pc.red("error")}: --devdep is incompatible with --scope global ` +
        "(local installs must use the project-scoped MCP config).\n"
    );
    process.exit(1);
  }

  printBanner();

  p.intro(pc.bgCyan(pc.black(" argent init ")));

  let version = getInstalledVersion() ?? "unknown";
  p.log.info(`${pc.dim("Package:")} ${PACKAGE_NAME}@${version}`);

  // ── Step 0: Install / Update Check ──────────────────────────────────────────

  const globallyInstalled = isGloballyInstalled();
  // Resolve project root once — needed for the local install check, the
  // PnP probe, and for the Step-1 MCP entry construction. We use the same
  // resolution rules as the rest of init so the choices stay consistent.
  const projectRoot = resolveProjectRoot(process.cwd());
  const locallyInstalled = isLocallyInstalled(projectRoot);

  let installMode: InstallMode;
  if (devdepFlagRequested) {
    installMode = "local";
  } else if (locallyInstalled && !globallyInstalled) {
    // A devDep is already on disk but nothing global — assume the user
    // re-running init wants to refresh the existing local setup, not
    // suddenly switch to a global install. Stays opt-in: the prompt below
    // still appears the first time, and `--devdep` is still the canonical
    // non-interactive selector.
    installMode = "local";
  } else {
    installMode = "global";
  }

  if (!globallyInstalled && !locallyInstalled) {
    if (!nonInteractive) {
      // Loop so the Local-mode confirm step can route the user back to
      // the install-mode select instead of forcing them to abort init
      // and start over. Only Esc/Ctrl+C (p.isCancel) actually cancels.
      while (true) {
        const installChoice = await p.select({
          message: "Argent isn't installed yet. How would you like to set it up?",
          // Global is the recommended default — it's the broadest
          // install topology and works for every workflow. Local is
          // offered as an opt-in for teams that want to commit their
          // argent version + MCP config alongside the rest of the
          // project.
          initialValue: "global" as const,
          options: [
            {
              value: "global" as const,
              label: "Global (recommended)",
              hint: "Makes the argent command available everywhere",
            },
            {
              value: "local" as const,
              label: "Local (devDependency)",
              hint: "Might be used by teams to share configuration",
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

        // Surface the cross-editor relative-path caveat only after the
        // user has picked Local. The vast majority of users go global
        // and never see this; for the team-share path we add a single
        // confirm prompt so the caveat lands as decision context, not
        // noise.
        if (installChoice === "local") {
          p.log.warn(
            `Only Claude Code formally documents project-relative MCP command paths ` +
              `(via ${pc.cyan("${CLAUDE_PROJECT_DIR}")}). For Cursor, VS Code, Zed, ` +
              `Codex, opencode, and Gemini the recipe relies on the MCP client ` +
              `launching the server from the project root — supported in practice ` +
              `but not contractually guaranteed. If a teammate's editor fails to ` +
              `start argent, verify its working directory first.`
          );

          p.log.message(pc.dim("  Press y for yes, n for no, enter to confirm."));
          const confirmLocal = await p.confirm({
            message: "Proceed with the Local devDependency install?",
            initialValue: true,
          });
          if (p.isCancel(confirmLocal)) {
            // Esc / Ctrl+C — treat as a hard cancel.
            p.cancel("Installation cancelled.");
            process.exit(0);
          }
          if (!confirmLocal) {
            // User backed out of Local — re-prompt the install mode.
            continue;
          }
        }

        installMode = installChoice;
        break;
      }
    }

    if (installMode === "local") {
      // Refuse early when the workspace can't host a devDep — better than
      // letting `npm install` fail with a noisy stack a step later.
      if (!hasPackageJson(projectRoot)) {
        p.log.error(
          `No package.json found at ${pc.dim(projectRoot)}.\n` +
            `  Run ${pc.cyan("npm init -y")} first, then re-run ${pc.cyan("argent init --devdep")}.`
        );
        process.exit(1);
      }
      if (isYarnPnp(projectRoot)) {
        p.log.error(
          `Yarn PnP detected (.pnp.cjs at ${pc.dim(projectRoot)}).\n` +
            `  The devDep flow needs a real node_modules/.bin directory.\n` +
            `  Switch to ${pc.cyan('nodeLinker: "node-modules"')} in .yarnrc.yml or ` +
            `re-run with ${pc.cyan("argent init")} for a global install.`
        );
        process.exit(1);
      }

      const pm = detectPackageManager();
      const installTarget = fromTar ?? PACKAGE_NAME;
      const cmd = localDevInstallCommand(pm, installTarget);
      const cmdStr = formatShellCommand(cmd);
      const spinner = p.spinner();
      spinner.start(`Installing ${PACKAGE_NAME} as a devDependency...`);
      try {
        await runShellCommand(cmd);
        spinner.stop(pc.green("Installed as devDependency."));
        // Read from the freshly-installed local copy, not the running
        // module — when init is invoked via `npx`, getInstalledVersion()
        // would still report the npx cache version.
        version = getLocallyInstalledVersion(projectRoot) ?? version;
      } catch (err) {
        spinner.stop(pc.red("Installation failed."));
        p.log.error(`${err}`);
        p.log.info(`Install Argent manually with: ${pc.cyan(cmdStr)}`);
        process.exit(1);
      }
    } else {
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
    }
  } else if (installMode === "local" && !locallyInstalled) {
    // `--devdep` was requested but only the global binary is present. Run
    // the local install on top of what's already there — both can coexist.
    if (!hasPackageJson(projectRoot)) {
      p.log.error(
        `No package.json found at ${pc.dim(projectRoot)}.\n` +
          `  Run ${pc.cyan("npm init -y")} first, then re-run ${pc.cyan("argent init --devdep")}.`
      );
      process.exit(1);
    }
    if (isYarnPnp(projectRoot)) {
      p.log.error(
        `Yarn PnP detected (.pnp.cjs at ${pc.dim(projectRoot)}).\n` +
          `  The devDep flow needs a real node_modules/.bin directory.`
      );
      process.exit(1);
    }
    const pm = detectPackageManager();
    const installTarget = fromTar ?? PACKAGE_NAME;
    const cmd = localDevInstallCommand(pm, installTarget);
    const spinner = p.spinner();
    spinner.start(`Installing ${PACKAGE_NAME} as a devDependency...`);
    try {
      await runShellCommand(cmd);
      spinner.stop(pc.green("Installed as devDependency."));
      // See sibling branch above — read the freshly-installed local
      // package.json so npx-cache invocations report the right version.
      version = getLocallyInstalledVersion(projectRoot) ?? version;
    } catch (err) {
      spinner.stop(pc.red("Installation failed."));
      p.log.error(`${err}`);
      process.exit(1);
    }
  } else if (installMode === "global" && fromTar) {
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
  } else if (installMode === "global") {
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

  if (installMode === "local") {
    // The cross-editor relative-path caveat is surfaced at the Step-0
    // prompt where the user actually picks the mode — see above.
    p.log.info(
      `${pc.dim("Mode:")} Local devDependency — argent is pinned in ${pc.cyan("package.json")}, ` +
        `MCP configs point at ${pc.cyan("./node_modules/.bin/argent")}.\n` +
        `  Commit the changed files (package.json, lockfile, MCP configs) so the team shares this setup.`
    );
  }

  // In local-install mode, restrict the adapter universe to ones that have
  // a project-scoped config file. Windsurf/Hermes are global-only and
  // would force the user to fall back to a global install anyway.
  const adapterUniverse =
    installMode === "local"
      ? ALL_ADAPTERS.filter((a) => a.acceptsLocalInstall !== false)
      : ALL_ADAPTERS;
  const detected = detectAdapters().filter((a) => adapterUniverse.includes(a));
  const detectedNames = detected.map((a) => a.name);

  if (installMode === "local") {
    const dropped = ALL_ADAPTERS.filter((a) => a.acceptsLocalInstall === false);
    if (dropped.length > 0) {
      p.log.info(
        pc.dim(
          `Skipping ${dropped.map((a) => a.name).join(", ")} ` +
            `(global-only — no project config file to commit).`
        )
      );
    }
  }

  let selectedAdapters: McpConfigAdapter[];

  if (nonInteractive) {
    selectedAdapters = detected.length > 0 ? detected : adapterUniverse;
  } else {
    const choices = adapterUniverse.map((a) => {
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

  if (installMode === "local") {
    // The committed config has to live next to the package.json so every
    // teammate's checkout picks it up. The scope prompt would only have one
    // legitimate answer in this mode, so skip it.
    scope = "local";
  } else if (nonInteractive) {
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

  const effectiveRoot = scope === "custom" ? customRoot! : projectRoot;
  const normalizedScope: "local" | "global" = scope === "global" ? "global" : "local";
  // MCP entry shape depends on install topology AND target adapter (Claude
  // Code expands `${CLAUDE_PROJECT_DIR}`, the others use a plain relative
  // path), so it has to be constructed per-adapter inside the loop.
  const entryMode: McpEntryMode =
    installMode === "local" ? { kind: "local", projectRoot: effectiveRoot } : { kind: "global" };
  const mcpResults: string[] = [];

  for (const adapter of selectedAdapters) {
    const mcpEntry = getMcpEntry(entryMode, adapter);
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

  const scopeLabel = installMode === "local" ? "local devDependency" : scope;
  const summaryLines = [
    `${pc.green("MCP server")} configured for ${selectedAdapters.map((a) => a.name).join(", ")} (${scopeLabel})`,
    `${pc.green("Auto-approve")} ${allowlistEnabled ? "enabled" : "skipped"}`,
    `${pc.green("Skills")} ${skillsMethod === "manual" ? "instructions printed" : "installed"}`,
    `${pc.green("Rules & agents")} ${copyResults.length > 0 ? "copied" : "n/a"}`,
  ];

  p.note(summaryLines.join("\n"), "Summary");

  if (installMode === "local") {
    p.note(
      [
        pc.bold("Commit these so the team shares the setup:"),
        `  • ${pc.cyan("package.json")}  ${pc.dim("(devDependency entry)")}`,
        `  • ${pc.cyan("package-lock.json / pnpm-lock.yaml / yarn.lock / bun.lock")}  ${pc.dim("(pin)")}`,
        `  • the per-editor MCP config files written above`,
        `  • optionally ${pc.cyan(".claude/")}, ${pc.cyan(".cursor/")} etc. for the skills/rules`,
      ].join("\n"),
      "Team Share"
    );
  }

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
  p.outro("Done.");
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
