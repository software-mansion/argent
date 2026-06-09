import * as p from "@clack/prompts";
import pc from "picocolors";
import { execFileSync } from "node:child_process";
import semver from "semver";
import { init as telemetryInit, track } from "@argent/telemetry";
import {
  ALL_ADAPTERS,
  findConfiguredAdapterScopes,
  getMcpEntry,
  copyRulesAndAgents,
  type McpConfigAdapter,
} from "./mcp-configs.js";
import {
  getGloballyInstalledVersion,
  isGloballyInstalled,
  isNewerVersion,
  detectPackageManager,
  globalInstallCommand,
  formatShellCommand,
  resolveProjectRoot,
  RULES_DIR,
  AGENTS_DIR,
} from "./utils.js";
import { refreshArgentSkills, formatSkillRefreshSummary } from "./skills.js";
import { PACKAGE_NAME } from "./constants.js";
import { resolveInstallableUpdateTarget } from "./update-target.js";
import { killToolServer } from "@argent/tools-client";
import { finalizeTelemetry } from "./telemetry-finalize.js";

function getRequestedVersion(args: string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--version") {
      return args[i + 1] ?? null;
    }
    if (arg?.startsWith("--version=")) {
      return arg.slice("--version=".length) || null;
    }
  }
  return null;
}

type UpdateTrigger = "update" | "mcp_update";
type UpdatePackageAction = "standalone_update" | "standalone_install" | "mcp_update";

export function getUpdateTriggerFromEnv(env: NodeJS.ProcessEnv = process.env): UpdateTrigger {
  return env.ARGENT_UPDATE_TRIGGER === "mcp_update" ? "mcp_update" : "update";
}

export function resolveUpdatePackageAction(
  trigger: UpdateTrigger,
  installed: string | null
): UpdatePackageAction {
  if (trigger === "mcp_update") return "mcp_update";
  return installed ? "standalone_update" : "standalone_install";
}

export async function update(args: string[]): Promise<void> {
  const nonInteractive = args.includes("--yes") || args.includes("-y");
  const requestedVersion = getRequestedVersion(args);
  const trigger = getUpdateTriggerFromEnv();
  telemetryInit("installer");
  const updateStartTime = performance.now();
  track("installation:cli_update_start", {});
  let telemetryFinalized = false;

  const trackPackageAction = async (
    action: UpdatePackageAction | "no_update" | "update_skipped" | "update_failed",
    startedAt: number,
    isSuccess: boolean
  ): Promise<void> => {
    track("installation:package_action", {
      trigger,
      action,
      is_success: isSuccess,
      duration_ms: performance.now() - startedAt,
    });
  };

  const failUpdateTelemetry = async (): Promise<void> => {
    if (telemetryFinalized) return;
    telemetryFinalized = true;
    await finalizeTelemetry(() => {
      track("installation:cli_update_fail", {
        duration_ms: performance.now() - updateStartTime,
      });
    });
  };

  const completeUpdateTelemetry = async (): Promise<void> => {
    if (telemetryFinalized) return;
    telemetryFinalized = true;
    await finalizeTelemetry(() => {
      track("installation:cli_update_complete", {
        duration_ms: performance.now() - updateStartTime,
      });
    });
  };

  try {
    p.intro(pc.bgCyan(pc.black(" argent update ")));

    // When invoked via `npx @swmansion/argent update`, the running package is
    // the npx cache and will always be at the latest published version. Reading the
    // version from PACKAGE_ROOT would falsely report "already on the latest"
    // both when no global install exists AND when the global install is
    // outdated. getGloballyInstalledVersion() resolves the *real* global
    // binary's package.json, so the compare reflects what the user has
    // installed rather than what npx just downloaded.
    const globallyInstalled = isGloballyInstalled();
    const installed = globallyInstalled ? getGloballyInstalledVersion() : null;

    if (globallyInstalled && !installed) {
      await trackPackageAction("update_failed", updateStartTime, false);
      await failUpdateTelemetry();
      p.log.error("Could not determine installed version.");
      process.exit(1);
    }

    const spinner = p.spinner();
    spinner.start("Checking for updates...");

    const pm = detectPackageManager();
    let latest: string | null = null;
    let target: string | null = null;
    let minReleaseAgeMs = 0;

    if (requestedVersion !== null) {
      if (!semver.valid(requestedVersion) || semver.prerelease(requestedVersion)) {
        spinner.stop(pc.red("Invalid update target."));
        await trackPackageAction("update_failed", updateStartTime, false);
        await failUpdateTelemetry();
        p.log.error(`Requested version is not a stable semver: ${requestedVersion}`);
        process.exit(1);
      }
      target = requestedVersion;
    } else {
      let resolved;
      try {
        resolved = await resolveInstallableUpdateTarget(pm, installed);
      } catch (err) {
        spinner.stop(pc.red("Could not reach registry."));
        await trackPackageAction("update_failed", updateStartTime, false);
        await failUpdateTelemetry();
        p.log.error(`Failed to check registry: ${err}`);
        process.exit(1);
      }

      if (resolved === null) {
        spinner.stop(pc.red("Could not reach registry."));
        await trackPackageAction("update_failed", updateStartTime, false);
        await failUpdateTelemetry();
        p.log.error("Failed to determine the latest Argent release from the registry.");
        process.exit(1);
      }

      latest = resolved.latestVersion;
      target = resolved.targetVersion;
      minReleaseAgeMs = resolved.minReleaseAgeMs;
    }

    spinner.stop("Version check complete.");

    if (installed) {
      p.log.info(`Installed: ${pc.cyan(`v${installed}`)}`);
    } else {
      p.log.warn(`${PACKAGE_NAME} is not installed globally.`);
    }
    if (latest) {
      p.log.info(`Latest:    ${pc.cyan(`v${latest}`)}`);
    }
    if (target) {
      const label = latest && latest !== target ? "Target:    " : "Version:   ";
      const suffix = latest && latest !== target ? pc.dim(" (newest installable)") : "";
      p.log.info(`${label}${pc.cyan(`v${target}`)}${suffix}`);
    }

    const needsInstall = target !== null && (!installed || isNewerVersion(target, installed));
    const latestIsNewer = latest !== null && (!installed || isNewerVersion(latest, installed));

    if (needsInstall && target !== null) {
      if (installed) {
        p.log.warn(`Update available: ${pc.yellow(`v${installed}`)} -> ${pc.green(`v${target}`)}`);
      }

      const cmd = globalInstallCommand(pm, `${PACKAGE_NAME}@${target}`);
      const cmdStr = formatShellCommand(cmd);

      if (!nonInteractive) {
        p.log.message(pc.dim("  Press y for yes, n for no, enter to confirm."));

        const proceed = await p.confirm({
          message: installed
            ? `Update to v${target}?`
            : `Install ${PACKAGE_NAME}@${target} globally?`,
          initialValue: true,
        });

        if (p.isCancel(proceed) || !proceed) {
          await trackPackageAction("update_skipped", updateStartTime, true);
          await completeUpdateTelemetry();
          p.cancel(installed ? "Update cancelled." : "Install cancelled.");
          process.exit(0);
        }
      }

      p.log.info(`Running: ${pc.dim(cmdStr)}`);

      try {
        await killToolServer();
      } catch (err) {
        await trackPackageAction("update_failed", updateStartTime, false);
        await failUpdateTelemetry();
        p.log.error(`Could not stop the running tool server: ${err}`);
        process.exit(1);
      }

      const packageAction = resolveUpdatePackageAction(trigger, installed);
      const packageActionStartedAt = performance.now();
      try {
        execFileSync(cmd.bin, cmd.args, {
          stdio: "inherit",
          env: { ...process.env, ARGENT_SKIP_POSTINSTALL: "1" },
        });
      } catch (err) {
        await trackPackageAction(packageAction, packageActionStartedAt, false);
        await failUpdateTelemetry();
        p.log.error(`${installed ? "Update" : "Install"} failed: ${err}`);
        process.exit(1);
      }
      await trackPackageAction(packageAction, packageActionStartedAt, true);
    } else {
      await trackPackageAction("no_update", updateStartTime, true);
      if (latest && target === null && latestIsNewer && minReleaseAgeMs > 0) {
        p.log.warn(
          `Latest version ${pc.cyan(`v${latest}`)} is still held by your minimum-release-age policy.`
        );
        p.log.info("No installable update is available yet.");
      } else if (latest && target && latest !== target) {
        p.log.success("Already on the latest installable version.");
      } else {
        p.log.success("Already on the latest version.");
      }
    }

    // Refresh configuration
    spinner.start("Refreshing workspace configuration...");

    const projectRoot = resolveProjectRoot(process.cwd());
    const mcpEntry = getMcpEntry();
    const results: string[] = [];

    // Only refresh adapter scopes that already contain an argent entry. A
    // present editor dir (`.gemini`, `.cursor`, ...) is not consent — issue
    // #195 — so we look for the argent MCP server key in the actual config.
    const configuredScopes = findConfiguredAdapterScopes(ALL_ADAPTERS, projectRoot);
    const adaptersByScope = new Map<"local" | "global", Set<McpConfigAdapter>>([
      ["local", new Set()],
      ["global", new Set()],
    ]);

    for (const { adapter, scope, configPath } of configuredScopes) {
      try {
        adapter.write(configPath, mcpEntry);
        results.push(`${pc.green("+")} ${adapter.name} ${pc.dim(configPath)}`);
      } catch {
        // Skip paths that can't be written.
      }
      adaptersByScope.get(scope === "project" ? "local" : "global")!.add(adapter);
    }

    // Refresh allowlists only for scopes that already had argent configured —
    // matches the editor list above.
    for (const [scope, adapters] of adaptersByScope) {
      for (const adapter of adapters) {
        if (!adapter.addAllowlist) continue;
        try {
          adapter.addAllowlist(projectRoot, scope);
        } catch {
          // non-fatal
        }
      }
    }

    // Refresh rules/agents the same way: per-scope, only for adapters the user
    // opted into in that scope.
    const localAdapters = [...adaptersByScope.get("local")!];
    const globalAdapters = [...adaptersByScope.get("global")!];
    const ruleResults = [
      ...copyRulesAndAgents(globalAdapters, projectRoot, "global", RULES_DIR, AGENTS_DIR),
      ...copyRulesAndAgents(localAdapters, projectRoot, "local", RULES_DIR, AGENTS_DIR),
    ];

    spinner.stop("Configuration refreshed.");

    if (results.length > 0) {
      p.note(results.join("\n"), "MCP Configs Updated");
    }

    if (ruleResults.length > 0) {
      p.note(ruleResults.join("\n"), "Rules & Agents Updated");
    }

    const skillSummary = formatSkillRefreshSummary(refreshArgentSkills(projectRoot));
    if (skillSummary) {
      p.note(skillSummary, "Skills Updated");
    }

    await completeUpdateTelemetry();

    p.outro(pc.green("Update complete."));
  } catch (err) {
    await failUpdateTelemetry();
    throw err;
  }
}
