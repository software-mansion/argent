import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { update } from "../src/update.js";

// Declining the update prompt must end the run like the pre-multi-target flow
// did: cancel + exit 0, without the config refresh (entry rewrites, allowlists,
// the stale-config sweep's removals, rules/agents, skills) running afterwards.

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
// Mutable install topology the utils mock reads through, so tests can stage
// "the global install landed at v99" (flip `globalVersion` from the mocked
// package-manager run) or "no global install at all".
const topologyState = vi.hoisted(() => ({ globalInstalled: true, globalVersion: "1.0.0" }));

vi.mock("../src/utils.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/utils.js")>();
  return {
    ...original,
    isGloballyInstalled: vi.fn(() => topologyState.globalInstalled),
    getGloballyInstalledVersion: vi.fn(() => topologyState.globalVersion),
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

beforeEach(() => {
  vi.clearAllMocks();
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
    expect(childProcessMock.execFileSync).not.toHaveBeenCalled();
    expect(telemetryMock.track).toHaveBeenCalledWith(
      "installation:cli_update_complete",
      expect.anything()
    );
    // The config refresh never ran: the file the refresh would rewrite is
    // byte-identical.
    expect(fs.readFileSync(mcpJson, "utf8")).toBe(before);
  });

  it("accepting the prompt still proceeds to the install", async () => {
    promptsMock.confirm.mockResolvedValueOnce(true);
    // The mocked package-manager run "lands" the target version on disk —
    // success is decided from the disk, never the exit code alone.
    childProcessMock.execFileSync.mockImplementationOnce((() => {
      topologyState.globalVersion = "99.0.0";
      return undefined;
    }) as never);

    await update([]);

    expect(childProcessMock.execFileSync).toHaveBeenCalled();
    expect(promptsMock.cancel).not.toHaveBeenCalled();
    expect(telemetryMock.track).toHaveBeenCalledWith(
      "installation:cli_update_complete",
      expect.anything()
    );
  });

  it("fails a zero-exit install whose target version never landed on disk", async () => {
    promptsMock.confirm.mockResolvedValueOnce(true);

    // The package manager exits 0 but the resolvable global version stays at
    // v1.0.0 (an npm-prefix/PATH split). The disk verdict wins: the run must
    // report failure, not "Update complete".
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

// Package-manager invocations among all mocked execFileSync calls — adapter
// detection also shells out (e.g. `which opencode`), so tests must not count
// raw call totals.
function npmCalls(): Array<[string, string[]]> {
  return (childProcessMock.execFileSync.mock.calls as Array<[string, string[]]>).filter(
    ([bin]) => bin === "npm"
  );
}

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

    // Both package-manager runs were attempted (the old flow process.exit(1)'d
    // mid-loop and never reached the local install)...
    const pmCalls = npmCalls();
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
    // Monorepo hygiene: .argent/install.json at the member root, the
    // declaration hoisted to the workspace root. The record IS the project's
    // opt-in (install-record.ts's "record wins"), so update must proceed like
    // it did on HEAD, not print the not-declared guidance.
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

    expect(npmCalls().length).toBeGreaterThan(0);
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

    // The customized entry is byte-identical: not rewritten to the stock
    // command, not removed by the stale-config sweep (which is report-only
    // for cross-project entries under --yes anyway).
    expect(fs.readFileSync(cursorGlobal, "utf8")).toBe(before);
    expect(telemetryMock.track).toHaveBeenCalledWith(
      "installation:cli_update_complete",
      expect.anything()
    );
  });

  it("repairs a corrupted (unparseable) argent entry instead of skipping it as customized", async () => {
    // A mangled entry (merge-conflict remnant, hand-edit to an url form)
    // normalizes to getArgentEntry's { command: "" } sentinel. HEAD's
    // unconditional refresh restored the working stock command; the
    // classification must keep doing that, not label it "customized".
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
