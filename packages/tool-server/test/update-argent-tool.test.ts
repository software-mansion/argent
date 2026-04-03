import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock child_process before importing the module under test.
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { updateArgentTool } from "../src/tools/system/update-argent";

const mockSpawn = vi.mocked(spawn);

function makeChild() {
  return { unref: vi.fn() } as unknown as ReturnType<typeof spawn>;
}

describe("update-argent tool", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockSpawn.mockReturnValue(makeChild());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("returns the expected message immediately", async () => {
    const result = await updateArgentTool.execute({}, undefined, undefined);

    expect(result).toEqual({
      message:
        "Argent update initiated. The tool server will stop and restart automatically once the update is installed. Subsequent tool calls will reconnect to the updated server.",
    });
  });

  it("spawns the correct command after 2 seconds", async () => {
    await updateArgentTool.execute({}, undefined, undefined);

    // Not yet spawned before 2000 ms.
    vi.advanceTimersByTime(1999);
    expect(mockSpawn).not.toHaveBeenCalled();

    // Now cross the threshold.
    vi.advanceTimersByTime(1);
    expect(mockSpawn).toHaveBeenCalledOnce();
    expect(mockSpawn).toHaveBeenCalledWith(
      "npx",
      ["@swmansion/argent", "update", "--yes"],
      { detached: true, stdio: "ignore" },
    );
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
});
