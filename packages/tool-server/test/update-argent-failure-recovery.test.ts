import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

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

type FakeChild = EventEmitter & { unref: ReturnType<typeof vi.fn> };

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.unref = vi.fn();
  return child;
}

function stateWithUpdate(latestVersion = "99.0.0") {
  return {
    updateAvailable: true,
    currentVersion: "1.0.0",
    latestVersion,
  };
}

describe("update-argent failure recovery", () => {
  let updateArgentTool: typeof import("../src/tools/system/update-argent").updateArgentTool;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    mockGetUpdateState.mockReturnValue(stateWithUpdate());
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const mod = await import("../src/tools/system/update-argent");
    updateArgentTool = mod.updateArgentTool;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    stderrSpy.mockRestore();
  });

  it("clears the in-progress lock when the spawned child emits 'error'", async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const first = await updateArgentTool.execute({}, undefined, undefined);
    expect((first as { message: string }).message).toContain("update initiated");

    // Run the deferred spawn so listeners attach.
    vi.advanceTimersByTime(2000);
    expect(mockSpawn).toHaveBeenCalledOnce();

    // Simulate a spawn failure (e.g. argent not on PATH, ENOENT).
    child.emit("error", new Error("spawn argent ENOENT"));

    // A retry must NOT be locked out — the previous attempt failed.
    const second = await updateArgentTool.execute({}, undefined, undefined);
    const secondMessage = (second as { message: string }).message;
    expect(secondMessage).not.toContain("already in progress");
    expect(secondMessage).toContain("update initiated");
  });

  it("clears the in-progress lock when the spawned child exits non-zero", async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    await updateArgentTool.execute({}, undefined, undefined);
    vi.advanceTimersByTime(2000);

    // Update process exited with a non-zero code.
    child.emit("exit", 1, null);

    const second = await updateArgentTool.execute({}, undefined, undefined);
    const secondMessage = (second as { message: string }).message;
    expect(secondMessage).not.toContain("already in progress");
    expect(secondMessage).toContain("update initiated");
  });

  it("keeps the lock when the spawned child exits cleanly (code 0)", async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    await updateArgentTool.execute({}, undefined, undefined);
    vi.advanceTimersByTime(2000);

    // Successful exit — the tool-server is about to be replaced; do not unlock.
    child.emit("exit", 0, null);

    const second = await updateArgentTool.execute({}, undefined, undefined);
    expect((second as { message: string }).message).toContain("already in progress");
  });

  it("logs to stderr on spawn error", async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    await updateArgentTool.execute({}, undefined, undefined);
    vi.advanceTimersByTime(2000);

    child.emit("error", new Error("spawn argent ENOENT"));

    expect(stderrSpy).toHaveBeenCalled();
    const writes = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(writes).toContain("ENOENT");
  });
});
