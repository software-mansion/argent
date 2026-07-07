import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Mock child_process and update-checker before importing the module under test.
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("../src/utils/update-checker", () => ({
  getUpdateState: vi.fn(),
}));

import { spawn } from "node:child_process";
import { getUpdateState } from "../src/utils/update-checker";

const mockSpawn = vi.mocked(spawn);
const mockGetUpdateState = vi.mocked(getUpdateState);

function makeChild() {
  // `on` is required: the tool attaches 'error' and 'exit' listeners so a
  // failed spawn (ENOENT when `argent` isn't on PATH — the norm in local mode)
  // can't crash the tool-server, and a no-op updater run unblocks later calls.
  return { unref: vi.fn(), on: vi.fn() } as unknown as ReturnType<typeof spawn>;
}

function stateWithUpdate(latestVersion = "99.0.0") {
  return {
    updateAvailable: true,
    updateInstallable: true,
    installableVersion: latestVersion,
    currentVersion: "1.0.0",
    latestVersion,
    latestPublishedAt: null,
    minReleaseAgeMs: 0,
  };
}

function stateHeldByPolicy(latestVersion = "99.0.0") {
  return {
    updateAvailable: true,
    updateInstallable: false,
    installableVersion: null,
    currentVersion: "1.0.0",
    latestVersion,
    latestPublishedAt: null,
    minReleaseAgeMs: 7 * 24 * 60 * 60 * 1000,
  };
}

function stateUpToDate() {
  return {
    updateAvailable: false,
    updateInstallable: false,
    installableVersion: null,
    currentVersion: "1.0.0",
    latestVersion: "1.0.0",
    latestPublishedAt: null,
    minReleaseAgeMs: 0,
  };
}

describe("update-argent tool", () => {
  // Re-import per test so the module-level `updateScheduled` flag resets.
  let updateArgentTool: typeof import("../src/tools/system/update-argent").updateArgentTool;
  let savedInstallKind: string | undefined;
  let savedProjectRoot: string | undefined;
  let originalCwd: string;
  let tmpDir: string;

  // A directory that provably hosts a local argent install, for tests that
  // exercise the project-root resolution of a local-targeted update.
  function stageDeclaringProject(): string {
    const projDir = path.join(tmpDir, "proj");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(
      path.join(projDir, "package.json"),
      JSON.stringify({ name: "proj", devDependencies: { "@swmansion/argent": "^1.0.0" } })
    );
    return projDir;
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    mockSpawn.mockReturnValue(makeChild());
    mockGetUpdateState.mockReturnValue(stateWithUpdate());
    // Pin the running-install classification: the fallback cwd-walk would
    // otherwise pick up whatever repository the test process runs in.
    savedInstallKind = process.env.ARGENT_INSTALL_KIND;
    savedProjectRoot = process.env.ARGENT_PROJECT_ROOT;
    process.env.ARGENT_INSTALL_KIND = "global";
    delete process.env.ARGENT_PROJECT_ROOT;
    originalCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-update-tool-"));
    // A cwd with no ancestor declaring argent, so findDeclaringProjectRoot is
    // deterministic (os.tmpdir() ancestors never declare the package).
    process.chdir(tmpDir);
    const mod = await import("../src/tools/system/update-argent");
    updateArgentTool = mod.updateArgentTool;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (savedInstallKind === undefined) delete process.env.ARGENT_INSTALL_KIND;
    else process.env.ARGENT_INSTALL_KIND = savedInstallKind;
    if (savedProjectRoot === undefined) delete process.env.ARGENT_PROJECT_ROOT;
    else process.env.ARGENT_PROJECT_ROOT = savedProjectRoot;
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("returns a message with current and latest version on success", async () => {
    const result = await updateArgentTool.execute({}, {}, undefined);
    expect((result as { message: string }).message).toContain("1.0.0 -> v99.0.0");
    expect((result as { message: string }).message).toContain("restart");
  });

  it("spawns `argent update` with a pinned target flag (not npx) after 2 seconds", async () => {
    await updateArgentTool.execute({}, { target: "global" }, undefined);

    vi.advanceTimersByTime(1999);
    expect(mockSpawn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(mockSpawn).toHaveBeenCalledOnce();
    expect(mockSpawn).toHaveBeenCalledWith(
      "argent",
      ["update", "--yes", "--global", "--version", "99.0.0"],
      {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, ARGENT_UPDATE_TRIGGER: "mcp_update" },
      }
    );
  });

  it("pins --local (no --version) and --project-root when targeting the other install", async () => {
    // A global-serving session asked to update the project's local install:
    // the --version pin came from the RUNNING install's update state, so the
    // installer resolves the right version per target itself — and the spawned
    // updater must bind to the declaring project via an explicit flag (its
    // inherited cwd is this server's editor-chosen cwd; a cwd pin would also
    // fail the spawn if the dir vanished).
    const projDir = stageDeclaringProject();
    process.chdir(projDir);

    await updateArgentTool.execute({}, { target: "local" }, undefined);
    vi.advanceTimersByTime(2000);

    expect(mockSpawn).toHaveBeenCalledWith(
      "argent",
      ["update", "--yes", "--local", "--project-root", fs.realpathSync(projDir)],
      expect.not.objectContaining({ cwd: expect.anything() })
    );
  });

  it("pins --version and the recorded project root when the running install IS the local target", async () => {
    const projDir = stageDeclaringProject();
    process.env.ARGENT_INSTALL_KIND = "local";
    process.env.ARGENT_PROJECT_ROOT = projDir;

    await updateArgentTool.execute({}, { target: "local" }, undefined);
    vi.advanceTimersByTime(2000);

    expect(mockSpawn).toHaveBeenCalledWith(
      "argent",
      ["update", "--yes", "--local", "--version", "99.0.0", "--project-root", projDir],
      expect.not.objectContaining({ cwd: expect.anything() })
    );
  });

  it("re-proves a recorded project root that no longer exists instead of pinning it", async () => {
    // The server recorded ARGENT_PROJECT_ROOT at spawn; the project has since
    // been deleted. The tool must not schedule an update bound to a dead path.
    process.env.ARGENT_INSTALL_KIND = "local";
    process.env.ARGENT_PROJECT_ROOT = path.join(tmpDir, "deleted-project");

    const result = await updateArgentTool.execute({}, { target: "local" }, undefined);

    expect((result as { message: string }).message).toContain("Could not determine which project");
    vi.advanceTimersByTime(5000);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("refuses a local target when no project can be located, instead of guessing", async () => {
    const result = await updateArgentTool.execute({}, { target: "local" }, undefined);

    expect((result as { message: string }).message).toContain("Could not determine which project");
    vi.advanceTimersByTime(5000);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("pins both --global and --local when target is 'both' and a project is locatable", async () => {
    const projDir = stageDeclaringProject();
    process.chdir(projDir);

    await updateArgentTool.execute({}, { target: "both" }, undefined);
    vi.advanceTimersByTime(2000);

    expect(mockSpawn).toHaveBeenCalledWith(
      "argent",
      ["update", "--yes", "--global", "--local", "--project-root", fs.realpathSync(projDir)],
      expect.not.objectContaining({ cwd: expect.anything() })
    );
  });

  it("degrades 'both' to --global (and says so) when no project is locatable", async () => {
    const result = await updateArgentTool.execute({}, { target: "both" }, undefined);
    vi.advanceTimersByTime(2000);

    // The degraded target IS the running install, so its gates and version pin
    // apply like a plain global update.
    expect(mockSpawn).toHaveBeenCalledWith(
      "argent",
      ["update", "--yes", "--global", "--version", "99.0.0"],
      expect.not.objectContaining({ cwd: expect.anything() })
    );
    expect((result as { message: string }).message).toContain("project-local install was skipped");
  });

  it("a degraded 'both' honors the running install's up-to-date gate", async () => {
    // 'both' with no locatable project degrades to global-only — exactly the
    // running install — so an up-to-date state must answer instead of spawning
    // a pointless updater with a false "will restart" promise.
    mockGetUpdateState.mockReturnValue(stateUpToDate());

    const result = await updateArgentTool.execute({}, { target: "both" }, undefined);

    expect((result as { message: string }).message).toContain("already up to date");
    vi.advanceTimersByTime(5000);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("auto (default) pins exactly one target flag and hints at the other install", async () => {
    const result = await updateArgentTool.execute({}, {}, undefined);
    vi.advanceTimersByTime(2000);

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args[0]).toBe("update");
    expect(args).toContain("--version");
    expect(args).toContain("99.0.0");
    // In 'auto' mode we resolve to the single install serving this session.
    const flags = args.filter((a) => a === "--global" || a === "--local");
    expect(flags).toHaveLength(1);
    // ...and hint at the OTHER install so the agent can offer to update it too.
    expect((result as { message: string }).message).toMatch(/call this tool again with target/);
  });

  it("does NOT spawn before 2 seconds have elapsed", async () => {
    await updateArgentTool.execute({}, {}, undefined);
    vi.advanceTimersByTime(1999);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("calls unref() on the child process", async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);

    await updateArgentTool.execute({}, {}, undefined);
    vi.advanceTimersByTime(2000);

    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("swallows a spawn error and allows a retry (no tool-server crash in local mode)", async () => {
    const handlers: Record<string, (err: Error) => void> = {};
    const child = {
      unref: vi.fn(),
      on: vi.fn((event: string, cb: (err: Error) => void) => {
        handlers[event] = cb;
        return child;
      }),
    } as unknown as ReturnType<typeof spawn>;
    mockSpawn.mockReturnValue(child);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await updateArgentTool.execute({}, {}, undefined);
    vi.advanceTimersByTime(2000);

    // ENOENT (`argent` not on PATH): the 'error' handler must exist and not throw.
    expect(handlers.error).toBeTypeOf("function");
    expect(() => handlers.error!(new Error("spawn argent ENOENT"))).not.toThrow();

    // The scheduled flag reset, so a later call re-attempts rather than reporting
    // "already in progress" forever.
    const second = await updateArgentTool.execute({}, {}, undefined);
    expect((second as { message: string }).message).not.toContain("already in progress");
    vi.advanceTimersByTime(2000);
    expect(mockSpawn).toHaveBeenCalledTimes(2);

    errSpy.mockRestore();
  });

  it("a no-op updater exit unblocks later calls (the server was not restarted)", async () => {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    const child = {
      unref: vi.fn(),
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        handlers[event] = cb;
        return child;
      }),
    } as unknown as ReturnType<typeof spawn>;
    mockSpawn.mockReturnValue(child);

    await updateArgentTool.execute({}, {}, undefined);
    vi.advanceTimersByTime(2000);

    // The updater ran and exited WITHOUT killing this server — it no-op'd
    // (e.g. a cross-install target that was already current). The next call
    // must not be stuck behind "already in progress".
    expect(handlers.exit).toBeTypeOf("function");
    handlers.exit!(0);

    const second = await updateArgentTool.execute({}, {}, undefined);
    expect((second as { message: string }).message).not.toContain("already in progress");
  });

  it("returns 'already up to date' when no update is available for the running install", async () => {
    mockGetUpdateState.mockReturnValue(stateUpToDate());

    const result = await updateArgentTool.execute({}, {}, undefined);
    expect((result as { message: string }).message).toContain("already up to date");
    vi.advanceTimersByTime(5000);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("a cross-install target bypasses the running install's up-to-date gate", async () => {
    // The update state only describes the RUNNING (global) install; "we are
    // current" says nothing about the project's local devDependency. The
    // installer gets the final word for the other install.
    mockGetUpdateState.mockReturnValue(stateUpToDate());
    const projDir = stageDeclaringProject();
    process.chdir(projDir);

    const result = await updateArgentTool.execute({}, { target: "local" }, undefined);
    vi.advanceTimersByTime(2000);

    expect((result as { message: string }).message).toContain("update initiated");
    expect(mockSpawn).toHaveBeenCalledWith(
      "argent",
      ["update", "--yes", "--local", "--project-root", fs.realpathSync(projDir)],
      expect.not.objectContaining({ cwd: expect.anything() })
    );
  });

  it("accepts an optionalDependencies declaration when proving the project", async () => {
    const projDir = path.join(tmpDir, "opt-proj");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(
      path.join(projDir, "package.json"),
      JSON.stringify({ name: "opt", optionalDependencies: { "@swmansion/argent": "^1.0.0" } })
    );
    process.chdir(projDir);

    const result = await updateArgentTool.execute({}, { target: "local" }, undefined);
    vi.advanceTimersByTime(2000);

    expect((result as { message: string }).message).toContain("update initiated");
    expect(mockSpawn).toHaveBeenCalledWith(
      "argent",
      ["update", "--yes", "--local", "--project-root", fs.realpathSync(projDir)],
      expect.anything()
    );
  });

  it("returns a held-by-policy message and does not spawn when the latest update is not installable yet", async () => {
    mockGetUpdateState.mockReturnValue(stateHeldByPolicy());

    const result = await updateArgentTool.execute({}, {}, undefined);
    expect((result as { message: string }).message).toContain("not installable yet");
    vi.advanceTimersByTime(5000);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("returns 'already in progress' and does not double-spawn on second call", async () => {
    await updateArgentTool.execute({}, {}, undefined);
    const second = await updateArgentTool.execute({}, {}, undefined);

    expect((second as { message: string }).message).toContain("already in progress");

    vi.advanceTimersByTime(5000);
    // Only one spawn despite two calls.
    expect(mockSpawn).toHaveBeenCalledOnce();
  });
});
