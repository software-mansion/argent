import express from "express";
import supertest from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Registry, type DeviceInfo } from "@argent/registry";

import { failedSpawn } from "./helpers/failed-spawn";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => ({
  ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
  spawn: spawnMock,
}));
vi.mock("child_process", async () => ({
  ...(await vi.importActual<typeof import("child_process")>("child_process")),
  spawn: spawnMock,
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

describe("spawn failure without stdio", () => {
  beforeEach(() => {
    spawnMock.mockImplementation(failedSpawn);
  });

  it("rejects simctl with the spawn error", async () => {
    const { execSimctl } = await import("../src/utils/simctl-exec");
    await expect(execSimctl(["simctl", "help"])).rejects.toMatchObject({ code: "EMFILE" });
  });

  it("disables suspension watching when its helper cannot start", async () => {
    const { startSuspensionWatch } = await import("../src/utils/macos-suspension-watch");
    await expect(startSuspensionWatch("/fake/helper", 123)).resolves.toBeNull();
  });

  it("serves a JSON error when tar cannot start an artifact download", async () => {
    const { makeArtifactRoute } = await import("../src/artifacts");
    const registry = new Registry();
    const artifact = await registry.artifacts.register({
      hostPath: __dirname,
      kind: "native-profile-trace",
    });
    const app = express().get("/artifacts/:id", makeArtifactRoute(registry));
    const res = await supertest(app).get(`/artifacts/${artifact.id}`);
    expect(res.status).toBe(500);
    expect(res.headers["content-disposition"]).toBeUndefined();
    expect(res.body).toEqual({
      error: `Failed to archive artifact "${artifact.id}": spawn EMFILE`,
    });
  });

  it("simulator-server (iOS)", async () => {
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
    const { androidDevtoolsBlueprint } = await import("../src/blueprints/android-devtools");
    const device: DeviceInfo = { id: "emulator-5554", platform: "android", kind: "emulator" };
    await expect(androidDevtoolsBlueprint.factory({}, device, { device })).rejects.toMatchObject({
      cause: { code: "EMFILE" },
    });
  });

  it("android profiler perfetto capture", async () => {
    const { startPerfetto } = await import("../src/utils/android-profiler/capture");
    await expect(
      startPerfetto({ serial: "emulator-5554", appPackage: "com.example.app", timestamp: "t" })
    ).rejects.toThrow(/EMFILE/);
  });
});
