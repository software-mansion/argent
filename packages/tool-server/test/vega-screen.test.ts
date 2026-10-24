import { describe, it, expect, vi } from "vitest";

vi.mock("../src/utils/vega-vvd", () => ({
  discoverVegaConsolePort: async () => 5556,
}));

// `adb emu` exits 0 when the console refuses a command; the refusal is a `KO:` line on stdout.
const runAdb = vi.fn();
vi.mock("../src/utils/adb", () => ({
  runAdb: (...a: unknown[]) => runAdb(...a),
}));

import { captureVegaScreenshotPng } from "../src/utils/vega-screen";

describe("captureVegaScreenshotPng", () => {
  it("includes the emulator console reply when no PNG is written", async () => {
    runAdb.mockResolvedValue({
      stdout: "KO: authentication token does not match ~/.emulator_console_auth_token\n",
      stderr: "",
    });
    await expect(captureVegaScreenshotPng()).rejects.toThrow(
      "emulator console wrote no PNG for emulator-5556: KO: authentication token does not match ~/.emulator_console_auth_token"
    );
  });
});
