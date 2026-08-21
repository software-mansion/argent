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
const resolveAndroidBinaryMock = vi.fn();
vi.mock("../src/utils/android-binary", () => ({
  resolveAndroidBinary: (name: string) => resolveAndroidBinaryMock(name),
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
  resolveAndroidBinaryMock.mockReset().mockResolvedValue("/sdk/platform-tools/adb");
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

  it("Android -> resolved adb -s <serial> emu kill", async () => {
    resolveDeviceMock.mockReturnValue({ platform: "android", kind: "emulator" });
    await shutdownOwnedDevice("emulator-5554");
    expect(resolveAndroidBinaryMock).toHaveBeenCalledWith("adb");
    expect(execFileMock).toHaveBeenCalledWith(
      "/sdk/platform-tools/adb",
      ["-s", "emulator-5554", "emu", "kill"],
      expect.any(Function)
    );
  });

  it('Android with unresolvable adb -> falls back to bare "adb"', async () => {
    resolveDeviceMock.mockReturnValue({ platform: "android", kind: "emulator" });
    resolveAndroidBinaryMock.mockResolvedValue(null);
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

  it("leaves a physical iPhone alone at session teardown", async () => {
    // Lens tears down the devices it booted. A physical iPhone was never ours
    // to boot, so it is never ours to power off — and `simctl shutdown` could
    // not do it anyway. Mirrors the physical-Android exclusion below.
    resolveDeviceMock.mockReturnValue({ platform: "ios", kind: "device" });
    await shutdownOwnedDevice("00008120-000E6D0C0ABBA01E");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("leaves a physical Android phone alone at session teardown", async () => {
    // The other half of the same rule, and the one that decides whether this
    // function is scoped by kind at all: platform alone sends a phone serial to
    // `adb -s <serial> emu kill`, and the failure is swallowed, so nothing here
    // reports that teardown reached for a device Lens never booted.
    resolveDeviceMock.mockReturnValue({ platform: "android", kind: "device" });
    await shutdownOwnedDevice("R5CT30ABCDE");
    expect(resolveAndroidBinaryMock).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
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

  it("Android emulator -> ok:true and resolved adb emu kill", async () => {
    resolveDeviceMock.mockReturnValue({ platform: "android", kind: "emulator" });
    expect(await shutdownDevice("emulator-5554")).toEqual({ ok: true });
    expect(execFileMock).toHaveBeenCalledWith(
      "/sdk/platform-tools/adb",
      ["-s", "emulator-5554", "emu", "kill"],
      expect.any(Function)
    );
  });

  it("physical Android device -> ok:false with a reason, no exec", async () => {
    resolveDeviceMock.mockReturnValue({ platform: "android", kind: "device" });
    const r = await shutdownDevice("PHONE123");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/physical Android/i);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("physical iPhone -> ok:false with a reason, no simctl", async () => {
    // The `kind` half of the iOS branch. Platform alone would send a hardware
    // UDID to `xcrun simctl shutdown`, which answers "Invalid device" — the UI
    // would then blame the UDID rather than say the phone can't be powered off
    // remotely. Same shape as the physical-Android case above.
    resolveDeviceMock.mockReturnValue({ platform: "ios", kind: "device" });
    const r = await shutdownDevice("00008120-000E6D0C0ABBA01E");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/physical iPhone/i);
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
