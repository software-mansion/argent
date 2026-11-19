import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  classifyMcpEntry,
  findConfigured,
  renderDoctorReport,
  resolveDoctorRoot,
  stripPackageBinDirs,
  toolchainChecks,
  type DoctorCheck,
  type EntryContext,
} from "../src/doctor.js";

let projectRoot: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argent-doctor-"));
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

function ctx(overrides: Partial<EntryContext> = {}): EntryContext {
  return {
    projectRoot,
    globalOnPath: true,
    localInstalled: false,
    argentCommand: "argent",
    globalInstallFix: "npm install -g @swmansion/argent",
    projectInstallFix: "npm install",
    ...overrides,
  };
}

describe("classifyMcpEntry", () => {
  const bare = { command: "argent", args: ["mcp"] };

  it("accepts `argent mcp` when argent is on PATH", () => {
    expect(classifyMcpEntry(bare, ctx()).status).toBe("ok");
  });

  it("fails `argent mcp` when argent is not on PATH and points at the global install", () => {
    const result = classifyMcpEntry(bare, ctx({ globalOnPath: false }));
    expect(result.status).toBe("error");
    expect(result.fix).toBe("npm install -g @swmansion/argent");
  });

  it("only warns when the entry's own env may let the editor find argent", () => {
    const entry = { ...bare, env: { PATH: "/custom/bin" } };
    expect(classifyMcpEntry(entry, ctx({ globalOnPath: false })).status).toBe("warn");
  });

  it("checks a node entry's script relative to the project root", () => {
    const script = "node_modules/@swmansion/argent/dist/cli.js";
    const entry = { command: "node", args: [script, "mcp"] };
    const missing = classifyMcpEntry(entry, ctx());
    expect(missing.status).toBe("error");
    expect(missing.fix).toBe("npm install");

    fs.mkdirSync(path.dirname(path.join(projectRoot, script)), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, script), "");
    expect(classifyMcpEntry(entry, ctx()).status).toBe("ok");
  });

  it("needs a local or global install for `npx argent mcp` but not for the scoped package", () => {
    const local = { command: "npx", args: ["--no-install", "argent", "mcp"] };
    const nothing = ctx({ globalOnPath: false });
    expect(classifyMcpEntry(local, nothing).status).toBe("error");
    expect(classifyMcpEntry(local, { ...nothing, localInstalled: true }).status).toBe("ok");
    expect(classifyMcpEntry(local, ctx()).status).toBe("ok");
    const onDemand = { command: "npx", args: ["-y", "@swmansion/argent@latest", "mcp"] };
    expect(classifyMcpEntry(onDemand, nothing).status).toBe("ok");
  });

  it("fails an absolute command that no longer exists", () => {
    const entry = { command: path.join(projectRoot, "gone", "argent"), args: ["mcp"] };
    expect(classifyMcpEntry(entry, ctx()).status).toBe("error");
  });

  it("warns about an entry it could not read", () => {
    expect(classifyMcpEntry({ command: "", args: [] }, ctx()).status).toBe("warn");
  });
});

describe("toolchainChecks", () => {
  const adb = "/sdk/platform-tools/adb";

  it("passes with Xcode selected and adb found", () => {
    const checks = toolchainChecks({
      adb,
      xcode: { developerDir: "/Applications/Xcode.app/Contents/Developer", simctl: true },
    });
    expect(checks.map((c) => c.status)).toEqual(["ok", "ok"]);
  });

  it("tells the user to select Xcode when only the Command Line Tools are active", () => {
    const [ios] = toolchainChecks({
      adb,
      xcode: { developerDir: "/Library/Developer/CommandLineTools", simctl: false },
    });
    expect(ios!.status).toBe("warn");
    expect(ios!.fix).toContain("xcode-select -s");
  });

  it("warns when adb is missing and skips iOS off macOS", () => {
    const [ios, android] = toolchainChecks({ adb: null, xcode: null });
    expect(ios!.status).toBe("info");
    expect(android!.status).toBe("warn");
    expect(android!.fix).toContain("ANDROID_HOME");
  });
});

describe("stripPackageBinDirs", () => {
  it("drops node_modules/.bin so a project copy does not pass for a global install", () => {
    const value = ["/proj/node_modules/.bin", "/usr/local/bin", "/usr/bin"].join(path.delimiter);
    expect(stripPackageBinDirs(value)).toBe(["/usr/local/bin", "/usr/bin"].join(path.delimiter));
  });
});

function writeArgentEntry(configPath: string): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const config = { mcpServers: { argent: { command: "argent", args: ["mcp"] } } };
  fs.writeFileSync(configPath, JSON.stringify(config));
}

describe("resolveDoctorRoot", () => {
  it("finds a config written to a parent directory with init's custom install directory", () => {
    const repo = path.join(projectRoot, "ws", "repo-a");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repo, "src"));
    writeArgentEntry(path.join(projectRoot, "ws", ".mcp.json"));
    const homeDir = path.join(projectRoot, "home");
    expect(resolveDoctorRoot(path.join(repo, "src"), homeDir)).toBe(path.join(projectRoot, "ws"));
  });

  it("keeps the git root when no parent has a config", () => {
    const repo = path.join(projectRoot, "repo-a");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    expect(resolveDoctorRoot(repo, path.join(projectRoot, "home"))).toBe(repo);
  });
});

describe("findConfigured", () => {
  const realHome = process.env.HOME;
  afterEach(() => {
    process.env.HOME = realHome;
  });

  it("lists a global config once when run from the home directory", () => {
    process.env.HOME = projectRoot;
    writeArgentEntry(path.join(projectRoot, ".cursor", "mcp.json"));
    const cursor = findConfigured(projectRoot).filter((c) => c.adapter.name === "Cursor");
    expect(cursor.map((c) => c.scope)).toEqual(["global"]);
  });
});

describe("renderDoctorReport", () => {
  const passed = { status: "ok", label: "Cursor: argent mcp" } as const;
  const info = { status: "info", label: "Running v1.0.0" } as const;
  const warning = {
    status: "warn",
    label: "Rules missing in ~/.cursor/rules",
    detail: "argent.md",
    fix: "argent init",
  } as const;
  const failure = {
    status: "error",
    label: "`argent` is not on PATH",
    fix: "npm install -g @swmansion/argent",
  } as const;

  function report(...checks: DoctorCheck[]) {
    return { version: "1.0.0", projectRoot, sections: [{ title: "Install", checks }] };
  }

  it("prints only the header and one summary line when every check passes", () => {
    const lines = stripVTControlCharacters(renderDoctorReport(report(passed, info, passed))).split(
      "\n"
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("argent doctor v1.0.0");
    expect(lines[1]).toBe("✔ All 2 checks passed. Argent looks good.");
  });

  it("puts the summary first and lists errors before warnings with their advice", () => {
    const output = stripVTControlCharacters(renderDoctorReport(report(passed, warning, failure)));
    expect(output).toContain("1/3 checks passed. 2 checks failed.");
    expect(output).toContain("Use --verbose to see the passed checks.");
    expect(output).not.toContain(passed.label);
    expect(output.indexOf("✖ `argent` is not on PATH")).toBeLessThan(
      output.indexOf("⚠ Rules missing")
    );
    expect(output).toContain(
      "⚠ Rules missing in ~/.cursor/rules\n  argent.md\nAdvice:\nargent init"
    );
    expect(
      output.trimEnd().endsWith("2 checks failed, indicating possible issues with your setup.")
    ).toBe(true);
  });

  it("lists the passed checks with --verbose", () => {
    const output = stripVTControlCharacters(
      renderDoctorReport(report(passed, info, failure), true)
    );
    expect(output).toContain("✔ Cursor: argent mcp");
    expect(output).toContain("· Running v1.0.0");
    expect(output).not.toContain("--verbose");
  });
});
