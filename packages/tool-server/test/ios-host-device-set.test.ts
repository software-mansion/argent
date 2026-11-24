import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Every per-device simctl call in `ios-host` has to carry the device set the
 * UDID lives in. A simulator in an additional set (Radon IDE's, say) is not
 * addressable from the default set, so a call that skips `--set` fails with
 * "Invalid device" — and the app-state probes fail in a way that reads as a
 * verdict: `inspectRunningApp` reports the app as not running, which is
 * `not_running`, which tells an agent to relaunch an app that is already up.
 *
 * `ios-device-sets.test.ts` covers the resolver; this covers the two call sites
 * it can't see.
 */
const execFileMock = vi.fn<(cmd: string, args: readonly string[]) => unknown>();
const additionalSets: string[] = [];

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
      const callback = (typeof opts === "function" ? opts : cb!) as (
        err: Error | null,
        out: { stdout: string; stderr: string }
      ) => void;
      const result = execFileMock(cmd, args);
      if (result instanceof Error) callback(result, { stdout: "", stderr: "" });
      else
        callback(
          null,
          (result as { stdout: string; stderr: string }) ?? { stdout: "", stderr: "" }
        );
    },
  };
});

vi.mock("@argent/configuration-core", async () => {
  const actual = await vi.importActual<typeof import("@argent/configuration-core")>(
    "@argent/configuration-core"
  );
  return { ...actual, getAdditionalIosDeviceSets: () => additionalSets };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, existsSync: () => true };
});

vi.mock("@argent/native-devtools-ios", () => ({
  bootstrapDylibPath: () => "/fake/dylibs/libArgentInjectionBootstrap.dylib",
  bootstrapDylibPathTcp: () => "/fake/dylibs/tcp/libArgentInjectionBootstrap.dylib",
  bootstrapDylibPathTvos: () => "/fake/dylibs/tvos/libArgentInjectionBootstrap.dylib",
  tcpInjectionDylibs: () => [],
  axServiceBinaryPath: () => "/fake/ax-service",
  axServiceBinaryPathTcp: () => "/fake/ax-service-tcp",
}));

import { localIosHost } from "../src/utils/ios-host";
import { __resetDeviceSetCacheForTesting } from "../src/utils/ios-device-sets";

const EXTRA_SET = "/Users/dev/Library/Caches/com.swmansion.radon-ide/Devices/iOS";
const UDID = "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB";
const BUNDLE = "com.example.app";
const PID = 4242;

/** The `spawn … launchctl list` invocations seen, in order. */
let spawnCalls: string[][] = [];

beforeEach(() => {
  __resetDeviceSetCacheForTesting();
  additionalSets.length = 0;
  additionalSets.push(EXTRA_SET);
  spawnCalls = [];
  execFileMock.mockReset().mockImplementation((cmd, args) => {
    if (/\bps$/.test(cmd)) {
      return { stdout: `01:00 /Devices/${UDID}/App.app/App FOO=bar\n`, stderr: "" };
    }
    const argv = [...args];
    // Device-set probe: the UDID lives only in the additional set.
    if (argv.includes("list") && argv.includes("--json")) {
      const inExtraSet = argv[1] === "--set" && argv[2] === EXTRA_SET;
      return {
        stdout: JSON.stringify({
          devices: {
            "com.apple.CoreSimulator.SimRuntime.iOS-26-4": inExtraSet ? [{ udid: UDID }] : [],
          },
        }),
        stderr: "",
      };
    }
    if (argv.includes("launchctl")) {
      spawnCalls.push(argv);
      // Stand where simctl stands: the device answers from the set that owns it
      // and is "invalid" from any other, so a call site that drops `--set` fails
      // here the way it would in the field.
      const owningSet = additionalSets.length > 0 ? EXTRA_SET : null;
      const addressedSet = argv[1] === "--set" ? argv[2]! : null;
      if (addressedSet !== owningSet) return new Error(`Invalid device: ${UDID}`);
      return { stdout: `${PID}\t0\tUIKitApplication:${BUNDLE}[dffa][rb-legacy]\n`, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });
});

describe("ios-host simctl calls for a simulator in an additional device set", () => {
  it("addresses the owning set when listing running bundle ids", async () => {
    await expect(localIosHost.listRunningBundleIds(UDID)).resolves.toEqual(new Set([BUNDLE]));
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.slice(0, 5)).toEqual(["simctl", "--set", EXTRA_SET, "spawn", UDID]);
  });

  it("addresses the owning set when inspecting the running app", async () => {
    const inspection = await localIosHost.inspectRunningApp(UDID, BUNDLE);
    expect(inspection.running).toBe(true);
    expect(inspection.process?.pid).toBe(PID);
    expect(spawnCalls[0]!.slice(0, 5)).toEqual(["simctl", "--set", EXTRA_SET, "spawn", UDID]);
  });

  it("leaves --set off a default-set simulator", async () => {
    additionalSets.length = 0;
    await localIosHost.inspectRunningApp(UDID, BUNDLE);
    expect(spawnCalls[0]![0]).toBe("simctl");
    expect(spawnCalls[0]).not.toContain("--set");
  });
});
