import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isAccessibilityEnabled } from "../../src/cli/accessibility.js";
import * as child_process from "node:child_process";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execSync: vi.fn() };
});

const mockedExecSync = vi.mocked(child_process.execSync);

describe("isAccessibilityEnabled", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("returns false on non-darwin platforms", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    expect(isAccessibilityEnabled()).toBe(false);
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  it("returns true when swift reports true", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockedExecSync.mockReturnValue("true\n");
    expect(isAccessibilityEnabled()).toBe(true);
  });

  it("returns false when swift reports false", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockedExecSync.mockReturnValue("false\n");
    expect(isAccessibilityEnabled()).toBe(false);
  });

  it("returns false when swift throws", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockedExecSync.mockImplementation(() => {
      throw new Error("swift not found");
    });
    expect(isAccessibilityEnabled()).toBe(false);
  });
});
