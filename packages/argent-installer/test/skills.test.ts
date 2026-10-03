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

import {
  refreshArgentSkills,
  formatSkillRefreshSummary,
  skillScopesForTargets,
} from "../src/skills.js";

let tmpDir: string;
const originalXdg = process.env.XDG_STATE_HOME;

// Skills a *newer* install wrote are never pruned (see mayPruneScope), so a
// fixture that expects pruning has to record a version at or below ours.
const OLD_REF = { ref: "v0.0.1" };

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
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (originalXdg === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = originalXdg;
});

describe("refreshArgentSkills", () => {
  it("skips the refresh entirely when the bundled set is unreadable", () => {
    // listBundledSkills returns [] when SKILLS_DIR is gone — a pruned pnpm
    // store dir mid-update, a broken install. Treating that as "argent ships
    // zero skills" would classify EVERY tracked skill as orphaned and prune
    // them all from both scopes.
    listBundledSkillsMock.mockReturnValue([]);
    writeLock(path.join(tmpDir, "skills-lock.json"), {
      "argent-create-flow": {},
      "argent-device-interact": {},
    });

    const results = refreshArgentSkills({ projectRoot: tmpDir, scopes: ["project", "global"] });

    expect(results).toEqual([]);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("pins every skills CLI run to the project root", () => {
    // The refresh can run as a detached updater whose inherited cwd is the
    // tool-server's editor-chosen one; project-scope `skills` commands act on
    // their cwd.
    listBundledSkillsMock.mockReturnValue(["argent-create-flow"]);
    writeLock(path.join(tmpDir, "skills-lock.json"), { "argent-create-flow": {} });

    refreshArgentSkills({ projectRoot: tmpDir, scopes: ["project"] });

    expect(execFileSyncMock).toHaveBeenCalledWith(
      "npx",
      expect.any(Array),
      expect.objectContaining({ cwd: tmpDir })
    );
  });

  it("returns an empty array when no scope tracks argent skills", () => {
    listBundledSkillsMock.mockReturnValue(["argent-create-flow"]);

    const results = refreshArgentSkills({
      projectRoot: tmpDir,
      scopes: ["project", "global"],
    });

    expect(results).toEqual([]);
    // With no tracked scopes we must not have invoked the skills CLI at all —
    // blind `skills add` in a random cwd would create a stray skills-lock.json.
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("resyncs a tracked project scope when the lock has an argent skill", () => {
    listBundledSkillsMock.mockReturnValue(["argent-create-flow", "argent-ios-simulator-setup"]);
    writeLock(path.join(tmpDir, "skills-lock.json"), {
      "argent-create-flow": {},
    });

    const results = refreshArgentSkills({ projectRoot: tmpDir, scopes: ["project"] });

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
    listBundledSkillsMock.mockReturnValue(["argent-create-flow"]);
    writeLock(path.join(tmpDir, "xdg", "skills", ".skill-lock.json"), {
      "argent-create-flow": {},
    });

    const results = refreshArgentSkills({ projectRoot: tmpDir, scopes: ["global"] });

    expect(results).toEqual([
      { scope: "global", synced: 1, syncError: null, pruned: [], pruneError: null },
    ]);
    const [, args] = execFileSyncMock.mock.calls[0]!;
    expect(args).toContain("-g");
  });

  it("prunes argent skills that are no longer bundled", () => {
    listBundledSkillsMock.mockReturnValue(["argent-create-flow"]);
    writeLock(path.join(tmpDir, "skills-lock.json"), {
      "argent-create-flow": OLD_REF,
      "argent-super-workflow": OLD_REF, // was removed from bundled set
    });

    const results = refreshArgentSkills({ projectRoot: tmpDir, scopes: ["project", "global"] });

    expect(results).toHaveLength(1);
    expect(results[0]!.pruned).toEqual(["argent-super-workflow"]);
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
    // Second call is the remove — the orphan name is passed positionally.
    const [, removeArgs] = execFileSyncMock.mock.calls[1]!;
    expect(removeArgs).toContain("remove");
    expect(removeArgs).toContain("argent-super-workflow");
  });

  it("does not touch non-argent skills even if they sit in the same lock", () => {
    listBundledSkillsMock.mockReturnValue(["argent-create-flow"]);
    writeLock(path.join(tmpDir, "skills-lock.json"), {
      "argent-create-flow": {},
      "vercel-agent-skills": {},
      "my-custom-skill": {},
    });

    const results = refreshArgentSkills({ projectRoot: tmpDir, scopes: ["project"] });

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
    listBundledSkillsMock.mockReturnValue(["argent-create-flow"]);
    writeLock(path.join(tmpDir, "skills-lock.json"), { "argent-create-flow": {} });
    writeLock(path.join(tmpDir, "xdg", "skills", ".skill-lock.json"), {
      "argent-create-flow": {},
    });

    const results = refreshArgentSkills({ projectRoot: tmpDir, scopes: ["project", "global"] });

    expect(results.map((r) => r.scope)).toEqual(["project", "global"]);
  });

  it("records sync errors without aborting the scope or skipping prune", () => {
    listBundledSkillsMock.mockReturnValue(["argent-create-flow"]);
    writeLock(path.join(tmpDir, "skills-lock.json"), {
      "argent-create-flow": OLD_REF,
      "argent-old-workflow": OLD_REF,
    });

    execFileSyncMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("add")) throw new Error("network down\nstack trace here");
      return Buffer.from("");
    });

    const results = refreshArgentSkills({ projectRoot: tmpDir, scopes: ["project", "global"] });

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
    listBundledSkillsMock.mockReturnValue(["argent-create-flow"]);
    writeLock(path.join(tmpDir, "skills-lock.json"), {
      "argent-create-flow": OLD_REF,
      "argent-old-workflow": OLD_REF,
    });

    execFileSyncMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("remove")) throw new Error("permission denied");
      return Buffer.from("");
    });

    const results = refreshArgentSkills({ projectRoot: tmpDir, scopes: ["project"] });

    expect(results[0]).toMatchObject({
      synced: 1,
      syncError: null,
      pruned: [],
      pruneError: "permission denied",
    });
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

describe("scope containment", () => {
  // Both stores track argent skills, so anything acting on the wrong one shows up.
  function stageBothScopes(): void {
    listBundledSkillsMock.mockReturnValue(["argent-create-flow"]);
    writeLock(path.join(tmpDir, "skills-lock.json"), {
      "argent-create-flow": OLD_REF,
      "argent-old-workflow": OLD_REF,
    });
    writeLock(path.join(tmpDir, "xdg", "skills", ".skill-lock.json"), {
      "argent-create-flow": OLD_REF,
      "argent-old-workflow": OLD_REF,
    });
  }

  const skillCalls = () =>
    (execFileSyncMock.mock.calls as [string, string[]][]).map(([, args]) => args);

  it("leaves the machine-wide store alone when only the project was asked for", () => {
    // The reported bug: `argent update --local` rewrote the global store that
    // every other project on the machine shares.
    stageBothScopes();

    const results = refreshArgentSkills({ projectRoot: tmpDir, scopes: ["project"] });

    expect(results.map((r) => r.scope)).toEqual(["project"]);
    expect(skillCalls().every((args) => !args.includes("-g"))).toBe(true);
  });

  it("never prunes out of a store it was not asked to touch", () => {
    // The destructive half: prune targets the running package's bundled set, so
    // an older install would delete skills the store's real owner still ships.
    stageBothScopes();

    refreshArgentSkills({ projectRoot: tmpDir, scopes: ["project"] });

    const removals = skillCalls().filter((args) => args.includes("remove"));
    expect(removals.length).toBe(1);
    expect(removals[0]!).not.toContain("-g");
  });

  it("leaves the project store alone when only the global was asked for", () => {
    stageBothScopes();

    const results = refreshArgentSkills({ projectRoot: tmpDir, scopes: ["global"] });

    expect(results.map((r) => r.scope)).toEqual(["global"]);
    expect(skillCalls().every((args) => args.includes("-g"))).toBe(true);
  });

  it("does nothing at all when no scope is requested", () => {
    stageBothScopes();

    expect(refreshArgentSkills({ projectRoot: tmpDir, scopes: [] })).toEqual([]);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});

describe("prune ownership", () => {
  it("does not delete skills a newer install put there", () => {
    // Running 0.18.1 against a store filled by a hypothetical 99.x: the extra
    // skills are not obsolete, they are simply unknown to this package.
    listBundledSkillsMock.mockReturnValue(["argent-create-flow"]);
    writeLock(path.join(tmpDir, "skills-lock.json"), {
      "argent-create-flow": { ref: "v99.0.0" },
      "argent-from-the-future": { ref: "v99.0.0" },
    });

    const results = refreshArgentSkills({ projectRoot: tmpDir, scopes: ["project"] });

    expect(results[0]!.pruned).toEqual([]);
    const removals = (execFileSyncMock.mock.calls as [string, string[]][]).filter(([, args]) =>
      args.includes("remove")
    );
    expect(removals).toEqual([]);
  });

  it("does not delete when the store records no version at all", () => {
    // An older lock shape or a local source: we cannot tell who owns it, so we
    // must not judge which of its skills are obsolete.
    listBundledSkillsMock.mockReturnValue(["argent-create-flow"]);
    writeLock(path.join(tmpDir, "skills-lock.json"), {
      "argent-create-flow": {},
      "argent-old-workflow": {},
    });

    const results = refreshArgentSkills({ projectRoot: tmpDir, scopes: ["project"] });

    expect(results[0]!.pruned).toEqual([]);
  });
});

describe("skillScopesForTargets", () => {
  it.each([
    [["local"], "local", ["project"]],
    [["local"], "global", ["project"]],
    [["global"], "global", ["project", "global"]],
    // A global bump must not re-pin a lock that tracks the project's own install.
    [["global"], "local", ["global"]],
    [["global", "local"], "local", ["project", "global"]],
    [["global", "local"], "global", ["project", "global"]],
  ])("targets %j in a %s-mode project → %j", (targets, mode, expected) => {
    expect(skillScopesForTargets(targets as never, mode as never)).toEqual(expected);
  });

  it("returns scopes in a stable order regardless of target order", () => {
    expect(skillScopesForTargets(["local", "global"], "global")).toEqual(["project", "global"]);
    expect(skillScopesForTargets(["global", "local"], "global")).toEqual(["project", "global"]);
  });
});
