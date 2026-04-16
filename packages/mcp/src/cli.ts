#!/usr/bin/env node
/**
 * argent CLI — globally-installed entry point.
 *
 * Usage:
 *   argent mcp          Start the MCP stdio server (used by editors)
 *   argent init         Set up argent in a workspace (MCP + skills + rules)
 *   argent install      Alias for init
 *   argent update       Check for updates, refresh configuration
 *   argent uninstall    Remove argent from a workspace
 *   argent remove       Alias for uninstall
 */

import { PACKAGE_NAME } from "./cli/constants.js";
import { getInstalledVersion } from "./cli/utils.js";

const [, , command, ...rest] = process.argv;
const isMcpServer = command === "mcp";

process.on("uncaughtException", (err) => {
  process.stderr.write(`[argent] Uncaught exception: ${err.stack ?? err}\n`);
  if (!isMcpServer) process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  process.stderr.write(
    `[argent] Unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : reason}\n`
  );
  if (!isMcpServer) process.exit(1);
});

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
    case "install":
      return (await import("./cli/init.js")).init(rest);
    case "update":
      return (await import("./cli/update.js")).update(rest);
    case "uninstall":
    case "remove":
      return (await import("./cli/uninstall.js")).uninstall(rest);
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
