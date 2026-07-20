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

import {
  listAndroidDevices,
  getAndroidRuntimeKind,
  isAndroidTv,
  __resetAndroidRuntimeKindCacheForTesting,
  getCachedAndroidRuntimeKind,
} from "../src/utils/adb";

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
  // The runtime-kind memo persists across calls within the process; clear it so
  // each case starts from a cold probe (and reused serials don't leak verdicts).
  __resetAndroidRuntimeKindCacheForTesting();
});

// `mockDevice` populates avd_name as empty, so the cache key avdName is null.
function withAvdName(serial: string, avdName: string): void {
  const prev = execFileMock.getMockImplementation();
  execFileMock.mockImplementation((cmd: string, args: string[]) => {
    if (
      cmd === "adb" &&
      args[0] === "-s" &&
      args[1] === serial &&
      args[2] === "shell" &&
      (args[3] === "getprop ro.boot.qemu.avd_name" || args[3] === "getprop ro.kernel.qemu.avd_name")
    ) {
      return { stdout: `${avdName}\n`, stderr: "" };
    }
    return prev?.(cmd, args) ?? { stdout: "", stderr: "" };
  });
}

describe("Android TV discovery — runtimeKind", () => {
  it("tags a device exposing the leanback/television feature as runtimeKind 'tv'", async () => {
    mockDevice("emulator-5556", { features: LEANBACK_FEATURES, characteristics: "emulator" });
    const devices = await listAndroidDevices({ runtimeKind: true });
    expect(devices).toHaveLength(1);
    expect(devices[0]!.runtimeKind).toBe("tv");
  });

  it("regression: Google ATV emulator (leanback feature present, characteristics='emulator') is 'tv'", async () => {
    // The Google ATV emulator images report ro.build.characteristics=emulator
    // (NOT 'tv'), so the feature list is the only reliable signal. This is the
    // exact shape observed on the Television_1080p AVD during live testing.
    mockDevice("emulator-5554", { features: LEANBACK_FEATURES, characteristics: "emulator" });
    const devices = await listAndroidDevices({ runtimeKind: true });
    expect(devices[0]!.runtimeKind).toBe("tv");
  });

  it("falls back to the characteristics 'tv' token when the feature list is empty", async () => {
    mockDevice("emulator-5556", { features: "", characteristics: "nosdcard,tv" });
    const devices = await listAndroidDevices({ runtimeKind: true });
    expect(devices[0]!.runtimeKind).toBe("tv");
  });

  it("tags a phone (touchscreen features, no leanback) as runtimeKind 'mobile'", async () => {
    mockDevice("emulator-5554", { features: PHONE_FEATURES, characteristics: "nosdcard" });
    const devices = await listAndroidDevices({ runtimeKind: true });
    expect(devices[0]!.runtimeKind).toBe("mobile");
  });

  it("reports an indeterminate runtimeKind (undefined) when both signals are empty/unreadable", async () => {
    // An empty feature list is indistinguishable from a genuine phone, so a
    // device mid-boot / under load must NOT be pinned to "mobile" — it stays
    // undefined (and uncached) so the next call re-probes.
    mockDevice("emulator-5554", {});
    const devices = await listAndroidDevices({ runtimeKind: true });
    expect(devices[0]!.runtimeKind).toBeUndefined();
  });

  it("regression: empty feature list + characteristics='emulator' is indeterminate, NOT 'mobile'", async () => {
    // ATV emulator boot window: feature list empty, characteristics='emulator'
    // (non-empty, no `tv` token). Must stay indeterminate, not collapse to
    // "mobile" — that would mislabel and cache the TV as a phone.
    mockDevice("emulator-5554", { features: "", characteristics: "emulator" });
    const devices = await listAndroidDevices({ runtimeKind: true });
    expect(devices[0]!.runtimeKind).toBeUndefined();
  });

  it("characteristics fallback does not false-match a non-'tv' token like 'atv'", async () => {
    mockDevice("emulator-5554", { features: PHONE_FEATURES, characteristics: "atv,nosdcard" });
    const devices = await listAndroidDevices({ runtimeKind: true });
    expect(devices[0]!.runtimeKind).toBe("mobile");
  });

  it("a populated non-leanback feature list wins over a stray 'tv' characteristics token", async () => {
    // The feature list is the primary, authoritative signal. A phone that
    // answered `pm list features` (no leanback) must stay "mobile" even if
    // ro.build.characteristics happens to carry a `tv` token — and we must not
    // pay the characteristics round-trip at all once features answered.
    mockDevice("emulator-5554", { features: PHONE_FEATURES, characteristics: "tv,nosdcard" });
    const devices = await listAndroidDevices({ runtimeKind: true });
    expect(devices[0]!.runtimeKind).toBe("mobile");
    const probedCharacteristics = execFileMock.mock.calls.some(
      (c) => c[0] === "adb" && (c[1] as string[]).includes("ro.build.characteristics")
    );
    expect(probedCharacteristics).toBe(false);
  });

  it("skips the runtimeKind feature probe by default (boot-loop hot path)", async () => {
    // The boot-loop poller (findSerialByAvdName) calls listAndroidDevices every
    // 1.5s and never reads runtimeKind, so the default must NOT issue the
    // `pm list features` probe — which mid-boot can block up to the enrichment
    // timeout — nor populate the field.
    mockDevice("emulator-5554", { features: LEANBACK_FEATURES });
    const devices = await listAndroidDevices();
    expect(devices[0]!.runtimeKind).toBeUndefined();
    const probedFeatures = execFileMock.mock.calls.some(
      (c) => c[0] === "adb" && (c[1] as string[]).includes("pm list features")
    );
    expect(probedFeatures).toBe(false);
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

  it("does not cache an indeterminate probe — a slow TV re-probes and self-heals", async () => {
    // First call: both signals empty (device still booting) → indeterminate.
    mockDevice("emulator-5554", {});
    expect(await getAndroidRuntimeKind("emulator-5554")).toBeUndefined();
    // Now the feature list answers; since the miss wasn't cached as "mobile",
    // the next call re-probes and correctly resolves "tv" — no restart needed.
    mockDevice("emulator-5554", { features: LEANBACK_FEATURES });
    expect(await getAndroidRuntimeKind("emulator-5554")).toBe("tv");
  });

  it("regression: ATV emulator mid-boot (features empty, characteristics='emulator') self-heals to 'tv'", async () => {
    // Boot window must be indeterminate AND uncached — otherwise the "mobile"
    // verdict is pinned for the process lifetime, even after PMS comes up.
    mockDevice("emulator-5554", { features: "", characteristics: "emulator" });
    expect(await getAndroidRuntimeKind("emulator-5554")).toBeUndefined();
    // PMS up: the uncached miss re-probes and resolves "tv".
    mockDevice("emulator-5554", { features: LEANBACK_FEATURES, characteristics: "emulator" });
    expect(await getAndroidRuntimeKind("emulator-5554")).toBe("tv");
  });

  it("re-probes when a reused emulator slot boots a different AVD", async () => {
    // A TV AVD occupies emulator-5554 and gets cached as 'tv'.
    mockDevice("emulator-5554", { features: LEANBACK_FEATURES });
    withAvdName("emulator-5554", "Television_1080p");
    expect(await getAndroidRuntimeKind("emulator-5554")).toBe("tv");

    // It shuts down and a phone AVD reclaims the same console slot. The serial
    // matches a cached entry, but the avdName differs → re-probe, not a stale
    // 'tv' verdict that would route the phone to the focus/leanback backends.
    mockDevice("emulator-5554", { features: PHONE_FEATURES });
    withAvdName("emulator-5554", "Pixel_7_API_34");
    expect(await getAndroidRuntimeKind("emulator-5554")).toBe("mobile");
  });

  it("does not read avd_name getprops for a physical (non-emulator) serial", async () => {
    // A physical serial is never reclaimed and has no qemu avd_name, so the hot
    // path must not spend two getprops to always get null — it keys on null.
    mockDevice("A1B2C3D4", { features: PHONE_FEATURES });
    expect(await getAndroidRuntimeKind("A1B2C3D4")).toBe("mobile");
    const probedAvdName = execFileMock.mock.calls.some(
      (c) =>
        c[0] === "adb" &&
        Array.isArray(c[1]) &&
        (c[1] as string[]).some((a) => typeof a === "string" && a.includes("avd_name"))
    );
    expect(probedAvdName).toBe(false);
  });

  it("re-uses the cached verdict on a second call without re-probing features", async () => {
    // The per-interaction callers (describe / keyboard / launch / restart) hit
    // this repeatedly; a cache hit must skip the `pm list features` round-trip.
    mockDevice("emulator-5556", { features: LEANBACK_FEATURES });
    expect(await getAndroidRuntimeKind("emulator-5556")).toBe("tv");
    const featureProbesBefore = execFileMock.mock.calls.filter(
      (c) =>
        c[0] === "adb" && Array.isArray(c[1]) && (c[1] as string[]).includes("pm list features")
    ).length;
    expect(await getAndroidRuntimeKind("emulator-5556")).toBe("tv");
    const featureProbesAfter = execFileMock.mock.calls.filter(
      (c) =>
        c[0] === "adb" && Array.isArray(c[1]) && (c[1] as string[]).includes("pm list features")
    ).length;
    expect(featureProbesAfter).toBe(featureProbesBefore);
  });

  it("evicts the cached verdict once the serial leaves the device list", async () => {
    mockDevice("emulator-5554", { features: LEANBACK_FEATURES });
    expect(await getAndroidRuntimeKind("emulator-5554")).toBe("tv");
    // Serial no longer attached → undefined, and the cache entry is dropped so
    // the slot's next occupant doesn't inherit 'tv'.
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "adb" && args[0] === "devices" && args.length === 1) {
        return { stdout: "List of devices attached\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    expect(await getAndroidRuntimeKind("emulator-5554")).toBeUndefined();
  });
});

describe("getCachedAndroidRuntimeKind — synchronous cache-only read", () => {
  it("returns undefined for a serial that has never been probed", () => {
    // No async probe has warmed the cache → the hot-path reader stays coarse.
    expect(getCachedAndroidRuntimeKind("emulator-5554")).toBeUndefined();
  });

  it("returns the memoized 'tv' verdict after an async probe warms it, without any adb call", async () => {
    mockDevice("emulator-5556", { features: LEANBACK_FEATURES });
    expect(await getAndroidRuntimeKind("emulator-5556")).toBe("tv");
    const callsBefore = execFileMock.mock.calls.length;
    expect(getCachedAndroidRuntimeKind("emulator-5556")).toBe("tv");
    // The cache read must not shell out to adb.
    expect(execFileMock.mock.calls.length).toBe(callsBefore);
  });

  it("returns the memoized 'mobile' verdict for a warmed phone serial", async () => {
    mockDevice("emulator-5554", { features: PHONE_FEATURES });
    expect(await getAndroidRuntimeKind("emulator-5554")).toBe("mobile");
    expect(getCachedAndroidRuntimeKind("emulator-5554")).toBe("mobile");
  });

  it("does not cache (stays undefined) when the probe was indeterminate", async () => {
    mockDevice("emulator-5554", {});
    expect(await getAndroidRuntimeKind("emulator-5554")).toBeUndefined();
    expect(getCachedAndroidRuntimeKind("emulator-5554")).toBeUndefined();
  });
});
