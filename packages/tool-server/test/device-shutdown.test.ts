import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the callback-style execFile that device-shutdown promisifies, plus the
// device classifier, so this unit test asserts the platform dispatch + argv +
// error contracts with no real simctl/adb.
const execFileMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));
const resolveDeviceMock = vi.fn();
vi.mock("../src/utils/device-info", () => ({
  resolveDevice: (id: string) => resolveDeviceMock(id),
}));

import {
  shutdownOwnedDevice,
  shutdownOwnedDevices,
  shutdownDevice,
} from "../src/utils/device-shutdown";

// Default: exec succeeds (callback style: (file, args, cb) => cb(err, {stdout,stderr})).
function execSucceeds() {
  execFileMock.mockImplementation(
    (_file: string, _args: string[], cb: (e: unknown, r: unknown) => void) =>
      cb(null, { stdout: "", stderr: "" })
  );
}
function execFails(message: string) {
  execFileMock.mockImplementation((_file: string, _args: string[], cb: (e: unknown) => void) =>
    cb(new Error(message))
  );
}

beforeEach(() => {
  execFileMock.mockReset();
  resolveDeviceMock.mockReset();
  execSucceeds();
});

describe("shutdownOwnedDevice (best-effort, swallows errors)", () => {
  it("iOS -> xcrun simctl shutdown <udid>", async () => {
    resolveDeviceMock.mockReturnValue({ platform: "ios", kind: "simulator" });
    await shutdownOwnedDevice("UDID-1");
    expect(execFileMock).toHaveBeenCalledWith(
      "xcrun",
      ["simctl", "shutdown", "UDID-1"],
      expect.any(Function)
    );
  });

  it("Android -> adb -s <serial> emu kill", async () => {
    resolveDeviceMock.mockReturnValue({ platform: "android", kind: "emulator" });
    await shutdownOwnedDevice("emulator-5554");
    expect(execFileMock).toHaveBeenCalledWith(
      "adb",
      ["-s", "emulator-5554", "emu", "kill"],
      expect.any(Function)
    );
  });

  it("chromium / vega -> no exec (nothing to shut down)", async () => {
    resolveDeviceMock.mockReturnValue({ platform: "chromium", kind: "chromium" });
    await shutdownOwnedDevice("chromium-cdp-9222");
    resolveDeviceMock.mockReturnValue({ platform: "vega", kind: "vvd" });
    await shutdownOwnedDevice("amazon-vvd-1");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("swallows an exec failure (must never break session teardown)", async () => {
    resolveDeviceMock.mockReturnValue({ platform: "ios", kind: "simulator" });
    execFails("simctl: boom");
    await expect(shutdownOwnedDevice("UDID-1")).resolves.toBeUndefined();
  });

  it("swallows an unclassifiable id (resolveDevice throws)", async () => {
    resolveDeviceMock.mockImplementation(() => {
      throw new Error("bad id");
    });
    await expect(shutdownOwnedDevice("???")).resolves.toBeUndefined();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("shutdownOwnedDevices runs every id", async () => {
    resolveDeviceMock.mockReturnValue({ platform: "ios", kind: "simulator" });
    await shutdownOwnedDevices(["A", "B"]);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});

describe("shutdownDevice (surfaces the outcome)", () => {
  it("iOS -> ok:true and simctl argv", async () => {
    resolveDeviceMock.mockReturnValue({ platform: "ios", kind: "simulator" });
    expect(await shutdownDevice("UDID-1")).toEqual({ ok: true });
    expect(execFileMock).toHaveBeenCalledWith(
      "xcrun",
      ["simctl", "shutdown", "UDID-1"],
      expect.any(Function)
    );
  });

  it("Android emulator -> ok:true and adb emu kill", async () => {
    resolveDeviceMock.mockReturnValue({ platform: "android", kind: "emulator" });
    expect(await shutdownDevice("emulator-5554")).toEqual({ ok: true });
  });

  it("physical Android device -> ok:false with a reason, no exec", async () => {
    resolveDeviceMock.mockReturnValue({ platform: "android", kind: "device" });
    const r = await shutdownDevice("PHONE123");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/physical Android/i);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("chromium / vega -> ok:false, unsupported", async () => {
    resolveDeviceMock.mockReturnValue({ platform: "chromium", kind: "chromium" });
    expect((await shutdownDevice("chromium-cdp-9222")).ok).toBe(false);
  });

  it("unknown id (resolveDevice throws) -> ok:false", async () => {
    resolveDeviceMock.mockImplementation(() => {
      throw new Error("bad id");
    });
    const r = await shutdownDevice("???");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Unknown device/i);
  });

  it("surfaces an exec failure as ok:false with the message", async () => {
    resolveDeviceMock.mockReturnValue({ platform: "ios", kind: "simulator" });
    execFails("simctl: boom");
    const r = await shutdownDevice("UDID-1");
    expect(r).toEqual({ ok: false, error: "simctl: boom" });
  });
});
