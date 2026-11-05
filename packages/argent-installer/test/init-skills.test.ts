import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// `runSkillsStep` spawns `npx skills add ...`. Mock `spawn` with a child that
// exits 0 so the test can inspect the spawn options without running npx.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    default: { ...actual, spawn: spawnMock },
    spawn: spawnMock,
  };
});

vi.mock("@argent/telemetry", () => ({ track: vi.fn() }));

vi.mock("../src/utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils.js")>();
  return { ...actual, isOnline: vi.fn(async () => true) };
});

import { runSkillsStep } from "../src/init-skills.js";

const originalPackage = process.env.npm_config_package;
const originalHome = process.env.HOME;
const originalXdg = process.env.XDG_STATE_HOME;
let tmpDir: string;
let exitCode: number;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-init-skills-test-"));
  // Never touch the real ~/.agents or ~/.claude skill dirs.
  process.env.HOME = path.join(tmpDir, "home");
  process.env.XDG_STATE_HOME = path.join(tmpDir, "home", "xdg");
  exitCode = 0;
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    setImmediate(() => child.emit("close", exitCode));
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

    const method = await runSkillsStep({
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
