#!/usr/bin/env node
/**
 * argent CLI — globally-installed entry point.
 *
 * Usage:
 *   argent mcp          Start the MCP stdio server (used by editors)
 *   argent init         Set up argent in a workspace (MCP + skills + rules)
 *   argent update       Check for updates, refresh configuration
 *   argent uninstall    Remove argent from a workspace
 *   argent bridge       [future] Execute tool-server commands via CLI
 */

import { PACKAGE_NAME } from "./cli/constants.js";
import { getInstalledVersion } from "./cli/utils.js";

const [, , command, ...rest] = process.argv;

function printHelp(): void {
  const version = getInstalledVersion() ?? "unknown";
  console.log(`
argent v${version}

Usage: argent <command> [options]

Commands:
  mcp         Start the MCP stdio server (used by editors)
  init        Initialize argent in the current workspace (MCP server + skills)
  update      Check for updates and refresh configuration
  uninstall   Remove argent configuration from the workspace
  bridge      [future] Execute tool-server commands via CLI

Options:
  --help, -h     Show this help message
  --version, -v  Show version

Run \`argent <command> --help\` for command-specific help.

Package: ${PACKAGE_NAME}
`);
}

async function main(): Promise<void> {
  switch (command) {
    case "mcp":
      return (await import("./mcp-server.js")).startMcpServer();
    case "init":
      return (await import("./cli/init.js")).init(rest);
    case "update":
      return (await import("./cli/update.js")).update(rest);
    case "uninstall":
      return (await import("./cli/uninstall.js")).uninstall(rest);
    case "bridge":
      return (await import("./cli/bridge.js")).bridge(rest);
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
