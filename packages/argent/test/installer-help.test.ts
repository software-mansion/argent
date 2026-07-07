import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INSTALLER_COMMAND_META,
  INSTALLER_COMMANDS,
  installerHelpRequested,
  isInstallerCommand,
  printInstallerHelp,
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

  // On destructive commands the match is deliberately lenient: a fat-fingered
  // help request must never fall through to the real uninstall (which, with no
  // `--yes`, opens the "Remove argent configuration…" confirm with Yes
  // pre-selected).
  it("is true for --help=<value> (a plausible fat-finger)", () => {
    expect(installerHelpRequested("uninstall", ["--help=foo"])).toBe(true);
    expect(installerHelpRequested("init", ["--help="])).toBe(true);
  });

  it("is true for case-insensitive help flags", () => {
    expect(installerHelpRequested("uninstall", ["--HELP"])).toBe(true);
    expect(installerHelpRequested("remove", ["-H"])).toBe(true);
    expect(installerHelpRequested("update", ["--Help=x"])).toBe(true);
  });

  it("is true for the bareword `help` as the first argument", () => {
    expect(installerHelpRequested("uninstall", ["help"])).toBe(true);
    expect(installerHelpRequested("init", ["HELP"])).toBe(true);
  });

  it("does not treat a bareword `help` in a later position as help", () => {
    // `--from help` names a package/tarball literally called `help`; it must
    // not be swallowed as a help request.
    expect(installerHelpRequested("init", ["--from", "help"])).toBe(false);
  });

  it("is false for a near-miss flag that only starts with --help", () => {
    // `--helpme` is not a help request (no `=`, not exactly `--help`).
    expect(installerHelpRequested("uninstall", ["--helpme"])).toBe(false);
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
    // A non-installer command must not be intercepted via the bareword either.
    expect(installerHelpRequested("run", ["help"])).toBe(false);
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

describe("printInstallerHelp", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  function render(command: (typeof INSTALLER_COMMANDS)[number]): string {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    printInstallerHelp(command);
    return logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
  }

  afterEach(() => {
    logSpy?.mockRestore();
  });

  it("prints the usage line and summary for every installer command", () => {
    for (const command of INSTALLER_COMMANDS) {
      const out = render(command);
      const meta = INSTALLER_COMMAND_META[command];
      expect(out).toContain(`Usage: ${meta.usage}`);
      expect(out).toContain(meta.summary);
      expect(out).toContain("Run `argent --help` for the full list of commands.");
    }
  });

  it("lists the real flags each command accepts", () => {
    // The point of `--help` is to tell the user which flags exist.
    const init = render("init");
    expect(init).toContain("Options:");
    expect(init).toContain("--yes, -y");
    expect(init).toContain("--no-telemetry");
    expect(init).toContain("--from <path>");

    const update = render("update");
    expect(update).toContain("--version <version>");
    expect(update).toContain("--no-telemetry");

    const uninstall = render("uninstall");
    expect(uninstall).toContain("Options:");
    expect(uninstall).toContain("--yes, -y");
  });

  it("points aliases at their target command instead of duplicating options", () => {
    const install = render("install");
    expect(install).toContain("Run `argent init --help` to see its options.");
    expect(install).not.toContain("Options:");

    const remove = render("remove");
    expect(remove).toContain("Run `argent uninstall --help` to see its options.");
    expect(remove).not.toContain("Options:");
  });

  it("only writes to stdout (no wizard / prompt / network)", () => {
    // The whole contract of the help path is that it is side-effect-free. This
    // asserts the function's sole observable effect is console.log; the
    // end-to-end guarantee (config left untouched) is covered in
    // cli-dispatch.test.ts.
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = printInstallerHelp("uninstall");
    expect(result).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("INSTALLER_COMMAND_META", () => {
  it("covers exactly the installer command set", () => {
    expect(Object.keys(INSTALLER_COMMAND_META).sort()).toEqual([...INSTALLER_COMMANDS].sort());
  });

  it("summaries have no trailing period (they are rendered inline in the top-level table)", () => {
    for (const command of INSTALLER_COMMANDS) {
      expect(INSTALLER_COMMAND_META[command].summary.endsWith(".")).toBe(false);
    }
  });

  it("aliases carry no own options and non-aliases carry at least one", () => {
    for (const command of INSTALLER_COMMANDS) {
      const meta = INSTALLER_COMMAND_META[command];
      if (meta.aliasOf) {
        expect(meta.options).toHaveLength(0);
        expect(isInstallerCommand(meta.aliasOf)).toBe(true);
      } else {
        expect(meta.options.length).toBeGreaterThan(0);
      }
    }
  });
});
