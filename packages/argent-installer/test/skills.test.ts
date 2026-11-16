import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Module mocks ─────────────────────────────────────────────────────────────
// `refreshArgentSkills` shells out to `npx skills add|remove`; we mock
// `execFileSync` so tests never touch the real skills CLI. The mock is hoisted
// so vi.mock can reference it.

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    default: { ...actual, execFileSync: execFileSyncMock },
    execFileSync: execFileSyncMock,
  };
});

// The skills module reads the bundled SKILLS_DIR via utils.ts. Stub
// `listBundledSkills` so each test controls which skills are considered
// currently shipped — everything else in utils.ts behaves normally.

const { listBundledSkillsMock } = vi.hoisted(() => ({
  listBundledSkillsMock: vi.fn(),
}));

vi.mock("../src/utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils.js")>();
  return {
    ...actual,
    listBundledSkills: listBundledSkillsMock,
  };
});

import { refreshArgentSkills, formatSkillRefreshSummary } from "../src/skills.js";

let tmpDir: string;
const originalXdg = process.env.XDG_STATE_HOME;
const originalHome = process.env.HOME;

function writeLock(lockPath: string, skills: Record<string, Record<string, unknown>>): void {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ version: 1, skills }));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-skills-test-"));
  execFileSyncMock.mockReset();
  listBundledSkillsMock.mockReset();
  // Point the global lock at a per-test directory so we never touch the
  // user's real ~/.agents/.skill-lock.json during the suite.
  process.env.XDG_STATE_HOME = path.join(tmpDir, "xdg");
  // The legacy-dir prune resolves global skill dirs from homedir().
  process.env.HOME = path.join(tmpDir, "home");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (originalXdg === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = originalXdg;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

describe("refreshArgentSkills", () => {
  it("skips the refresh entirely when the bundled set is unreadable", () => {
    // listBundledSkills returns [] when SKILLS_DIR is gone — a pruned pnpm
    // store dir mid-update, a broken install. Treating that as "argent ships
    // zero skills" would classify EVERY tracked skill as orphaned and prune
    // them all from both scopes.
    listBundledSkillsMock.mockReturnValue([]);
    writeLock(path.join(tmpDir, "skills-lock.json"), {
      "argent-create-e2e": {},
      "argent-device-interact": {},
    });

    const results = refreshArgentSkills(tmpDir);

    expect(results).toEqual([]);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("pins every skills CLI run to the project root", () => {
    // The refresh can run as a detached updater whose inherited cwd is the
    // tool-server's editor-chosen one; project-scope `skills` commands act on
    // their cwd.
    listBundledSkillsMock.mockReturnValue(["argent-create-e2e"]);
    writeLock(path.join(tmpDir, "skills-lock.json"), { "argent-create-e2e": {} });

    refreshArgentSkills(tmpDir);

    expect(execFileSyncMock).toHaveBeenCalledWith(
      "npx",
      expect.any(Array),
      expect.objectContaining({ cwd: tmpDir })
    );
  });

  it("runs the skills CLI without an inherited npm_config_package", () => {
    // Under `npx --package @swmansion/argent -- argent ...`, npm exports
    // npm_config_package; a nested `npx skills` would otherwise reinstall argent
    // instead of the skills CLI (#1335).
    listBundledSkillsMock.mockReturnValue(["argent-create-e2e"]);
    writeLock(path.join(tmpDir, "skills-lock.json"), { "argent-create-e2e": {} });
    const original = process.env.npm_config_package;
    process.env.npm_config_package = "@swmansion/argent@latest";
    try {
      refreshArgentSkills(tmpDir);
    } finally {
      if (original === undefined) delete process.env.npm_config_package;
      else process.env.npm_config_package = original;
    }

    expect(execFileSyncMock).toHaveBeenCalled();
    for (const call of execFileSyncMock.mock.calls) {
      const opts = call[2] as { env?: NodeJS.ProcessEnv };
      expect(opts.env).toBeDefined();
      expect(opts.env).not.toHaveProperty("npm_config_package");
    }
  });

  it("returns an empty array when no scope tracks argent skills", () => {
    listBundledSkillsMock.mockReturnValue(["argent-create-e2e"]);

    const results = refreshArgentSkills(tmpDir);

    expect(results).toEqual([]);
    // With no tracked scopes we must not have invoked the skills CLI at all —
    // blind `skills add` in a random cwd would create a stray skills-lock.json.
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("resyncs a tracked project scope when the lock has an argent skill", () => {
    listBundledSkillsMock.mockReturnValue(["argent-create-e2e", "argent-ios-simulator-setup"]);
    writeLock(path.join(tmpDir, "skills-lock.json"), {
      "argent-create-e2e": {},
    });

    const results = refreshArgentSkills(tmpDir);

    expect(results).toEqual([
      { scope: "project", synced: 2, syncError: null, pruned: [], pruneError: null },
    ]);
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const [bin, args] = execFileSyncMock.mock.calls[0]! as [string, string[]];
    expect(bin).toBe("npx");
    expect(args).toContain("add");
    expect(args).not.toContain("-g");
    // The host project's npm engine gate (engines/devEngines) must be softened
    // via `--force` so re-sync never aborts with EBADDEVENGINES (#298). The
    // flag has to precede the `skills` command for npm to consume it.
    expect(args.indexOf("--force")).toBe(0);
    expect(args.indexOf("--force")).toBeLessThan(args.indexOf("skills"));
  });

  it("resyncs a tracked global scope with the -g flag", () => {
    listBundledSkillsMock.mockReturnValue(["argent-create-e2e"]);
    writeLock(path.join(tmpDir, "xdg", "skills", ".skill-lock.json"), {
      "argent-create-e2e": {},
    });

    const results = refreshArgentSkills(tmpDir);

    expect(results).toEqual([
      { scope: "global", synced: 1, syncError: null, pruned: [], pruneError: null },
    ]);
    const [, args] = execFileSyncMock.mock.calls[0]!;
    expect(args).toContain("-g");
  });

  it("prunes argent skills that are no longer bundled", () => {
    listBundledSkillsMock.mockReturnValue(["argent-create-e2e"]);
    writeLock(path.join(tmpDir, "skills-lock.json"), {
      "argent-create-e2e": {},
      "argent-super-workflow": {}, // was removed from bundled set
    });

    const results = refreshArgentSkills(tmpDir);

    expect(results).toHaveLength(1);
    expect(results[0]!.pruned).toEqual(["argent-super-workflow"]);
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
    // Second call is the remove — the orphan name is passed positionally.
    const [, removeArgs] = execFileSyncMock.mock.calls[1]!;
    expect(removeArgs).toContain("remove");
    expect(removeArgs).toContain("argent-super-workflow");
  });

  it("does not touch non-argent skills even if they sit in the same lock", () => {
    listBundledSkillsMock.mockReturnValue(["argent-create-e2e"]);
    writeLock(path.join(tmpDir, "skills-lock.json"), {
      "argent-create-e2e": {},
      "vercel-agent-skills": {},
      "my-custom-skill": {},
    });

    const results = refreshArgentSkills(tmpDir);

    // Only one scope, and no prune happened because nothing argent-prefixed
    // was missing. The other skills must not appear anywhere in results.
    expect(results).toEqual([
      { scope: "project", synced: 1, syncError: null, pruned: [], pruneError: null },
    ]);
    for (const call of execFileSyncMock.mock.calls) {
      expect(call[1]).not.toContain("vercel-agent-skills");
      expect(call[1]).not.toContain("my-custom-skill");
    }
  });

  it("refreshes both scopes when both track argent skills", () => {
    listBundledSkillsMock.mockReturnValue(["argent-create-e2e"]);
    writeLock(path.join(tmpDir, "skills-lock.json"), { "argent-create-e2e": {} });
    writeLock(path.join(tmpDir, "xdg", "skills", ".skill-lock.json"), {
      "argent-create-e2e": {},
    });

    const results = refreshArgentSkills(tmpDir);

    expect(results.map((r) => r.scope)).toEqual(["project", "global"]);
  });

  it("records sync errors without aborting the scope or skipping prune", () => {
    listBundledSkillsMock.mockReturnValue(["argent-create-e2e"]);
    writeLock(path.join(tmpDir, "skills-lock.json"), {
      "argent-create-e2e": {},
      "argent-old-workflow": {},
    });

    execFileSyncMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("add")) throw new Error("network down\nstack trace here");
      return Buffer.from("");
    });

    const results = refreshArgentSkills(tmpDir);

    // Sync failed, but prune still ran and succeeded.
    expect(results[0]).toMatchObject({
      scope: "project",
      synced: 0,
      syncError: "network down",
      pruned: ["argent-old-workflow"],
      pruneError: null,
    });
  });

  it("records prune errors independently of sync success", () => {
    listBundledSkillsMock.mockReturnValue(["argent-create-e2e"]);
    writeLock(path.join(tmpDir, "skills-lock.json"), {
      "argent-create-e2e": {},
      "argent-old-workflow": {},
    });

    execFileSyncMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("remove")) throw new Error("permission denied");
      return Buffer.from("");
    });

    const results = refreshArgentSkills(tmpDir);

    expect(results[0]).toMatchObject({
      synced: 1,
      syncError: null,
      pruned: [],
      pruneError: "permission denied",
    });
  });

  it("removes untracked legacy skill dirs and their editor links", () => {
    listBundledSkillsMock.mockReturnValue(["argent-create-e2e"]);
    writeLock(path.join(tmpDir, "skills-lock.json"), { "argent-create-e2e": {} });
    const store = path.join(tmpDir, ".agents", "skills");
    fs.mkdirSync(path.join(store, "argent-create-flow"), { recursive: true });
    fs.writeFileSync(path.join(store, "argent-create-flow", "SKILL.md"), "old");
    fs.mkdirSync(path.join(store, "my-skill"), { recursive: true });
    const editor = path.join(tmpDir, ".claude", "skills");
    fs.mkdirSync(editor, { recursive: true });
    // Dangles once the store copy above is gone.
    fs.symlinkSync(path.join(store, "argent-qa-flows"), path.join(editor, "argent-qa-flows"));

    const results = refreshArgentSkills(tmpDir);

    expect(results[0]!.pruned).toEqual(["argent-create-flow", "argent-qa-flows"]);
    expect(fs.existsSync(path.join(store, "argent-create-flow"))).toBe(false);
    expect(fs.lstatSync(path.join(editor, "argent-qa-flows"), { throwIfNoEntry: false })).toBe(
      undefined
    );
    expect(fs.existsSync(path.join(store, "my-skill"))).toBe(true);
    // Removed from disk directly: no lock entry, so no `skills remove` run.
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it("leaves legacy skill dirs alone in a scope that tracks no argent skill", () => {
    listBundledSkillsMock.mockReturnValue(["argent-create-e2e"]);
    const legacy = path.join(tmpDir, ".agents", "skills", "argent-create-flow");
    fs.mkdirSync(legacy, { recursive: true });

    expect(refreshArgentSkills(tmpDir)).toEqual([]);
    expect(fs.existsSync(legacy)).toBe(true);
  });
});

describe("formatSkillRefreshSummary", () => {
  it("returns null for an empty result set", () => {
    expect(formatSkillRefreshSummary([])).toBeNull();
  });

  it("returns null when every result is a no-op", () => {
    const summary = formatSkillRefreshSummary([
      { scope: "project", synced: 0, syncError: null, pruned: [], pruneError: null },
    ]);
    expect(summary).toBeNull();
  });

  it("reports sync counts and pruned names", () => {
    const summary = formatSkillRefreshSummary([
      {
        scope: "project",
        synced: 9,
        syncError: null,
        pruned: ["argent-old-workflow"],
        pruneError: null,
      },
    ]);
    expect(summary).toContain("project");
    expect(summary).toContain("synced 9");
    expect(summary).toContain("pruned 1 (argent-old-workflow)");
  });

  it("surfaces both sync and prune errors", () => {
    const summary = formatSkillRefreshSummary([
      {
        scope: "global",
        synced: 0,
        syncError: "network down",
        pruned: [],
        pruneError: "permission denied",
      },
    ]);
    expect(summary).toContain("sync failed");
    expect(summary).toContain("network down");
    expect(summary).toContain("prune failed");
    expect(summary).toContain("permission denied");
  });
});
