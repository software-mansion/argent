import { describe, it, expect, vi, beforeEach } from "vitest";

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

vi.mock("../src/utils/android-binary", () => ({
  resolveAndroidBinary: vi.fn(async (name: "adb" | "emulator") => name),
  __resetAndroidBinaryCacheForTesting: () => {},
}));

import { listAndroidDevices, getAndroidRuntimeKind, isAndroidTv } from "../src/utils/adb";

// Mock one device. `features` is the `pm list features` output (the primary TV
// signal — leanback / television); `characteristics` is the `ro.build.characteristics`
// value (the secondary fallback). Either can independently make a device read as TV.
function mockDevice(
  serial: string,
  opts: { features?: string; characteristics?: string } = {}
): void {
  const features = opts.features ?? "";
  const characteristics = opts.characteristics ?? "";
  execFileMock.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === "adb" && args[0] === "devices" && args.length === 1) {
      return { stdout: `List of devices attached\n${serial}\tdevice\n`, stderr: "" };
    }
    if (cmd === "adb" && args[0] === "-s" && args[2] === "shell") {
      const shell = args[3] ?? "";
      if (shell === "getprop ro.product.model") return { stdout: "AndroidTV\n", stderr: "" };
      if (shell === "getprop ro.build.version.sdk") return { stdout: "34\n", stderr: "" };
      if (shell === "pm list features") return { stdout: `${features}\n`, stderr: "" };
      if (shell === "getprop ro.build.characteristics")
        return { stdout: `${characteristics}\n`, stderr: "" };
      return { stdout: "\n", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });
}

const LEANBACK_FEATURES =
  "feature:android.hardware.type.television\nfeature:android.software.leanback\nfeature:android.software.leanback_only";
const PHONE_FEATURES = "feature:android.hardware.touchscreen\nfeature:android.software.app_widgets";

beforeEach(() => {
  execFileMock.mockReset();
});

describe("Android TV discovery — runtimeKind", () => {
  it("tags a device exposing the leanback/television feature as runtimeKind 'tv'", async () => {
    mockDevice("emulator-5556", { features: LEANBACK_FEATURES, characteristics: "emulator" });
    const devices = await listAndroidDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0]!.runtimeKind).toBe("tv");
  });

  it("regression: Google ATV emulator (leanback feature present, characteristics='emulator') is 'tv'", async () => {
    // The Google ATV emulator images report ro.build.characteristics=emulator
    // (NOT 'tv'), so the feature list is the only reliable signal. This is the
    // exact shape observed on the Television_1080p AVD during live testing.
    mockDevice("emulator-5554", { features: LEANBACK_FEATURES, characteristics: "emulator" });
    const devices = await listAndroidDevices();
    expect(devices[0]!.runtimeKind).toBe("tv");
  });

  it("falls back to the characteristics 'tv' token when the feature list is empty", async () => {
    mockDevice("emulator-5556", { features: "", characteristics: "nosdcard,tv" });
    const devices = await listAndroidDevices();
    expect(devices[0]!.runtimeKind).toBe("tv");
  });

  it("tags a phone (touchscreen features, no leanback) as runtimeKind 'mobile'", async () => {
    mockDevice("emulator-5554", { features: PHONE_FEATURES, characteristics: "nosdcard" });
    const devices = await listAndroidDevices();
    expect(devices[0]!.runtimeKind).toBe("mobile");
  });

  it("defaults to 'mobile' when both signals are empty/unreadable", async () => {
    mockDevice("emulator-5554", {});
    const devices = await listAndroidDevices();
    expect(devices[0]!.runtimeKind).toBe("mobile");
  });

  it("characteristics fallback does not false-match a non-'tv' token like 'atv'", async () => {
    mockDevice("emulator-5554", { features: PHONE_FEATURES, characteristics: "atv,nosdcard" });
    const devices = await listAndroidDevices();
    expect(devices[0]!.runtimeKind).toBe("mobile");
  });
});

describe("Android TV discovery — getAndroidRuntimeKind / isAndroidTv", () => {
  it("resolves the runtime kind for a ready TV serial", async () => {
    mockDevice("emulator-5556", { features: LEANBACK_FEATURES });
    expect(await getAndroidRuntimeKind("emulator-5556")).toBe("tv");
    expect(await isAndroidTv("emulator-5556")).toBe(true);
  });

  it("returns undefined for a serial not in the device list", async () => {
    mockDevice("emulator-5556", { features: LEANBACK_FEATURES });
    // NOTE: getAndroidRuntimeKind memoises per-serial; a serial never seen is
    // not cached, so this re-lists and finds no match.
    expect(await getAndroidRuntimeKind("emulator-9999")).toBeUndefined();
    expect(await isAndroidTv("emulator-9999")).toBe(false);
  });
});
