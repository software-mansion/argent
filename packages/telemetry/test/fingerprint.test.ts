/**
 * `resolveHostFingerprint` shells out to `simulator-server fingerprint`. It must
 * be best-effort: any failure (binary missing, non-zero exit, timeout, empty
 * output) returns null so identity falls back to a random id and never throws.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const execFileSyncMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFileSync: (...args: unknown[]) => execFileSyncMock(...args) };
});

const binaryPathMock = vi.fn(() => "/fake/simulator-server");
vi.mock("@argent/native-devtools-ios", () => ({
  simulatorServerBinaryPath: () => binaryPathMock(),
}));

import { resolveHostFingerprint } from "../src/fingerprint.js";

describe("resolveHostFingerprint", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    binaryPathMock.mockReset();
    binaryPathMock.mockReturnValue("/fake/simulator-server");
  });

  it("returns the trimmed fingerprint on success", () => {
    execFileSyncMock.mockReturnValue(`${"a".repeat(64)}\n`);
    expect(resolveHostFingerprint()).toBe("a".repeat(64));
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "/fake/simulator-server",
      ["fingerprint"],
      expect.objectContaining({ encoding: "utf8" })
    );
  });

  it("returns null for empty / whitespace-only output", () => {
    execFileSyncMock.mockReturnValue("   \n");
    expect(resolveHostFingerprint()).toBeNull();
  });

  it("returns null when the command throws (missing binary / non-zero exit / timeout)", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("spawn ENOENT");
    });
    expect(resolveHostFingerprint()).toBeNull();
  });

  it("returns null when the binary path cannot be resolved", () => {
    binaryPathMock.mockImplementation(() => {
      throw new Error("simulator-server binary not found for platform");
    });
    expect(resolveHostFingerprint()).toBeNull();
  });
});
