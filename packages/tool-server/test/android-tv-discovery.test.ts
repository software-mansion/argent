import { describe, it, expect, vi, beforeEach } from "vitest";

type ExecResult = { stdout: string; stderr: string } | Error | undefined;
const execFileMock = vi.fn<(cmd: string, args: string[]) => ExecResult | Promise<ExecResult>>();

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
      const deliver = (result: ExecResult) => {
        if (result instanceof Error) callback(result, { stdout: "", stderr: "" });
        else callback(null, result ?? { stdout: "", stderr: "" });
      };
      const result = execFileMock(cmd, [...args]);
      if (result instanceof Promise) void result.then(deliver);
      else deliver(result);
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
    // ro.build.characteristics happens to carry a `tv` token.
    mockDevice("emulator-5554", { features: PHONE_FEATURES, characteristics: "tv,nosdcard" });
    const devices = await listAndroidDevices({ runtimeKind: true });
    expect(devices[0]!.runtimeKind).toBe("mobile");
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

type Gate = { promise: Promise<void>; open: () => void };
function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const shellCalls = (shell: string) =>
  execFileMock.mock.calls.filter((c) => c[1]?.[2] === "shell" && c[1]?.[3] === shell);

// One emulator whose shells are answered by `answer`; returning an Error is an
// unanswered (timed out) read.
function mockEmulator(
  serial: string,
  answer: (shell: string) => ExecResult | Promise<ExecResult>
): void {
  execFileMock.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === "adb" && args[0] === "devices" && args.length === 1) {
      return { stdout: `List of devices attached\n${serial}\tdevice\n`, stderr: "" };
    }
    if (cmd === "adb" && args[0] === "-s" && args[2] === "shell") return answer(args[3] ?? "");
    return { stdout: "", stderr: "" };
  });
}
const out = (stdout: string) => ({ stdout: `${stdout}\n`, stderr: "" });

describe("listAndroidDevices on a device that stops answering", () => {
  it("does not reuse the cached form factor when the avd read fails", async () => {
    const serial = "emulator-5570";
    let wedged = false;
    mockEmulator(serial, (shell) => {
      if (wedged) return new Error("timeout");
      if (shell.includes("avd_name")) return out("Pixel_API_34");
      if (shell === "pm list features") return out(PHONE_FEATURES);
      return out("1");
    });

    const first = await listAndroidDevices({ runtimeKind: true });
    expect(first[0]?.runtimeKind).toBe("mobile");

    wedged = true;
    execFileMock.mockClear();
    const second = await listAndroidDevices({ runtimeKind: true });
    expect(second[0]?.runtimeKind).toBeUndefined();
    expect(shellCalls("pm list features")).toHaveLength(0);
  });

  it("a phone on a slot a TV used to hold is not reported as a TV while it isn't answering", async () => {
    const serial = "emulator-5554";
    let occupant: "tv" | "phone" = "tv";
    let answers = true;
    mockEmulator(serial, (shell) => {
      if (!answers) return new Error("timeout");
      if (shell.includes("avd_name")) return out(occupant === "tv" ? "TV_API_34" : "Pixel_API_34");
      if (shell === "pm list features")
        return out(occupant === "tv" ? LEANBACK_FEATURES : PHONE_FEATURES);
      return out("1");
    });
    expect((await listAndroidDevices({ runtimeKind: true }))[0]?.runtimeKind).toBe("tv");

    occupant = "phone";
    answers = false;
    expect((await listAndroidDevices({ runtimeKind: true }))[0]?.runtimeKind).toBeUndefined();
    expect(await getAndroidRuntimeKind(serial)).toBeUndefined();
  });

  it("a phone on a reused TV slot whose avd read times out but features answer is not a TV", async () => {
    const serial = "emulator-5554";
    let occupant: "tv" | "phone" = "tv";
    mockEmulator(serial, (shell) => {
      if (shell.includes("avd_name"))
        return occupant === "tv" ? out("TV_API_34") : new Error("timeout");
      if (shell === "pm list features")
        return out(occupant === "tv" ? LEANBACK_FEATURES : PHONE_FEATURES);
      return out("1");
    });
    expect((await listAndroidDevices({ runtimeKind: true }))[0]?.runtimeKind).toBe("tv");

    occupant = "phone";
    expect((await listAndroidDevices({ runtimeKind: true }))[0]?.runtimeKind).not.toBe("tv");
  });

  it("starts the feature probe of an unseen device without waiting for the avd read", async () => {
    const avd = gate();
    mockEmulator("emulator-5572", (shell) => {
      if (shell.includes("avd_name")) return avd.promise.then(() => out("Pixel_API_34"));
      if (shell === "pm list features") return out(PHONE_FEATURES);
      return out("1");
    });
    const listing = listAndroidDevices({ runtimeKind: true });
    await tick();
    expect(shellCalls("pm list features")).toHaveLength(1);
    avd.open();
    expect((await listing)[0]?.runtimeKind).toBe("mobile");
  });

  it("reads the characteristics fallback without waiting for the feature list", async () => {
    const features = gate();
    mockEmulator("emulator-5574", (shell) => {
      if (shell === "pm list features") return features.promise.then(() => out(PHONE_FEATURES));
      if (shell.includes("avd_name")) return out("Pixel_API_34");
      return out("1");
    });
    const listing = listAndroidDevices({ runtimeKind: true });
    await tick();
    expect(shellCalls("getprop ro.build.characteristics")).toHaveLength(1);
    features.open();
    expect((await listing)[0]?.runtimeKind).toBe("mobile");
  });

  it("reads the feature list without waiting for the characteristics fallback", async () => {
    const characteristics = gate();
    mockEmulator("emulator-5578", (shell) => {
      if (shell === "getprop ro.build.characteristics")
        return characteristics.promise.then(() => out("emulator"));
      if (shell === "pm list features") return out(PHONE_FEATURES);
      if (shell.includes("avd_name")) return out("Pixel_API_34");
      return out("1");
    });
    const listing = listAndroidDevices({ runtimeKind: true });
    await tick();
    expect(shellCalls("pm list features")).toHaveLength(1);
    characteristics.open();
    expect((await listing)[0]?.runtimeKind).toBe("mobile");
  });

  it("a TV listed while its avd read timed out is not inherited by a frozen occupant", async () => {
    const serial = "emulator-5554";
    let answers = true;
    mockEmulator(serial, (shell) => {
      if (shell.includes("avd_name")) return new Error("timeout");
      if (!answers) return new Error("timeout");
      if (shell === "pm list features") return out(LEANBACK_FEATURES);
      return out("1");
    });
    expect((await listAndroidDevices({ runtimeKind: true }))[0]?.runtimeKind).toBe("tv");

    answers = false;
    expect((await listAndroidDevices({ runtimeKind: true }))[0]?.runtimeKind).toBeUndefined();
  });
});

describe("listAndroidDevices runtime-kind cache", () => {
  it("re-lists a known physical phone from the cache without probing it again", async () => {
    mockEmulator("R58M12345", (shell) => {
      if (shell.includes("avd_name")) return out("");
      if (shell === "pm list features") return out(PHONE_FEATURES);
      return out("1");
    });
    expect((await listAndroidDevices({ runtimeKind: true }))[0]?.runtimeKind).toBe("mobile");

    execFileMock.mockClear();
    expect((await listAndroidDevices({ runtimeKind: true }))[0]?.runtimeKind).toBe("mobile");
    expect(shellCalls("pm list features")).toHaveLength(0);
  });

  it("keeps a known physical phone's kind while it stops answering", async () => {
    let answers = true;
    mockEmulator("R58M12345", (shell) => {
      if (!answers) return new Error("timeout");
      if (shell.includes("avd_name")) return out("");
      if (shell === "pm list features") return out(PHONE_FEATURES);
      return out("1");
    });
    expect((await listAndroidDevices({ runtimeKind: true }))[0]?.runtimeKind).toBe("mobile");

    answers = false;
    expect((await listAndroidDevices({ runtimeKind: true }))[0]?.runtimeKind).toBe("mobile");
  });

  it("re-probes a reused emulator slot when a different AVD that answers takes it", async () => {
    const serial = "emulator-5554";
    let occupant: "tv" | "phone" = "tv";
    mockEmulator(serial, (shell) => {
      if (shell.includes("avd_name")) return out(occupant === "tv" ? "TV_API_34" : "Pixel_API_34");
      if (shell === "pm list features")
        return out(occupant === "tv" ? LEANBACK_FEATURES : PHONE_FEATURES);
      return out("1");
    });
    expect((await listAndroidDevices({ runtimeKind: true }))[0]?.runtimeKind).toBe("tv");

    occupant = "phone";
    expect((await listAndroidDevices({ runtimeKind: true }))[0]?.runtimeKind).toBe("mobile");
    expect(getCachedAndroidRuntimeKind(serial)).toBe("mobile");
  });

  it("re-probes a reused emulator slot when an answering occupant has no avd props", async () => {
    const serial = "emulator-5554";
    let occupant: "tv" | "other" = "tv";
    mockEmulator(serial, (shell) => {
      if (shell.includes("avd_name")) return out(occupant === "tv" ? "TV_API_34" : "");
      if (shell === "pm list features")
        return out(occupant === "tv" ? LEANBACK_FEATURES : PHONE_FEATURES);
      return out("1");
    });
    expect((await listAndroidDevices({ runtimeKind: true }))[0]?.runtimeKind).toBe("tv");

    occupant = "other";
    expect((await listAndroidDevices({ runtimeKind: true }))[0]?.runtimeKind).toBe("mobile");
  });

  it("does not report a booting phone on a reused TV slot as the TV", async () => {
    const serial = "emulator-5554";
    let occupant: "tv" | "phone" = "tv";
    mockEmulator(serial, (shell) => {
      if (shell.includes("avd_name")) return out(occupant === "tv" ? "TV_API_34" : "Pixel_API_34");
      if (shell === "pm list features") return out(occupant === "tv" ? LEANBACK_FEATURES : "");
      return out("emulator");
    });
    expect((await listAndroidDevices({ runtimeKind: true }))[0]?.runtimeKind).toBe("tv");

    occupant = "phone";
    expect((await listAndroidDevices({ runtimeKind: true }))[0]?.runtimeKind).toBeUndefined();
  });

  it("does not cache an indeterminate verdict, so a booting TV is found on the next listing", async () => {
    const serial = "emulator-5576";
    let booted = false;
    mockEmulator(serial, (shell) => {
      if (shell.includes("avd_name")) return out("TV_API_34");
      if (shell === "pm list features") return out(booted ? LEANBACK_FEATURES : "");
      return out("");
    });
    expect((await listAndroidDevices({ runtimeKind: true }))[0]?.runtimeKind).toBeUndefined();

    booted = true;
    expect((await listAndroidDevices({ runtimeKind: true }))[0]?.runtimeKind).toBe("tv");
    expect(await getAndroidRuntimeKind(serial)).toBe("tv");
  });
});
