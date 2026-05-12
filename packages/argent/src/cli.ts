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
 *   argent server status|stop|logs   Manage the shared tool-server
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type * as Installer from "@argent/installer";
import type * as Mcp from "@argent/mcp";
import type * as Cli from "@argent/cli";
import { BUNDLED_RUNTIME_PATHS } from "./bundled-paths.js";
import { installFatalHandlers } from "./fatal-handlers.js";

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

function printHelp(): void {
  const version = getInstalledVersion() ?? "unknown";
  console.log(`
argent v${version}

Usage: argent <command> [options]

Commands:
  mcp         Start the MCP stdio server (used by editors)
  init        Initialize argent in the current workspace (MCP server + skills)
  install     Alias for init
  update      Check for updates and refresh configuration
  uninstall   Remove argent configuration from the workspace
  remove      Alias for uninstall
  tools       List tools exposed by the tool-server
  run         Invoke a tool by name (use \`argent run <tool> --help\` for flags)
  server      Manage the shared tool-server (status / stop / logs)

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await import("./installer.mjs" as any)) as typeof Installer;
}
async function loadMcp(): Promise<typeof Mcp> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await import("./mcp-server.mjs" as any)) as typeof Mcp;
}
async function loadCli(): Promise<typeof Cli> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await import("./cli-cmds.mjs" as any)) as typeof Cli;
}

async function main(): Promise<void> {
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
    case "server":
      return (await loadCli()).server(rest);
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
