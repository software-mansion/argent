import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { uninstall } from "../src/uninstall.js";

/**
 * Issue #622: `uninstall` prunes the workspace and only then runs
 * `npm uninstall -g`. When the global prefix is root-owned (the usual
 * `sudo npm i -g` install) that removal dies on EACCES, and the user is left
 * with no configuration and a package that is still installed — and, before
 * this fix, an exit code of 0 saying it all went fine.
 *
 * These tests pin the contract that makes that impossible: nothing irreversible
 * runs until we know the removal can work, and a run that did not finish says so
 * to the shell.
 */

const telemetryMock = vi.hoisted(() => ({
  init: vi.fn(),
  track: vi.fn(),
  resetLocalTelemetryState: vi.fn().mockResolvedValue({ localIdRemoved: true, noticeReset: true }),
  shutdown: vi.fn().mockResolvedValue(undefined),
  warmTelemetryIdentitySync: vi.fn(),
}));

const childProcessMock = vi.hoisted(() => ({
  execSync: vi.fn(() => "/usr/local/bin/argent\n"),
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

const promptsMock = vi.hoisted(() => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  confirm: vi.fn(async () => true),
  multiselect: vi.fn(),
  isCancel: vi.fn(() => false),
  note: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
    step: vi.fn(),
    success: vi.fn(),
  },
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
}));

vi.mock("@argent/telemetry", () => telemetryMock);
vi.mock("node:child_process", () => childProcessMock);
vi.mock("@clack/prompts", () => promptsMock);
vi.mock("@argent/tools-client", () => ({
  killToolServer: vi.fn().mockResolvedValue(undefined),
  killToolServerForInstallDir: vi.fn().mockResolvedValue(0),
}));
vi.mock("../src/telemetry-finalize.js", () => ({
  finalizeTelemetry: vi.fn(async (capture: () => void) => capture()),
}));

// The probe reads real filesystem permissions; force its verdict here so these
// tests describe the FLOW rather than the machine they run on. The probe's own
// behavior is covered in uninstall-permissions.test.ts.
const probeState = vi.hoisted(() => ({
  verdict: "writable" as "writable" | "blocked" | "unknown",
}));

vi.mock("../src/utils.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/utils.js")>();
  return {
    ...original,
    isGloballyInstalled: vi.fn(() => true),
    probeGlobalPackageRemoval: vi.fn(() => ({
      verdict: probeState.verdict,
      parentDir: "/usr/local/lib/node_modules/@swmansion",
    })),
  };
});

class ExitSentinel extends Error {
  constructor(public readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

let tmpDir: string;
let projDir: string;
let originalCwd: string;
let savedHome: string | undefined;
let savedUserProfile: string | undefined;
let exitSpy: ReturnType<typeof vi.spyOn>;

/** Workspace content the prune would destroy, staged so we can assert it survives. */
function stageWorkspaceConfig(): { mcpPath: string; skillPath: string } {
  const mcpPath = path.join(projDir, ".mcp.json");
  fs.writeFileSync(
    mcpPath,
    JSON.stringify({ mcpServers: { argent: { command: "argent", args: ["mcp"] } } }, null, 2)
  );
  const skillDir = path.join(projDir, ".agents", "skills", "argent-device-interact");
  fs.mkdirSync(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(skillPath, "# argent-device-interact\n");
  return { mcpPath, skillPath };
}

function npmUninstallCalls(): unknown[][] {
  return childProcessMock.execFileSync.mock.calls.filter((call) => {
    const args = call[1];
    return Array.isArray(args) && args.includes("uninstall");
  }) as unknown[][];
}

function loggedText(): string {
  const all = [
    ...promptsMock.log.error.mock.calls,
    ...promptsMock.log.info.mock.calls,
    ...promptsMock.log.warn.mock.calls,
  ];
  return all.map((call) => String(call[0])).join("\n");
}

beforeEach(() => {
  vi.clearAllMocks();
  probeState.verdict = "writable";
  childProcessMock.execSync.mockReturnValue("/usr/local/bin/argent\n");
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-uninstall-preflight-"));
  originalCwd = process.cwd();
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpDir;
  process.env.USERPROFILE = tmpDir;
  projDir = path.join(tmpDir, "proj");
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, "package.json"), JSON.stringify({ name: "proj" }));
  fs.mkdirSync(path.join(projDir, ".git"), { recursive: true });
  process.chdir(projDir);
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitSentinel(code);
  }) as never);
});

afterEach(() => {
  exitSpy.mockRestore();
  process.chdir(originalCwd);
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedUserProfile;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("uninstall preflight — a removal that cannot work destroys nothing", () => {
  it("keeps the workspace intact and exits 1 when the global prefix is not writable", async () => {
    probeState.verdict = "blocked";
    const { mcpPath, skillPath } = stageWorkspaceConfig();
    const mcpBefore = fs.readFileSync(mcpPath, "utf8");

    await expect(uninstall(["--yes"])).rejects.toThrow(ExitSentinel);

    // The whole point: the config belongs to an install that is still here.
    expect(fs.existsSync(mcpPath)).toBe(true);
    expect(fs.readFileSync(mcpPath, "utf8")).toBe(mcpBefore);
    expect(fs.existsSync(skillPath)).toBe(true);
    // And we never even asked the package manager.
    expect(npmUninstallCalls()).toHaveLength(0);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("reports the blocked preflight as its own failure, not as a failed subprocess", async () => {
    probeState.verdict = "blocked";

    await expect(uninstall(["--yes"])).rejects.toThrow(ExitSentinel);

    expect(telemetryMock.track).toHaveBeenCalledWith(
      "installation:cli_uninstall_complete",
      expect.objectContaining({
        error_code: "UNINSTALL_PACKAGE_ROOT_NOT_WRITABLE",
        has_pruned_content: false,
        has_uninstalled_package: false,
      })
    );
    // Nothing was removed, so the machine-wide telemetry identity stays put.
    expect(telemetryMock.resetLocalTelemetryState).not.toHaveBeenCalled();
  });

  it("tells the user how to finish the job", async () => {
    probeState.verdict = "blocked";

    await expect(uninstall(["--yes"])).rejects.toThrow(ExitSentinel);

    const text = loggedText();
    expect(text).toMatch(/not writable/);
    if (process.platform === "win32") {
      expect(text).toMatch(/Administrator/);
    } else {
      // `sudo -E` is NOT usable: sudo-rs (Ubuntu 25.10's default) ignores the
      // flag outright, leaving HOME as /root so the user's own global config
      // would be missed. The VAR=value form survives env_reset everywhere.
      expect(text).toContain('sudo HOME="$HOME" argent uninstall --global');
      expect(text).not.toContain("sudo -E");
    }
  });

  it("does not claim the install was never found — it was found, just not removable", async () => {
    probeState.verdict = "blocked";

    await expect(uninstall(["--yes"])).rejects.toThrow(ExitSentinel);

    expect(loggedText()).not.toMatch(/no matching .* install detected/);
  });
});

describe("uninstall preflight — inconclusive readings must not block", () => {
  it('proceeds normally when the probe says "unknown"', async () => {
    // ACLs, exotic mounts, non-npm managers and Windows all land here. Treating
    // "unknown" as "blocked" would refuse uninstalls that work today.
    probeState.verdict = "unknown";
    stageWorkspaceConfig();

    await uninstall(["--yes"]);

    expect(npmUninstallCalls().length).toBeGreaterThan(0);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('proceeds normally when the probe says "writable"', async () => {
    stageWorkspaceConfig();

    await uninstall(["--yes"]);

    expect(npmUninstallCalls().length).toBeGreaterThan(0);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe("uninstall preflight — scoped to the target actually being removed", () => {
  it("leaves a --local run alone even when the global prefix is unwritable", async () => {
    // A user-owned devDependency has nothing to do with the global prefix.
    probeState.verdict = "blocked";
    const nodeModules = path.join(projDir, "node_modules", "@swmansion", "argent");
    fs.mkdirSync(nodeModules, { recursive: true });
    fs.writeFileSync(
      path.join(nodeModules, "package.json"),
      JSON.stringify({ name: "@swmansion/argent", version: "0.0.0" })
    );
    fs.writeFileSync(
      path.join(projDir, "package.json"),
      JSON.stringify({ name: "proj", devDependencies: { "@swmansion/argent": "0.0.0" } })
    );

    await uninstall(["--yes", "--local"]);

    expect(exitSpy).not.toHaveBeenCalled();
    // Whatever ran, it was not a global removal.
    for (const call of npmUninstallCalls()) {
      expect(call[1]).not.toContain("-g");
    }
  });
});

describe("uninstall — a failed removal is reported to the shell", () => {
  it("exits 1 when the package manager fails, instead of reporting success", async () => {
    // The reported symptom's other half: before this fix the command returned 0
    // after a destructive, half-finished run, so `argent uninstall -y && …`
    // carried on as though the package were gone.
    childProcessMock.execFileSync.mockImplementation((bin: string) => {
      if (bin === "npm") throw new Error("Command failed: npm uninstall -g @swmansion/argent");
      return undefined;
    });

    await expect(uninstall(["--yes"])).rejects.toThrow(ExitSentinel);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("names the permission problem when the removal fails on an unwritable prefix", async () => {
    // Nothing to classify from: execShellCommandSync inherits stdio, so npm's
    // stderr went to the terminal and never reaches us. Re-probing is what
    // identifies this without parsing any output.
    let probeCalls = 0;
    probeState.verdict = "writable";
    childProcessMock.execFileSync.mockImplementation((bin: string) => {
      if (bin === "npm") {
        // The prefix turns out to be unwritable only once npm tries.
        probeState.verdict = "blocked";
        probeCalls++;
        throw new Error("Command failed: npm uninstall -g @swmansion/argent");
      }
      return undefined;
    });

    await expect(uninstall(["--yes"])).rejects.toThrow(ExitSentinel);

    expect(probeCalls).toBe(1);
    expect(loggedText()).toMatch(/not writable/);
    expect(telemetryMock.track).toHaveBeenCalledWith(
      "installation:cli_uninstall_complete",
      expect.objectContaining({
        error_code: "UNINSTALL_PACKAGE_ACTION_FAILED",
        failure_spawn_code: "EACCES",
      })
    );
  });

  it("passes other failures through unchanged", async () => {
    probeState.verdict = "writable";
    childProcessMock.execFileSync.mockImplementation((bin: string) => {
      if (bin === "npm") throw new Error("Command failed: ENOTFOUND registry.npmjs.org");
      return undefined;
    });

    await expect(uninstall(["--yes"])).rejects.toThrow(ExitSentinel);

    const text = loggedText();
    expect(text).toMatch(/ENOTFOUND/);
    expect(text).not.toMatch(/not writable/);
  });
});
