import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SkillsStepResult } from "../src/init-skills.js";

// Drives `init()` end to end with every step module stubbed, to check what the
// skills step's result does to the exit code, the terminal telemetry and the
// closing note (#614).

const { runSkillsStep, track, log, note } = vi.hoisted(() => ({
  runSkillsStep: vi.fn(),
  track: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), step: vi.fn(), message: vi.fn() },
  note: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  log,
  note,
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  isCancel: () => false,
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
}));
vi.mock("@argent/telemetry", () => ({
  init: vi.fn(),
  track,
  warmTelemetryIdentitySync: vi.fn(),
  writeConsentFlag: vi.fn(),
}));
vi.mock("../src/telemetry-finalize.js", () => ({
  finalizeTelemetry: async (capture: () => void) => capture(),
}));
vi.mock("../src/first-run-notice.js", () => ({
  resolveTelemetryConsent: async () => ({ kind: "skipped" }),
}));
vi.mock("../src/install-runner.js", () => ({ runInstall: async () => "1.0.0" }));
vi.mock("../src/init-adapters.js", () => ({
  chooseAdapters: async () => ({ selected: [{ name: "Claude Code" }], detected: [] }),
}));
vi.mock("../src/init-scope.js", () => ({ chooseScope: async () => ({ scope: "local" }) }));
vi.mock("../src/init-mcp-write.js", () => ({
  writeMcpConfigs: () => ({ adapters: [{ name: "Claude Code" }], lines: [] }),
}));
vi.mock("../src/init-stale-config.js", () => ({
  cleanupStaleMcpConfigs: async () => ({ lines: [], removedCount: 0, warnedCount: 0 }),
}));
vi.mock("../src/init-allowlist.js", () => ({
  configureAllowlist: async () => ({ enabled: false, lines: [] }),
}));
vi.mock("../src/cli-record.js", () => ({ writeCliRecord: vi.fn() }));
vi.mock("../src/retired-files.js", () => ({ reportRetiredFiles: async () => {} }));
vi.mock("../src/mcp-configs.js", () => ({
  ALL_ADAPTERS: [],
  copyRulesAndAgents: () => ["+ rules"],
  findRetiredRulesAndAgents: () => [],
}));
vi.mock("../src/utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils.js")>()),
  getInstalledVersion: () => "1.0.0",
  resolveProjectRoot: () => "/tmp/argent-init-exit-test",
  isDeclaredLocally: () => false,
  readInstallRecord: () => null,
  removeInstallRecord: () => false,
  writeInstallRecord: vi.fn(),
}));
vi.mock("../src/init-skills.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/init-skills.js")>()),
  runSkillsStep,
}));

import { init } from "../src/init.js";

const result = (overrides: Partial<SkillsStepResult>): SkillsStepResult => ({
  method: "default",
  outcome: "success",
  source: "pinned",
  usedFallback: false,
  installedCount: 18,
  installedThisRun: 18,
  forcedManual: false,
  ...overrides,
});

class Exit extends Error {
  constructor(readonly code: number | undefined) {
    super(`exit ${code}`);
  }
}

async function runInit(skills: SkillsStepResult) {
  runSkillsStep.mockResolvedValue(skills);
  const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Exit(code as number | undefined);
  });
  let code: number | undefined = 0;
  try {
    await init(["--yes"]);
  } catch (err) {
    if (!(err instanceof Exit)) throw err;
    code = err.code;
  } finally {
    exit.mockRestore();
  }
  const complete = track.mock.calls.find(([name]) => name === "installation:cli_init_complete");
  const notes = note.mock.calls.map((c) => String(c[0])).join("\n");
  const warnings = log.warn.mock.calls.map((c) => String(c[0])).join("\n");
  return { code, complete: complete?.[1] as Record<string, unknown>, notes, warnings };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("init exit code and closing note from the skills step (#614)", () => {
  it("exits 1 when an install ran, failed and left nothing on disk", async () => {
    const r = await runInit(
      result({ outcome: "failure", source: null, installedCount: 0, installedThisRun: 0 })
    );

    expect(r.code).toBe(1);
    expect(r.complete).toMatchObject({ is_success: false, error_code: "INSTALL_SKILLS_FAILED" });
    expect(r.notes).not.toContain("Argent is ready!");
    expect(r.warnings).toContain("Argent is not ready");
  });

  it("exits 0 offline, where nothing was tried, and does not claim readiness", async () => {
    const r = await runInit(
      result({
        method: "manual",
        outcome: "skipped",
        source: null,
        installedCount: 0,
        installedThisRun: 0,
        forcedManual: true,
      })
    );

    expect(r.code).toBe(0);
    expect(r.complete).toMatchObject({ is_success: true });
    expect(r.complete).not.toHaveProperty("error_code");
    expect(r.notes).not.toContain("Argent is ready!");
    expect(r.warnings).toContain("Argent is not ready");
  });

  it("exits 0 when skills were installed, and says Argent is ready", async () => {
    const r = await runInit(result({}));

    expect(r.code).toBe(0);
    expect(r.complete).toMatchObject({ is_success: true });
    expect(r.notes).toContain("Argent is ready!");
  });

  it("exits 0 when the user chose Manual", async () => {
    const r = await runInit(
      result({
        method: "manual",
        outcome: "skipped",
        source: null,
        installedCount: 0,
        installedThisRun: 0,
      })
    );

    expect(r.code).toBe(0);
    expect(r.notes).toContain("Argent is ready!");
  });

  it("exits 0 after a failed run over earlier skills, without claiming readiness", async () => {
    const r = await runInit(
      result({ outcome: "failure", source: null, installedCount: 3, installedThisRun: 0 })
    );

    expect(r.code).toBe(0);
    expect(r.notes).not.toContain("Argent is ready!");
    expect(r.warnings).toContain("Skills were not updated");
  });
});
