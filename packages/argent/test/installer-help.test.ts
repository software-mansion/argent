import { describe, expect, it } from "vitest";
import {
  INSTALLER_COMMANDS,
  installerHelpRequested,
  isInstallerCommand,
} from "../src/installer-help.js";

// Guards the fix for #451: `argent <installer-cmd> --help` must short-circuit
// to help instead of forwarding `--help` to the side-effecting installer
// functions (which don't handle it and would run the real command — e.g.
// `uninstall --help` opening the destructive removal prompt).

describe("installerHelpRequested", () => {
  it("is true for every installer subcommand with --help", () => {
    for (const command of INSTALLER_COMMANDS) {
      expect(installerHelpRequested(command, ["--help"])).toBe(true);
    }
  });

  it("is true for the -h short flag", () => {
    expect(installerHelpRequested("uninstall", ["-h"])).toBe(true);
    expect(installerHelpRequested("remove", ["-h"])).toBe(true);
  });

  it("is true when the help flag trails other arguments", () => {
    expect(installerHelpRequested("init", ["--scope", "project", "--help"])).toBe(true);
    expect(installerHelpRequested("update", ["--foo", "-h"])).toBe(true);
  });

  it("is false for an installer subcommand without a help flag", () => {
    expect(installerHelpRequested("init", [])).toBe(false);
    expect(installerHelpRequested("uninstall", ["--yes"])).toBe(false);
    expect(installerHelpRequested("update", ["--check"])).toBe(false);
  });

  it("is false for non-installer commands even with --help (they handle it themselves)", () => {
    // `argent run <tool> --help` must still print the tool's own flags, and
    // likewise for tools/server/etc. — never intercepted here.
    expect(installerHelpRequested("run", ["--help"])).toBe(false);
    expect(installerHelpRequested("run", ["gesture-tap", "--help"])).toBe(false);
    expect(installerHelpRequested("tools", ["--help"])).toBe(false);
    expect(installerHelpRequested("server", ["-h"])).toBe(false);
    expect(installerHelpRequested("mcp", ["--help"])).toBe(false);
  });

  it("is false for an undefined command", () => {
    expect(installerHelpRequested(undefined, ["--help"])).toBe(false);
  });
});

describe("isInstallerCommand", () => {
  it("recognizes exactly the installer command set", () => {
    expect([...INSTALLER_COMMANDS].sort()).toEqual(
      ["init", "install", "remove", "uninstall", "update"].sort()
    );
    for (const command of INSTALLER_COMMANDS) {
      expect(isInstallerCommand(command)).toBe(true);
    }
  });

  it("rejects non-installer and undefined commands", () => {
    expect(isInstallerCommand("run")).toBe(false);
    expect(isInstallerCommand("mcp")).toBe(false);
    expect(isInstallerCommand(undefined)).toBe(false);
  });
});
