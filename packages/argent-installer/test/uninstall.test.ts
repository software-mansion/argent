import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  ALL_ADAPTERS,
  getMcpEntry,
  addClaudePermission,
  removeClaudePermission,
} from "../src/mcp-configs.js";
import { log, outro } from "@clack/prompts";
import {
  cleanupSkillsLockFile,
  getBundledSkillNames,
  removeBundledContent,
  removeBundledSkillInstalls,
  uninstall,
} from "../src/uninstall.js";

const telemetryMock = vi.hoisted(() => ({
  init: vi.fn(),
  track: vi.fn(),
  resetLocalTelemetryState: vi.fn().mockResolvedValue({
    localIdRemoved: true,
    noticeReset: true,
  }),
  shutdown: vi.fn().mockResolvedValue(undefined),
}));

const childProcessMock = vi.hoisted(() => ({
  execSync: vi.fn(() => "/usr/local/bin/argent\n"),
  execFileSync: vi.fn(),
}));

const toolsClientMock = vi.hoisted(() => ({
  killToolServer: vi.fn().mockResolvedValue(undefined),
  killToolServerForInstallDir: vi.fn().mockResolvedValue(0),
}));

vi.mock("@argent/telemetry", () => telemetryMock);
vi.mock("node:child_process", () => childProcessMock);
vi.mock("@argent/tools-client", () => toolsClientMock);
vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  confirm: vi.fn(),
  isCancel: vi.fn(() => false),
  log: {
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    step: vi.fn(),
    success: vi.fn(),
  },
  note: vi.fn(),
}));

let tmpDir: string;
let originalCwd: string;
let savedAgent: string | undefined;

function writeFile(filePath: string, contents = "test"): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-uninstall-test-"));
  originalCwd = process.cwd();
  // detectPackageManager() reads npm_config_user_agent, so the uninstall
  // command these tests assert on is whichever package manager runs the suite.
  // Unset it to pin the npm shape — otherwise the execFileSync mock below,
  // which throws only for "npm", never fires and the failure-path tests
  // silently exercise the success path.
  savedAgent = process.env.npm_config_user_agent;
  delete process.env.npm_config_user_agent;
  vi.clearAllMocks();
  // A successful `uninstall -g` takes argent off PATH — the post-command check
  // reads that back, so the default mocks have to move together or a passing
  // removal looks like npm's silent no-op.
  let globalOnPath = true;
  childProcessMock.execSync.mockImplementation(() => {
    if (!globalOnPath) throw new Error("not found");
    return "/usr/local/bin/argent\n";
  });
  childProcessMock.execFileSync.mockImplementation(((_bin: string, args: string[]) => {
    if (Array.isArray(args) && args.includes("uninstall") && args.includes("-g"))
      globalOnPath = false;
    return undefined;
  }) as never);
});

afterEach(() => {
  process.chdir(originalCwd);
  if (savedAgent === undefined) delete process.env.npm_config_user_agent;
  else process.env.npm_config_user_agent = savedAgent;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("uninstall — telemetry consent preservation", () => {
  // The prune step resolves global skill/rule/agent targets from homedir(), so
  // point HOME at the empty tmpDir: the prune then finds nothing to remove and
  // has_pruned_content is deterministically false regardless of what the real
  // home contains (these are telemetry-behavior tests, not real-home cleanup).
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  beforeEach(() => {
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
  });

  it("does not reset uninstall telemetry identity when no global package was uninstalled", async () => {
    childProcessMock.execSync.mockImplementationOnce(() => {
      throw new Error("not found");
    });
    process.chdir(tmpDir);

    await uninstall(["--yes"]);

    expect(childProcessMock.execFileSync).not.toHaveBeenCalledWith(
      "npm",
      expect.arrayContaining(["uninstall", "-g"])
    );
    expect(telemetryMock.track).toHaveBeenCalledWith("installation:cli_uninstall_complete", {
      has_pruned_content: false,
      has_uninstalled_package: false,
      install_mode: "global",
    });
    expect(telemetryMock.resetLocalTelemetryState).not.toHaveBeenCalled();
  });

  it("resets uninstall telemetry identity without persisting a consent opt-out after global package uninstall", async () => {
    process.chdir(tmpDir);

    await uninstall(["--yes"]);

    expect(childProcessMock.execFileSync).toHaveBeenCalledWith(
      "npm",
      expect.arrayContaining(["uninstall", "-g", "@swmansion/argent"]),
      expect.any(Object)
    );
    expect(telemetryMock.resetLocalTelemetryState).toHaveBeenCalledWith();
  });

  it("drains queued uninstall telemetry before deleting the local telemetry id", async () => {
    process.chdir(tmpDir);

    await uninstall(["--yes"]);

    expect(telemetryMock.track).toHaveBeenCalledWith("installation:cli_uninstall_complete", {
      has_pruned_content: false,
      has_uninstalled_package: true,
      install_mode: "global",
    });

    const shutdownOrder = telemetryMock.shutdown.mock.invocationCallOrder[0]!;
    const resetOrder = telemetryMock.resetLocalTelemetryState.mock.invocationCallOrder[0]!;
    expect(shutdownOrder).toBeLessThan(resetOrder);
  });

  it("does not delete the local telemetry id when global package uninstall fails", async () => {
    process.chdir(tmpDir);
    childProcessMock.execFileSync.mockImplementation((bin: string) => {
      if (bin === "npm") throw new Error("npm failed");
      return undefined;
    });

    await uninstall(["--yes"]);

    expect(telemetryMock.track).toHaveBeenCalledWith(
      "installation:cli_uninstall_complete",
      expect.objectContaining({
        error_code: "UNINSTALL_PACKAGE_ACTION_FAILED",
        has_pruned_content: false,
        has_uninstalled_package: false,
      })
    );
    expect(telemetryMock.resetLocalTelemetryState).not.toHaveBeenCalled();
  });

  it("drains uninstall telemetry when package shutdown throws before uninstalling", async () => {
    process.chdir(tmpDir);
    // Stage a resolvable fake global install so the kill (scoped to the install
    // dir being removed) is actually attempted.
    const globalPkg = path.join(tmpDir, "global-argent");
    writeFile(path.join(globalPkg, "package.json"), JSON.stringify({ name: "@swmansion/argent" }));
    writeFile(path.join(globalPkg, "bin", "argent"), "#!/usr/bin/env node\n");
    childProcessMock.execSync.mockImplementation(
      () => path.join(globalPkg, "bin", "argent") + "\n"
    );
    toolsClientMock.killToolServerForInstallDir.mockRejectedValueOnce(
      new Error("tool server busy")
    );

    await expect(uninstall(["--yes"])).rejects.toThrow("tool server busy");
    // The probe follows symlinks (macOS /var → /private/var), so compare realpaths.
    expect(toolsClientMock.killToolServerForInstallDir).toHaveBeenCalledWith(
      fs.realpathSync(globalPkg)
    );

    expect(telemetryMock.track).toHaveBeenCalledWith(
      "installation:cli_uninstall_complete",
      expect.objectContaining({
        error_code: "UNINSTALL_TOOLSERVER_STOP_FAILED",
        has_pruned_content: false,
        has_uninstalled_package: false,
      })
    );
    expect(telemetryMock.shutdown).toHaveBeenCalledOnce();
    expect(telemetryMock.resetLocalTelemetryState).not.toHaveBeenCalled();
  });

  it("drains uninstall telemetry on an unclassified throw outside the classified paths", async () => {
    process.chdir(tmpDir);
    // An unexpected failure that no classified handler covers (e.g. a clack
    // prompt or a cleanup step blowing up). The outer wrapper must still flush
    // the buffered cli_uninstall_start with a terminal cli_uninstall_complete.
    const clack = await import("@clack/prompts");
    vi.mocked(clack.log.step).mockImplementationOnce(() => {
      throw new Error("unexpected boom");
    });

    await expect(uninstall(["--yes"])).rejects.toThrow("unexpected boom");

    expect(telemetryMock.track).toHaveBeenCalledWith(
      "installation:cli_uninstall_complete",
      expect.objectContaining({
        error_code: "UNINSTALL_UNCLASSIFIED_FAILED",
      })
    );
    expect(telemetryMock.shutdown).toHaveBeenCalledOnce();
    expect(telemetryMock.resetLocalTelemetryState).not.toHaveBeenCalled();
  });
});

// ── MCP entry removal across all adapters ─────────────────────────────────────

// `argent init`'s prefix recovery writes a prefix into npm's user config, which
// an inherited npm_config_prefix outranks. npm then uninstalls from a prefix
// this install does not live under, prints "up to date" and exits 0.
describe("uninstall — a global removal npm did not perform", () => {
  let savedHome: string | undefined;
  let packageDir: string;
  let binPath: string;

  beforeEach(() => {
    savedHome = process.env.HOME;
    process.env.HOME = tmpDir;
    packageDir = path.join(tmpDir, "npm-global", "lib", "node_modules", "@swmansion", "argent");
    writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "@swmansion/argent", version: "9.9.9" })
    );
    writeFile(path.join(packageDir, "dist", "cli.js"), "#!/usr/bin/env node\n");
    binPath = path.join(tmpDir, "npm-global", "bin", "argent");
    fs.mkdirSync(path.dirname(binPath), { recursive: true });
    fs.symlinkSync(path.join(packageDir, "dist", "cli.js"), binPath);
    childProcessMock.execSync.mockImplementation(() => {
      if (!fs.existsSync(binPath)) throw new Error("not found");
      return `${binPath}\n`;
    });
    // The verification asks npm where its global directory is; the tests below
    // decide what the removal leaves in it.
    childProcessMock.execFileSync.mockImplementation(((_bin: string, args: string[]) => {
      if (Array.isArray(args) && args.includes("root") && args.includes("-g"))
        return `${path.dirname(path.dirname(packageDir))}\n`;
      return undefined;
    }) as never);
    process.chdir(tmpDir);
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  it("does not report a removal that left the package where it was", async () => {
    // The default mock above removes nothing — npm's no-op exit 0.
    await uninstall(["--yes"]);

    expect(childProcessMock.execFileSync).toHaveBeenCalledWith(
      "npm",
      expect.arrayContaining(["uninstall", "-g"]),
      expect.anything()
    );
    expect(fs.existsSync(packageDir)).toBe(true);
    const successes = vi.mocked(log.success).mock.calls.map(([m]) => m as string);
    expect(successes).not.toContain("Removed global package.");
    const errors = vi.mocked(log.error).mock.calls.map(([m]) => m as string);
    expect(errors.some((m) => m.includes("is still at"))).toBe(true);
    // Machine-wide state must survive an install that is still on PATH.
    expect(telemetryMock.resetLocalTelemetryState).not.toHaveBeenCalled();
  });

  it("reports the removal once the package is actually gone", async () => {
    childProcessMock.execFileSync.mockImplementation(((_bin: string, args: string[]) => {
      if (!Array.isArray(args)) return undefined;
      if (args.includes("root") && args.includes("-g"))
        return `${path.dirname(path.dirname(packageDir))}\n`;
      if (args.includes("uninstall") && args.includes("-g")) {
        fs.rmSync(packageDir, { recursive: true, force: true });
        fs.rmSync(binPath, { force: true });
      }
      return undefined;
    }) as never);

    await uninstall(["--yes"]);

    const successes = vi.mocked(log.success).mock.calls.map(([m]) => m as string);
    expect(successes).toContain("Removed global package.");
    expect(telemetryMock.resetLocalTelemetryState).toHaveBeenCalled();
  });
});

describe("uninstall — a global install linked at its source", () => {
  // `npm install -g <folder>` (and `npm link`) make the global entry a symlink,
  // so the package root the PATH probe resolves is the developer's checkout —
  // untouched by the removal, and no evidence the removal failed.
  let savedHome: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
    process.env.HOME = tmpDir;
    const sourceDir = path.join(tmpDir, "checkout");
    writeFile(
      path.join(sourceDir, "package.json"),
      JSON.stringify({ name: "@swmansion/argent", version: "9.9.9" })
    );
    writeFile(path.join(sourceDir, "dist", "cli.js"), "#!/usr/bin/env node\n");
    const entry = path.join(tmpDir, "npm-global", "lib", "node_modules", "@swmansion", "argent");
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.symlinkSync(sourceDir, entry);
    const binPath = path.join(tmpDir, "npm-global", "bin", "argent");
    fs.mkdirSync(path.dirname(binPath), { recursive: true });
    fs.symlinkSync(path.join(sourceDir, "dist", "cli.js"), binPath);
    childProcessMock.execSync.mockImplementation(() => {
      if (!fs.existsSync(binPath)) throw new Error("not found");
      return `${binPath}\n`;
    });
    // npm removes the two links it made and leaves the checkout alone.
    childProcessMock.execFileSync.mockImplementation(((_bin: string, args: string[]) => {
      if (!Array.isArray(args)) return undefined;
      if (args.includes("root") && args.includes("-g")) return `${path.dirname(entry)}/..\n`;
      if (args.includes("uninstall") && args.includes("-g")) {
        fs.rmSync(entry, { force: true });
        fs.rmSync(binPath, { force: true });
      }
      return undefined;
    }) as never);
    process.chdir(tmpDir);
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  it("reports the removal even though the linked source directory survives", async () => {
    await uninstall(["--yes"]);

    expect(fs.existsSync(path.join(tmpDir, "checkout", "package.json"))).toBe(true);
    const errors = vi.mocked(log.error).mock.calls.map(([m]) => m as string);
    expect(errors.some((m) => m.includes("still resolves to"))).toBe(false);
    const successes = vi.mocked(log.success).mock.calls.map(([m]) => m as string);
    expect(successes).toContain("Removed global package.");
    expect(telemetryMock.resetLocalTelemetryState).toHaveBeenCalled();
  });
});

describe("uninstall — a second argent further down PATH", () => {
  // `which -a argent` answers for the whole PATH, so a project's
  // node_modules/.bin/argent (what `npm run` and direnv put there) outlives a
  // global removal and must not be read as the global one surviving.
  let savedHome: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
    process.env.HOME = tmpDir;
    const globalPkg = path.join(
      tmpDir,
      "npm-global",
      "lib",
      "node_modules",
      "@swmansion",
      "argent"
    );
    writeFile(
      path.join(globalPkg, "package.json"),
      JSON.stringify({ name: "@swmansion/argent", version: "9.9.9" })
    );
    writeFile(path.join(globalPkg, "dist", "cli.js"), "#!/usr/bin/env node\n");
    const globalBin = path.join(tmpDir, "npm-global", "bin", "argent");
    fs.mkdirSync(path.dirname(globalBin), { recursive: true });
    fs.symlinkSync(path.join(globalPkg, "dist", "cli.js"), globalBin);

    const localPkg = path.join(tmpDir, "proj", "node_modules", "@swmansion", "argent");
    writeFile(
      path.join(localPkg, "package.json"),
      JSON.stringify({ name: "@swmansion/argent", version: "9.9.9" })
    );
    writeFile(path.join(localPkg, "dist", "cli.js"), "#!/usr/bin/env node\n");
    const localBin = path.join(tmpDir, "proj", "node_modules", ".bin", "argent");
    fs.mkdirSync(path.dirname(localBin), { recursive: true });
    fs.symlinkSync(path.join(localPkg, "dist", "cli.js"), localBin);

    // The global install comes first, the project shim second — PATH order.
    childProcessMock.execSync.mockImplementation(
      () => [globalBin, localBin].filter((b) => fs.existsSync(b)).join("\n") + "\n"
    );
    childProcessMock.execFileSync.mockImplementation(((_bin: string, args: string[]) => {
      if (!Array.isArray(args)) return undefined;
      if (args.includes("root") && args.includes("-g"))
        return `${path.dirname(path.dirname(globalPkg))}\n`;
      if (args.includes("uninstall") && args.includes("-g")) {
        fs.rmSync(globalPkg, { recursive: true, force: true });
        fs.rmSync(globalBin, { force: true });
      }
      return undefined;
    }) as never);
    process.chdir(tmpDir);
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  it("reports the global removal even though the project shim is still on PATH", async () => {
    await uninstall(["--yes", "--global"]);

    const errors = vi.mocked(log.error).mock.calls.map(([m]) => m as string);
    expect(errors.some((m) => m.includes("global uninstall failed"))).toBe(false);
    const successes = vi.mocked(log.success).mock.calls.map(([m]) => m as string);
    expect(successes).toContain("Removed global package.");
  });
});

describe("uninstall — MCP entry removal", () => {
  for (const adapter of ALL_ADAPTERS) {
    it(`removes argent from ${adapter.name} config`, () => {
      const configPath = adapter.projectPath(tmpDir);
      if (!configPath) return; // skip adapters without project path

      adapter.write(configPath, getMcpEntry());
      expect(adapter.remove(configPath)).toBe(true);
      expect(fs.existsSync(configPath)).toBe(false);
    });
  }

  it("handles removal from non-existent files gracefully", () => {
    for (const adapter of ALL_ADAPTERS) {
      expect(adapter.remove(path.join(tmpDir, "nonexistent.json"))).toBe(false);
    }
  });
});

// ── Permissions cleanup ───────────────────────────────────────────────────────

describe("uninstall — permissions cleanup", () => {
  it("removes mcp__argent permission when present", () => {
    addClaudePermission(tmpDir, "local");
    removeClaudePermission(tmpDir, "local");

    const settingsPath = path.join(tmpDir, ".claude", "settings.json");
    expect(fs.existsSync(settingsPath)).toBe(false);
  });

  it("does not throw when .claude/settings.json does not exist", () => {
    expect(() => removeClaudePermission(tmpDir, "local")).not.toThrow();
  });

  it("does not throw when permissions.allow is missing", () => {
    const settingsPath = path.join(tmpDir, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({}));

    expect(() => removeClaudePermission(tmpDir, "local")).not.toThrow();
  });
});

// ── Skills cleanup helpers ────────────────────────────────────────────────────

describe("uninstall — skills cleanup helpers", () => {
  it("discovers bundled skill names from frontmatter", () => {
    const skillsDir = path.join(tmpDir, "skills");

    writeFile(
      path.join(skillsDir, "argent-create-flow", "SKILL.md"),
      ["---", "name: argent-create-flow", "description: test", "---", "", "body"].join("\n")
    );
    writeFile(
      path.join(skillsDir, "argent-react-native-optimization", "SKILL.md"),
      [
        "---",
        'name: "argent-react-native-optimization"',
        "description: test",
        "---",
        "",
        "body",
      ].join("\n")
    );
    writeFile(path.join(skillsDir, "references", "guide.md"));

    expect(getBundledSkillNames(skillsDir)).toEqual([
      "argent-create-flow",
      "argent-react-native-optimization",
    ]);
  });

  it("resolves the frontmatter name past a trailing YAML comment", () => {
    // The previous `^name:(.+)$` capture + outer-quote strip kept an inline
    // `# …` comment as part of the name. Parsing the YAML block resolves the
    // scalar correctly.
    const skillsDir = path.join(tmpDir, "skills");
    writeFile(
      path.join(skillsDir, "argent-test-ui-flow", "SKILL.md"),
      [
        "---",
        "name: argent-test-ui-flow # managed by argent",
        "description: test",
        "---",
        "",
        "body",
      ].join("\n")
    );
    expect(getBundledSkillNames(skillsDir)).toEqual(["argent-test-ui-flow"]);
  });

  it("removes installed skill entries by current skill names only", () => {
    const targetDir = path.join(tmpDir, ".claude", "skills");
    const storeDir = path.join(tmpDir, ".agents", "skills", "argent-create-flow");

    writeFile(path.join(storeDir, "SKILL.md"), "skill");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.symlinkSync(
      path.relative(targetDir, path.join(tmpDir, ".agents", "skills", "argent-create-flow")),
      path.join(targetDir, "argent-create-flow")
    );
    writeFile(path.join(targetDir, "argent-react-native-optimization", "SKILL.md"), "argent");
    writeFile(path.join(targetDir, "react-native-optimization", "SKILL.md"), "unrelated");
    writeFile(path.join(targetDir, "vendor-skill", "SKILL.md"), "vendor");

    const result = removeBundledSkillInstalls(
      ["argent-create-flow", "argent-react-native-optimization"],
      targetDir
    );

    expect(result.removedPaths.sort()).toEqual([
      "argent-create-flow",
      "argent-react-native-optimization",
    ]);
    expect(fs.existsSync(path.join(targetDir, "argent-create-flow"))).toBe(false);
    expect(fs.existsSync(path.join(targetDir, "argent-react-native-optimization"))).toBe(false);
    expect(fs.existsSync(path.join(targetDir, "react-native-optimization"))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, "vendor-skill"))).toBe(true);
    expect(fs.existsSync(storeDir)).toBe(true);
  });

  it("removes only Argent entries from skills-lock.json", () => {
    const lockPath = path.join(tmpDir, "skills-lock.json");
    writeFile(
      lockPath,
      JSON.stringify(
        {
          version: 1,
          skills: {
            "argent-create-flow": { source: "argent" },
            "argent-react-native-optimization": { source: "argent" },
            "react-native-optimization": { source: "vendor" },
            "vendor-skill": { source: "vendor" },
          },
        },
        null,
        2
      )
    );

    const result = cleanupSkillsLockFile(lockPath, [
      "argent-create-flow",
      "argent-react-native-optimization",
    ]);

    expect(result).toEqual({
      removedSkills: ["argent-create-flow", "argent-react-native-optimization"],
      removedFile: false,
    });

    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    expect(parsed.skills).toEqual({
      "react-native-optimization": { source: "vendor" },
      "vendor-skill": { source: "vendor" },
    });
  });

  it("deletes skills-lock.json when only Argent entries remain", () => {
    const lockPath = path.join(tmpDir, "skills-lock.json");
    writeFile(
      lockPath,
      JSON.stringify(
        {
          version: 1,
          skills: {
            "argent-create-flow": { source: "argent" },
          },
        },
        null,
        2
      )
    );

    const result = cleanupSkillsLockFile(lockPath, ["argent-create-flow"]);

    expect(result).toEqual({
      removedSkills: ["argent-create-flow"],
      removedFile: true,
    });
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});

// ── Bundled content pruning ───────────────────────────────────────────────────

describe("uninstall — prune bundled content", () => {
  it("removes only Argent-owned files and keeps unrelated content", () => {
    const bundledDir = path.join(tmpDir, "bundled");
    const targetDir = path.join(tmpDir, ".claude", "agents");

    writeFile(path.join(bundledDir, "argent-environment-inspector.md"));
    writeFile(path.join(bundledDir, "references", "quality-control-checklist.md"));

    writeFile(path.join(targetDir, "argent-environment-inspector.md"), "argent");
    writeFile(path.join(targetDir, "other-vendor.md"), "vendor");
    writeFile(path.join(targetDir, "references", "quality-control-checklist.md"), "argent");
    writeFile(path.join(targetDir, "references", "vendor-checklist.md"), "vendor");
    writeFile(path.join(targetDir, "custom", "notes.md"), "user");

    const result = removeBundledContent(bundledDir, targetDir);

    expect(result.removedPaths.sort()).toEqual(
      [
        "argent-environment-inspector.md",
        path.join("references", "quality-control-checklist.md"),
      ].sort()
    );
    expect(result.removedRoot).toBe(false);

    expect(fs.existsSync(path.join(targetDir, "argent-environment-inspector.md"))).toBe(false);
    expect(fs.existsSync(path.join(targetDir, "references", "quality-control-checklist.md"))).toBe(
      false
    );
    expect(fs.existsSync(path.join(targetDir, "other-vendor.md"))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, "references", "vendor-checklist.md"))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, "custom", "notes.md"))).toBe(true);
  });

  it("removes now-empty directories after deleting Argent content", () => {
    const bundledDir = path.join(tmpDir, "bundled");
    const targetDir = path.join(tmpDir, ".cursor", "rules");

    writeFile(path.join(bundledDir, "argent.md"));
    writeFile(path.join(bundledDir, "nested", "guide.md"));
    writeFile(path.join(targetDir, "argent.md"), "argent");
    writeFile(path.join(targetDir, "nested", "guide.md"), "argent");

    const result = removeBundledContent(bundledDir, targetDir);

    expect(result.removedPaths.sort()).toEqual(
      ["argent.md", path.join("nested", "guide.md")].sort()
    );
    expect(result.removedRoot).toBe(true);
    expect(fs.existsSync(targetDir)).toBe(false);
  });

  it("handles missing source or target directories gracefully", () => {
    const result = removeBundledContent(path.join(tmpDir, "missing"), path.join(tmpDir, "target"));
    expect(result).toEqual({ removedPaths: [], removedRoot: false });
  });
});

describe("uninstall — local (committable) mode package removal", () => {
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  beforeEach(() => {
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
  });

  function stageLocalProject(): void {
    fs.mkdirSync(path.join(tmpDir, ".argent"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".argent", "install.json"),
      JSON.stringify({ mode: "local", package: "@swmansion/argent" })
    );
    const pkgDir = path.join(tmpDir, "node_modules", "@swmansion", "argent");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "@swmansion/argent", version: "1.0.0" })
    );
    fs.writeFileSync(path.join(tmpDir, "package-lock.json"), "{}");
  }

  it("removes the local devDependency and NEVER the global package", async () => {
    stageLocalProject();
    process.chdir(tmpDir);

    await uninstall(["--yes"]);

    const calls = childProcessMock.execFileSync.mock.calls as Array<
      [string, string[], { cwd?: string }?]
    >;
    // Local devDep removal happened: `npm uninstall <pkg>` with cwd, no -g.
    const localCall = calls.find(
      ([bin, args]) =>
        bin === "npm" &&
        Array.isArray(args) &&
        args.includes("uninstall") &&
        args.includes("@swmansion/argent") &&
        !args.includes("-g")
    );
    expect(localCall).toBeTruthy();
    expect(localCall![2]?.cwd).toBeTruthy();

    // No -g call even though the mocked PATH probe reports a global install —
    // local mode must never nuke the user's shared global tool.
    // `uninstall` as well as `-g`: the verification asks `npm root -g` too.
    const globalCall = calls.find(
      ([, args]) => Array.isArray(args) && args.includes("-g") && args.includes("uninstall")
    );
    expect(globalCall).toBeFalsy();

    expect(telemetryMock.track).toHaveBeenCalledWith(
      "installation:cli_uninstall_complete",
      expect.objectContaining({ install_mode: "local", has_uninstalled_package: true })
    );
  });

  it("removes the local-mode install record (.argent/install.json) during prune", async () => {
    stageLocalProject();
    process.chdir(tmpDir);

    await uninstall(["--yes"]);

    expect(fs.existsSync(path.join(tmpDir, ".argent", "install.json"))).toBe(false);
  });

  it("keeps the local telemetry state on a local-only removal (global install retained)", async () => {
    stageLocalProject();
    process.chdir(tmpDir);

    await uninstall(["--yes"]);

    // The local devDependency was removed, but the global install (and other
    // projects) remain in use — the local telemetry state must stay.
    expect(telemetryMock.track).toHaveBeenCalledWith(
      "installation:cli_uninstall_complete",
      expect.objectContaining({ has_uninstalled_package: true })
    );
    expect(telemetryMock.resetLocalTelemetryState).not.toHaveBeenCalled();
  });

  it("resets the local telemetry state when the removed local install was the last one", async () => {
    stageLocalProject();
    process.chdir(tmpDir);
    // No global argent anywhere: this devDependency is the machine's last known
    // install, so removing it must reset local telemetry like a global uninstall.
    childProcessMock.execSync.mockImplementation(() => {
      throw new Error("not found");
    });

    await uninstall(["--yes"]);

    expect(telemetryMock.track).toHaveBeenCalledWith(
      "installation:cli_uninstall_complete",
      expect.objectContaining({ has_uninstalled_package: true })
    );
    expect(telemetryMock.resetLocalTelemetryState).toHaveBeenCalledWith();
  });

  it("--local skips the package removal when the project never opted into argent", async () => {
    // Resolvable copy with no committed record or manifest declaration (hoisted
    // transitive dep / workspace symlink) — removal would rewrite files the user
    // never opted into.
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "host" }));
    fs.writeFileSync(path.join(tmpDir, "package-lock.json"), "{}");
    const pkgDir = path.join(tmpDir, "node_modules", "@swmansion", "argent");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "@swmansion/argent", version: "1.0.0" })
    );
    process.chdir(tmpDir);

    await uninstall(["--yes", "--local"]);

    const calls = childProcessMock.execFileSync.mock.calls as Array<[string, string[]]>;
    expect(calls.some(([, args]) => Array.isArray(args) && args.includes("uninstall"))).toBe(false);
    expect(fs.existsSync(path.join(pkgDir, "package.json"))).toBe(true);
    expect(telemetryMock.track).toHaveBeenCalledWith(
      "installation:cli_uninstall_complete",
      expect.objectContaining({ has_uninstalled_package: false })
    );
  });
});

// ── Scoped config cleanup (scopesToClean) ─────────────────────────────────────
// Cleanup must spare the scopes that keep a RETAINED install wired up, on
// implicit defaults as well as explicit flags. HOME is the temp dir; the project
// lives in a subdir so project- and global-scope config paths never collide
// (Cursor uses .cursor/mcp.json for both).

describe("uninstall — scoped config cleanup", () => {
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  let projDir: string;
  beforeEach(() => {
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;
    projDir = path.join(tmpDir, "proj");
    fs.mkdirSync(projDir, { recursive: true });
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
  });

  function stageProject(opts: { materialized: boolean }): void {
    writeFile(
      path.join(projDir, "package.json"),
      JSON.stringify({ name: "proj", devDependencies: { "@swmansion/argent": "^1.0.0" } })
    );
    writeFile(
      path.join(projDir, ".argent", "install.json"),
      JSON.stringify({ mode: "local", package: "@swmansion/argent" })
    );
    if (opts.materialized) {
      writeFile(
        path.join(projDir, "node_modules", "@swmansion", "argent", "package.json"),
        JSON.stringify({ name: "@swmansion/argent", version: "1.0.0" })
      );
    }
  }

  function stageConfigs(): { projectMcp: string; globalCursor: string } {
    const projectMcp = path.join(projDir, ".mcp.json");
    const globalCursor = path.join(tmpDir, ".cursor", "mcp.json");
    writeFile(projectMcp, JSON.stringify({ mcpServers: { argent: getMcpEntry() } }));
    writeFile(globalCursor, JSON.stringify({ mcpServers: { argent: getMcpEntry() } }));
    return { projectMcp, globalCursor };
  }

  // The adapters delete a config file that becomes empty after removing the
  // argent entry, so "file gone" also reads as "entry removed".
  function hasArgentEntry(configPath: string): boolean {
    if (!fs.existsSync(configPath)) return false;
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    return Boolean(parsed.mcpServers && "argent" in parsed.mcpServers);
  }

  it("coexistence --yes removes the local install but keeps the global install's configs", async () => {
    stageProject({ materialized: true });
    const { projectMcp, globalCursor } = stageConfigs();
    process.chdir(projDir);

    await uninstall(["--yes"]);

    // Project-scope entry (runs the removed local copy) is gone…
    expect(hasArgentEntry(projectMcp)).toBe(false);
    // …but the RETAINED global install stays wired up in global scope.
    expect(hasArgentEntry(globalCursor)).toBe(true);

    const calls = childProcessMock.execFileSync.mock.calls as Array<[string, string[]]>;
    expect(calls.some(([, args]) => args.includes("-g") && args.includes("uninstall"))).toBe(false);
  });

  it("--global keeps the committed project entries and the local-mode record", async () => {
    stageProject({ materialized: true });
    const { projectMcp, globalCursor } = stageConfigs();
    process.chdir(projDir);

    await uninstall(["--yes", "--global"]);

    // The retained local install's committed files survive…
    expect(hasArgentEntry(projectMcp)).toBe(true);
    expect(fs.existsSync(path.join(projDir, ".argent", "install.json"))).toBe(true);
    // …while the removed global install is unwired and uninstalled.
    expect(hasArgentEntry(globalCursor)).toBe(false);
    const calls = childProcessMock.execFileSync.mock.calls as Array<[string, string[]]>;
    expect(calls.some(([, args]) => args.includes("-g"))).toBe(true);
  });

  it("fresh clone --yes (record, dep not materialized) removes the present global but keeps committed team files", async () => {
    stageProject({ materialized: false });
    const { projectMcp, globalCursor } = stageConfigs();
    process.chdir(projDir);

    await uninstall(["--yes"]);

    // The present global install was the target: unwired and uninstalled…
    expect(hasArgentEntry(globalCursor)).toBe(false);
    const calls = childProcessMock.execFileSync.mock.calls as Array<[string, string[]]>;
    expect(calls.some(([, args]) => args.includes("-g"))).toBe(true);
    // …while the not-yet-materialized local mode's committed files survive.
    expect(hasArgentEntry(projectMcp)).toBe(true);
    expect(fs.existsSync(path.join(projDir, ".argent", "install.json"))).toBe(true);
  });
});

describe("uninstall — a project shim ahead of the global install on PATH", () => {
  // `npm run`, `npx` and direnv all prepend node_modules/.bin, so the first
  // `which -a argent` hit is the project's copy — which npm's global removal
  // neither touches nor should be read as the global one surviving.
  let savedHome: string | undefined;
  let globalPkg: string;

  beforeEach(() => {
    savedHome = process.env.HOME;
    process.env.HOME = tmpDir;
    const globalRoot = path.join(tmpDir, "npm-global", "lib", "node_modules");
    globalPkg = path.join(globalRoot, "@swmansion", "argent");
    writeFile(
      path.join(globalPkg, "package.json"),
      JSON.stringify({ name: "@swmansion/argent", version: "9.9.9" })
    );
    writeFile(path.join(globalPkg, "dist", "cli.js"), "#!/usr/bin/env node\n");
    const globalBin = path.join(tmpDir, "npm-global", "bin", "argent");
    fs.mkdirSync(path.dirname(globalBin), { recursive: true });
    fs.symlinkSync(path.join(globalPkg, "dist", "cli.js"), globalBin);

    const localPkg = path.join(tmpDir, "proj", "node_modules", "@swmansion", "argent");
    writeFile(
      path.join(localPkg, "package.json"),
      JSON.stringify({ name: "@swmansion/argent", version: "9.9.9" })
    );
    writeFile(path.join(localPkg, "dist", "cli.js"), "#!/usr/bin/env node\n");
    const localBin = path.join(tmpDir, "proj", "node_modules", ".bin", "argent");
    fs.mkdirSync(path.dirname(localBin), { recursive: true });
    fs.symlinkSync(path.join(localPkg, "dist", "cli.js"), localBin);

    // The project shim first, the global install second.
    childProcessMock.execSync.mockImplementation(
      () => [localBin, globalBin].filter((b) => fs.existsSync(b)).join("\n") + "\n"
    );
    childProcessMock.execFileSync.mockImplementation(((_bin: string, args: string[]) => {
      if (!Array.isArray(args)) return undefined;
      if (args.includes("root") && args.includes("-g")) return `${globalRoot}\n`;
      if (args.includes("uninstall") && args.includes("-g")) {
        fs.rmSync(globalPkg, { recursive: true, force: true });
        fs.rmSync(globalBin, { force: true });
      }
      return undefined;
    }) as never);
    process.chdir(tmpDir);
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  it("reports the removal npm performed, not the shim PATH still answers with", async () => {
    await uninstall(["--yes", "--global"]);

    expect(fs.existsSync(globalPkg)).toBe(false);
    const errors = vi.mocked(log.error).mock.calls.map(([m]) => m as string);
    expect(errors.some((m) => m.includes("global uninstall failed"))).toBe(false);
    expect(vi.mocked(log.success).mock.calls.map(([m]) => m as string)).toContain(
      "Removed global package."
    );
    expect(telemetryMock.resetLocalTelemetryState).toHaveBeenCalled();
  });

  it("stops the tool server of the install it removed, not the shim's", async () => {
    const removed = fs.realpathSync(globalPkg);
    const shim = fs.realpathSync(path.join(tmpDir, "proj", "node_modules", "@swmansion", "argent"));

    await uninstall(["--yes", "--global"]);

    expect(toolsClientMock.killToolServerForInstallDir).toHaveBeenCalledWith(removed);
    expect(toolsClientMock.killToolServerForInstallDir).not.toHaveBeenCalledWith(shim);
  });
});

describe("uninstall — an argent npm did not install", () => {
  // A pnpm shim, a Nix profile wrapper or a Homebrew link puts argent on PATH
  // with no npm-owned package behind it. `npm uninstall -g` exits 0 having done
  // nothing, and the machine-wide reset below must not fire under an install
  // that is still there.
  let savedHome: string | undefined;
  let shim: string;

  beforeEach(() => {
    savedHome = process.env.HOME;
    process.env.HOME = tmpDir;
    // A shell script, not a symlink: nothing resolves it back to a package.
    shim = path.join(tmpDir, "pnpm-home", "bin", "argent");
    writeFile(shim, '#!/bin/sh\nexec node /elsewhere/cli.js "$@"\n');
    const globalRoot = path.join(tmpDir, "npm-global", "lib", "node_modules");
    fs.mkdirSync(globalRoot, { recursive: true });
    childProcessMock.execSync.mockImplementation(() => `${shim}\n`);
    childProcessMock.execFileSync.mockImplementation(((_bin: string, args: string[]) => {
      if (Array.isArray(args) && args.includes("root") && args.includes("-g"))
        return `${globalRoot}\n`;
      return undefined; // `npm uninstall -g` prints "up to date" and exits 0.
    }) as never);
    process.chdir(tmpDir);
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  it("does not announce a removal npm could not have made", async () => {
    await uninstall(["--yes", "--global"]);

    expect(fs.existsSync(shim)).toBe(true);
    expect(vi.mocked(log.success).mock.calls.map(([m]) => m as string)).not.toContain(
      "Removed global package."
    );
    expect(telemetryMock.resetLocalTelemetryState).not.toHaveBeenCalled();
    expect(telemetryMock.track).toHaveBeenCalledWith(
      "installation:cli_uninstall_complete",
      expect.objectContaining({
        error_code: "UNINSTALL_PACKAGE_ACTION_FAILED",
        has_uninstalled_package: false,
      })
    );
    // The closing line is the last thing the user reads, so it cannot say the
    // removal happened.
    expect(vi.mocked(outro).mock.lastCall?.[0]).toContain("still installed globally");
  });

  it("still removes the project devDependency it was also asked to remove", async () => {
    // The global target is listed first, so giving up on it would take the
    // local removal with it.
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "proj", devDependencies: { "@swmansion/argent": "^9.9.9" } })
    );
    writeFile(
      path.join(tmpDir, "node_modules", "@swmansion", "argent", "package.json"),
      JSON.stringify({ name: "@swmansion/argent", version: "9.9.9" })
    );

    await uninstall(["--yes", "--global", "--local"]);

    expect(vi.mocked(log.success).mock.calls.map(([m]) => m as string)).toContain(
      "Removed local package."
    );
    expect(vi.mocked(log.error).mock.calls.map(([m]) => m as string)).toContainEqual(
      expect.stringContaining("npm has nothing at")
    );
  });
});

describe("uninstall — a link whose source was deleted", () => {
  // `npm install -g <folder>` then `rm -rf` the checkout: the global entry is a
  // dangling symlink, still npm's to remove.
  let savedHome: string | undefined;
  let entry: string;

  beforeEach(() => {
    savedHome = process.env.HOME;
    process.env.HOME = tmpDir;
    const globalRoot = path.join(tmpDir, "npm-global", "lib", "node_modules");
    entry = path.join(globalRoot, "@swmansion", "argent");
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.symlinkSync(path.join(tmpDir, "deleted-checkout"), entry);
    childProcessMock.execSync.mockImplementation(() => `${tmpDir}/npm-global/bin/argent\n`);
    childProcessMock.execFileSync.mockImplementation(((_bin: string, args: string[]) => {
      if (!Array.isArray(args)) return undefined;
      if (args.includes("root") && args.includes("-g")) return `${globalRoot}\n`;
      if (args.includes("uninstall") && args.includes("-g")) fs.rmSync(entry, { force: true });
      return undefined;
    }) as never);
    process.chdir(tmpDir);
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  it("reports the removal instead of denying npm ever had it", async () => {
    await uninstall(["--yes", "--global"]);

    expect(vi.mocked(log.success).mock.calls.map(([m]) => m as string)).toContain(
      "Removed global package."
    );
    // realpath throws on it, so the entry npm made is the only directory left
    // to scope the teardown to.
    expect(toolsClientMock.killToolServerForInstallDir).toHaveBeenCalledWith(entry);
  });
});

describe("uninstall — a removal the package manager refused", () => {
  // `npm uninstall -g` under a read-only prefix exits 243/EACCES — the machine
  // class this whole preflight exists for. The run still owes the user the
  // other removal it was asked for, and an outro either way.
  let savedHome: string | undefined;
  let localPkg: string;

  beforeEach(() => {
    savedHome = process.env.HOME;
    process.env.HOME = tmpDir;
    const globalRoot = path.join(tmpDir, "npm-global", "lib", "node_modules");
    writeFile(
      path.join(globalRoot, "@swmansion", "argent", "package.json"),
      JSON.stringify({ name: "@swmansion/argent", version: "9.9.9" })
    );
    fs.mkdirSync(path.join(tmpDir, ".argent"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".argent", "install.json"),
      JSON.stringify({ mode: "local", package: "@swmansion/argent" })
    );
    localPkg = path.join(tmpDir, "node_modules", "@swmansion", "argent");
    writeFile(
      path.join(localPkg, "package.json"),
      JSON.stringify({ name: "@swmansion/argent", version: "1.0.0" })
    );
    childProcessMock.execFileSync.mockImplementation(((_bin: string, args: string[]) => {
      if (!Array.isArray(args)) return undefined;
      if (args.includes("root") && args.includes("-g")) return `${globalRoot}\n`;
      if (args.includes("uninstall") && args.includes("-g")) throw new Error("EACCES");
      if (args.includes("uninstall")) fs.rmSync(localPkg, { recursive: true, force: true });
      return undefined;
    }) as never);
    process.chdir(tmpDir);
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  it("still removes the other target, and says which one is left", async () => {
    await uninstall(["--yes", "--global", "--local"]);

    const errors = vi.mocked(log.error).mock.calls.map(([m]) => m as string);
    expect(errors.some((m) => m.includes("global uninstall failed"))).toBe(true);
    expect(fs.existsSync(localPkg)).toBe(false);
    expect(
      vi
        .mocked(outro)
        .mock.calls.map(([m]) => m as string)
        .join("")
    ).toContain("still installed globally");
    expect(telemetryMock.track).toHaveBeenCalledWith(
      "installation:cli_uninstall_complete",
      expect.objectContaining({ error_code: "UNINSTALL_PACKAGE_ACTION_FAILED" })
    );
  });
});

describe("uninstall — npm's directory asked on a run that would remove with pnpm", () => {
  // `pnpm dlx @swmansion/argent uninstall`: npm's global directory is not a
  // place `pnpm remove -g` can reach, so finding an install there is not
  // finding one this run can take away.
  let savedHome: string | undefined;
  let globalPkg: string;

  beforeEach(() => {
    savedHome = process.env.HOME;
    process.env.HOME = tmpDir;
    process.env.npm_config_user_agent = "pnpm/9.1.0 npm/? node/v22.0.0 darwin arm64";
    const globalRoot = path.join(tmpDir, "npm-global", "lib", "node_modules");
    globalPkg = path.join(globalRoot, "@swmansion", "argent");
    writeFile(
      path.join(globalPkg, "package.json"),
      JSON.stringify({ name: "@swmansion/argent", version: "9.9.9" })
    );
    childProcessMock.execSync.mockImplementation(() => {
      throw new Error("not found");
    });
    childProcessMock.execFileSync.mockImplementation(((_bin: string, args: string[]) =>
      Array.isArray(args) && args.includes("root") && args.includes("-g")
        ? `${globalRoot}\n`
        : undefined) as never);
    process.chdir(tmpDir);
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    delete process.env.npm_config_user_agent;
  });

  it("does not report removing what pnpm was never going to reach", async () => {
    await uninstall(["--yes"]);

    const ran = (childProcessMock.execFileSync.mock.calls as Array<[string, string[]]>).some(
      ([bin, args]) => bin === "pnpm" && Array.isArray(args) && args.includes("-g")
    );
    expect(ran).toBe(false);
    expect(fs.existsSync(globalPkg)).toBe(true);
    expect(vi.mocked(log.success).mock.calls.map(([m]) => m as string)).not.toContain(
      "Removed global package."
    );
  });
});

describe("uninstall — machine-wide state under a global install only npm can see", () => {
  // The install `argent init`'s prefix recovery makes: PATH cannot see it until
  // the user adds its bin directory, and removing the project's devDependency
  // must not clear the telemetry identity out from under it.
  let savedHome: string | undefined;
  let localPkg: string;

  beforeEach(() => {
    savedHome = process.env.HOME;
    process.env.HOME = tmpDir;
    const globalRoot = path.join(tmpDir, "npm-global", "lib", "node_modules");
    writeFile(
      path.join(globalRoot, "@swmansion", "argent", "package.json"),
      JSON.stringify({ name: "@swmansion/argent", version: "9.9.9" })
    );
    fs.mkdirSync(path.join(tmpDir, ".argent"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".argent", "install.json"),
      JSON.stringify({ mode: "local", package: "@swmansion/argent" })
    );
    localPkg = path.join(tmpDir, "node_modules", "@swmansion", "argent");
    writeFile(
      path.join(localPkg, "package.json"),
      JSON.stringify({ name: "@swmansion/argent", version: "1.0.0" })
    );
    childProcessMock.execSync.mockImplementation(() => {
      throw new Error("not found");
    });
    childProcessMock.execFileSync.mockImplementation(((_bin: string, args: string[]) => {
      if (!Array.isArray(args)) return undefined;
      if (args.includes("root") && args.includes("-g")) return `${globalRoot}\n`;
      if (args.includes("uninstall") && !args.includes("-g"))
        fs.rmSync(localPkg, { recursive: true, force: true });
      return undefined;
    }) as never);
    process.chdir(tmpDir);
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  it("keeps the telemetry identity the global install still answers for", async () => {
    await uninstall(["--yes", "--local"]);

    expect(fs.existsSync(localPkg)).toBe(false);
    expect(telemetryMock.resetLocalTelemetryState).not.toHaveBeenCalled();
  });
});

describe("uninstall — npm answers for a global directory it holds nothing in", () => {
  // `npm root -g` names a directory whether or not anything is under it, so the
  // answer alone is not an install to remove.
  let savedHome: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
    process.env.HOME = tmpDir;
    const globalRoot = path.join(tmpDir, "npm-global", "lib", "node_modules");
    fs.mkdirSync(globalRoot, { recursive: true });
    childProcessMock.execSync.mockImplementation(() => {
      throw new Error("not found");
    });
    childProcessMock.execFileSync.mockImplementation(((_bin: string, args: string[]) =>
      Array.isArray(args) && args.includes("root") && args.includes("-g")
        ? `${globalRoot}\n`
        : undefined) as never);
    process.chdir(tmpDir);
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  it("finds nothing to remove rather than offering a removal of nothing", async () => {
    await uninstall(["--yes"]);

    expect(childProcessMock.execFileSync).not.toHaveBeenCalledWith(
      "npm",
      expect.arrayContaining(["uninstall", "-g"])
    );
    expect(
      vi
        .mocked(log.info)
        .mock.calls.map(([m]) => m as string)
        .join("")
    ).toContain("no matching @swmansion/argent install detected");
  });
});

describe("uninstall — a global install another package manager owns", () => {
  // pnpm's global directory has a shape argent cannot name, so its removal is
  // not judged against npm's — which holds nothing, and would read as a no-op.
  let savedHome: string | undefined;
  let savedAgentHere: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
    savedAgentHere = process.env.npm_config_user_agent;
    process.env.HOME = tmpDir;
    process.env.npm_config_user_agent = "pnpm/10.0.0 npm/? node/v24.0.0 darwin arm64";
    const pnpmPkg = path.join(tmpDir, "pnpm-global", "5", "node_modules", "@swmansion", "argent");
    writeFile(
      path.join(pnpmPkg, "package.json"),
      JSON.stringify({ name: "@swmansion/argent", version: "9.9.9" })
    );
    const bin = path.join(tmpDir, "pnpm-home", "argent");
    writeFile(bin, "#!/bin/sh\n");
    fs.mkdirSync(path.join(tmpDir, "npm-global", "lib", "node_modules"), { recursive: true });
    childProcessMock.execSync.mockImplementation(() => `${bin}\n`);
    childProcessMock.execFileSync.mockImplementation(((_bin: string, args: string[]) => {
      if (Array.isArray(args) && args.includes("root") && args.includes("-g"))
        return `${path.join(tmpDir, "npm-global", "lib", "node_modules")}\n`;
      return undefined;
    }) as never);
    process.chdir(tmpDir);
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedAgentHere === undefined) delete process.env.npm_config_user_agent;
    else process.env.npm_config_user_agent = savedAgentHere;
  });

  it("reports the removal pnpm made rather than what npm's directory holds", async () => {
    await uninstall(["--yes", "--global"]);

    expect(childProcessMock.execFileSync).toHaveBeenCalledWith(
      "pnpm",
      expect.arrayContaining(["remove", "-g"]),
      expect.anything()
    );
    expect(vi.mocked(log.success).mock.calls.map(([m]) => m as string)).toContain(
      "Removed global package."
    );
  });
});

describe("uninstall — a global install the shells cannot see yet", () => {
  // What `argent init`'s prefix recovery leaves behind: installed under a new
  // prefix whose bin directory is not on PATH until the user adds the line.
  let savedHome: string | undefined;
  let packageDir: string;
  let realPackageDir: string;

  beforeEach(() => {
    savedHome = process.env.HOME;
    process.env.HOME = tmpDir;
    const globalRoot = path.join(tmpDir, "npm-global", "lib", "node_modules");
    packageDir = path.join(globalRoot, "@swmansion", "argent");
    writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "@swmansion/argent", version: "9.9.9" })
    );
    realPackageDir = fs.realpathSync(packageDir);
    // Nothing on PATH at all.
    childProcessMock.execSync.mockImplementation(() => {
      throw new Error("not found");
    });
    childProcessMock.execFileSync.mockImplementation(((_bin: string, args: string[]) => {
      if (!Array.isArray(args)) return undefined;
      if (args.includes("root") && args.includes("-g")) return `${globalRoot}\n`;
      if (args.includes("uninstall") && args.includes("-g"))
        fs.rmSync(packageDir, { recursive: true, force: true });
      return undefined;
    }) as never);
    process.chdir(tmpDir);
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  it("removes what npm owns instead of reporting nothing to remove", async () => {
    await uninstall(["--yes", "--global"]);

    expect(fs.existsSync(packageDir)).toBe(false);
    expect(vi.mocked(log.success).mock.calls.map(([m]) => m as string)).toContain(
      "Removed global package."
    );
    // The teardown needs a directory to scope itself to, and PATH has none.
    expect(toolsClientMock.killToolServerForInstallDir).toHaveBeenCalledWith(realPackageDir);
  });
});
