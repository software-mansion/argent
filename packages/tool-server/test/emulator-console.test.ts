import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";

const runAdb = vi.fn();
vi.mock("../src/utils/adb", () => ({
  runAdb: (...a: unknown[]) => runAdb(...a),
}));

import { runEmuConsole } from "../src/utils/emulator-console";

const originalPlatform = process.platform;
function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

afterEach(() => {
  setPlatform(originalPlatform);
});

async function rejectionFor(stdout: string): Promise<string> {
  runAdb.mockResolvedValue({ stdout, stderr: "" });
  const err = await runEmuConsole("emulator-5554", ["posture", "1"]).catch((e: unknown) => e);
  return (err as Error).message;
}

describe("runEmuConsole", () => {
  it("keeps the auth refusal that precedes the verdict, and names the token file", async () => {
    runAdb.mockResolvedValue({
      stdout:
        "KO: authentication token does not match ~/.emulator_console_auth_token\r\nKO: unknown command, try 'help'\r\n",
      stderr: "",
    });
    const err = await runEmuConsole("emulator-5554", ["posture", "1"]).catch((e: unknown) => e);
    expect((err as Error).message).toBe(
      `emulator console rejected \`posture 1\` — KO: authentication token does not match ~/.emulator_console_auth_token; KO: unknown command, try 'help' (adb authenticates to the console with ${join(homedir(), ".emulator_console_auth_token")}, which must be a regular file, not a symlink, holding the emulator's token)`
    );
  });

  it("leaves the token hint off a refusal that is not an unknown command", async () => {
    expect(await rejectionFor("KO: unknown sensor name: acceleration\r\n")).toBe(
      "emulator console rejected `posture 1` — KO: unknown sensor name: acceleration"
    );
  });

  it("does not call a symlinked token file unusable on Windows, where adb follows it", async () => {
    setPlatform("win32");
    expect(await rejectionFor("KO: unknown command, try 'help'\r\n")).toBe(
      `emulator console rejected \`posture 1\` — KO: unknown command, try 'help' (adb authenticates to the console with ${join(homedir(), ".emulator_console_auth_token")}, which must be a file holding the emulator's token)`
    );
  });
});
