import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  classifyMcpEntry,
  configuredFor,
  xcodesIn,
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
    cwd: projectRoot,
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

  it("does not judge an entry that sets its own PATH", () => {
    const ownPath = { env: { PATH: path.join(projectRoot, "bin") } };
    const pnpm = { command: "pnpm", args: ["dlx", "@swmansion/argent", "mcp"] };
    for (const entry of [bare, pnpm]) {
      const result = classifyMcpEntry({ ...entry, ...ownPath }, ctx({ globalOnPath: false }));
      expect(result.status).toBe("info");
      expect(result.label).toContain("sets its own PATH, not checked");
    }
  });

  it("fails an argent entry that does not start the MCP server", () => {
    expect(classifyMcpEntry({ command: "argent", args: ["serve"] }, ctx()).status).toBe("error");
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

    const subfolder = path.join(projectRoot, "src");
    fs.mkdirSync(subfolder);
    const fromSubfolder = classifyMcpEntry(entry, ctx({ cwd: subfolder }));
    expect(fromSubfolder.status).toBe("error");
    expect(fromSubfolder.fix).toBe(`Start the editor in ${projectRoot}`);
  });

  it("asks to rerun init, not to install the project, for a missing absolute script", () => {
    const entry = { command: "node", args: [path.join(projectRoot, "gone", "cli.js"), "mcp"] };
    expect(classifyMcpEntry(entry, ctx()).fix).toBe("argent init");
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

    it("fails a runner that is not on PATH and accepts one that is", () => {
      process.env.PATH = path.join(projectRoot, "shell");
      const missing = classifyMcpEntry(entry, ctx());
      expect(missing.status).toBe("error");
      expect(missing.label).toContain("`pnpm` is not on PATH");
      process.env.PATH = projectRoot;
      fs.writeFileSync(path.join(projectRoot, pnpm), "", { mode: 0o755 });
      expect(classifyMcpEntry(entry, ctx()).status).toBe("ok");
    });

    it.skipIf(process.platform === "win32")("skips a runner that is not executable", () => {
      process.env.PATH = projectRoot;
      fs.writeFileSync(path.join(projectRoot, pnpm), "", { mode: 0o644 });
      expect(classifyMcpEntry(entry, ctx()).status).toBe("error");
      fs.mkdirSync(path.join(projectRoot, "later"));
      fs.writeFileSync(path.join(projectRoot, "later", pnpm), "", { mode: 0o755 });
      process.env.PATH = [projectRoot, path.join(projectRoot, "later")].join(path.delimiter);
      expect(classifyMcpEntry(entry, ctx()).status).toBe("ok");
    });

    it("names the package that ships the runner", () => {
      process.env.PATH = path.join(projectRoot, "shell");
      const bunx = { command: "bunx", args: ["@swmansion/argent", "mcp"] };
      expect(classifyMcpEntry(bunx, ctx()).fix).toBe(
        "Install Bun, or put `bunx` on the PATH the entry runs with"
      );
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
    expect(toolchainChecks(report, ["/Applications/Xcode-26.6.app"])[0]!.fix).toBe(
      "Run sudo xcode-select -s /Applications/Xcode-26.6.app/Contents/Developer"
    );
    expect(toolchainChecks(report, [])[0]!.fix).toContain("Install Xcode from the App Store");
    expect(toolchainChecks(report, ["/Applications/Xcode 26.1.app"])[0]!.fix).toBe(
      'Run sudo xcode-select -s "/Applications/Xcode 26.1.app/Contents/Developer"'
    );
  });

  describe("with toolchain env vars set", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("asks to unset DEVELOPER_DIR, which xcode-select cannot override", () => {
      vi.stubEnv("DEVELOPER_DIR", "/nonexistent");
      const [ios] = toolchainChecks(
        { adb, xcode: { developerDir: "/nonexistent", simctl: false, firstLaunch: null } },
        ["/Applications/Xcode.app"]
      );
      expect(ios!.fix).toBe(
        "Unset DEVELOPER_DIR (it overrides xcode-select), then run sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
      );
    });

    it("names an ANDROID_HOME that has no adb", () => {
      vi.stubEnv("ANDROID_SDK_ROOT", undefined);
      vi.stubEnv("ANDROID_HOME", "/nonexistent/sdk");
      const [, android] = toolchainChecks({ adb: null, xcode: null });
      expect(android!.detail).toBe(
        "ANDROID_HOME is /nonexistent/sdk, which has no platform-tools/adb"
      );
    });
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

  it("finds renamed Xcode apps but not other apps whose name starts with Xcode", () => {
    for (const app of ["Xcode.app", "Xcode-26.6.app", "Xcode 26.1.app", "Xcodes.app"]) {
      fs.mkdirSync(path.join(projectRoot, app));
    }
    expect(
      xcodesIn(projectRoot)
        .map((p) => path.basename(p))
        .sort()
    ).toEqual(["Xcode 26.1.app", "Xcode-26.6.app", "Xcode.app"]);
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

  it("counts only Claude Code's config above the git root, since Claude Code reads it", () => {
    const homeDir = path.join(projectRoot, "home");
    const ws = path.join(homeDir, "ws");
    const src = path.join(ws, "repo-a", "src");
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(path.join(ws, "repo-a", ".git"));
    writeArgentEntry(path.join(ws, ".mcp.json"));
    writeArgentEntry(path.join(ws, ".cursor", "mcp.json"));
    process.env.HOME = homeDir;
    expect(resolveDoctorRoot(src, homeDir)).toBe(ws);
    expect(configuredFor(ws, src).map((c) => c.adapter.name)).toEqual(["Claude Code"]);
  });

  it("keeps looking for the repo's config when a global entry exists", () => {
    const homeDir = path.join(projectRoot, "home");
    const mono = path.join(projectRoot, "mono");
    const web = path.join(mono, "apps", "web");
    fs.mkdirSync(path.join(mono, ".git"), { recursive: true });
    fs.mkdirSync(path.join(web, ".vscode"), { recursive: true });
    writeArgentEntry(path.join(mono, ".mcp.json"));
    writeArgentEntry(path.join(homeDir, ".cursor", "mcp.json"));
    process.env.HOME = homeDir;
    expect(resolveDoctorRoot(web, homeDir)).toBe(mono);
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

  function editorChecks(root: string, cwd = root) {
    return editorsSection({ ...ctx({ projectRoot: root, cwd }), configured: findConfigured(root) })
      .checks;
  }

  function writeEntry(configPath: string, container: string, server: object): void {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ [container]: { argent: server } }));
  }

  it("checks a relative script from this folder only for editors started in it", () => {
    process.env.HOME = path.join(projectRoot, "home");
    const script = "node_modules/@swmansion/argent/dist/cli.js";
    fs.mkdirSync(path.dirname(path.join(projectRoot, script)), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, script), "");
    const entry = { command: "node", args: [script, "mcp"] };
    writeEntry(path.join(projectRoot, ".mcp.json"), "mcpServers", entry);
    writeEntry(path.join(projectRoot, ".cursor", "mcp.json"), "mcpServers", entry);
    fs.mkdirSync(path.join(projectRoot, ".codex"));
    fs.writeFileSync(
      path.join(projectRoot, ".codex", "config.toml"),
      `[mcp_servers.argent]\ncommand = "node"\nargs = ["${script}", "mcp"]\n`
    );
    const src = path.join(projectRoot, "src");
    fs.mkdirSync(src);
    const checks = editorChecks(projectRoot, src);
    expect(checks.find((c) => c.label.startsWith("Claude Code"))!.status).toBe("error");
    expect(checks.find((c) => c.label.startsWith("Codex"))!.status).toBe("error");
    expect(checks.find((c) => c.label.startsWith("Cursor"))!.status).toBe("ok");
  });

  it("still reports no entry when only an unrelated global config is broken", () => {
    const homeDir = path.join(projectRoot, "home");
    process.env.HOME = homeDir;
    fs.mkdirSync(path.join(homeDir, ".config", "zed"), { recursive: true });
    fs.writeFileSync(path.join(homeDir, ".config", "zed", "settings.json"), '{"a": 1 "b": 2}');
    const labels = editorChecks(projectRoot)
      .filter((c) => c.status === "error")
      .map((c) => c.label);
    expect(labels).toEqual([
      "Zed: the config has a JSON syntax error on line 1",
      "No editor has an argent MCP entry for this project",
    ]);
  });

  it("points at a broken global config that holds the argent entry instead of init", () => {
    const homeDir = path.join(projectRoot, "home");
    process.env.HOME = homeDir;
    fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, ".codex", "config.toml"),
      'model = gpt-5\n[mcp_servers.argent]\ncommand = "argent"\nargs = ["mcp"]\n'
    );
    const labels = editorChecks(projectRoot)
      .filter((c) => c.status === "error")
      .map((c) => c.label);
    expect(labels).toEqual(["Codex: the config has a TOML syntax error on line 1"]);
  });

  it("ignores broken configs above the git root that only Claude Code would read past", () => {
    const homeDir = path.join(projectRoot, "home");
    process.env.HOME = homeDir;
    const ws = path.join(projectRoot, "code");
    const repo = path.join(ws, "newrepo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    writeArgentEntry(path.join(ws, ".mcp.json"));
    fs.mkdirSync(path.join(ws, ".gemini"));
    fs.writeFileSync(path.join(ws, ".gemini", "settings.json"), '{"mcpServers": {"x": 1,}}');
    const checks = editorsSection({
      ...ctx({ projectRoot: ws, cwd: repo }),
      configured: configuredFor(ws, repo),
    }).checks;
    expect(checks.filter((c) => c.status === "error")).toEqual([]);
  });

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

  it("fails a broken TOML or YAML config while another editor is fine", () => {
    const homeDir = path.join(projectRoot, "home");
    process.env.HOME = homeDir;
    writeArgentEntry(path.join(homeDir, ".cursor", "mcp.json"));
    fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, ".codex", "config.toml"),
      'model = gpt-5\n[mcp_servers.argent]\ncommand = "argent"\nargs = ["mcp"]\n'
    );
    fs.mkdirSync(path.join(homeDir, ".hermes"), { recursive: true });
    fs.writeFileSync(path.join(homeDir, ".hermes", "config.yaml"), "a: 1\nfoo: [\nb: 2\n");
    const checks = editorChecks(projectRoot);
    expect(checks.filter((c) => c.status === "error").map((c) => c.label)).toEqual([
      "Codex: the config has a TOML syntax error on line 1",
      "Hermes: the config has a YAML syntax error on line 3",
    ]);
    expect(checks.find((c) => c.label.startsWith("Detected"))?.label ?? "").not.toMatch(
      /Codex|Hermes/
    );
  });

  it("points at the broken line when the config cannot be parsed at all", () => {
    process.env.HOME = path.join(projectRoot, "home");
    fs.writeFileSync(path.join(projectRoot, ".mcp.json"), '{ "mcpServers": oops');
    const checks = editorChecks(projectRoot).filter((c) => c.status === "error");
    expect(checks.map((c) => c.label)).toEqual([
      "Claude Code: the config has a JSON syntax error on line 1",
    ]);
  });

  it("reports an empty config as no entry, as the editor does", () => {
    process.env.HOME = path.join(projectRoot, "home");
    fs.writeFileSync(path.join(projectRoot, ".mcp.json"), "\n");
    const checks = editorChecks(projectRoot).filter((c) => c.status === "error");
    expect(checks.map((c) => c.label)).toEqual([
      "No editor has an argent MCP entry for this project",
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
