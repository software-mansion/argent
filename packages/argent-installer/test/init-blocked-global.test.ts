import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { init } from "../src/init.js";
import { runInstall } from "../src/install-runner.js";
import { promptInstallMode } from "../src/init-mode-prompt.js";
import { probeGlobalInstallTarget } from "../src/global-prefix.js";
import { writeConsentFlag } from "@argent/telemetry";
import type { GlobalInstallTarget } from "../src/global-prefix.js";

// init decides three things about a blocked global install that nothing else
// can: whether to ask at all, which mode to fall back to when it cannot, and
// which mode the rest of the run configures once the install has landed. The
// install itself is mocked — this is about the wiring around it.

const telemetryMock = vi.hoisted(() => ({
  init: vi.fn(),
  track: vi.fn(),
  warmTelemetryIdentitySync: vi.fn(),
  writeConsentFlag: vi.fn(),
}));

vi.mock("@argent/telemetry", () => telemetryMock);
vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  note: vi.fn(),
  confirm: vi.fn(async () => true),
  isCancel: vi.fn(() => false),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
    step: vi.fn(),
    success: vi.fn(),
  },
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
}));
vi.mock("../src/first-run-notice.js", () => ({
  resolveTelemetryConsent: vi.fn(async () => ({ kind: "resolved" })),
}));
vi.mock("../src/install-runner.js", () => ({
  runInstall: vi.fn(async () => ({ version: "9.9.9", installMode: "global", pathHint: null })),
}));
vi.mock("../src/init-mode-prompt.js", () => ({ promptInstallMode: vi.fn(async () => "global") }));
vi.mock("../src/global-prefix.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/global-prefix.js")>();
  return { ...original, probeGlobalInstallTarget: vi.fn(() => null) };
});

// Steps after the install: they configure whichever mode init hands them, and
// every assertion below is about what init hands over.
vi.mock("../src/init-adapters.js", () => ({
  chooseAdapters: vi.fn(async () => ({ selected: [], detected: [] })),
}));
vi.mock("../src/init-scope.js", () => ({ chooseScope: vi.fn(async () => ({ scope: "local" })) }));
vi.mock("../src/init-mcp-write.js", () => ({
  writeMcpConfigs: vi.fn(() => ({ adapters: [], lines: [] })),
}));
vi.mock("../src/init-stale-config.js", () => ({
  cleanupStaleMcpConfigs: vi.fn(async () => ({ lines: [], removedCount: 0, warnedCount: 0 })),
}));
vi.mock("../src/init-allowlist.js", () => ({
  configureAllowlist: vi.fn(async () => ({ enabled: false, lines: [] })),
}));
vi.mock("../src/init-skills.js", () => ({
  runSkillsStep: vi.fn(async () => ({ method: "skip", installedCount: 0, lines: [] })),
}));

const topologyState = vi.hoisted(() => ({ globalInstalled: false }));
vi.mock("../src/utils.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/utils.js")>();
  return {
    ...original,
    isGloballyInstalled: vi.fn(() => topologyState.globalInstalled),
    getInstalledVersion: vi.fn(() => "9.9.9"),
    detectPackageManager: vi.fn(() => "npm" as const),
  };
});

const blocked: GlobalInstallTarget = {
  dir: "/nix/store/aaaa-nodejs/lib/node_modules",
  blocked: true,
  nixStore: true,
};

let tmpDir: string;
let originalCwd: string;
let savedHome: string | undefined;
let savedIsTty: boolean | undefined;
let exitSpy: ReturnType<typeof vi.spyOn>;

class ExitSentinel extends Error {}

/** The mode init told runInstall to install, plus the block it acknowledged. */
function installArgs(): { installMode: string; globalBlockAcknowledged: boolean } {
  const [args] = vi.mocked(runInstall).mock.calls[0] as [
    { installMode: string; globalBlockAcknowledged: boolean },
  ];
  return args;
}

beforeEach(() => {
  vi.clearAllMocks();
  topologyState.globalInstalled = false;
  vi.mocked(probeGlobalInstallTarget).mockReturnValue(blocked);
  vi.mocked(promptInstallMode).mockResolvedValue("global");
  vi.mocked(runInstall).mockResolvedValue({
    version: "9.9.9",
    installMode: "global",
    pathHint: null,
  });
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-init-blocked-"));
  originalCwd = process.cwd();
  savedHome = process.env.HOME;
  process.env.HOME = tmpDir;
  // resolveProjectRoot walks up for editor/git markers, not package.json.
  fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "proj" }));
  process.chdir(tmpDir);
  savedIsTty = process.stdin.isTTY;
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new ExitSentinel();
  }) as never);
});

afterEach(() => {
  exitSpy.mockRestore();
  process.chdir(originalCwd);
  Object.defineProperty(process.stdin, "isTTY", { value: savedIsTty, configurable: true });
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("init — a blocked global install decides the mode step", () => {
  it("asks, and treats picking Globally as the block acknowledged", async () => {
    await init(["--no-telemetry"]);

    expect(promptInstallMode).toHaveBeenCalledWith(
      "global",
      expect.objectContaining({ pm: "npm" })
    );
    expect(installArgs()).toMatchObject({ installMode: "global", globalBlockAcknowledged: true });
  });

  it("does not render a menu with no terminal to answer it on", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });

    await init(["--no-telemetry"]);

    expect(promptInstallMode).not.toHaveBeenCalled();
    // Nothing was acknowledged, so the install step spells out the remedies.
    expect(installArgs()).toMatchObject({ installMode: "global", globalBlockAcknowledged: false });
  });

  it("does not ask when argent could carry out neither way out", async () => {
    fs.rmSync(path.join(tmpDir, "package.json"));
    const { detectPackageManager } = await import("../src/utils.js");
    vi.mocked(detectPackageManager).mockReturnValue("pnpm");

    await init(["--no-telemetry"]);

    expect(promptInstallMode).not.toHaveBeenCalled();
    expect(installArgs()).toMatchObject({ globalBlockAcknowledged: false });
  });

  it("falls back to the mode the project recorded, not to global", async () => {
    // `--yes` resolves this same situation to the recorded mode; a run with no
    // terminal must not tell the user to run the mode they already chose.
    fs.mkdirSync(path.join(tmpDir, ".argent"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".argent", "install.json"),
      JSON.stringify({ mode: "local", package: "@swmansion/argent" })
    );
    Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });

    await init(["--no-telemetry"]);

    expect(installArgs()).toMatchObject({ installMode: "local" });
  });

  it("never acknowledges a block the mode flag skipped the question for", async () => {
    // --global is a mode, not an answer to a wall the user was never shown.
    await init(["--global", "--no-telemetry"]);

    expect(promptInstallMode).not.toHaveBeenCalled();
    expect(installArgs()).toMatchObject({ installMode: "global", globalBlockAcknowledged: false });
  });
});

describe("init — the mode the install landed in governs the rest of the run", () => {
  beforeEach(() => {
    // What a recovery does with `--global` on a blocked machine.
    vi.mocked(runInstall).mockResolvedValue({
      version: "9.9.9",
      installMode: "local",
      pathHint: null,
    });
  });

  it("configures the install that exists, not the one that was asked for", async () => {
    const { chooseAdapters } = await import("../src/init-adapters.js");

    await init(["--global", "--no-telemetry"]);

    expect(chooseAdapters).toHaveBeenCalledWith(expect.objectContaining({ installMode: "local" }));
    expect(
      JSON.parse(fs.readFileSync(path.join(tmpDir, ".argent", "install.json"), "utf8"))
    ).toMatchObject({ mode: "local" });
  });

  it("records the --no-telemetry opt-out in the project it ended up installing into", async () => {
    // A committed local install carries the opt-out to every clone; the mode is
    // only known after the install, so the write cannot precede it.
    await init(["--global", "--no-telemetry"]);

    expect(writeConsentFlag).toHaveBeenCalledWith(false, "project", expect.anything());
  });

  it("leaves the project alone when the install stayed global", async () => {
    vi.mocked(runInstall).mockResolvedValue({
      version: "9.9.9",
      installMode: "global",
      pathHint: null,
    });

    await init(["--global", "--no-telemetry"]);

    expect(writeConsentFlag).not.toHaveBeenCalledWith(false, "project", expect.anything());
  });
});
