import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the adb + console-port helpers the toolkit-flag helper leans on.
const runAdb = vi.fn();
vi.mock("../src/utils/adb", () => ({ runAdb: (...a: unknown[]) => runAdb(...a) }));
vi.mock("../src/utils/vega-vvd", () => ({ discoverVegaConsolePort: vi.fn(async () => 5554) }));

import { ensureAutomationToolkitEnabled } from "../src/utils/vega-automation";

beforeEach(() => {
  runAdb.mockReset();
  runAdb.mockResolvedValue({ stdout: "", stderr: "" });
});

describe("ensureAutomationToolkitEnabled", () => {
  it("touches the enable flag on the derived emulator serial", async () => {
    await ensureAutomationToolkitEnabled("amazon-abc");
    expect(runAdb).toHaveBeenCalledWith(
      ["-s", "emulator-5554", "shell", "touch", "/tmp/automation-toolkit.enable"],
      expect.any(Object)
    );
  });
});
