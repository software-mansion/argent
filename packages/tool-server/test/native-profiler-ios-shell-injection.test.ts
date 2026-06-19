import { describe, it, expect, vi } from "vitest";

// Records every child_process invocation the profiler makes so the test can
// assert how the (attacker-influenced) udid is passed.
const rec = vi.hoisted(() => ({
  calls: [] as { fn: string; file: string; args: string[] }[],
}));

vi.mock("child_process", () => ({
  execFileSync: (file: string, args: string[]) => {
    rec.calls.push({ fn: "execFileSync", file, args });
    if (args.includes("launchctl")) {
      // `launchctl list` output: PID, status, label.
      return "123\t0\tUIKitApplication:com.example.app[abc]\n";
    }
    if (args.includes("listapps")) {
      return "(opaque simctl plist)";
    }
    if (args[0] === "-convert") {
      // plutil JSON of installed apps, keyed arbitrarily.
      return JSON.stringify({
        "com.example.app": {
          CFBundleExecutable: "Example",
          CFBundleIdentifier: "com.example.app",
          ApplicationType: "User",
        },
      });
    }
    return "";
  },
  // A regression back to shell interpolation would route the command (with the
  // udid baked into the string) through execSync — make that fail loudly.
  execSync: (cmd: string) => {
    rec.calls.push({ fn: "execSync", file: String(cmd), args: [] });
    throw new Error(`execSync must not be used here (shell-injection risk): ${cmd}`);
  },
  spawn: () => {
    throw new Error("spawn not expected in this test");
  },
}));

import { enumerateRunningUserApps } from "../src/tools/profiler/native-profiler/platforms/ios";

describe("native iOS profiler: device_id shell-injection guard", () => {
  it("passes a hostile udid only as a discrete argv element (never via a shell)", () => {
    rec.calls.length = 0;
    const hostileUdid = 'booted"; touch /tmp/argent-pwned #';

    const apps = enumerateRunningUserApps(hostileUdid);
    expect(apps).toHaveLength(1);

    // No shell-interpreted execSync was used at all.
    expect(rec.calls.every((c) => c.fn === "execFileSync")).toBe(true);

    // simctl was invoked with the udid as an exact, standalone argv element —
    // not concatenated into a command string a shell could parse.
    const simctlCalls = rec.calls.filter((c) => c.args.includes("simctl"));
    expect(simctlCalls.length).toBeGreaterThanOrEqual(2);
    for (const c of simctlCalls) {
      expect(c.file).toBe("xcrun");
      expect(c.args).toContain(hostileUdid);
    }
  });
});
