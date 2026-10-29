import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
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

import {
  clearAutomationEnabled,
  clearAutomationEnabledOrWarn,
  setAccessibilityPrefsPreBoot,
} from "../src/utils/ax-prefs";

function defaultsError(stderr: string): Error & { stderr: string } {
  return Object.assign(new Error("Command failed"), { stderr });
}

function preBootKeys(): Array<string | undefined> {
  return calls.filter((c) => c.cmd === "plutil" && c.args[0] === "-replace").map((c) => c.args[1]);
}

beforeEach(() => {
  calls.length = 0;
  nextError = null;
});

afterAll(() => {
  fs.rmSync(deviceSetDir, { recursive: true, force: true });
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

  it("clearAutomationEnabled treats a missing pref as cleared", async () => {
    nextError = defaultsError(
      "Domain (com.apple.Accessibility) not found.\nDefaults have not been changed."
    );

    await expect(clearAutomationEnabled("UDID-2")).resolves.toBeUndefined();
  });

  it("clearAutomationEnabled surfaces simctl's error for a missing device set", async () => {
    nextError = defaultsError("Provided set path does not exist: /x");

    await expect(clearAutomationEnabled("UDID-6")).rejects.toThrow("Command failed");
  });

  it("clearAutomationEnabled surfaces simctl's error when the sim is not booted", async () => {
    nextError = defaultsError("Process spawn via launchd failed because device is not booted.");

    await expect(clearAutomationEnabled("UDID-3")).rejects.toThrow("Command failed");
  });

  it("clearAutomationEnabledOrWarn logs a failure instead of throwing", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    nextError = defaultsError("Invalid device: UDID-5");

    await expect(clearAutomationEnabledOrWarn("UDID-5")).resolves.toBeUndefined();

    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("could not clear AutomationEnabled")
    );
    stderr.mockRestore();
  });

  it("setAccessibilityPrefsPreBoot never writes AutomationEnabled on an iOS sim", async () => {
    await setAccessibilityPrefsPreBoot("UDID-4", { isTvOs: false });

    expect(preBootKeys()).toEqual([
      "IgnoreAXServerEntitlements",
      "AccessibilityEnabled",
      "ApplicationAccessibilityEnabled",
    ]);
  });

  it("setAccessibilityPrefsPreBoot writes AutomationEnabled on an Apple TV sim", async () => {
    await setAccessibilityPrefsPreBoot("UDID-7", { isTvOs: true });

    expect(preBootKeys()).toEqual([
      "AutomationEnabled",
      "IgnoreAXServerEntitlements",
      "AccessibilityEnabled",
      "ApplicationAccessibilityEnabled",
    ]);
  });
});
