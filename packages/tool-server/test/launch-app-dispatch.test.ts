import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Registry } from "@argent/registry";

const execFileMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: readonly string[],
      opts: unknown,
      cb?: (err: Error | null, out: { stdout: string; stderr: string }) => void
    ) => {
      const callback = typeof opts === "function" ? opts : cb!;
      const options = typeof opts === "function" ? undefined : opts;
      const result = execFileMock(cmd, args, options);
      if (result instanceof Error) callback(result, { stdout: "", stderr: "" });
      else callback(null, result ?? { stdout: "", stderr: "" });
    },
  };
});

import { createLaunchAppTool } from "../src/tools/simulator/launch-app";
import { __resetClassifyCacheForTests, warmDeviceCache } from "../src/utils/platform-detect";

const iosUdid = "11111111-2222-3333-4444-555555555555";
const androidSerial = "emulator-5554";

const iosNativeApi = { ensureEnvReady: vi.fn().mockResolvedValue(undefined) };
const resolveService = vi.fn(async () => iosNativeApi);
const registry = { resolveService } as unknown as Registry;

beforeEach(() => {
  execFileMock.mockReset().mockReturnValue({ stdout: "", stderr: "" });
  iosNativeApi.ensureEnvReady.mockClear().mockResolvedValue(undefined);
  resolveService.mockClear().mockResolvedValue(iosNativeApi);
  __resetClassifyCacheForTests();
  // Pre-populate the classify cache so tests don't shell out for xcrun / adb
  // list lookups (those paths are covered separately in classify-device.test.ts).
  warmDeviceCache([
    { udid: iosUdid, platform: "ios" },
    { udid: androidSerial, platform: "android" },
  ]);
});

describe("launch-app.services — no pre-declared services (factory form)", () => {
  it("declares no services; platform-specific service resolution is deferred to execute", () => {
    // We moved NativeDevtools resolution into execute so the platform check
    // can be async (list-based classifyDevice). If a future change re-adds a
    // service request here, the udid-shape it would use is an iOS-only URN
    // that would fail for Android devices.
    const tool = createLaunchAppTool(registry);
    expect(tool.services({ udid: iosUdid, bundleId: "com.example" })).toEqual({});
    expect(tool.services({ udid: androidSerial, bundleId: "com.example" })).toEqual({});
  });
});

describe("launch-app.execute — iOS path (behavior preserved through factory refactor)", () => {
  it("prepares native devtools then calls `xcrun simctl launch`", async () => {
    const tool = createLaunchAppTool(registry);
    await tool.execute!({}, { udid: iosUdid, bundleId: "com.apple.Preferences" });

    expect(resolveService).toHaveBeenCalledWith(`NativeDevtools:${iosUdid}`);
    expect(iosNativeApi.ensureEnvReady).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledWith(
      "xcrun",
      ["simctl", "launch", iosUdid, "com.apple.Preferences"],
      undefined
    );
  });

  it("ensureEnvReady awaits *before* launch (injection must be in place pre-spawn)", async () => {
    const order: string[] = [];
    iosNativeApi.ensureEnvReady.mockImplementation(async () => {
      order.push("ensureEnvReady");
    });
    execFileMock.mockImplementation(() => {
      order.push("xcrun");
      return { stdout: "", stderr: "" };
    });

    const tool = createLaunchAppTool(registry);
    await tool.execute!({}, { udid: iosUdid, bundleId: "com.apple.Preferences" });
    expect(order).toEqual(["ensureEnvReady", "xcrun"]);
  });

  it("ignores an `activity` arg on iOS (Android-only parameter)", async () => {
    const tool = createLaunchAppTool(registry);
    await tool.execute!(
      {},
      { udid: iosUdid, bundleId: "com.apple.Preferences", activity: ".Root" }
    );
    expect(execFileMock).toHaveBeenCalledWith(
      "xcrun",
      ["simctl", "launch", iosUdid, "com.apple.Preferences"],
      undefined
    );
  });
});

// Helper: install a mock that handles the two adb calls the Android path
// makes — `cmd package resolve-activity --brief` (for the no-activity case)
// and `am start -W`. Defaults return "Status: ok" so the positive-match in
// assertAmStartOk passes. Callers can override individual responses.
function stubAndroidLaunchAdb(
  opts: {
    resolveStdout?: string;
    amStartStdout?: string;
  } = {}
) {
  execFileMock.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === "adb" && args.includes("shell")) {
      const shell = args[args.indexOf("shell") + 1] ?? "";
      if (shell.startsWith("cmd package resolve-activity")) {
        return {
          stdout:
            opts.resolveStdout ??
            "priority=0 preferredOrder=0 match=0x0 specificIndex=-1\ncom.android.settings/.Settings\n",
          stderr: "",
        };
      }
      if (shell.startsWith("am start")) {
        return {
          stdout: opts.amStartStdout ?? "Starting: Intent { cmp=com.x/.Main }\nStatus: ok\n",
          stderr: "",
        };
      }
    }
    return { stdout: "", stderr: "" };
  });
}

describe("launch-app.execute — Android path", () => {
  it("resolves the default LAUNCHER activity and waits via `am start -W` when no activity is provided", async () => {
    // Regression: the previous implementation fired `monkey … LAUNCHER 1` and
    // returned immediately — describe/tap could race a still-forking app.
    // Now we resolve the component up-front and use `am start -W` so the tool
    // only returns once the activity has been drawn.
    stubAndroidLaunchAdb();
    const tool = createLaunchAppTool(registry);
    await tool.execute!({}, { udid: androidSerial, bundleId: "com.android.settings" });

    const shells = execFileMock.mock.calls
      .filter((c: unknown[]) => (c[0] as string) === "adb")
      .map((c: unknown[]) => (c[1] as string[])[3] ?? "");
    expect(shells).toContain("cmd package resolve-activity --brief com.android.settings");
    expect(shells).toContain("am start -W -n com.android.settings/.Settings");
    // NativeDevtools (iOS-only) must NOT be resolved on the Android path.
    expect(resolveService).not.toHaveBeenCalled();
  });

  it("uses `am start -W -n pkg/.Activity` when activity starts with a dot", async () => {
    stubAndroidLaunchAdb();
    const tool = createLaunchAppTool(registry);
    await tool.execute!(
      {},
      { udid: androidSerial, bundleId: "com.example.app", activity: ".MainActivity" }
    );
    expect(execFileMock).toHaveBeenCalledWith(
      "adb",
      ["-s", androidSerial, "shell", "am start -W -n com.example.app/.MainActivity"],
      expect.any(Object)
    );
  });

  it("passes pre-qualified `pkg/.Activity` strings through unchanged", async () => {
    stubAndroidLaunchAdb();
    const tool = createLaunchAppTool(registry);
    await tool.execute!(
      {},
      {
        udid: androidSerial,
        bundleId: "com.example.app",
        activity: "com.example.app/com.example.app.MainActivity",
      }
    );
    expect(execFileMock).toHaveBeenCalledWith(
      "adb",
      ["-s", androidSerial, "shell", "am start -W -n com.example.app/com.example.app.MainActivity"],
      expect.any(Object)
    );
  });

  it("succeeds when output contains 'Error' in a class name but also 'Status: ok'", async () => {
    // The old matcher was /Error|Exception/ with a !/Status: ok/ escape hatch.
    // That was brittle: a benign `Activity: com.example.ErrorReportingActivity`
    // line combined with any future removal of the "Status: ok" banner would
    // spuriously fail. A positive match on Status: ok is both simpler and
    // correct under `am start -W` semantics.
    stubAndroidLaunchAdb({
      amStartStdout:
        "Starting: Intent { cmp=com.example/.Main }\n" +
        "Activity: com.example.ErrorReportingActivity (trampoline)\n" +
        "Status: ok\n" +
        "LaunchState: COLD\n",
    });
    const tool = createLaunchAppTool(registry);
    const result = await tool.execute!(
      {},
      { udid: androidSerial, bundleId: "com.example", activity: ".Main" }
    );
    expect(result).toEqual({ launched: true, bundleId: "com.example" });
  });

  it("rejects when `am start` reports anything other than `Status: ok` (e.g. `Status: null`)", async () => {
    // `Status: null` means the activity resolved but threw during onCreate.
    // The old regex did not catch this — silent false-success.
    stubAndroidLaunchAdb({
      amStartStdout: "Starting: Intent { cmp=com.foo/.Bar }\nStatus: null\nLaunchState: UNKNOWN\n",
    });
    const tool = createLaunchAppTool(registry);
    await expect(
      tool.execute!({}, { udid: androidSerial, bundleId: "com.foo", activity: ".Bar" })
    ).rejects.toThrow(/am start failed/);
  });

  it("throws when am start reports a class-not-found error", async () => {
    stubAndroidLaunchAdb({
      amStartStdout: "Error: Activity class {com.foo/.Bar} does not exist.",
    });
    const tool = createLaunchAppTool(registry);
    await expect(
      tool.execute!({}, { udid: androidSerial, bundleId: "com.foo", activity: ".Bar" })
    ).rejects.toThrow(/am start failed/);
  });

  it("throws a helpful error when the package has no launcher activity at all", async () => {
    // `cmd package resolve-activity --brief` prints nothing parseable if the
    // package is either not installed or has no android.intent.category.LAUNCHER
    // activity. Regression: the old monkey path would print "** No activities
    // found to run, monkey aborted." — we replace that failure mode with a
    // clearer "install the app first" message.
    stubAndroidLaunchAdb({ resolveStdout: "No activity found\n" });
    const tool = createLaunchAppTool(registry);
    await expect(
      tool.execute!({}, { udid: androidSerial, bundleId: "com.not.installed" })
    ).rejects.toThrow(/Could not resolve a LAUNCHER activity/);
  });
});
