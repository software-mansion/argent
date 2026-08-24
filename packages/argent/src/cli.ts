#!/usr/bin/env node
/**
 * argent CLI entry point. Dispatch only: subcommand implementations live in the
 * sibling workspace packages (@argent/installer, @argent/mcp, @argent/cli) and
 * are lazy-imported from bundles in dist/.
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

// `summary` is shared with the per-command `--help` so the two can't drift;
// `details` are rendered only in this table.
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
  mcp         ${installerHelpEntry("mcp")}
  init        ${installerHelpEntry("init")}
  install     ${installerHelpEntry("install")}
  update      ${installerHelpEntry("update")}
  uninstall   ${installerHelpEntry("uninstall")}
  remove      ${installerHelpEntry("remove")}
  tools       List tools exposed by the tool-server
  run         Invoke a tool by name (use \`argent run <tool> --help\` for flags)
  flow        Run a flow by name or YAML path (use \`argent flow --help\` for options)
  server      Manage the shared tool-server (start / status / stop / logs)
  lens        Open Argent Lens bound to a fresh coding-agent session (macOS)
  link        Route client requests to a remote tool-server
  unlink      Remove the persisted remote tool-server link
  enable      Enable a feature flag (global by default, --scope project for project)
  disable     Disable a feature flag (global by default, --scope project for project)
  flags       Show current feature-flag state
  config      Manage configuration (list / get / set / unset, project & global)
  secrets     List the secrets a {{secret:NAME}} placeholder can type, and their sources
  telemetry   Manage opt-out telemetry (status / enable / disable)

Options:
  --help, -h     Show this help message
  --version, -v  Show version

Run \`argent <command> --help\` for command-specific help.

Package: ${PACKAGE_NAME}
`);
}

// The bundles are produced at build time by scripts/bundle-tools.cjs into dist/;
// typed against the workspace packages so calls are still checked.
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
  // The installers forward argv to side-effecting functions that ignore
  // `--help` (so `argent uninstall --help` would run the real, destructive
  // command), and `mcp` is handed no argv at all, so a help flag there starts
  // the stdio server and blocks on stdin. Every other subcommand parses
  // `--help` itself.
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
    case "secrets":
      return (await loadCli()).secrets(rest);
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
