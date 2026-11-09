import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { DeviceInfo, Registry } from "@argent/registry";

// An app opened from the home screen (a tap, a key, a tv-remote select) before
// the watcher's first poll armed injection launches without the native-devtools
// dylib. Every input to a local iOS / Apple TV simulator goes through the
// simulator-server or tv-control service, so neither may start its backend
// before that poll. The real watcher runs here with its first poll held open.
// Devices the watcher never arms (Android, remote, provider-claimed) and
// targets a factory rejects must not wait on it.

const IOS_UDID = "11111111-1111-1111-1111-111111111111";
const TV_UDID = "22222222-2222-2222-2222-222222222222";
const CLAIMED_UDID = "33333333-3333-3333-3333-333333333333";

const spawnMock = vi.fn();
const execFileMock = vi.fn();

class FakeProc extends EventEmitter {
  stdout = new Readable({ read() {} });
  stderr = new Readable({ read() {} });
  stdin = { write: vi.fn() };
  killed = false;
  kill() {
    this.killed = true;
    return true;
  }
}

/** A backend that exits before becoming ready, so the factory under test rejects. */
function exitingProc(): FakeProc {
  const proc = new FakeProc();
  setImmediate(() => proc.emit("exit", 1, null));
  return proc;
}

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: (...args: unknown[]) => {
      spawnMock(...args);
      return exitingProc();
    },
    execFile: (...args: unknown[]) => {
      execFileMock(...args);
      return exitingProc();
    },
  };
});

vi.mock("../src/utils/simctl-exec", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/simctl-exec")>()),
  execSimctl: async () =>
    JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-18-5": [{ udid: IOS_UDID, state: "Booted" }],
        "com.apple.CoreSimulator.SimRuntime.tvOS-18-5": [{ udid: TV_UDID, state: "Booted" }],
      },
    }),
}));

vi.mock("../src/utils/xcode-first-launch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/xcode-first-launch")>()),
  xcodeFirstLaunchPending: () => false,
}));

vi.mock("../src/blueprints/ax-service", () => ({
  ensureAutomationEnabled: async () => {},
}));

vi.mock("../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-devices")>()),
  isTvOsSimulator: async (udid: string) => udid === TV_UDID,
  isFoldableSimulator: async () => false,
  cacheSimulatorRuntimeKind: () => {},
  listIosSimulators: async () => [
    {
      udid: IOS_UDID,
      name: "iPhone",
      runtime: "iOS 18.5",
      runtimeKind: "mobile",
      state: "Booted",
    },
    {
      udid: TV_UDID,
      name: "Apple TV",
      runtime: "tvOS 18.5",
      runtimeKind: "tv",
      state: "Booted",
    },
  ],
}));

vi.mock("../src/utils/ios-device-sets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-device-sets")>()),
  configuredAdditionalDeviceSets: () => [],
  deviceSetForUdid: async () => null,
  simctlTargetForUdidSync: (udid: string) => ({ prefix: ["simctl"], nativeId: udid }),
}));

vi.mock("@argent/native-devtools-ios", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@argent/native-devtools-ios")>()),
  simulatorServerBinaryPath: () => "/fake/simulator-server",
  simulatorServerRunDir: () => "/fake",
  tvosAxServiceBinaryPath: () => "/fake/tvos-ax-service",
  tvosHidDaemonBinaryPath: () => "/fake/tvos-hid-daemon",
}));

vi.mock("../src/utils/external-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/external-devices")>()),
  assertExternalCapability: async () => {},
  externalClaimForAnyId: (id: string) =>
    id === CLAIMED_UDID ? { provider: { name: "Provider" } } : undefined,
}));

vi.mock("../src/utils/moq-client", () => ({
  openMoqClient: async () => {
    throw new Error("moq dialed");
  },
}));

import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";
import { startSimulatorWatcher } from "../src/utils/simulator-watcher";
import { simulatorServerBlueprint } from "../src/blueprints/simulator-server";
import { tvControlBlueprint } from "../src/blueprints/tv-control";

const ios: DeviceInfo = { id: IOS_UDID, platform: "ios", kind: "simulator" };
const tv: DeviceInfo = { id: TV_UDID, platform: "ios", kind: "simulator" };

/** Rejects with "waited on the first poll" if `started` is still pending after 1s. */
async function settledWithPollHeld(started: Promise<unknown>): Promise<unknown> {
  const held = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("waited on the first poll")), 1_000)
  );
  return Promise.race([started, held]);
}

let stop: (() => void) | undefined;
/** Finishes the first poll's injection attempt for every booted simulator. */
let arm!: () => void;

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  __resetDepCacheForTests();
  __primeDepCacheForTests(["adb"]);
  spawnMock.mockReset();
  execFileMock.mockReset();
  const held: Array<() => void> = [];
  arm = () => held.forEach((resolve) => resolve());
  const resolveService = vi.fn(
    () => new Promise((resolve) => held.push(() => resolve({ getInitFailure: () => null })))
  );
  ({ stop } = startSimulatorWatcher({ resolveService } as unknown as Registry));
});

afterEach(() => {
  stop?.();
  stop = undefined;
});

describe("simulator input waits for the watcher's first poll", () => {
  it("simulator-server does not start for an iOS simulator until the poll armed injection", async () => {
    const started = simulatorServerBlueprint.factory({}, ios, { device: ios });
    started.catch(() => {});
    await flush();
    expect(spawnMock).not.toHaveBeenCalled();

    arm();
    await expect(started).rejects.toThrow(/before becoming ready/);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("tv-control does not start for an Apple TV simulator until the poll armed injection", async () => {
    const started = tvControlBlueprint.factory({}, tv, { device: tv });
    started.catch(() => {});
    await flush();
    expect(execFileMock).not.toHaveBeenCalled();

    arm();
    await expect(started).rejects.toThrow(/exited with code 1/);
    expect(execFileMock).toHaveBeenCalled();
  });

  it.each<[string, DeviceInfo, RegExp]>([
    [
      "an Android emulator",
      { id: "emulator-5554", platform: "android", kind: "emulator" },
      /before becoming ready/,
    ],
    [
      "a remote iOS simulator",
      { id: `remote:${IOS_UDID}`, platform: "ios-remote", kind: "simulator" },
      /moq dialed/,
    ],
    [
      "a provider-claimed iOS simulator",
      { id: CLAIMED_UDID, platform: "ios", kind: "simulator" },
      /did not publish a simulator-server endpoint/,
    ],
  ])("simulator-server for %s does not wait on the poll", async (_name, device, reached) => {
    const started = simulatorServerBlueprint.factory({}, device, { device });
    await expect(settledWithPollHeld(started)).rejects.toThrow(reached);
  });

  it("tv-control rejects an iPhone simulator without waiting on the poll", async () => {
    const started = tvControlBlueprint.factory({}, ios, { device: ios });
    await expect(settledWithPollHeld(started)).rejects.toThrow(/is not a tvOS simulator/);
  });
});
