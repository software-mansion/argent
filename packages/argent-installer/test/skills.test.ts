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
  it("returns an empty array when no scope tracks argent skills", () => {
    listBundledSkillsMock.mockReturnValue(["argent-create-flow"]);

    const results = refreshArgentSkills(tmpDir);

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

    const results = refreshArgentSkills(tmpDir);

    expect(results).toEqual([
      { scope: "project", synced: 2, syncError: null, pruned: [], pruneError: null },
    ]);
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const [bin, args] = execFileSyncMock.mock.calls[0]!;
    expect(bin).toBe("npx");
    expect(args).toContain("add");
    expect(args).not.toContain("-g");
  });

  it("resyncs a tracked global scope with the -g flag", () => {
    listBundledSkillsMock.mockReturnValue(["argent-create-flow"]);
    writeLock(path.join(tmpDir, "xdg", "skills", ".skill-lock.json"), {
      "argent-create-flow": {},
    });

    const results = refreshArgentSkills(tmpDir);

    expect(results).toEqual([
      { scope: "global", synced: 1, syncError: null, pruned: [], pruneError: null },
    ]);
    const [, args] = execFileSyncMock.mock.calls[0]!;
    expect(args).toContain("-g");
  });

  it("prunes argent skills that are no longer bundled", () => {
    listBundledSkillsMock.mockReturnValue(["argent-create-flow"]);
    writeLock(path.join(tmpDir, "skills-lock.json"), {
      "argent-create-flow": {},
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
    listBundledSkillsMock.mockReturnValue(["argent-create-flow"]);
    writeLock(path.join(tmpDir, "skills-lock.json"), {
      "argent-create-flow": {},
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
    listBundledSkillsMock.mockReturnValue(["argent-create-flow"]);
    writeLock(path.join(tmpDir, "skills-lock.json"), { "argent-create-flow": {} });
    writeLock(path.join(tmpDir, "xdg", "skills", ".skill-lock.json"), {
      "argent-create-flow": {},
    });

    const results = refreshArgentSkills(tmpDir);

    expect(results.map((r) => r.scope)).toEqual(["project", "global"]);
  });

  it("records sync errors without aborting the scope or skipping prune", () => {
    listBundledSkillsMock.mockReturnValue(["argent-create-flow"]);
    writeLock(path.join(tmpDir, "skills-lock.json"), {
      "argent-create-flow": {},
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
    listBundledSkillsMock.mockReturnValue(["argent-create-flow"]);
    writeLock(path.join(tmpDir, "skills-lock.json"), {
      "argent-create-flow": {},
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
