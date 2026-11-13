import { afterEach, describe, expect, it, vi } from "vitest";
import type { CDPTarget } from "../../src/utils/debugger/discovery";

// test/setup/stub-android-device-name.ts stubs this module suite-wide.
vi.unmock("../../src/utils/debugger/android-device-name");

type AdbDevice = { serial: string; state: string };
const adbShell = vi.hoisted(() => vi.fn(async (_serial: string, _command: string) => ""));
const listAndroidSerials = vi.hoisted(() =>
  vi.fn(async (_options?: { devicesTimeoutMs?: number }): Promise<AdbDevice[]> => [])
);
vi.mock("../../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/adb")>()),
  adbShell: (serial: string, command: string) => adbShell(serial, command),
  listAndroidSerials: (options?: { devicesTimeoutMs?: number }) => listAndroidSerials(options),
}));

import { ADB_DEVICES_TIMEOUT_MS } from "../../src/utils/adb";
import {
  androidDeviceNames,
  otherAndroidDeviceOnline,
} from "../../src/utils/debugger/android-device-name";
import { checkFallbackTarget } from "../../src/utils/debugger/fallback-target";
import { externalNativeId } from "../../src/utils/external-devices";

afterEach(() => {
  adbShell.mockReset();
  listAndroidSerials.mockReset();
});

/**
 * `adb devices` lists these, and each serial's getprop answers with its name
 * parts (a function: the answer comes later; none: adb cannot read it). adb
 * knows a provider's device by its own serial, not by the `ext:` id.
 */
function devices(
  list: Array<[serial: string, state: string, props?: string | (() => Promise<string>)]>
) {
  listAndroidSerials.mockResolvedValue(list.map(([serial, state]) => ({ serial, state })));
  adbShell.mockImplementation(async (serial: string) => {
    const props = list.find(([s]) => s === externalNativeId(serial))?.[2];
    if (props === undefined) throw new Error(`adb: device '${serial}' not found`);
    return typeof props === "string" ? props : props();
  });
}

const API36 = "model=sdk_gphone64_arm64\nrelease=16\nsdk=36\n";
const API35 = "model=sdk_gphone64_arm64\nrelease=15\nsdk=35\n";

/** An emulator whose shell does not answer: adb gives up at its timeout. */
function frozen(): Promise<string> {
  return new Promise((_resolve, reject) =>
    setTimeout(() => reject(new Error("adb: Command timed out")), 1_000)
  );
}

describe("otherAndroidDeviceOnline", () => {
  it("is false when adb lists no other online device, and reads no names", async () => {
    devices([
      ["emulator-5582", "device", API36],
      ["emulator-5586", "offline"],
    ]);

    expect(await otherAndroidDeviceOnline("emulator-5582")).toBe(false);
    expect(listAndroidSerials).toHaveBeenCalledWith({ devicesTimeoutMs: ADB_DEVICES_TIMEOUT_MS });
    expect(adbShell).not.toHaveBeenCalled();
  });

  it("is true when another device is online, whatever its system image", async () => {
    devices([
      ["emulator-5582", "device", API36],
      ["emulator-5584", "device", API35],
    ]);

    expect(await otherAndroidDeviceOnline("emulator-5582")).toBe(true);
  });

  it("knows a provider's device by the serial adb lists", async () => {
    devices([["emulator-5582", "device", API36]]);

    expect(await otherAndroidDeviceOnline("ext:acme-1:emulator-5582")).toBe(false);
  });

  it("is true when adb cannot list the devices", async () => {
    listAndroidSerials.mockRejectedValue(new Error("adb not found"));

    expect(await otherAndroidDeviceOnline("emulator-5582")).toBe(true);
  });
});

describe("androidDeviceNames", () => {
  it("builds the name React Native reports, and the model alone for Genymotion", async () => {
    // An older adb shell ends its lines with \r\n.
    adbShell.mockResolvedValue("model=sdk_gphone64_arm64\r\nrelease=16\r\nsdk=36\r\n");

    expect(await androidDeviceNames("emulator-5582")).toEqual([
      "sdk_gphone64_arm64 - 16 - API 36",
      "sdk_gphone64_arm64",
    ]);
    expect(adbShell).toHaveBeenCalledWith("emulator-5582", expect.stringContaining("getprop"));
  });

  it("keeps a model name with spaces", async () => {
    adbShell.mockResolvedValue("model=Pixel 9 Pro\nrelease=15\nsdk=35\n");

    expect(await androidDeviceNames("4C091FDAP000AB")).toEqual([
      "Pixel 9 Pro - 15 - API 35",
      "Pixel 9 Pro",
    ]);
  });

  it("is undefined when adb cannot read the device", async () => {
    adbShell.mockRejectedValue(new Error("adb: device 'not-a-serial' not found"));

    expect(await androidDeviceNames("not-a-serial")).toBeUndefined();
  });

  it("is undefined when a property is empty", async () => {
    adbShell.mockResolvedValue("model=sdk_gphone64_arm64\nrelease=\nsdk=36\n");

    expect(await androidDeviceNames("emulator-5582")).toBeUndefined();
  });
});

describe("checkFallbackTarget's adb reads for an Android serial", () => {
  const KEYED = {
    id: "904f32cb7611d7a43b99a5276e18506a3505b892-1",
    title: "com.example.app (sdk_gphone64_arm64 - 16 - API 36)",
    webSocketDebuggerUrl: "ws://localhost:8081/inspector/debug?device=904f32cb&page=1",
    deviceName: "sdk_gphone64_arm64 - 16 - API 36",
    appId: "com.example.app",
    reactNative: { logicalDeviceId: "904f32cb7611d7a43b99a5276e18506a3505b892" },
  } as CDPTarget;
  // RN 0.72's legacy inspector, as test/metro/vega-target-routing.test.ts lists it.
  const LEGACY = {
    id: "1-1",
    description: "com.example.phone",
    title: "Hermes React Native",
    webSocketDebuggerUrl: "ws://[::1]:8081/inspector/debug?device=1&page=1",
    deviceName: "Pixel 7 - 13 - API 33",
  } as CDPTarget;
  const PIXEL7 = "model=Pixel 7\nrelease=13\nsdk=33\n";

  const readSerials = () => adbShell.mock.calls.map(([serial]) => serial);

  it("reads no name of another device, so a frozen one costs nothing", async () => {
    devices([
      ["emulator-5582", "device", API36],
      ["emulator-5584", "device", frozen],
    ]);

    const note = await checkFallbackTarget(KEYED, "emulator-5582", 8081);

    expect(note).toContain("Argent connected to the only runtime on Metro port 8081");
    expect(readSerials()).toEqual(["emulator-5582"]);
  });

  it("adds no note for a provider's device that is the only one adb lists", async () => {
    devices([["emulator-5582", "device", API36]]);

    expect(await checkFallbackTarget(KEYED, "ext:acme-1:emulator-5582", 8081)).toBeUndefined();
  });

  it("does not list the devices for a legacy-inspector runtime", async () => {
    devices([
      ["4C091FDAP000AB", "device", PIXEL7],
      ["emulator-5584", "device", API36],
    ]);

    expect(await checkFallbackTarget(LEGACY, "4C091FDAP000AB", 8081)).toBeUndefined();
    expect(readSerials()).toEqual(["4C091FDAP000AB"]);
    expect(listAndroidSerials).not.toHaveBeenCalled();
  });

  it("lists the devices while it reads the name, so a slow adb costs one timeout", async () => {
    let listed!: () => void;
    const listing = new Promise<void>((resolve) => (listed = resolve));
    let first: string | undefined;
    devices([
      [
        "emulator-5582",
        "device",
        async () => {
          first = await Promise.race([
            listing.then(() => "device list"),
            new Promise<string>((resolve) => setTimeout(() => resolve("name read"), 1_000)),
          ]);
          return API36;
        },
      ],
    ]);
    const answer = listAndroidSerials.getMockImplementation()!;
    listAndroidSerials.mockImplementation(async (options) => {
      listed();
      return answer(options);
    });

    expect(await checkFallbackTarget(KEYED, "emulator-5582", 8081)).toBeUndefined();
    expect(first).toBe("device list");
  });
});
