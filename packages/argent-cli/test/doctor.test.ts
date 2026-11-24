import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  classifyMcpEntry,
  editorsSection,
  findConfigured,
  globalInstallFix,
  managedTargets,
  renderDoctorReport,
  resolveDoctorRoot,
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

  it("checks both paths of a pinned global entry", () => {
    const node = path.join(projectRoot, "bin", "node");
    const cli = path.join(
      projectRoot,
      "lib",
      "node_modules",
      "@swmansion",
      "argent",
      "dist",
      "cli.js"
    );
    const entry = { command: node, args: [cli, "mcp"] };
    fs.mkdirSync(path.dirname(node), { recursive: true });
    fs.writeFileSync(node, "");
    const missing = classifyMcpEntry(entry, ctx());
    expect(missing.status).toBe("error");
    expect(missing.label).toContain(`${cli} does not exist`);

    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(cli, "");
    expect(classifyMcpEntry(entry, ctx()).status).toBe("ok");
  });

  describe("package runner on PATH", () => {
    const realPath = process.env.PATH;
    const entry = { command: "pnpm", args: ["dlx", "@swmansion/argent", "mcp"] };
    const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    afterEach(() => {
      process.env.PATH = realPath;
    });

    it("fails a runner that is on neither the shell's nor the entry's PATH", () => {
      process.env.PATH = path.join(projectRoot, "shell");
      const missing = classifyMcpEntry({ ...entry, env: { PATH: "/opt/x:${PATH}" } }, ctx());
      expect(missing.status).toBe("error");
      expect(missing.label).toContain("`pnpm` is not on PATH");
    });

    it("accepts a runner on the entry's PATH or on the shell's PATH it expands", () => {
      process.env.PATH = path.join(projectRoot, "shell");
      fs.writeFileSync(path.join(projectRoot, pnpm), "");
      expect(classifyMcpEntry({ ...entry, env: { PATH: projectRoot } }, ctx()).status).toBe("ok");
      process.env.PATH = projectRoot;
      const expanded = { ...entry, env: { PATH: "/opt/x:${PATH}" } };
      expect(classifyMcpEntry(expanded, ctx()).status).toBe("ok");
    });
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
      xcode: {
        developerDir: "/Applications/Xcode.app/Contents/Developer",
        simctl: true,
        firstLaunch: null,
      },
    });
    expect(checks.map((c) => c.status)).toEqual(["ok", "ok"]);
  });

  it("tells the user to select Xcode when only the Command Line Tools are active", () => {
    const [ios] = toolchainChecks({
      adb,
      xcode: {
        developerDir: "/Library/Developer/CommandLineTools",
        simctl: false,
        firstLaunch: null,
      },
    });
    expect(ios!.status).toBe("warn");
    expect(ios!.fix).toContain("xcode-select -s");
  });

  it("selects the Xcode that is installed and asks to install one only when none is", () => {
    const report = {
      adb,
      xcode: {
        developerDir: "/Library/Developer/CommandLineTools",
        simctl: false,
        firstLaunch: null,
      },
    };
    expect(toolchainChecks(report, ["Xcode-26.6.app"])[0]!.fix).toBe(
      "Run sudo xcode-select -s /Applications/Xcode-26.6.app/Contents/Developer"
    );
    expect(toolchainChecks(report, [])[0]!.fix).toContain("Install Xcode from the App Store");
  });

  it("warns while Xcode has not finished its first launch", () => {
    const [ios] = toolchainChecks({
      adb,
      xcode: {
        developerDir: "/Applications/Xcode.app/Contents/Developer",
        simctl: true,
        firstLaunch: "open the Xcode at /Applications/Xcode.app once",
      },
    });
    expect(ios!.status).toBe("warn");
    expect(ios!.fix).toBe("Open the Xcode at /Applications/Xcode.app once");
  });

  it("warns when adb is missing and skips iOS off macOS", () => {
    const [ios, android] = toolchainChecks({ adb: null, xcode: null });
    expect(ios!.status).toBe("info");
    expect(android!.status).toBe("warn");
    expect(android!.fix).toContain("ANDROID_HOME");
  });
});

function writeArgentEntry(configPath: string): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const config = { mcpServers: { argent: { command: "argent", args: ["mcp"] } } };
  fs.writeFileSync(configPath, JSON.stringify(config));
}

describe("resolveDoctorRoot", () => {
  const realHome = process.env.HOME;
  afterEach(() => {
    process.env.HOME = realHome;
  });

  it("finds the config at the git root from a subfolder with its own marker", () => {
    const repo = path.join(projectRoot, "repo");
    const app = path.join(repo, "packages", "app");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(app, ".vscode"), { recursive: true });
    writeArgentEntry(path.join(repo, ".mcp.json"));
    const homeDir = path.join(projectRoot, "home");
    process.env.HOME = homeDir;
    expect(resolveDoctorRoot(app, homeDir)).toBe(repo);
  });

  it("ignores a config above the git root", () => {
    const repo = path.join(projectRoot, "code", "newrepo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    writeArgentEntry(path.join(projectRoot, "code", ".cursor", "mcp.json"));
    const homeDir = path.join(projectRoot, "home");
    process.env.HOME = homeDir;
    expect(resolveDoctorRoot(repo, homeDir)).toBe(repo);
  });

  it("keeps the git root over a stale parent config when a global entry covers it", () => {
    const homeDir = path.join(projectRoot, "home");
    const app = path.join(homeDir, "Developer", "app");
    fs.mkdirSync(path.join(app, ".git"), { recursive: true });
    writeArgentEntry(path.join(homeDir, "Developer", ".mcp.json"));
    writeArgentEntry(path.join(homeDir, ".cursor", "mcp.json"));
    process.env.HOME = homeDir;
    expect(resolveDoctorRoot(app, homeDir)).toBe(app);
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

describe("editorsSection", () => {
  const realHome = process.env.HOME;
  afterEach(() => {
    process.env.HOME = realHome;
  });

  function editorChecks(root: string) {
    return editorsSection({ ...ctx({ projectRoot: root }), configured: findConfigured(root) })
      .checks;
  }

  it("fails a config the editor rejects even when the entry itself reads fine", () => {
    process.env.HOME = path.join(projectRoot, "home");
    fs.writeFileSync(
      path.join(projectRoot, ".mcp.json"),
      '{"mcpServers":{"argent":{"command":"argent","args":["mcp"]},}}'
    );
    const [claude] = editorChecks(projectRoot);
    expect(claude!.status).toBe("error");
    expect(claude!.label).toBe("Claude Code: the config has a JSON syntax error on line 1");
  });

  it("rejects a comment in Claude Code's config but not in Gemini's", () => {
    process.env.HOME = path.join(projectRoot, "home");
    const config = '// argent\n{"mcpServers":{"argent":{"command":"argent","args":["mcp"]}}}';
    fs.writeFileSync(path.join(projectRoot, ".mcp.json"), config);
    fs.mkdirSync(path.join(projectRoot, ".gemini"));
    fs.writeFileSync(path.join(projectRoot, ".gemini", "settings.json"), config);
    const checks = editorChecks(projectRoot);
    expect(checks.find((c) => c.label.startsWith("Claude Code"))!.status).toBe("error");
    expect(checks.find((c) => c.label.startsWith("Gemini"))!.status).toBe("ok");
  });

  it("points at the broken line when the config cannot be parsed at all", () => {
    process.env.HOME = path.join(projectRoot, "home");
    fs.writeFileSync(path.join(projectRoot, ".mcp.json"), '{ "mcpServers": oops');
    const checks = editorChecks(projectRoot).filter((c) => c.status === "error");
    expect(checks.map((c) => c.label)).toEqual([
      "Claude Code: the config has a JSON syntax error on line 1",
    ]);
  });

  it("does not offer global-only editors to a local install", () => {
    process.env.HOME = path.join(projectRoot, "home");
    fs.mkdirSync(path.join(projectRoot, "home", ".hermes"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "home", ".hermes", "config.yaml"), "model: x\n");
    const detected = () => editorChecks(projectRoot).find((c) => c.label.startsWith("Detected"));
    expect(detected()!.label).toContain("Hermes");

    fs.mkdirSync(path.join(projectRoot, ".argent"));
    fs.writeFileSync(path.join(projectRoot, ".argent", "install.json"), '{"mode":"local"}');
    expect(detected()?.label ?? "").not.toContain("Hermes");
  });

  it("tells the user to pick the global scope when a global entry is broken", () => {
    const homeDir = path.join(projectRoot, "home");
    process.env.HOME = homeDir;
    const gone = path.join(projectRoot, "gone");
    const cli = path.join(gone, "lib", "node_modules", "@swmansion", "argent", "dist", "cli.js");
    const config = {
      mcpServers: { argent: { command: path.join(gone, "bin", "node"), args: [cli, "mcp"] } },
    };
    fs.mkdirSync(path.join(homeDir, ".cursor"), { recursive: true });
    fs.writeFileSync(path.join(homeDir, ".cursor", "mcp.json"), JSON.stringify(config));
    const cursor = editorChecks(projectRoot).find((c) => c.label.startsWith("Cursor"));
    expect(cursor!.status).toBe("error");
    expect(cursor!.fix).toBe(
      'argent init, and choose Global at "Install MCP server globally or locally?"'
    );
  });
});

describe("globalInstallFix", () => {
  const realArgv = process.argv[1];
  const realPath = process.env.PATH;
  afterEach(() => {
    process.argv[1] = realArgv!;
    process.env.PATH = realPath;
  });

  it("asks to add the running argent's bin directory to PATH when it is missing there", () => {
    const binDir = path.join(projectRoot, "prefix", "bin");
    process.argv[1] = path.join(binDir, "argent");
    process.env.PATH = "/usr/bin:/bin";
    expect(globalInstallFix()).toBe(`Add ${binDir} to PATH`);
  });
});

describe("managedTargets", () => {
  const realHome = process.env.HOME;
  afterEach(() => {
    process.env.HOME = realHome;
  });

  it("checks rules only for project entries since init writes no global rules", () => {
    const homeDir = path.join(projectRoot, "home");
    const repo = path.join(projectRoot, "repo");
    writeArgentEntry(path.join(homeDir, ".cursor", "mcp.json"));
    writeArgentEntry(path.join(repo, ".cursor", "mcp.json"));
    process.env.HOME = homeDir;
    const { ruleDirs } = managedTargets({ projectRoot: repo, configured: findConfigured(repo) });
    expect(ruleDirs).toEqual([path.join(repo, ".cursor", "rules")]);
  });
});

describe("renderDoctorReport", () => {
  const passed = { status: "ok", label: "Cursor: argent mcp" } as const;
  const info = { status: "info", label: "Running v1.0.0" } as const;
  const warning = {
    status: "warn",
    label: "Rules missing in ~/my-app/.cursor/rules",
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
    expect(output).toContain("1/3 checks passed. 1 check failed and 1 warning.");
    expect(output).toContain("Use --verbose to see the passed checks.");
    expect(output).not.toContain(passed.label);
    expect(output.indexOf("✖ `argent` is not on PATH")).toBeLessThan(
      output.indexOf("⚠ Rules missing")
    );
    expect(output).toContain(
      "⚠ Rules missing in ~/my-app/.cursor/rules\n  argent.md\nAdvice:\nargent init"
    );
    expect(
      output
        .trimEnd()
        .endsWith("1 check failed and 1 warning, indicating possible issues with your setup.")
    ).toBe(true);
  });

  it("does not call a warning-only run failed", () => {
    const output = stripVTControlCharacters(renderDoctorReport(report(passed, warning)));
    expect(output).toContain("1/2 checks passed. 1 warning.");
    expect(output).not.toContain("failed");
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
