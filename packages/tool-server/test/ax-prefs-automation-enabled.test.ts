import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const calls: Array<{ cmd: string; args: readonly string[] }> = [];
let nextError: (Error & { stderr?: string }) | null = null;

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: readonly string[],
      opts: unknown,
      cb?: (err: Error | null, out?: { stdout: string; stderr: string }) => void
    ) => {
      const callback = typeof opts === "function" ? opts : cb!;
      calls.push({ cmd, args });
      const err = nextError;
      nextError = null;
      if (err) callback(err);
      else callback(null, { stdout: "", stderr: "" });
    },
  };
});

const deviceSetDir = fs.mkdtempSync(path.join(os.tmpdir(), "ax-prefs-"));

vi.mock("../src/utils/ios-device-sets", () => ({
  simctlArgsForUdid: async (_udid: string, args: string[]) => ["simctl", ...args],
  deviceSetForUdid: async () => deviceSetDir,
}));

import { clearAutomationEnabled, setAccessibilityPrefsPreBoot } from "../src/utils/ax-prefs";

function defaultsError(stderr: string): Error & { stderr: string } {
  return Object.assign(new Error("Command failed"), { stderr });
}

beforeEach(() => {
  calls.length = 0;
  nextError = null;
});

describe("AutomationEnabled, which leaves Full Keyboard Access unable to move focus", () => {
  it("clearAutomationEnabled deletes the pref inside the simulator", async () => {
    await clearAutomationEnabled("UDID-1");

    expect(calls).toEqual([
      {
        cmd: "xcrun",
        args: [
          "simctl",
          "spawn",
          "UDID-1",
          "defaults",
          "delete",
          "com.apple.Accessibility",
          "AutomationEnabled",
        ],
      },
    ]);
  });

  it("clearAutomationEnabled treats an absent pref as already cleared", async () => {
    nextError = defaultsError(
      "The domain/default pair of (com.apple.Accessibility, AutomationEnabled) does not exist"
    );

    await expect(clearAutomationEnabled("UDID-2")).resolves.toBeUndefined();
  });

  it("clearAutomationEnabled still reports a failed spawn", async () => {
    nextError = defaultsError("Invalid device: UDID-3");

    await expect(clearAutomationEnabled("UDID-3")).rejects.toThrow("Command failed");
  });

  it("setAccessibilityPrefsPreBoot never writes AutomationEnabled", async () => {
    await setAccessibilityPrefsPreBoot("UDID-4");

    const keys = calls
      .filter((c) => c.cmd === "plutil" && c.args[0] === "-replace")
      .map((c) => c.args[1]);
    expect(keys).toEqual([
      "IgnoreAXServerEntitlements",
      "AccessibilityEnabled",
      "ApplicationAccessibilityEnabled",
    ]);
  });
});
