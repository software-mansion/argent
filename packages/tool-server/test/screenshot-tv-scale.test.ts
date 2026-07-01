import { describe, expect, it, vi, beforeEach } from "vitest";

// `tvTargetLongSide` shells `sips -g pixelWidth -g pixelHeight` to read the
// capture's real dimensions, then returns the `sips -Z` target as
// longest-actual-side * scale. Mock child_process.execFile so we can feed it a
// 4K vs a non-4K (1920x1080) Apple TV capture and assert the target.
const execFileMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile: (...args: unknown[]) => execFileMock(...args) };
});

import { tvTargetLongSide } from "../src/tools/screenshot";

// promisify(execFile) appends a node-style callback as the last argument. Reply
// with the given sips `-g` stdout via that callback when present.
function mockSipsDims(stdout: string): void {
  execFileMock.mockImplementation((...args: unknown[]) => {
    const cb = args.find((a) => typeof a === "function") as
      | ((e: Error | null, r: { stdout: string }) => void)
      | undefined;
    cb?.(null, { stdout });
  });
}

describe("tvTargetLongSide — tvOS screenshot scaling", () => {
  beforeEach(() => execFileMock.mockReset());

  it("scales against the real long side for a 4K (3840x2160) capture", async () => {
    mockSipsDims("pixelWidth: 3840\npixelHeight: 2160\n");
    expect(await tvTargetLongSide("/tmp/cap.png", 0.3)).toBe(1152); // 3840 * 0.3
  });

  it("regression: scales against 1920 for a non-4K Apple TV capture (no 2x blowup)", async () => {
    // The standard non-4K "Apple TV" sim captures at 1920x1080. The old code
    // hardcoded 3840, so `-Z 1152` against a 1920-wide image yielded an
    // effective 0.6x — twice the requested 0.3. The target must be 1920*0.3=576.
    mockSipsDims("pixelWidth: 1920\npixelHeight: 1080\n");
    expect(await tvTargetLongSide("/tmp/cap.png", 0.3)).toBe(576);
  });

  it("falls back to the 4K long side when the dimension probe fails", async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args.find((a) => typeof a === "function") as
        | ((e: Error | null) => void)
        | undefined;
      cb?.(new Error("sips: command not found"));
    });
    expect(await tvTargetLongSide("/tmp/cap.png", 0.3)).toBe(1152); // 3840 * 0.3 fallback
  });
});
