#!/usr/bin/env node
/**
 * argent CLI — globally-installed entry point.
 *
 * This dispatcher is intentionally minimal: it parses the top-level command,
 * lazy-imports the matching bundle, and forwards arguments. The actual
 * subcommand implementations live in sibling workspace packages and ship as
 * pre-bundled CJS files in dist/ alongside this dispatcher.
 *
 * Usage:
 *   argent mcp                    Start the MCP stdio server (used by editors)
 *   argent init                   Set up argent in a workspace (MCP + skills + rules)
 *   argent install                Alias for init
 *   argent update                 Check for updates, refresh configuration
 *   argent uninstall              Remove argent from a workspace
 *   argent remove                 Alias for uninstall
 *   argent tools                  List tools exposed by the tool-server
 *   argent tools describe <name>  Show one tool's flags
 *   argent run <tool> [flags]     Invoke a tool by name
 *   argent server start [flags]   Spawn a long-lived tool-server (foreground by default)
 *   argent server status|stop|logs   Manage the shared tool-server
 *   argent lens                   Open Argent Lens bound to a fresh coding-agent session (macOS)
 *   argent link [flags]           Route client requests to a remote tool-server
 *   argent unlink                 Remove the persisted remote link
 *   argent enable <flag>          Enable a feature flag (global by default)
 *   argent disable <flag>         Disable a feature flag (global by default)
 *   argent flags                  Show current feature-flag state
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type * as Installer from "@argent/installer";
import type * as Mcp from "@argent/mcp";
import type * as Cli from "@argent/cli";
import { BUNDLED_RUNTIME_PATHS } from "./bundled-paths.js";
import { installFatalHandlers } from "./fatal-handlers.js";
import {
  INSTALLER_COMMAND_META,
  installerHelpRequested,
  printInstallerHelp,
  type InstallerCommand,
} from "./installer-help.js";

const PACKAGE_NAME = "@swmansion/argent";

function getInstalledVersion(): string | null {
  try {
    // dist/cli.js lives in the published package's dist/, so two-up is the
    // package root containing the shipped package.json.
    const pkgPath = path.resolve(import.meta.dirname, "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

const [, , command, ...rest] = process.argv;
const isMcpServer = command === "mcp";

installFatalHandlers({ isMcpServer });

// One installer row of the command table: the command's one-line summary plus
// its indented detail lines, both from INSTALLER_COMMAND_META. The summary is
// shared with the per-command `--help`, so the two can't drift; the details
// are table-only prose kept in the meta so each command's help text lives in
// one place.
function installerHelpEntry(command: InstallerCommand): string {
  const meta = INSTALLER_COMMAND_META[command];
  const details = (meta.details ?? []).map((line) => `\n              ${line}`).join("");
  return `${meta.summary}${details}`;
}

function printHelp(): void {
  const version = getInstalledVersion() ?? "unknown";
  console.log(`
argent v${version}

Usage: argent <command> [options]

Commands:
  mcp         Start the MCP stdio server (used by editors)
  init        ${installerHelpEntry("init")}
  install     ${installerHelpEntry("install")}
  update      ${installerHelpEntry("update")}
  uninstall   ${installerHelpEntry("uninstall")}
  remove      ${installerHelpEntry("remove")}
  tools       List tools exposed by the tool-server
  run         Invoke a tool by name (use \`argent run <tool> --help\` for flags)
  flow        Run a saved flow (use \`argent flow --help\` for options)
  server      Manage the shared tool-server (start / status / stop / logs)
  lens        Open Argent Lens bound to a fresh coding-agent session (macOS)
  link        Route client requests to a remote tool-server
  unlink      Remove the persisted remote tool-server link
  enable      Enable a feature flag (global by default, --scope project for project)
  disable     Disable a feature flag (global by default, --scope project for project)
  flags       Show current feature-flag state
  config      Manage configuration (list / get / set / unset, project & global)
  telemetry   Manage opt-out telemetry (status / enable / disable)

Options:
  --help, -h     Show this help message
  --version, -v  Show version

Run \`argent <command> --help\` for command-specific help.

Package: ${PACKAGE_NAME}
`);
}

// Lazy-load each subcommand bundle. Bundles are produced at build time by
// scripts/bundle-tools.cjs and shipped alongside this dispatcher in dist/.
// Typed against the workspace packages so calls are still checked.
async function loadInstaller(): Promise<typeof Installer> {
  return (await import("./installer.mjs" as any)) as typeof Installer;
}
async function loadMcp(): Promise<typeof Mcp> {
  return (await import("./mcp-server.mjs" as any)) as typeof Mcp;
}
async function loadCli(): Promise<typeof Cli> {
  return (await import("./cli-cmds.mjs" as any)) as typeof Cli;
}

async function main(): Promise<void> {
  // The installer subcommands (init / install / update / uninstall / remove)
  // forward their argv straight to the side-effecting installer functions,
  // which do not short-circuit on `--help` — so `argent uninstall --help`
  // would run the real (destructive) command. Intercept help for exactly that
  // set before dispatching. All other subcommands handle `--help` themselves.
  if (installerHelpRequested(command, rest)) {
    // installerHelpRequested only returns true for an InstallerCommand.
    printInstallerHelp(command as Parameters<typeof printInstallerHelp>[0]);
    return;
  }

  switch (command) {
    case "mcp":
      return (await loadMcp()).startMcpServer({ paths: BUNDLED_RUNTIME_PATHS });
    case "init":
    case "install":
      return (await loadInstaller()).init(rest);
    case "update":
      return (await loadInstaller()).update(rest);
    case "uninstall":
    case "remove":
      return (await loadInstaller()).uninstall(rest);
    case "tools":
      return (await loadCli()).tools(rest, { paths: BUNDLED_RUNTIME_PATHS });
    case "run":
      return (await loadCli()).run(rest, { paths: BUNDLED_RUNTIME_PATHS });
    case "flow":
      return (await loadCli()).flow(rest, { paths: BUNDLED_RUNTIME_PATHS });
    case "server":
      return (await loadCli()).server(rest, { paths: BUNDLED_RUNTIME_PATHS });
    case "lens":
      return (await loadCli()).lens(rest, { paths: BUNDLED_RUNTIME_PATHS });
    case "link":
      return (await loadCli()).link(rest);
    case "unlink":
      return (await loadCli()).unlink(rest);
    case "enable":
      return (await loadCli()).enable(rest);
    case "disable":
      return (await loadCli()).disable(rest);
    case "flags":
      return (await loadCli()).flags(rest);
    case "config":
      return (await loadCli()).config(rest);
    case "telemetry":
      return (await loadCli()).telemetry(rest);
    case "--version":
    case "-v":
      console.log(getInstalledVersion() ?? "unknown");
      return;
    case "--help":
    case "-h":
    default:
      printHelp();
      if (command && command !== "--help" && command !== "-h") {
        process.exit(1);
      }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
