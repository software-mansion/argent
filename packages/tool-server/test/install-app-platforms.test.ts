import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runAdb: vi.fn(),
  prepareAndroid: vi.fn(),
  prepareIos: vi.fn(),
  androidCleanup: vi.fn(),
  iosCleanup: vi.fn(),
  simctlInstall: vi.fn(),
}));

vi.mock("../src/utils/adb", () => ({ runAdb: mocks.runAdb }));
vi.mock("../src/utils/sim-remote", () => ({ simctlInstall: mocks.simctlInstall }));
vi.mock("../src/tools/install-app/artifact", () => ({
  prepareAndroidRemoteArtifact: mocks.prepareAndroid,
  prepareIosRemoteArtifact: mocks.prepareIos,
}));

import { androidImpl } from "../src/tools/install-app/platforms/android";
import { iosRemoteImpl } from "../src/tools/install-app/platforms/ios-remote";

const params = {
  udid: "emulator-5554",
  url: "https://example.com/app.apk",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prepareAndroid.mockResolvedValue({
    installablePath: "/tmp/materialized/app.apk",
    bundleId: "com.example.app",
    cleanup: mocks.androidCleanup,
  });
  mocks.prepareIos.mockResolvedValue({
    installablePath: "/tmp/materialized/App.app",
    bundleId: "com.example.app",
    cleanup: mocks.iosCleanup,
  });
  mocks.runAdb.mockResolvedValue({ stdout: "Success\n", stderr: "" });
  mocks.simctlInstall.mockResolvedValue(undefined);
});

describe("install-app platform handlers", () => {
  it("installs an Android APK in place with permissions granted", async () => {
    await expect(androidImpl.handler({}, params, {} as never)).resolves.toEqual({
      installed: true,
      bundleId: "com.example.app",
    });
    expect(mocks.runAdb).toHaveBeenCalledWith(
      ["-s", "emulator-5554", "install", "-r", "-d", "-g", "/tmp/materialized/app.apk"],
      { timeoutMs: 180_000 }
    );
    expect(mocks.androidCleanup).toHaveBeenCalledOnce();
  });

  it("cleans the downloaded Android artifact when installation fails", async () => {
    mocks.runAdb.mockRejectedValue(new Error("device offline"));
    await expect(androidImpl.handler({}, params, {} as never)).rejects.toThrow("device offline");
    expect(mocks.androidCleanup).toHaveBeenCalledOnce();
  });

  it("uploads and installs the materialized bundle on a remote iOS simulator", async () => {
    const remoteParams = { ...params, udid: "remote:00000000-0000-0000-0000-000000000000" };
    await expect(iosRemoteImpl.handler({}, remoteParams, {} as never)).resolves.toEqual({
      installed: true,
      bundleId: "com.example.app",
    });
    expect(mocks.simctlInstall).toHaveBeenCalledWith(
      remoteParams.udid,
      "/tmp/materialized/App.app"
    );
    expect(mocks.iosCleanup).toHaveBeenCalledOnce();
  });
});
