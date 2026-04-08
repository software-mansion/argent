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
  return { unref: vi.fn() } as unknown as ReturnType<typeof spawn>;
}

function stateWithUpdate(latestVersion = "99.0.0") {
  return {
    updateAvailable: true,
    currentVersion: "1.0.0",
    latestVersion,
  };
}

function stateUpToDate() {
  return {
    updateAvailable: false,
    currentVersion: "1.0.0",
    latestVersion: "1.0.0",
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
    const result = await updateArgentTool.execute({}, undefined, undefined);
    expect((result as { message: string }).message).toContain("1.0.0 -> v99.0.0");
    expect((result as { message: string }).message).toContain("restart");
  });

  it("spawns `argent update --yes` (not npx) after 2 seconds", async () => {
    await updateArgentTool.execute({}, undefined, undefined);

    vi.advanceTimersByTime(1999);
    expect(mockSpawn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(mockSpawn).toHaveBeenCalledOnce();
    expect(mockSpawn).toHaveBeenCalledWith("argent", ["update", "--yes"], {
      detached: true,
      stdio: "ignore",
    });
  });

  it("does NOT spawn before 2 seconds have elapsed", async () => {
    await updateArgentTool.execute({}, undefined, undefined);
    vi.advanceTimersByTime(1999);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("calls unref() on the child process", async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);

    await updateArgentTool.execute({}, undefined, undefined);
    vi.advanceTimersByTime(2000);

    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("returns 'already up to date' when no update is available", async () => {
    mockGetUpdateState.mockReturnValue(stateUpToDate());

    const result = await updateArgentTool.execute({}, undefined, undefined);
    expect((result as { message: string }).message).toContain("already up to date");
    vi.advanceTimersByTime(5000);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("returns 'already in progress' and does not double-spawn on second call", async () => {
    await updateArgentTool.execute({}, undefined, undefined);
    const second = await updateArgentTool.execute({}, undefined, undefined);

    expect((second as { message: string }).message).toContain("already in progress");

    vi.advanceTimersByTime(5000);
    // Only one spawn despite two calls.
    expect(mockSpawn).toHaveBeenCalledOnce();
  });
});
