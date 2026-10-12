import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { NativeProfilerSessionApi } from "../src/blueprints/native-profiler-session";

/**
 * Native profiling is the one iOS family that drives a command other than
 * simctl: `xctrace record --device <udid>`. simctl argv is substituted at the
 * ios-device-sets choke point, so this is the only path where a provider's
 * `ext:` id can still reach a subprocess that has never heard of it.
 */

/** Every subprocess the profiler starts, so the argv can be asserted on. */
const rec = vi.hoisted(() => ({
  captured: [] as { file: string; args: string[] }[],
  spawned: [] as { file: string; args: string[] }[],
}));

/**
 * Enough of a ChildProcess for a start whose readiness wait is stubbed out.
 */
const fakeChild = vi.hoisted(() => () => ({
  kill: () => true,
  on: () => {},
  once: () => {},
  pid: 4242,
  stderr: { on: () => {} },
  stdout: { on: () => {} },
}));

vi.mock("child_process", () => ({
  execFileSync: (file: string, args: string[]) => {
    rec.captured.push({ file, args });

    if (args.includes("launchctl")) {
      /** `launchctl list` output: PID, status, label. */
      return "123\t0\tUIKitApplication:com.example.app[abc]\n";
    }

    if (args.includes("listapps")) return "(opaque simctl plist)";
    if (args.includes("get_app_container")) return "/Devices/iOS/data/Example.app\n";

    if (args[0] === "-convert") {
      /** plutil JSON of the installed apps simctl listed. */
      return JSON.stringify({
        "com.example.app": {
          ApplicationType: "User",
          CFBundleExecutable: "Example",
          CFBundleIdentifier: "com.example.app",
        },
      });
    }

    return "";
  },

  /**
   * `promisify(execFile)`d at module load by ios-device-sets. An external
   * device's set comes from its descriptor, so nothing here is ever probed.
   */
  execFile: (
    _file: string,
    _args: string[],
    _options: unknown,
    callback: (err: Error | null, result: { stdout: string; stderr: string }) => void
  ) => {
    callback(null, { stderr: "", stdout: "" });
  },
  spawn: (file: string, args: string[]) => {
    rec.spawned.push({ args, file });
    return fakeChild();
  },
}));

vi.mock("../src/utils/ios-profiler/startup", () => ({
  waitForXctraceReady: async () => ({ via: "notify" }),
}));

vi.mock("../src/utils/ios-profiler/notify", () => ({
  listenForDarwinNotification: () => ({
    cancel: () => {},
    fired: new Promise<void>(() => {}),
    ready: Promise.resolve(),
  }),
}));

import { startNativeProfilerIos } from "../src/tools/profiler/native-profiler/platforms/ios";
import {
  __resetExternalDeviceCacheForTesting,
  __resetProviderWarningsForTesting,
  makeExternalId,
} from "../src/utils/external-devices";
import { __resetDeviceSetCacheForTesting } from "../src/utils/ios-device-sets";

const IOS_UDID = "1A2B3C4D-5E6F-7081-92A3-B4C5D6E7F809";
const PROVIDER_ID = "acme-3f2a9c";
const DEVICE_ID = makeExternalId(PROVIDER_ID, IOS_UDID);
const TEMPLATE_PATH = "/tmp/Argent.tracetemplate";

let deviceSet: string;
let temporaryDirectory: string;

/** Publish a descriptor offering the simulator for native profiling. */
function publishDescriptor(): void {
  const descriptorPath = path.join(temporaryDirectory, "acme.json");

  fs.writeFileSync(
    descriptorPath,
    JSON.stringify({
      devices: [
        {
          capabilities: ["native-profiler", "simctl"],
          deviceSet,
          kind: "simulator",
          name: "iPhone 16 Pro",
          nativeId: IOS_UDID,
          platform: "ios",
          state: "Booted",
        },
      ],
      id: PROVIDER_ID,
      name: "Acme IDE",
      schemaVersion: 1,
      supportUrl: "https://example.invalid/issues",
    })
  );

  process.env.ARGENT_DEVICE_PROVIDERS = descriptorPath;
}

function newSession(): NativeProfilerSessionApi {
  return {
    androidOnDeviceTracePath: null,
    appProcess: null,
    capturePid: null,
    captureProcess: null,
    cpuFilterPid: null,
    deviceId: DEVICE_ID,
    disposed: false,
    exportedFiles: null,
    lastExitInfo: null,
    mallocStackLogging: null,
    parsedData: null,
    platform: "ios",
    profilingActive: false,
    recordingExitedUnexpectedly: false,
    recordingMallocStackLogging: null,
    recordingTimedOut: false,
    recordingTimeout: null,
    traceFile: null,
    wallClockStartMs: null,
  };
}

/** The recording's argv, and the value `--device` was given. */
function recordedTarget(): { args: string[]; deviceArgument: string } {
  const record = rec.spawned.find((call) => call.file === "xctrace");
  expect(record).toBeDefined();
  const args = record!.args;
  const deviceIndex = args.indexOf("--device");
  expect(deviceIndex).toBeGreaterThanOrEqual(0);
  return { args, deviceArgument: args[deviceIndex + 1] };
}

beforeEach(() => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "argent-profiler-"));
  deviceSet = path.join(temporaryDirectory, "Devices", "iOS");
  fs.mkdirSync(deviceSet, { recursive: true });
  rec.captured.length = 0;
  rec.spawned.length = 0;
  delete process.env.ARGENT_DISABLE_DEVICE_PROVIDERS;
  /**
   * The device strategy is the only one that passes `--device` at all. On an
   * Xcode where it deadlocks the selector would silently pick the host-wide
   * fallback and leave the substitution under test unexercised.
   */
  process.env.ARGENT_IOS_CAPTURE = "device";
  __resetDeviceSetCacheForTesting();
  __resetExternalDeviceCacheForTesting();
  __resetProviderWarningsForTesting();
  publishDescriptor();
});

afterEach(() => {
  delete process.env.ARGENT_DEVICE_PROVIDERS;
  delete process.env.ARGENT_IOS_CAPTURE;
  fs.rmSync(temporaryDirectory, { force: true, recursive: true });
});

describe("native profiling a provider's simulator", () => {
  it("records against the udid xctrace knows, not the argent-side id", async () => {
    const session = newSession();

    await startNativeProfilerIos(session, {
      device_id: DEVICE_ID,
      template_path: TEMPLATE_PATH,
    });

    clearTimeout(session.recordingTimeout!);

    const { args, deviceArgument } = recordedTarget();
    expect(deviceArgument).toBe(IOS_UDID);

    /**
     * Attached by PID, so the recording is scoped to the app on that simulator.
     */
    expect(args[args.indexOf("--attach") + 1]).toBe("123");
  });

  it("cold-launches under the same udid when logging malloc stacks", async () => {
    const session = newSession();

    await startNativeProfilerIos(session, {
      device_id: DEVICE_ID,
      malloc_stack_logging: true,
      template_path: TEMPLATE_PATH,
    });

    clearTimeout(session.recordingTimeout!);

    const { args, deviceArgument } = recordedTarget();

    expect(deviceArgument).toBe(IOS_UDID);
    expect(args).toContain("--launch");
  });

  it("reaches the provider's device set and leaks the ext: id to nothing", async () => {
    const session = newSession();

    await startNativeProfilerIos(session, {
      device_id: DEVICE_ID,
      template_path: TEMPLATE_PATH,
    });

    clearTimeout(session.recordingTimeout!);

    const simctlCalls = rec.captured.filter((call) => call.args.includes("simctl"));

    expect(simctlCalls.length).toBeGreaterThanOrEqual(2);

    for (const call of simctlCalls) {
      expect(call.args.slice(0, 3)).toEqual(["simctl", "--set", deviceSet]);
    }

    const everyArgument = [...rec.captured, ...rec.spawned].flatMap((call) => call.args);

    expect(everyArgument.filter((argument) => argument.includes("ext:"))).toEqual([]);
    expect(everyArgument).toContain(IOS_UDID);
  });
});
