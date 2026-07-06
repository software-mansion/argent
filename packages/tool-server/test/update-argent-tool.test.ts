import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
  // `on` is required: the tool attaches an 'error' listener so a failed spawn
  // (ENOENT when `argent` isn't on PATH — the norm in local mode) can't crash
  // the tool-server via an unhandled 'error' event.
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

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    mockSpawn.mockReturnValue(makeChild());
    mockGetUpdateState.mockReturnValue(stateWithUpdate());
    const mod = await import("../src/tools/system/update-argent");
    updateArgentTool = mod.updateArgentTool;
  });

  afterEach(() => {
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

  it("pins --local when target is 'local'", async () => {
    await updateArgentTool.execute({}, { target: "local" }, undefined);
    vi.advanceTimersByTime(2000);
    expect(mockSpawn).toHaveBeenCalledWith(
      "argent",
      ["update", "--yes", "--local", "--version", "99.0.0"],
      expect.anything()
    );
  });

  it("pins both --global and --local when target is 'both'", async () => {
    await updateArgentTool.execute({}, { target: "both" }, undefined);
    vi.advanceTimersByTime(2000);
    expect(mockSpawn).toHaveBeenCalledWith(
      "argent",
      ["update", "--yes", "--global", "--local", "--version", "99.0.0"],
      expect.anything()
    );
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

  it("returns 'already up to date' when no update is available", async () => {
    mockGetUpdateState.mockReturnValue(stateUpToDate());

    const result = await updateArgentTool.execute({}, {}, undefined);
    expect((result as { message: string }).message).toContain("already up to date");
    vi.advanceTimersByTime(5000);
    expect(mockSpawn).not.toHaveBeenCalled();
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
