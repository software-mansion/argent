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
vi.mock("../src/utils.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/utils.js")>();
  return {
    ...original,
    isGloballyInstalled: vi.fn(() => true),
    getGloballyInstalledVersion: vi.fn(() => "1.0.0"),
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

    // The staged install never reaches v99, so the disk probe reports the
    // target didn't land; with a zero exit code update treats the install
    // command as authoritative and proceeds — good enough to prove the decline
    // gate doesn't block an accepted update.
    await update([]);

    expect(childProcessMock.execFileSync).toHaveBeenCalled();
    expect(promptsMock.cancel).not.toHaveBeenCalled();
  });
});
