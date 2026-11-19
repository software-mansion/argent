import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type DefaultsVerb = "export" | "delete";

const calls: Array<{ cmd: string; args: readonly string[] }> = [];
let exportedPlist = "";
const failures = new Map<DefaultsVerb, Error & { stderr?: string }>();

function failureFor(args: readonly string[]): Error | undefined {
  const verb = args[args.indexOf("defaults") + 1] as DefaultsVerb;
  return failures.get(verb);
}

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
      const err = failureFor(args);
      if (err) callback(err);
      else callback(null, { stdout: args.includes("export") ? exportedPlist : "", stderr: "" });
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
import { localIosHost } from "../src/utils/ios-host";

function defaultsError(stderr: string): Error & { stderr: string } {
  return Object.assign(new Error("Command failed"), { stderr });
}

function accessibilityPlist(keys: string[]): string {
  const entries = keys.map((key) => `<key>${key}</key><true/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>${entries}</dict>\n</plist>\n`;
}

function defaultsCalls(): string[][] {
  return calls
    .filter((c) => c.cmd === "xcrun")
    .map((c) => c.args.slice(c.args.indexOf("defaults")) as string[]);
}

function preBootKeys(): Array<string | undefined> {
  return calls.filter((c) => c.cmd === "plutil" && c.args[0] === "-replace").map((c) => c.args[1]);
}

beforeEach(() => {
  calls.length = 0;
  exportedPlist = accessibilityPlist(["AccessibilityEnabled"]);
  failures.clear();
});

afterAll(() => {
  fs.rmSync(deviceSetDir, { recursive: true, force: true });
});

describe("AutomationEnabled, which leaves Full Keyboard Access unable to move focus", () => {
  it("clearAutomationEnabled deletes the pref inside the simulator when it is set", async () => {
    exportedPlist = accessibilityPlist(["AccessibilityEnabled", "AutomationEnabled"]);

    await clearAutomationEnabled("UDID-1");

    expect(defaultsCalls()).toEqual([
      ["defaults", "export", "com.apple.Accessibility", "-"],
      ["defaults", "delete", "com.apple.Accessibility", "AutomationEnabled"],
    ]);
  });

  it("clearAutomationEnabled skips the delete when the pref is absent", async () => {
    await clearAutomationEnabled("UDID-2");

    expect(defaultsCalls()).toEqual([["defaults", "export", "com.apple.Accessibility", "-"]]);
  });

  it("clearAutomationEnabled skips the delete when the domain is empty", async () => {
    exportedPlist = accessibilityPlist([]);

    await clearAutomationEnabled("UDID-9");

    expect(defaultsCalls()).toEqual([["defaults", "export", "com.apple.Accessibility", "-"]]);
  });

  it.each([
    ["iOS 26", "Domain (com.apple.Accessibility) not found.\nDefaults have not been changed."],
    [
      "iOS 27",
      "Error: Could not find key 'AutomationEnabled' in domain 'com.apple.Accessibility'.\nDefaults have not been changed.",
    ],
  ])(
    "localIosHost.bootstrapAx resolves on a fresh %s sim, whose delete would fail",
    async (_runtime, deleteStderr) => {
      failures.set("delete", defaultsError(deleteStderr));

      await expect(localIosHost.bootstrapAx("UDID-10")).resolves.toEqual({
        entitlementBypassActive: false,
      });
      expect(defaultsCalls().map((c) => c[1])).not.toContain("delete");
    }
  );

  it("clearAutomationEnabled surfaces simctl's error for a missing device set", async () => {
    failures.set("export", defaultsError("Provided set path does not exist: /x"));

    await expect(clearAutomationEnabled("UDID-6")).rejects.toThrow("Command failed");
  });

  it("clearAutomationEnabled surfaces a failed delete of a set pref", async () => {
    exportedPlist = accessibilityPlist(["AutomationEnabled"]);
    failures.set("delete", defaultsError("Defaults have not been changed."));

    await expect(clearAutomationEnabled("UDID-11")).rejects.toThrow("Command failed");
  });

  it("localIosHost.bootstrapAx rejects when the sim is not booted", async () => {
    failures.set(
      "export",
      defaultsError("Process spawn via launchd failed because device is not booted.")
    );

    await expect(localIosHost.bootstrapAx("UDID-8")).rejects.toThrow("Command failed");
  });

  it("clearAutomationEnabledOrWarn logs a failure instead of throwing", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    failures.set("export", defaultsError("Invalid device: UDID-5"));

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
