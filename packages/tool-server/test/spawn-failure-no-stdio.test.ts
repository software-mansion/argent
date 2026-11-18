/**
 * When `spawn` fails (EMFILE, ENOMEM, ...), Node hands back a child with no
 * stdio streams and emits `error` on the next tick. Each long-lived spawn site
 * must turn that into a rejected call instead of throwing on the missing
 * stream and leaving `error` unlistened, which takes the whole process down.
 * (execSimctl has its own test: simctl-exec-spawn-failure.test.ts.)
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { DeviceInfo } from "@argent/registry";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => ({
  ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
  spawn: spawnMock,
}));
vi.mock("child_process", async () => ({
  ...(await vi.importActual<typeof import("child_process")>("child_process")),
  spawn: spawnMock,
}));

vi.mock("../src/blueprints/ax-service", () => ({
  ensureAutomationEnabled: vi.fn(async () => undefined),
}));
vi.mock("@argent/native-devtools-ios", () => ({
  simulatorServerBinaryPath: () => "/fake/bin/simulator-server",
  simulatorServerRunDir: () => "/fake/bin",
}));
vi.mock("../src/utils/ios-devices", () => ({
  isTvOsSimulator: vi.fn(async () => false),
  isFoldableSimulator: vi.fn(async () => false),
}));
vi.mock("../src/utils/ios-device-sets", () => ({
  deviceSetForUdid: vi.fn(async () => null),
}));
vi.mock("../src/utils/android-binary", () => ({
  resolveAndroidBinary: vi.fn(async () => "/fake/adb"),
}));
vi.mock("../src/utils/android-helper-install", () => ({
  ensureAndroidDevtoolsInstalled: vi.fn(async () => undefined),
}));
vi.mock("@argent/native-devtools-android", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@argent/native-devtools-android")>()),
  helperManifest: () => ({ instrumentationRunner: "x/y.Runner" }),
}));

/** A child as Node returns it when spawn fails: no stdio, `error` next tick. */
function failedSpawn() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: null;
    stderr: null;
    stdin: null;
    kill: () => void;
  };
  child.stdout = null;
  child.stderr = null;
  child.stdin = null;
  child.kill = () => {};
  process.nextTick(() =>
    child.emit("error", Object.assign(new Error("spawn EMFILE"), { code: "EMFILE" }))
  );
  return child;
}

describe("spawn failure without stdio rejects instead of crashing", () => {
  it("simulator-server (iOS)", async () => {
    spawnMock.mockImplementation(failedSpawn);
    const { __resetDepCacheForTests, __primeDepCacheForTests } =
      await import("../src/utils/check-deps");
    __resetDepCacheForTests();
    __primeDepCacheForTests(["xcrun", "adb"]);
    const { simulatorServerBlueprint } = await import("../src/blueprints/simulator-server");
    const device: DeviceInfo = {
      id: "11111111-2222-3333-4444-555555555555",
      platform: "ios",
      kind: "simulator",
    };
    await expect(simulatorServerBlueprint.factory({}, device, { device })).rejects.toThrow(
      /EMFILE/
    );
  });

  it("android-devtools helper", async () => {
    spawnMock.mockImplementation(failedSpawn);
    const { androidDevtoolsBlueprint } = await import("../src/blueprints/android-devtools");
    const device: DeviceInfo = { id: "emulator-5554", platform: "android", kind: "emulator" };
    await expect(androidDevtoolsBlueprint.factory({}, device, { device })).rejects.toThrow(
      /helper process error/
    );
  });

  it("android profiler perfetto capture", async () => {
    spawnMock.mockImplementation(failedSpawn);
    const { startPerfetto } = await import("../src/utils/android-profiler/capture");
    await expect(
      startPerfetto({ serial: "emulator-5554", appPackage: "com.example.app", timestamp: "t" })
    ).rejects.toThrow(/EMFILE/);
  });
});
