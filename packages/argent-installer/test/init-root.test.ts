import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// After the scope choice, `init` hands one root (`effectiveRoot`) to the MCP
// config, rules/agents and skills steps. Run from a project subdirectory, the
// skills step must get that root, not the cwd (#1467). The steps are stubbed
// so only that hand-off is observed.

const promptsMock = vi.hoisted(() => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  note: vi.fn(),
  isCancel: vi.fn(() => false),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
    step: vi.fn(),
    success: vi.fn(),
  },
}));

const steps = vi.hoisted(() => ({
  chooseScope: vi.fn(),
  writeMcpConfigs: vi.fn((..._args: unknown[]) => ({ adapters: [], lines: [] })),
  copyRulesAndAgents: vi.fn((..._args: unknown[]) => [] as string[]),
  runSkillsStep: vi.fn(async (..._args: unknown[]) => ({
    method: "default",
    outcome: "success",
    source: "pinned",
    usedFallback: false,
    installedCount: 1,
    installedThisRun: 1,
    forcedManual: false,
  })),
}));

vi.mock("@clack/prompts", () => promptsMock);
vi.mock("@argent/telemetry", () => ({
  init: vi.fn(),
  track: vi.fn(),
  warmTelemetryIdentitySync: vi.fn(),
  writeConsentFlag: vi.fn(),
}));
vi.mock("../src/telemetry-finalize.js", () => ({
  finalizeTelemetry: vi.fn(async (capture: () => void) => capture()),
}));
vi.mock("../src/first-run-notice.js", () => ({
  resolveTelemetryConsent: vi.fn(async () => ({ kind: "enabled" })),
}));
vi.mock("../src/install-runner.js", () => ({ runInstall: vi.fn(async () => "1.0.0") }));
vi.mock("../src/init-adapters.js", () => ({
  chooseAdapters: vi.fn(async () => ({ selected: [], detected: [] })),
}));
vi.mock("../src/init-scope.js", () => ({ chooseScope: steps.chooseScope }));
vi.mock("../src/init-mcp-write.js", () => ({ writeMcpConfigs: steps.writeMcpConfigs }));
vi.mock("../src/init-stale-config.js", () => ({
  cleanupStaleMcpConfigs: vi.fn(async () => ({ lines: [], removedCount: 0, warnedCount: 0 })),
}));
vi.mock("../src/init-allowlist.js", () => ({
  configureAllowlist: vi.fn(async () => ({ enabled: false, lines: [] })),
}));
// The summary helpers stay real: they only format the stubbed step's result.
vi.mock("../src/init-skills.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/init-skills.js")>()),
  runSkillsStep: steps.runSkillsStep,
}));
vi.mock("../src/cli-record.js", () => ({ writeCliRecord: vi.fn() }));
vi.mock("../src/retired-files.js", () => ({ reportRetiredFiles: vi.fn(async () => {}) }));
vi.mock("../src/mcp-configs.js", () => ({
  ALL_ADAPTERS: [],
  copyRulesAndAgents: steps.copyRulesAndAgents,
  findRetiredRulesAndAgents: vi.fn(() => []),
}));

import { init } from "../src/init.js";

let tmpDir: string;
let root: string;
let subdir: string;
let originalCwd: string;
let savedHome: string | undefined;
let savedUserProfile: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  // realpath: process.cwd() reports the resolved path (macOS /var -> /private/var).
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-init-root-")));
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = path.join(tmpDir, "home");
  process.env.USERPROFILE = path.join(tmpDir, "home");
  root = path.join(tmpDir, "repo");
  subdir = path.join(root, "packages", "app");
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.mkdirSync(subdir, { recursive: true });
  originalCwd = process.cwd();
  process.chdir(subdir);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedUserProfile;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function skillsRoot(): unknown {
  expect(steps.runSkillsStep).toHaveBeenCalledTimes(1);
  return (steps.runSkillsStep.mock.calls[0]![0] as { effectiveRoot: string }).effectiveRoot;
}

describe("init - skills root (#1467)", () => {
  it("hands the skills step the resolved project root when run from a subdirectory", async () => {
    steps.chooseScope.mockResolvedValue({ scope: "local" });

    await init(["--yes", "--global"]);

    const mcpRoot = (steps.writeMcpConfigs.mock.calls[0]![0] as { effectiveRoot: string })
      .effectiveRoot;
    expect(mcpRoot).toBe(root);
    expect(steps.copyRulesAndAgents.mock.calls[0]![1]).toBe(root);
    expect(skillsRoot()).toBe(root);
  });

  it("hands the skills step the custom root for a custom-scope install", async () => {
    const custom = path.join(tmpDir, "elsewhere");
    fs.mkdirSync(custom);
    steps.chooseScope.mockResolvedValue({ scope: "custom", customRoot: custom });

    await init(["--yes", "--global"]);

    expect(skillsRoot()).toBe(custom);
    expect(steps.copyRulesAndAgents.mock.calls[0]![1]).toBe(custom);
  });
});
