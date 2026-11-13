import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// `runSkillsStep` spawns `npx skills add ...`. Mock `spawn` with a child that
// exits 0 so the test can inspect the spawn options without running npx.
const { spawnMock, confirmMock, trackMock, state } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  confirmMock: vi.fn(),
  trackMock: vi.fn(),
  state: { bundledUnreadable: false, globalRoot: null as string | null },
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    default: { ...actual, spawn: spawnMock },
    spawn: spawnMock,
  };
});

vi.mock("@argent/telemetry", () => ({ track: trackMock }));

vi.mock("../src/utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils.js")>();
  return {
    ...actual,
    isOnline: vi.fn(async () => true),
    getGloballyInstalledPackageRoot: () => state.globalRoot,
    getGloballyInstalledVersion: () => (state.globalRoot ? actual.getInstalledVersion() : null),
    listBundledSkills: (dir?: string) =>
      state.bundledUnreadable ? [] : actual.listBundledSkills(dir),
  };
});

vi.mock("@clack/prompts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clack/prompts")>();
  return { ...actual, confirm: confirmMock, select: vi.fn(async () => "interactive") };
});

import {
  formatSkillsSummaryLine,
  runSkillsStep,
  skillsAreMissing,
  type SkillsStepResult,
} from "../src/init-skills.js";
import { SKILLS_DIR, buildArgentSkillsSource, getInstalledVersion } from "../src/utils.js";

const originalPackage = process.env.npm_config_package;
const originalHome = process.env.HOME;
const originalXdg = process.env.XDG_STATE_HOME;
let tmpDir: string;
let exitCode: number;
// Exit code per `skills add` attempt, then `exitCode`. Null means killed by a signal.
let addExitCodes: (number | null)[];
// Whether a clean `skills add` writes a skill, as the real CLI does.
let addWritesSkills: boolean;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-init-skills-test-"));
  // Never touch the real ~/.agents or ~/.claude skill dirs.
  process.env.HOME = path.join(tmpDir, "home");
  process.env.XDG_STATE_HOME = path.join(tmpDir, "home", "xdg");
  exitCode = 0;
  addExitCodes = [];
  addWritesSkills = true;
  state.bundledUnreadable = false;
  state.globalRoot = null;
  confirmMock.mockReset();
  trackMock.mockClear();
  spawnMock.mockReset();
  spawnMock.mockImplementation((_cmd: string, args: string[], opts: { cwd?: string }) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    const isAdd = args.includes("add");
    const code = isAdd && addExitCodes.length > 0 ? addExitCodes.shift()! : exitCode;
    if (isAdd && code === 0 && addWritesSkills) {
      const root = args.includes("-g") ? process.env.HOME! : (opts.cwd ?? process.cwd());
      const skill = path.join(root, ".agents", "skills", "argent-device-interact");
      fs.mkdirSync(skill, { recursive: true });
      fs.writeFileSync(path.join(skill, "SKILL.md"), "");
    }
    setImmediate(() => child.emit("close", code, code === null ? "SIGTERM" : null));
    return child;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (originalPackage === undefined) delete process.env.npm_config_package;
  else process.env.npm_config_package = originalPackage;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalXdg === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = originalXdg;
});

function mkdirs(...dirs: string[]): void {
  for (const dir of dirs) fs.mkdirSync(dir, { recursive: true });
}

function writeLock(lockPath: string, names: string[]): void {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const skills = Object.fromEntries(names.map((name) => [name, { source: "x" }]));
  fs.writeFileSync(lockPath, JSON.stringify({ version: 1, skills }));
}

function lockNames(lockPath: string): string[] {
  return Object.keys(JSON.parse(fs.readFileSync(lockPath, "utf8")).skills).sort();
}

describe("runSkillsStep", () => {
  it("runs `npx skills add` without an inherited npm_config_package (#1335)", async () => {
    // Set by `npx --package @swmansion/argent -- argent init`.
    process.env.npm_config_package = "@swmansion/argent@latest";

    const { method } = await runSkillsStep({
      nonInteractive: true,
      fromTar: null,
      version: "unknown",
      scope: "global",
    });

    expect(method).toBe("default");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args, opts] = spawnMock.mock.calls[0]! as [
      string,
      string[],
      { env?: NodeJS.ProcessEnv },
    ];
    expect(args).toContain("skills");
    expect(args).toContain("add");
    expect(opts.env).toBeDefined();
    expect(opts.env).not.toHaveProperty("npm_config_package");
  });

  it("removes legacy skills from the global scope after a successful install", async () => {
    const home = process.env.HOME!;
    const store = path.join(home, ".agents", "skills");
    const editor = path.join(home, ".claude", "skills");
    mkdirs(path.join(store, "argent-create-flow"), path.join(store, "argent-create-e2e"), editor);
    fs.symlinkSync(path.join(store, "argent-qa-flows"), path.join(editor, "argent-qa-flows"));
    const lockPath = path.join(home, "xdg", "skills", ".skill-lock.json");
    writeLock(lockPath, ["argent-create-flow", "argent-create-e2e"]);

    await runSkillsStep({
      nonInteractive: true,
      fromTar: null,
      version: "unknown",
      scope: "global",
    });

    expect(fs.existsSync(path.join(store, "argent-create-flow"))).toBe(false);
    expect(fs.lstatSync(path.join(editor, "argent-qa-flows"), { throwIfNoEntry: false })).toBe(
      undefined
    );
    expect(fs.existsSync(path.join(store, "argent-create-e2e"))).toBe(true);
    expect(lockNames(lockPath)).toEqual(["argent-create-e2e"]);
  });

  it("runs `skills remove` on tracked legacy names so every agent dir drops them", async () => {
    const home = process.env.HOME!;
    mkdirs(path.join(home, ".agents", "skills", "argent-create-flow"));
    writeLock(path.join(home, "xdg", "skills", ".skill-lock.json"), [
      "argent-create-flow",
      "argent-create-e2e",
    ]);

    await runSkillsStep({
      nonInteractive: true,
      fromTar: null,
      version: "unknown",
      scope: "global",
    });

    expect(spawnMock).toHaveBeenCalledTimes(2);
    const [, args] = spawnMock.mock.calls[1]! as [string, string[]];
    expect(args).toEqual(expect.arrayContaining(["skills", "remove", "-y", "-g"]));
    expect(args).toContain("argent-create-flow");
    expect(args).not.toContain("argent-create-e2e");
  });

  it("keeps legacy skills installed from another version's tag", async () => {
    // A project pinned to an older local install gets that version's skills,
    // which may still be the legacy names.
    const project = path.join(tmpDir, "project");
    vi.spyOn(process, "cwd").mockReturnValue(project);
    const legacy = path.join(project, ".agents", "skills", "argent-create-flow");
    mkdirs(legacy);
    const lockPath = path.join(project, "skills-lock.json");
    writeLock(lockPath, ["argent-create-flow"]);

    await runSkillsStep({
      nonInteractive: true,
      fromTar: null,
      version: "0.0.1-older",
      scope: "local",
    });

    const [, args] = spawnMock.mock.calls[0]! as [string, string[]];
    expect(args.some((arg) => arg.endsWith("#v0.0.1-older"))).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(legacy)).toBe(true);
    expect(lockNames(lockPath)).toEqual(["argent-create-flow"]);
  });

  it("removes legacy skills from the project only, leaving the global scope alone", async () => {
    const project = path.join(tmpDir, "project");
    vi.spyOn(process, "cwd").mockReturnValue(project);
    mkdirs(path.join(project, ".claude", "skills", "argent-create-flow"));
    writeLock(path.join(project, "skills-lock.json"), ["argent-create-flow", "argent-create-e2e"]);
    const globalLegacy = path.join(process.env.HOME!, ".claude", "skills", "argent-create-flow");
    mkdirs(globalLegacy);

    await runSkillsStep({
      nonInteractive: true,
      fromTar: null,
      version: "unknown",
      scope: "local",
    });

    expect(fs.existsSync(path.join(project, ".claude", "skills", "argent-create-flow"))).toBe(
      false
    );
    expect(lockNames(path.join(project, "skills-lock.json"))).toEqual(["argent-create-e2e"]);
    expect(fs.existsSync(globalLegacy)).toBe(true);
  });

  it("prunes the custom root a custom-scope install wrote to", async () => {
    const custom = path.join(tmpDir, "custom");
    const legacy = path.join(custom, ".agents", "skills", "argent-qa-flows");
    mkdirs(legacy);

    await runSkillsStep({
      nonInteractive: true,
      fromTar: null,
      version: "unknown",
      scope: "custom",
      customRoot: custom,
    });

    expect(fs.existsSync(legacy)).toBe(false);
  });

  it("runs project-scope `npx skills add` from the resolved project root, not a subdirectory (#1467)", async () => {
    const root = path.join(tmpDir, "repo");
    const subdir = path.join(root, "packages", "app");
    mkdirs(path.join(root, ".git"), subdir);
    vi.spyOn(process, "cwd").mockReturnValue(subdir);

    await runSkillsStep({
      nonInteractive: true,
      fromTar: null,
      version: "unknown",
      scope: "local",
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, , opts] = spawnMock.mock.calls[0]! as [string, string[], { cwd?: string }];
    expect(opts.cwd).toBe(root);
  });

  it("prunes legacy skills at the project root when init runs from a subdirectory (#1467)", async () => {
    const root = path.join(tmpDir, "repo");
    const subdir = path.join(root, "packages", "app");
    mkdirs(path.join(root, ".git"), subdir);
    vi.spyOn(process, "cwd").mockReturnValue(subdir);
    const legacy = path.join(root, ".claude", "skills", "argent-create-flow");
    mkdirs(legacy);
    const lockPath = path.join(root, "skills-lock.json");
    writeLock(lockPath, ["argent-create-flow", "argent-create-e2e"]);

    await runSkillsStep({
      nonInteractive: true,
      fromTar: null,
      version: "unknown",
      scope: "local",
    });

    expect(fs.existsSync(legacy)).toBe(false);
    expect(lockNames(lockPath)).toEqual(["argent-create-e2e"]);
  });

  it("keeps legacy skills when `npx skills add` fails", async () => {
    exitCode = 1;
    const legacy = path.join(process.env.HOME!, ".agents", "skills", "argent-create-flow");
    mkdirs(legacy);

    await runSkillsStep({
      nonInteractive: true,
      fromTar: null,
      version: "unknown",
      scope: "global",
    });

    expect(fs.existsSync(legacy)).toBe(true);
  });
});

describe("runSkillsStep when the install fails (#614)", () => {
  const version = "0.0.1-untagged";
  const pinned = buildArgentSkillsSource(version);
  const project = () => path.join(tmpDir, "project");

  const step = (overrides: Partial<Parameters<typeof runSkillsStep>[0]> = {}) =>
    runSkillsStep({
      nonInteractive: true,
      fromTar: null,
      version,
      scope: "local",
      ...overrides,
    });
  const interactiveStep = () => step({ nonInteractive: false });

  const addSources = (): string[] =>
    spawnMock.mock.calls
      .map((call) => call[1] as string[])
      .filter((args) => args.includes("add"))
      .map((args) => args[args.indexOf("add") + 1]!);

  beforeEach(() => {
    mkdirs(project());
    vi.spyOn(process, "cwd").mockReturnValue(project());
  });

  it("uses only the pinned source when it works", async () => {
    const result = await step();

    expect(addSources()).toEqual([pinned]);
    expect(result).toMatchObject({
      outcome: "success",
      source: "pinned",
      usedFallback: false,
      installedCount: 1,
    });
  });

  it("falls back to the bundled copy on any failure and says so in telemetry", async () => {
    addExitCodes = [1];

    const result = await step();

    expect(addSources()).toEqual([pinned, SKILLS_DIR]);
    expect(result).toMatchObject({
      outcome: "success",
      source: "bundled",
      usedFallback: true,
      installedCount: 1,
    });
    expect(trackMock).toHaveBeenCalledWith(
      "installation:skill_install",
      expect.objectContaining({ used_fallback: true, fallback_reason: "unclassified" })
    );
  });

  it("reports failure when the fallback fails too, with nothing on disk", async () => {
    exitCode = 1;

    const result = await step();

    expect(addSources()).toEqual([pinned, SKILLS_DIR]);
    expect(result).toMatchObject({
      outcome: "failure",
      source: null,
      usedFallback: false,
      installedCount: 0,
    });
  });

  it("counts skills an earlier install left behind when this one fails", async () => {
    exitCode = 1;
    const existing = path.join(project(), ".agents", "skills", "argent-device-interact");
    mkdirs(existing);
    fs.writeFileSync(path.join(existing, "SKILL.md"), "");

    const result = await step();

    expect(result).toMatchObject({ outcome: "failure", installedCount: 1 });
  });

  it("does not trust a clean exit that left nothing on disk (#1335)", async () => {
    addWritesSkills = false;

    const result = await step();

    expect(addSources()).toEqual([pinned, SKILLS_DIR]);
    expect(result).toMatchObject({ outcome: "failure", installedCount: 0 });
  });

  it("does not retry a source that is already the bundled copy", async () => {
    exitCode = 1;

    const result = await step({ fromTar: "/tmp/argent.tgz" });

    expect(addSources()).toEqual([SKILLS_DIR]);
    expect(result).toMatchObject({ outcome: "failure" });
  });

  it("does not retry when the bundled copy is unreadable", async () => {
    addExitCodes = [1];
    state.bundledUnreadable = true;

    const result = await step();

    expect(addSources()).toEqual([pinned]);
    expect(result).toMatchObject({ outcome: "failure" });
  });

  it("does not retry when npx itself is missing (#1206)", async () => {
    spawnMock.mockImplementationOnce(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      setImmediate(() =>
        child.emit("error", Object.assign(new Error("spawn npx ENOENT"), { code: "ENOENT" }))
      );
      return child;
    });

    const result = await step();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ outcome: "failure", installedCount: 0 });
  });

  it("does not retry an attempt killed by a signal", async () => {
    addExitCodes = [null];

    const result = await step();

    expect(addSources()).toEqual([pinned]);
    expect(result).toMatchObject({ outcome: "failure" });
  });

  it("keeps the scope flag when it retries", async () => {
    addExitCodes = [1];

    await step({ scope: "global" });

    const retryArgs = spawnMock.mock.calls[1]![1] as string[];
    expect(retryArgs).toEqual(
      expect.arrayContaining(["--fetch-retries=0", "add", SKILLS_DIR, "-g"])
    );
  });

  it("retries a custom-scope install from the custom root", async () => {
    addExitCodes = [1];
    const custom = path.join(tmpDir, "custom");
    mkdirs(custom);

    const result = await step({ scope: "custom", customRoot: custom });

    expect(spawnMock.mock.calls[1]![2]).toMatchObject({ cwd: custom });
    expect(result).toMatchObject({ outcome: "success", installedCount: 1 });
  });

  it("prunes legacy skills after a rescued install from this package's copy", async () => {
    addExitCodes = [1];
    const legacy = path.join(project(), ".agents", "skills", "argent-create-flow");
    mkdirs(legacy);

    await step({ version: getInstalledVersion()! });

    expect(fs.existsSync(legacy)).toBe(false);
  });

  it("asks before reopening the TUI, and stops if declined", async () => {
    addExitCodes = [1];
    confirmMock.mockResolvedValue(false);

    const result = await interactiveStep();

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(addSources()).toEqual([pinned]);
    expect(result).toMatchObject({ method: "interactive", outcome: "failure" });
  });

  it("retries in the TUI when confirmed", async () => {
    addExitCodes = [1];
    confirmMock.mockResolvedValue(true);

    const result = await interactiveStep();

    expect(addSources()).toEqual([pinned, SKILLS_DIR]);
    expect(result).toMatchObject({ outcome: "success", usedFallback: true });
  });

  it("falls back to the global install's copy, not the running package's", async () => {
    // Under `npx` the running package sits in the npx cache, and the lock would
    // record that machine-local, clearable path.
    addExitCodes = [1];
    state.globalRoot = path.join(tmpDir, "global", "argent");
    const globalSkill = path.join(state.globalRoot, "skills", "argent-device-interact");
    mkdirs(globalSkill);
    fs.writeFileSync(path.join(globalSkill, "SKILL.md"), "");
    const installed = getInstalledVersion()!;

    const result = await step({ version: installed });

    expect(addSources()).toEqual([
      buildArgentSkillsSource(installed),
      path.join(state.globalRoot, "skills"),
    ]);
    expect(result).toMatchObject({ outcome: "success", usedFallback: true });
  });

  it("does not count retired or stray argent dirs as installed skills", async () => {
    exitCode = 1;
    for (const name of ["argent-create-flow", "argent-qa-flows", "argent-not-a-skill"]) {
      mkdirs(path.join(project(), ".agents", "skills", name));
      fs.writeFileSync(path.join(project(), ".agents", "skills", name, "SKILL.md"), "");
    }

    const result = await step();

    expect(result).toMatchObject({ outcome: "failure", installedCount: 0 });
  });

  it("counts a skill reached through an editor's symlink", async () => {
    exitCode = 1;
    const shared = path.join(tmpDir, "elsewhere", "argent-device-interact");
    mkdirs(shared, path.join(project(), ".claude", "skills"));
    fs.writeFileSync(path.join(shared, "SKILL.md"), "");
    fs.symlinkSync(shared, path.join(project(), ".claude", "skills", "argent-device-interact"));

    const result = await step();

    expect(result).toMatchObject({ outcome: "failure", installedCount: 1 });
  });

  it("does not call a cancelled TUI over earlier skills a success", async () => {
    addWritesSkills = false;
    const existing = path.join(project(), ".agents", "skills", "argent-device-interact");
    mkdirs(existing);
    fs.writeFileSync(path.join(existing, "SKILL.md"), "");

    const result = await interactiveStep();

    expect(result).toMatchObject({ outcome: "skipped", installedCount: 1, installedThisRun: 0 });
  });

  it("treats a TUI that exits 0 and installs nothing as skipped, without retrying", async () => {
    addWritesSkills = false;

    const result = await interactiveStep();

    expect(confirmMock).not.toHaveBeenCalled();
    expect(addSources()).toEqual([pinned]);
    expect(result).toMatchObject({ outcome: "skipped", source: null, installedCount: 0 });
  });
});

describe("skills summary line (#614)", () => {
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

  it.each<[string, Partial<SkillsStepResult>, RegExp, boolean]>([
    ["a healthy install", {}, /18 installed$/, false],
    ["a rescued install", { usedFallback: true }, /18 installed from the bundled copy/, false],
    ["a partial run", { installedCount: 18, installedThisRun: 5 }, /5 installed$/, false],
    [
      "offline with earlier skills on disk",
      { method: "manual", outcome: "skipped", installedThisRun: 0, forcedManual: true },
      /not updated \(offline.*18 from an earlier install/,
      false,
    ],
    ["total failure", { outcome: "failure", installedCount: 0 }, /NOT installed/, true],
    [
      "failure over earlier skills",
      { outcome: "failure", installedThisRun: 0 },
      /not updated.*18 from an earlier install on disk/,
      false,
    ],
    [
      "offline with nothing on disk",
      { method: "manual", outcome: "skipped", installedCount: 0, forcedManual: true },
      /NOT installed \(offline/,
      false,
    ],
    [
      "Manual, chosen by the user",
      { method: "manual", outcome: "skipped", installedCount: 0 },
      /instructions printed$/,
      false,
    ],
    [
      "a TUI that installed nothing",
      { method: "interactive", outcome: "skipped", installedCount: 0 },
      /none installed \(none selected\)$/,
      false,
    ],
  ])("%s", (_name, overrides, line, missing) => {
    const skills = result(overrides);
    expect(formatSkillsSummaryLine(skills)).toMatch(line);
    expect(skillsAreMissing(skills)).toBe(missing);
  });
});
