import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { update } from "../src/update.js";
import { killToolServer, killToolServerForInstallDir } from "@argent/tools-client";

// Declining the update prompt must cancel + exit 0 without the config refresh
// (entry rewrites, allowlists, stale-config sweep, rules/agents, skills)
// running afterwards.

const telemetryMock = vi.hoisted(() => ({
  init: vi.fn(),
  track: vi.fn(),
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
  confirm: vi.fn(async () => false),
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
vi.mock("../src/first-run-notice.js", () => ({
  resolveTelemetryConsent: vi.fn(async () => ({ kind: "resolved" })),
}));
vi.mock("../src/telemetry-finalize.js", () => ({
  finalizeTelemetry: vi.fn(async (capture: () => void) => capture()),
}));
vi.mock("../src/update-target.js", () => ({
  resolveInstallableUpdateTarget: vi.fn(async () => ({
    latestVersion: "99.0.0",
    targetVersion: "99.0.0",
    minReleaseAgeMs: 0,
  })),
}));
// Mutable install topology — tests flip these to stage "no global install at
// all" or an install under a directory of their own. Mocked at topology.ts
// rather than at the utils.ts barrel that re-exports it, because
// global-prefix.ts imports isGloballyInstalled straight from the leaf.
const topologyState = vi.hoisted(() => ({
  globalInstalled: true,
  packageRoot: null as string | null,
}));

vi.mock("../src/topology.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/topology.js")>();
  return {
    ...original,
    isGloballyInstalled: vi.fn(() => topologyState.globalInstalled),
    // A package root is walked up from the binary PATH names, so there is
    // never one without it.
    getGloballyInstalledPackageRoot: vi.fn(() =>
      topologyState.globalInstalled ? topologyState.packageRoot : null
    ),
  };
});

// The messages are styled with picocolors, which stays on under CI.
// eslint-disable-next-line no-control-regex
const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, "");

class ExitSentinel extends Error {
  constructor(public readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

// A chmod'd directory is the only honest test of the writability preflight, and
// root bypasses the mode bits — the same gate global-prefix.test.ts uses.
const canTestUnwritable = process.platform !== "win32" && process.getuid?.() !== 0;

let tmpDir: string;
let projDir: string;
// Directories a test made unwritable, restored before the teardown removes the
// tree — rmSync cannot unlink a child of a read-only directory.
let readOnlyDirs: string[];
let originalCwd: string;
let savedHome: string | undefined;
let savedUserProfile: string | undefined;
let savedAgent: string | undefined;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // detectPackageManager() reads npm_config_user_agent, so the install/update
  // commands these tests assert on are whichever package manager runs the
  // suite. Unset it to pin the npm shape.
  savedAgent = process.env.npm_config_user_agent;
  delete process.env.npm_config_user_agent;
  vi.clearAllMocks();
  // clearAllMocks keeps implementations, and the tests below install their own
  // on execFileSync — reset it so one test's package-manager stub cannot decide
  // the next test's outcome.
  childProcessMock.execFileSync.mockReset();
  topologyState.globalInstalled = true;
  readOnlyDirs = [];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-update-decline-"));
  topologyState.packageRoot = stageArgentPackage(stagedGlobalRoot(), "1.0.0");
  originalCwd = process.cwd();
  // Sandbox HOME: the accepted-update path runs the real config refresh, which
  // probes (and would rewrite) global-scope configs under the home directory.
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpDir;
  process.env.USERPROFILE = tmpDir;
  projDir = path.join(tmpDir, "proj");
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, "package.json"), JSON.stringify({ name: "proj" }));
  // resolveProjectRoot walks up looking for editor/git markers (NOT
  // package.json) — pin the project root here so a marker staged under the
  // sandbox HOME (e.g. ~/.cursor) can't swallow it.
  fs.mkdirSync(path.join(projDir, ".git"), { recursive: true });
  process.chdir(projDir);
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitSentinel(code);
  }) as never);
});

afterEach(() => {
  for (const dir of readOnlyDirs) {
    try {
      fs.chmodSync(dir, 0o755);
    } catch {
      // Already gone.
    }
  }
  exitSpy.mockRestore();
  process.chdir(originalCwd);
  if (savedAgent === undefined) delete process.env.npm_config_user_agent;
  else process.env.npm_config_user_agent = savedAgent;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedUserProfile;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * A real @swmansion/argent package directory at `version` under the
 * `node_modules` at `root`. Returns the package directory.
 */
function stageArgentPackage(root: string, version: string): string {
  const packageDir = path.join(root, "@swmansion", "argent");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: "@swmansion/argent", version, bin: { argent: "dist/cli.js" } })
  );
  return packageDir;
}

/** The `node_modules` the default staged global install sits under. */
function stagedGlobalRoot(): string {
  return path.join(tmpDir, "global", "lib", "node_modules");
}

function stageReadOnly(dir: string): void {
  fs.chmodSync(dir, 0o555);
  readOnlyDirs.push(dir);
}

describe("update — interactive decline", () => {
  it("cancels and exits 0 without installing or refreshing any config", async () => {
    // A configured project entry the refresh WOULD rewrite (env is stripped by
    // adapter.write, so any rewrite changes the bytes).
    const mcpJson = path.join(projDir, ".mcp.json");
    fs.writeFileSync(
      mcpJson,
      JSON.stringify({
        mcpServers: { argent: { command: "argent", args: ["mcp"], env: { KEEP: "1" } } },
      })
    );
    const before = fs.readFileSync(mcpJson, "utf8");

    await expect(update([])).rejects.toThrow(ExitSentinel);

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(promptsMock.cancel).toHaveBeenCalledWith("Update cancelled.");
    // No install ran, and the decline still completed (not failed) telemetry.
    expect(npmInstallCalls()).toHaveLength(0);
    expect(telemetryMock.track).toHaveBeenCalledWith(
      "installation:cli_update_complete",
      expect.anything()
    );
    // The config refresh never ran: the file the refresh would rewrite is
    // byte-identical.
    expect(fs.readFileSync(mcpJson, "utf8")).toBe(before);
  });

  // The reported Nix bug: the global directory belongs to the store. Asking
  // "update?" there only leads to npm's EACCES, and stopping the tool server
  // for it costs the user a restart for nothing.
  it.skipIf(!canTestUnwritable)(
    "refuses a global update it cannot perform, before asking and before stopping the server",
    async () => {
      const globalRoot = path.join(tmpDir, "store", "lib", "node_modules");
      fs.mkdirSync(globalRoot, { recursive: true });
      stageReadOnly(globalRoot);
      childProcessMock.execFileSync.mockImplementation(((_bin: string, args: string[]) =>
        args[0] === "root" ? `${globalRoot}\n` : undefined) as never);

      await expect(update([])).rejects.toThrow(ExitSentinel);

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(promptsMock.confirm).not.toHaveBeenCalled();
      expect(killToolServerForInstallDir).not.toHaveBeenCalled();
      expect(npmInstallCalls()).toHaveLength(0);
      const errors = promptsMock.log.error.mock.calls.map(([m]) => plain(m as string));
      expect(errors.some((m) => m.includes("cannot update @swmansion/argent globally"))).toBe(true);
      // update only ever runs from an installed argent, so the way out names it.
      expect(errors.some((m) => m.includes("\n    argent init --local"))).toBe(true);
      expect(telemetryMock.track).toHaveBeenCalledWith(
        "installation:package_action",
        expect.objectContaining({
          action: "update_failed",
          error_code: "UPDATE_GLOBAL_PREFIX_UNWRITABLE",
        })
      );
      // The code that reaches the funnel as the run's terminal failure.
      expect(telemetryMock.track).toHaveBeenCalledWith(
        "installation:cli_update_fail",
        expect.objectContaining({ error_code: "UPDATE_GLOBAL_PREFIX_UNWRITABLE" })
      );
    }
  );

  // npm links its commands into <prefix>/bin, which the package-directory probe
  // never walks — and an update writes there too.
  it.skipIf(!canTestUnwritable)(
    "refuses a global update whose bin directory cannot be written either",
    async () => {
      const prefix = path.join(tmpDir, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const binDir = path.join(prefix, "bin");
      fs.mkdirSync(globalRoot, { recursive: true });
      fs.mkdirSync(binDir, { recursive: true });
      stageReadOnly(binDir);
      childProcessMock.execFileSync.mockImplementation(((_bin: string, args: string[]) => {
        if (args[0] === "root") return `${globalRoot}\n`;
        if (args[0] === "prefix") return `${prefix}\n`;
        return undefined;
      }) as never);

      await expect(update([])).rejects.toThrow(ExitSentinel);

      expect(promptsMock.confirm).not.toHaveBeenCalled();
      expect(killToolServerForInstallDir).not.toHaveBeenCalled();
      expect(npmInstallCalls()).toHaveLength(0);
      const errors = promptsMock.log.error.mock.calls.map(([m]) => plain(m as string));
      expect(errors.some((m) => m.includes(`it cannot write to ${binDir}`))).toBe(true);
      expect(telemetryMock.track).toHaveBeenCalledWith(
        "installation:cli_update_fail",
        expect.objectContaining({ error_code: "UPDATE_GLOBAL_PREFIX_UNWRITABLE" })
      );
    }
  );

  // needsInstall also covers "nothing installed for this mode", where calling
  // it an update names an operation the reader never asked for.
  // pnpm, yarn and bun all leave `root -g` / `global dir` unanswerable on a
  // machine with no global directory set up; the installed package's own
  // directory is what the probe falls back to.
  it.skipIf(!canTestUnwritable)(
    "uses the installed package's own directory when the manager will not answer",
    async () => {
      const nodeModules = path.join(tmpDir, "store", "lib", "node_modules");
      topologyState.packageRoot = stageArgentPackage(nodeModules, "1.0.0");
      const scopeDir = path.join(nodeModules, "@swmansion");
      stageReadOnly(scopeDir);
      childProcessMock.execFileSync.mockImplementation(((_bin: string, args: string[]) => {
        if (args[0] === "root") throw new Error("no global directory");
        return undefined;
      }) as never);

      await expect(update([])).rejects.toThrow(ExitSentinel);

      expect(exitSpy).toHaveBeenCalledWith(1);
      const errors = promptsMock.log.error.mock.calls.map(([m]) => plain(m as string));
      expect(errors.some((m) => m.includes("cannot update @swmansion/argent globally"))).toBe(true);
      expect(errors.some((m) => m.includes(scopeDir))).toBe(true);
      expect(npmInstallCalls()).toHaveLength(0);
    }
  );

  it.skipIf(!canTestUnwritable)(
    "calls it an install when there is no global install to update",
    async () => {
      topologyState.globalInstalled = false;
      const globalRoot = path.join(tmpDir, "store", "lib", "node_modules");
      fs.mkdirSync(globalRoot, { recursive: true });
      stageReadOnly(globalRoot);
      childProcessMock.execFileSync.mockImplementation(((_bin: string, args: string[]) =>
        args[0] === "root" ? `${globalRoot}\n` : undefined) as never);

      await expect(update(["--global"])).rejects.toThrow(ExitSentinel);

      const errors = promptsMock.log.error.mock.calls.map(([m]) => plain(m as string));
      expect(errors.some((m) => m.includes("cannot install @swmansion/argent globally"))).toBe(
        true
      );
      expect(errors.some((m) => m.includes("cannot update"))).toBe(false);
      // Nothing is installed, so a bare `argent` is not on PATH to run.
      expect(errors.some((m) => m.includes("npx @swmansion/argent init --local"))).toBe(true);
    }
  );

  it.skipIf(!canTestUnwritable)(
    "leaves out the per-project way out when there is no package.json to hold it",
    async () => {
      fs.rmSync(path.join(projDir, "package.json"));
      const globalRoot = path.join(tmpDir, "store", "lib", "node_modules");
      fs.mkdirSync(globalRoot, { recursive: true });
      stageReadOnly(globalRoot);
      childProcessMock.execFileSync.mockImplementation(((_bin: string, args: string[]) =>
        args[0] === "root" ? `${globalRoot}\n` : undefined) as never);

      await expect(update([])).rejects.toThrow(ExitSentinel);

      const errors = promptsMock.log.error.mock.calls.map(([m]) => plain(m as string));
      expect(errors.some((m) => m.includes("cannot update @swmansion/argent globally"))).toBe(true);
      expect(errors.some((m) => m.includes("init --local"))).toBe(false);
    }
  );

  it("accepting the prompt still proceeds to the install", async () => {
    promptsMock.confirm.mockResolvedValueOnce(true);
    // The mocked package-manager run "lands" the target version on disk —
    // success is decided from the disk, never the exit code alone.
    childProcessMock.execFileSync.mockImplementation(((_bin: string, args: string[]) => {
      if (args[0] === "install") stageArgentPackage(stagedGlobalRoot(), "99.0.0");
      return undefined;
    }) as never);

    await update([]);

    expect(npmInstallCalls()).toHaveLength(1);
    expect(promptsMock.cancel).not.toHaveBeenCalled();
    expect(telemetryMock.track).toHaveBeenCalledWith(
      "installation:cli_update_complete",
      expect.anything()
    );
  });

  it("fails a zero-exit install whose target version never landed on disk", async () => {
    promptsMock.confirm.mockResolvedValueOnce(true);

    // The package manager exits 0 but the global version stays at v1.0.0 (an
    // npm-prefix/PATH split); the disk verdict wins — the run must report failure.
    await expect(update([])).rejects.toThrow(ExitSentinel);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(telemetryMock.track).toHaveBeenCalledWith(
      "installation:cli_update_fail",
      expect.anything()
    );
    expect(telemetryMock.track).not.toHaveBeenCalledWith(
      "installation:cli_update_complete",
      expect.anything()
    );
  });
});

// Package-manager INSTALL runs among all mocked execFileSync calls — adapter
// detection (`which opencode`) and the global-prefix preflight (`npm root -g`)
// also shell out, so tests must not count raw call totals, nor every `npm`.
function npmInstallCalls(): Array<[string, string[]]> {
  return (childProcessMock.execFileSync.mock.calls as Array<[string, string[]]>).filter(
    ([bin, args]) => bin === "npm" && args[0] === "install"
  );
}

describe("update — agent-triggered runs never install a missing global", () => {
  it("mcp_update trigger no-ops a --global target when no global install exists", async () => {
    // The agent-triggered updater acts on an UPDATE consent, never an install
    // consent — a degraded 'both' or explicit 'global' target must not mutate
    // the machine's global prefix with a fresh install nobody had.
    topologyState.globalInstalled = false;
    const savedTrigger = process.env.ARGENT_UPDATE_TRIGGER;
    process.env.ARGENT_UPDATE_TRIGGER = "mcp_update";
    try {
      await update(["--yes", "--global"]);
    } finally {
      if (savedTrigger === undefined) delete process.env.ARGENT_UPDATE_TRIGGER;
      else process.env.ARGENT_UPDATE_TRIGGER = savedTrigger;
    }

    expect(npmInstallCalls()).toHaveLength(0);
    expect(telemetryMock.track).toHaveBeenCalledWith(
      "installation:cli_update_complete",
      expect.anything()
    );
  });
});

describe("update — multi-target failure handling", () => {
  it("a failing first target does not abort the loop — the second target still updates", async () => {
    // A coexisting global + local pair; `--yes` targets both, global first.
    fs.writeFileSync(
      path.join(projDir, "package.json"),
      JSON.stringify({ name: "proj", devDependencies: { "@swmansion/argent": "^1.0.0" } })
    );
    fs.writeFileSync(path.join(projDir, "package-lock.json"), "{}");
    const pkgDir = path.join(projDir, "node_modules", "@swmansion", "argent");
    fs.mkdirSync(pkgDir, { recursive: true });
    const localPkgJson = path.join(pkgDir, "package.json");
    fs.writeFileSync(localPkgJson, JSON.stringify({ name: "@swmansion/argent", version: "1.0.0" }));

    // Global fails hard (EACCES); the local run lands v99 on disk.
    childProcessMock.execFileSync.mockImplementation(((_bin: string, args: string[]) => {
      if (Array.isArray(args) && args.includes("-g")) {
        throw new Error("EACCES: permission denied");
      }
      fs.writeFileSync(
        localPkgJson,
        JSON.stringify({ name: "@swmansion/argent", version: "99.0.0" })
      );
      return undefined;
    }) as never);

    await expect(update(["--yes"])).rejects.toThrow(ExitSentinel);

    // Both package-manager runs were attempted (no mid-loop exit(1))...
    const pmCalls = npmInstallCalls();
    expect(pmCalls).toHaveLength(2);
    expect(pmCalls.some(([, args]) => args.includes("-g"))).toBe(true);
    expect(pmCalls.some(([, args]) => !args.includes("-g"))).toBe(true);
    // ...the local install landed, and the run still reports failure.
    expect(JSON.parse(fs.readFileSync(localPkgJson, "utf8")).version).toBe("99.0.0");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(telemetryMock.track).toHaveBeenCalledWith(
      "installation:cli_update_fail",
      expect.anything()
    );
  });
});

describe("update — record-only local project stays updatable", () => {
  it("a committed install record without a manifest declaration still updates the local install", async () => {
    // Monorepo layout: .argent/install.json at the member root, the declaration
    // hoisted to the workspace root. The record IS the opt-in (install-record.ts's
    // "record wins"), so update must proceed, not print the not-declared guidance.
    topologyState.globalInstalled = false;
    fs.writeFileSync(path.join(projDir, "package.json"), JSON.stringify({ name: "member" }));
    fs.writeFileSync(path.join(projDir, "package-lock.json"), "{}");
    fs.mkdirSync(path.join(projDir, ".argent"), { recursive: true });
    fs.writeFileSync(
      path.join(projDir, ".argent", "install.json"),
      JSON.stringify({ mode: "local", package: "@swmansion/argent" })
    );
    const pkgDir = path.join(projDir, "node_modules", "@swmansion", "argent");
    fs.mkdirSync(pkgDir, { recursive: true });
    const localPkgJson = path.join(pkgDir, "package.json");
    fs.writeFileSync(localPkgJson, JSON.stringify({ name: "@swmansion/argent", version: "1.0.0" }));

    childProcessMock.execFileSync.mockImplementation(((_bin: string, args: string[]) => {
      if (Array.isArray(args) && args.some((a) => a.includes("@swmansion/argent"))) {
        fs.writeFileSync(
          localPkgJson,
          JSON.stringify({ name: "@swmansion/argent", version: "99.0.0" })
        );
      }
      return undefined;
    }) as never);

    await update(["--yes"]);

    expect(npmInstallCalls().length).toBeGreaterThan(0);
    expect(JSON.parse(fs.readFileSync(localPkgJson, "utf8")).version).toBe("99.0.0");
    expect(telemetryMock.track).toHaveBeenCalledWith(
      "installation:cli_update_complete",
      expect.anything()
    );
  });
});

describe("update — customized MCP entries survive the refresh and the sweep", () => {
  it("never rewrites (or sweeps away) a customized global-scope entry", async () => {
    // Local-mode project, no global argent on PATH — the exact setup where the
    // old refresh rewrote a customized global entry to the stock command and
    // the stale sweep then deleted it as "provably dead".
    topologyState.globalInstalled = false;
    fs.writeFileSync(
      path.join(projDir, "package.json"),
      JSON.stringify({ name: "proj", devDependencies: { "@swmansion/argent": "^1.0.0" } })
    );
    fs.writeFileSync(path.join(projDir, "package-lock.json"), "{}");
    const pkgDir = path.join(projDir, "node_modules", "@swmansion", "argent");
    fs.mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
    const localPkgJson = path.join(pkgDir, "package.json");
    const stagePkg = (version: string): void => {
      fs.writeFileSync(
        localPkgJson,
        JSON.stringify({
          name: "@swmansion/argent",
          version,
          bin: { argent: "dist/cli.js" },
        })
      );
    };
    stagePkg("1.0.0");
    fs.writeFileSync(path.join(pkgDir, "dist", "cli.js"), "");

    // A hand-tuned cross-project entry pointing at a dev checkout.
    const cursorGlobal = path.join(tmpDir, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(cursorGlobal), { recursive: true });
    fs.writeFileSync(
      cursorGlobal,
      JSON.stringify({
        mcpServers: { argent: { command: "node", args: ["/home/dev/argent/cli.js", "mcp"] } },
      })
    );
    const before = fs.readFileSync(cursorGlobal, "utf8");

    childProcessMock.execFileSync.mockImplementation(((_bin: string, args: string[]) => {
      if (Array.isArray(args) && args.some((a) => a.includes("@swmansion/argent"))) {
        stagePkg("99.0.0");
      }
      return undefined;
    }) as never);

    await update(["--yes"]);

    // The customized entry is byte-identical: not rewritten to stock, not removed
    // by the stale-config sweep (report-only for cross-project entries under --yes).
    expect(fs.readFileSync(cursorGlobal, "utf8")).toBe(before);
    expect(telemetryMock.track).toHaveBeenCalledWith(
      "installation:cli_update_complete",
      expect.anything()
    );
  });

  it("repairs a corrupted (unparseable) argent entry instead of skipping it as customized", async () => {
    // A mangled entry (merge-conflict remnant, url form) normalizes to
    // getArgentEntry's { command: "" } sentinel — the classification must
    // repair it to the stock command, not label it "customized".
    const mcpJson = path.join(projDir, ".mcp.json");
    fs.writeFileSync(
      mcpJson,
      JSON.stringify({ mcpServers: { argent: { url: "http://localhost:9999" } } })
    );
    // The mocked package-manager run lands the global target so the run
    // reaches the refresh.
    childProcessMock.execFileSync.mockImplementation(((_bin: string, args: string[]) => {
      if (Array.isArray(args) && args.some((a) => a.includes("@swmansion/argent"))) {
        stageArgentPackage(stagedGlobalRoot(), "99.0.0");
      }
      return undefined;
    }) as never);

    await update(["--yes"]);

    const entry = (
      JSON.parse(fs.readFileSync(mcpJson, "utf8")) as {
        mcpServers: Record<string, { command?: string; args?: string[] }>;
      }
    ).mcpServers.argent;
    expect(entry.command).toBe("argent");
    expect(entry.args).toEqual(["mcp"]);
  });
});

// The prefix move `argent init` performs installs into a bin directory the
// user's shells do not export until their profile is edited: npm agrees argent
// is installed there, `which argent` finds nothing. PATH alone cannot tell
// that run whether there is anything to update.
describe("update — a global install PATH cannot see", () => {
  let npmRoot: string;
  let npmPackageDir: string;

  // `npm root -g` answers with the staged prefix; an install runs the caller's
  // callback rather than touching anything.
  const answerNpmRoot = (onGlobalInstall?: () => void, onLocalInstall?: () => void): void => {
    childProcessMock.execFileSync.mockImplementation(((bin: string, args: string[]) => {
      if (bin !== "npm" || !Array.isArray(args)) return undefined;
      if (args[0] === "root") return `${npmRoot}\n`;
      if (args[0] === "install") (args.includes("-g") ? onGlobalInstall : onLocalInstall)?.();
      return undefined;
    }) as never);
  };

  beforeEach(() => {
    topologyState.globalInstalled = false;
    npmRoot = path.join(tmpDir, "npm-global", "lib", "node_modules");
    npmPackageDir = stageArgentPackage(npmRoot, "1.0.0");
  });

  it("compares against the version npm holds instead of reinstalling it", async () => {
    stageArgentPackage(npmRoot, "99.0.0");
    answerNpmRoot();

    await update(["--yes"]);

    const info = promptsMock.log.info.mock.calls.map(([m]) => plain(m as string));
    const warns = promptsMock.log.warn.mock.calls.map(([m]) => plain(m as string));
    const successes = promptsMock.log.success.mock.calls.map(([m]) => plain(m as string));
    expect(info).toContain("Installed: v99.0.0");
    expect(warns).not.toContain("@swmansion/argent is not installed globally.");
    expect(successes).toContain("Already on the latest version.");
    expect(npmInstallCalls()).toHaveLength(0);
  });

  it("stops the tool server of the install npm holds, not the legacy single slot", async () => {
    answerNpmRoot(() => stageArgentPackage(npmRoot, "99.0.0"));

    await update(["--yes"]);

    expect(npmInstallCalls()).toHaveLength(1);
    // Realpathed: npmGlobalPackageRoot resolves the link npm made, and macOS
    // hands out /var symlinks for the temp directory.
    expect(killToolServerForInstallDir).toHaveBeenCalledWith(fs.realpathSync(npmPackageDir));
    expect(killToolServer).not.toHaveBeenCalled();
  });

  it("fails an install that never reached npm's directory instead of reporting success", async () => {
    // The install changes nothing on disk, and the version npm holds is what
    // decides — a bump that never happened is not a success.
    answerNpmRoot();

    await expect(update(["--yes"])).rejects.toThrow(ExitSentinel);

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errors = promptsMock.log.error.mock.calls.map(([m]) => plain(m as string));
    expect(
      errors.some((m) => m.includes("v1.0.0 is still what resolves for the global install"))
    ).toBe(true);
    expect(telemetryMock.track).not.toHaveBeenCalledWith(
      "installation:cli_update_complete",
      expect.anything()
    );
  });

  it.skipIf(!canTestUnwritable)(
    "spells the per-project way out with npx — npm's copy is no command to run",
    async () => {
      answerNpmRoot();
      stageReadOnly(path.join(npmRoot, "@swmansion"));

      await expect(update(["--yes"])).rejects.toThrow(ExitSentinel);

      const errors = promptsMock.log.error.mock.calls.map(([m]) => plain(m as string));
      // "update", not "install": npm holds a copy, even though PATH names none.
      expect(errors.some((m) => m.includes("cannot update @swmansion/argent globally"))).toBe(true);
      expect(errors.some((m) => m.includes("npx @swmansion/argent init --local"))).toBe(true);
    }
  );

  it("is a target of its own beside the project's local install", async () => {
    fs.writeFileSync(
      path.join(projDir, "package.json"),
      JSON.stringify({ name: "proj", devDependencies: { "@swmansion/argent": "^1.0.0" } })
    );
    fs.writeFileSync(path.join(projDir, "package-lock.json"), "{}");
    const localPkgJson = path.join(
      stageArgentPackage(path.join(projDir, "node_modules"), "1.0.0"),
      "package.json"
    );
    answerNpmRoot(
      () => stageArgentPackage(npmRoot, "99.0.0"),
      () =>
        fs.writeFileSync(
          localPkgJson,
          JSON.stringify({ name: "@swmansion/argent", version: "99.0.0" })
        )
    );

    await update(["--yes"]);

    const info = promptsMock.log.info.mock.calls.map(([m]) => plain(m as string));
    expect(
      info.some((m) => m.includes("Both a global and a project-local install were found"))
    ).toBe(true);
    const installs = npmInstallCalls();
    expect(installs.some(([, args]) => args.includes("-g"))).toBe(true);
    expect(installs.some(([, args]) => !args.includes("-g"))).toBe(true);
  });
});

// npm's directory is the copy `npm install -g` replaces; `argent` runs whatever
// PATH names first. When a prefix move leaves an older `sudo npm i -g` in an
// earlier bin directory, those are two different copies and only one of them
// gets updated.
describe("update — a second global copy shadowing the one being updated", () => {
  let npmRoot: string;

  /** A staged package whose bin `which -a argent` answers with. */
  const stageOnPath = (root: string, version: string): void => {
    const packageDir = stageArgentPackage(root, version);
    fs.mkdirSync(path.join(packageDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(packageDir, "dist", "cli.js"), "");
    const binDir = path.join(path.dirname(path.dirname(root)), "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const bin = path.join(binDir, "argent");
    fs.rmSync(bin, { force: true });
    fs.symlinkSync(path.join(packageDir, "dist", "cli.js"), bin);
    topologyState.packageRoot = packageDir;
    childProcessMock.execSync.mockReturnValue(`${bin}\n`);
  };

  beforeEach(() => {
    npmRoot = path.join(tmpDir, "npm-global", "lib", "node_modules");
    // PATH's copy sits under a prefix of its own, left behind by a `sudo npm
    // i -g` the later `npm config set prefix` moved away from.
    stageOnPath(path.join(tmpDir, "usr-local", "lib", "node_modules"), "1.0.0");
  });

  it("fails an update that landed in npm's prefix while PATH still serves the old copy", async () => {
    stageArgentPackage(npmRoot, "1.0.0");
    childProcessMock.execFileSync.mockImplementation(((bin: string, args: string[]) => {
      if (bin !== "npm" || !Array.isArray(args)) return undefined;
      if (args[0] === "root") return `${npmRoot}\n`;
      if (args[0] === "install") stageArgentPackage(npmRoot, "99.0.0");
      return undefined;
    }) as never);

    await expect(update(["--yes"])).rejects.toThrow(ExitSentinel);

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errors = promptsMock.log.error.mock.calls.map(([m]) => plain(m as string));
    expect(
      errors.some((m) =>
        m.includes("landed v99.0.0, but the `argent` on your PATH is still v1.0.0")
      )
    ).toBe(true);
    expect(telemetryMock.track).not.toHaveBeenCalledWith(
      "installation:cli_update_complete",
      expect.anything()
    );
  });

  it("says which copy is stale instead of reporting the shadowed one as up to date", async () => {
    stageArgentPackage(npmRoot, "99.0.0");
    childProcessMock.execFileSync.mockImplementation(((bin: string, args: string[]) =>
      bin === "npm" && Array.isArray(args) && args[0] === "root"
        ? `${npmRoot}\n`
        : undefined) as never);

    await update(["--yes"]);

    const warns = promptsMock.log.warn.mock.calls.map(([m]) => plain(m as string));
    expect(
      warns.some((m) =>
        m.includes("The `argent` on your PATH is v1.0.0, behind the v99.0.0 global install")
      )
    ).toBe(true);
    expect(npmInstallCalls()).toHaveLength(0);
  });

  it("leaves npm's leftover out of an update pnpm will run", async () => {
    process.env.npm_config_user_agent = "pnpm/9.12.0 npm/? node/v22.0.0 darwin arm64";
    // npm's directory holds a copy AHEAD of the live one: consulted, it would
    // report "already on the latest" and never run the pnpm install.
    stageArgentPackage(npmRoot, "99.0.0");
    childProcessMock.execFileSync.mockImplementation(((bin: string, args: string[]) => {
      if (!Array.isArray(args)) return undefined;
      if (bin === "npm" && args[0] === "root") return `${npmRoot}\n`;
      if (bin === "pnpm" && args[0] === "add")
        stageOnPath(path.join(tmpDir, "usr-local", "lib", "node_modules"), "99.0.0");
      return undefined;
    }) as never);

    await update(["--yes"]);

    const info = promptsMock.log.info.mock.calls.map(([m]) => plain(m as string));
    expect(info).toContain("Installed: v1.0.0");
    const adds = (childProcessMock.execFileSync.mock.calls as Array<[string, string[]]>).filter(
      ([bin, args]) => bin === "pnpm" && args[0] === "add"
    );
    expect(adds).toHaveLength(1);
    expect(promptsMock.log.error).not.toHaveBeenCalled();
  });
});
