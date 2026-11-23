import { homedir } from "node:os";
import { join } from "node:path";
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

const TOKEN_FILE = join(homedir(), ".emulator_console_auth_token");

async function failureFor(stdout: string): Promise<string> {
  runAdb.mockResolvedValue({ stdout, stderr: "" });
  const err = await captureVegaScreenshotPng().catch((e: unknown) => e);
  return (err as Error).message;
}

describe("captureVegaScreenshotPng", () => {
  it("reports a mismatched console auth token, on one line", async () => {
    // What a VVD's console replies when the tool-server's token differs from its own.
    expect(
      await failureFor(
        "KO: authentication token does not match ~/.emulator_console_auth_token\r\nKO: unknown command, try 'help'\r\n"
      )
    ).toBe(
      `emulator console wrote no PNG for emulator-5556: KO: authentication token does not match ~/.emulator_console_auth_token; KO: unknown command, try 'help' (adb authenticates to the console with ${TOKEN_FILE}, which must be a regular file, not a symlink, holding the emulator's token)`
    );
  });

  it("names the token file when adb sent no auth", async () => {
    // A missing or symlinked token file: the console refuses the command as unknown.
    expect(await failureFor("KO: unknown command, try 'help'\r\n")).toContain(
      `with ${TOKEN_FILE}, which must be a regular file, not a symlink`
    );
  });

  it("keeps the token hint off other refusals", async () => {
    expect(await failureFor("KO: Failed to take screenshot\r\n")).toBe(
      "emulator console wrote no PNG for emulator-5556: KO: Failed to take screenshot"
    );
    // Only the last line is the verdict.
    expect(await failureFor("KO: unknown command, try 'help'\r\nOK\r\n")).toBe(
      "emulator console wrote no PNG for emulator-5556: KO: unknown command, try 'help'; OK"
    );
  });

  it("says the reply was empty rather than ending on a bare colon", async () => {
    expect(await failureFor("")).toBe(
      "emulator console wrote no PNG for emulator-5556: empty reply"
    );
  });
});
