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

// Mock one device whose `ro.build.characteristics` is given by `characteristics`.
function mockDevice(serial: string, characteristics: string): void {
  execFileMock.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === "adb" && args[0] === "devices" && args.length === 1) {
      return { stdout: `List of devices attached\n${serial}\tdevice\n`, stderr: "" };
    }
    if (cmd === "adb" && args[0] === "-s" && args[2] === "shell") {
      const shell = args[3] ?? "";
      if (shell === "getprop ro.product.model") return { stdout: "AndroidTV\n", stderr: "" };
      if (shell === "getprop ro.build.version.sdk") return { stdout: "34\n", stderr: "" };
      if (shell === "getprop ro.build.characteristics")
        return { stdout: `${characteristics}\n`, stderr: "" };
      return { stdout: "\n", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });
}

beforeEach(() => {
  execFileMock.mockReset();
});

describe("Android TV discovery — runtimeKind", () => {
  it("tags a leanback device (characteristics include 'tv') as runtimeKind 'tv'", async () => {
    mockDevice("emulator-5556", "nosdcard,tv");
    const devices = await listAndroidDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0]!.runtimeKind).toBe("tv");
  });

  it("tags a phone (characteristics 'nosdcard') as runtimeKind 'mobile'", async () => {
    mockDevice("emulator-5554", "nosdcard");
    const devices = await listAndroidDevices();
    expect(devices[0]!.runtimeKind).toBe("mobile");
  });

  it("defaults to 'mobile' when the characteristics prop is empty/unreadable", async () => {
    mockDevice("emulator-5554", "");
    const devices = await listAndroidDevices();
    expect(devices[0]!.runtimeKind).toBe("mobile");
  });

  it("matches 'tv' case-insensitively and ignores surrounding whitespace", async () => {
    mockDevice("emulator-5556", "default, TV ");
    const devices = await listAndroidDevices();
    expect(devices[0]!.runtimeKind).toBe("tv");
  });

  it("does not false-match a substring like 'television' token boundaries", async () => {
    // 'atv' is a single token that is not exactly 'tv' → mobile.
    mockDevice("emulator-5554", "atv,nosdcard");
    const devices = await listAndroidDevices();
    expect(devices[0]!.runtimeKind).toBe("mobile");
  });
});

describe("Android TV discovery — getAndroidRuntimeKind / isAndroidTv", () => {
  it("resolves the runtime kind for a ready TV serial", async () => {
    mockDevice("emulator-5556", "tv");
    expect(await getAndroidRuntimeKind("emulator-5556")).toBe("tv");
    expect(await isAndroidTv("emulator-5556")).toBe(true);
  });

  it("returns undefined for a serial not in the device list", async () => {
    mockDevice("emulator-5556", "tv");
    // NOTE: getAndroidRuntimeKind memoises per-serial; a serial never seen is
    // not cached, so this re-lists and finds no match.
    expect(await getAndroidRuntimeKind("emulator-9999")).toBeUndefined();
    expect(await isAndroidTv("emulator-9999")).toBe(false);
  });
});
