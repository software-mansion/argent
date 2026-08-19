import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { update } from "../src/update.js";
import { killToolServerForInstallDir } from "@argent/tools-client";

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
// The sweep itself is covered in init-stale-config.test.ts; here only the
// confirmer update hands it matters.
const staleConfigMock = vi.hoisted(() => ({
  cleanupStaleMcpConfigs: vi.fn(async () => ({ lines: [], removedCount: 0, warnedCount: 0 })),
}));
vi.mock("../src/init-stale-config.js", () => staleConfigMock);
vi.mock("../src/update-target.js", () => ({
  resolveInstallableUpdateTarget: vi.fn(async () => ({
    latestVersion: "99.0.0",
    targetVersion: "99.0.0",
    minReleaseAgeMs: 0,
  })),
}));
// Mutable install topology read through the utils mock — tests flip these to
// stage "the global install landed at v99" or "no global install at all".
const topologyState = vi.hoisted(() => ({ globalInstalled: true, globalVersion: "1.0.0" }));

vi.mock("../src/utils.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/utils.js")>();
  return {
    ...original,
    isGloballyInstalled: vi.fn(() => topologyState.globalInstalled),
    getGloballyInstalledVersion: vi.fn(() => topologyState.globalVersion),
  };
});

// Node leaves isTTY undefined on a stdin that is not a terminal; the declared
// type admits only boolean, hence the cast.
function setIsTty(value: boolean | undefined): void {
  (process.stdin as { isTTY?: boolean }).isTTY = value;
}

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
let savedIsTty: boolean | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  // The prompts these tests answer only exist for a user who can answer them.
  savedIsTty = process.stdin.isTTY;
  setIsTty(true);
  // clearAllMocks keeps implementations, and the tests below install their own
  // on execFileSync — reset it so one test's package-manager stub cannot decide
  // the next test's outcome.
  childProcessMock.execFileSync.mockReset();
  topologyState.globalInstalled = true;
  topologyState.globalVersion = "1.0.0";
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-update-decline-"));
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
  exitSpy.mockRestore();
  setIsTty(savedIsTty);
  process.chdir(originalCwd);
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedUserProfile;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

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
  it("refuses a global update it cannot perform, before asking and before stopping the server", async () => {
    const globalRoot = path.join(tmpDir, "store", "lib", "node_modules");
    fs.mkdirSync(globalRoot, { recursive: true });
    fs.chmodSync(globalRoot, 0o555);
    childProcessMock.execFileSync.mockImplementation(((_bin: string, args: string[]) =>
      args[0] === "root" ? `${globalRoot}\n` : undefined) as never);

    await expect(update([])).rejects.toThrow(ExitSentinel);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(promptsMock.confirm).not.toHaveBeenCalled();
    expect(killToolServerForInstallDir).not.toHaveBeenCalled();
    expect(npmInstallCalls()).toHaveLength(0);
    const errors = promptsMock.log.error.mock.calls.map(([m]) => m as string);
    expect(errors.some((m) => m.includes("cannot update @swmansion/argent globally"))).toBe(true);
    expect(telemetryMock.track).toHaveBeenCalledWith(
      "installation:package_action",
      expect.objectContaining({
        action: "update_failed",
        error_code: "UPDATE_GLOBAL_PREFIX_UNWRITABLE",
      })
    );
  });

  // A confirm with no terminal behind it never settles: the run would end at a
  // rendered prompt, exit 0, and have updated nothing.
  it("refuses an update it cannot ask about, leaving the install alone", async () => {
    setIsTty(undefined);

    await expect(update([])).rejects.toThrow(ExitSentinel);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(promptsMock.confirm).not.toHaveBeenCalled();
    expect(npmInstallCalls()).toHaveLength(0);
    const errors = promptsMock.log.error.mock.calls.map(([m]) => m as string);
    expect(errors.some((m) => m.includes("--yes"))).toBe(true);
    expect(telemetryMock.track).toHaveBeenCalledWith(
      "installation:package_action",
      expect.objectContaining({ action: "update_failed", error_code: "UPDATE_NEEDS_TERMINAL" })
    );
  });

  // An update with nothing to install asks nothing, so it reaches the config
  // refresh with no terminal — where the sweep's cross-project removals would
  // otherwise open a confirmation nobody can answer.
  it("hands the sweep no confirmer when there is no terminal", async () => {
    topologyState.globalVersion = "99.0.0";
    setIsTty(undefined);

    await update([]);

    expect(staleConfigMock.cleanupStaleMcpConfigs).toHaveBeenCalledWith(
      expect.objectContaining({ confirmCrossProjectRemovals: undefined })
    );
  });

  it("keeps the sweep's confirmation for a run that can ask", async () => {
    topologyState.globalVersion = "99.0.0";

    await update([]);

    expect(staleConfigMock.cleanupStaleMcpConfigs).toHaveBeenCalledWith(
      expect.objectContaining({ confirmCrossProjectRemovals: expect.any(Function) })
    );
  });

  it("accepting the prompt still proceeds to the install", async () => {
    promptsMock.confirm.mockResolvedValueOnce(true);
    // The mocked package-manager run "lands" the target version on disk —
    // success is decided from the disk, never the exit code alone.
    childProcessMock.execFileSync.mockImplementation(((_bin: string, args: string[]) => {
      if (args[0] === "install") topologyState.globalVersion = "99.0.0";
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
        topologyState.globalVersion = "99.0.0";
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
