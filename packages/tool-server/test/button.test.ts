import { describe, it, expect, vi, beforeEach } from "vitest";

// Keep the real module (blueprints import from it too) but neutralise the
// fire-and-forget WebSocket send so no real socket is opened during the test.
vi.mock("../src/utils/simulator-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/simulator-client")>()),
  sendCommand: vi.fn(),
}));

// `button` runtime-probes whether a target is a TV (a tvOS sim looks like an
// iPhone, an Android TV emulator like a phone). Mock both probes so the unit
// tests stay hermetic and default to "not a TV"; the TV cases override per-test.
vi.mock("../src/utils/ios-devices", () => ({ isTvOsSimulator: vi.fn(async () => false) }));
vi.mock("../src/utils/adb", () => ({ isAndroidTv: vi.fn(async () => false) }));

import { createButtonTool } from "../src/tools/button";
import { UnsupportedOperationError } from "../src/utils/capability";
import { isTvOsSimulator } from "../src/utils/ios-devices";
import { isAndroidTv } from "../src/utils/adb";

const mockIsTvOs = vi.mocked(isTvOsSimulator);
const mockIsAndroidTv = vi.mocked(isAndroidTv);

const iosUdid = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const androidUdid = "emulator-5554";
const tvosUdid = "DDDDDDDD-DDDD-DDDD-DDDD-DDDDDDDDDDDD";

// A registry whose resolveService hands back a TV navigate spy or a no-op
// simulator-server, depending on the urn.
function makeRegistry() {
  const navigate = vi.fn().mockResolvedValue(undefined);
  const registry = {
    resolveService: vi.fn(async (urn: string) => {
      if (urn.startsWith("TvControl:") || urn.startsWith("AndroidTvControl:")) {
        return { navigate } as never;
      }
      // simulator-server: pressKey is unused (sendCommand is mocked above).
      return {} as never;
    }),
  } as never;
  return { registry, navigate };
}

beforeEach(() => {
  mockIsTvOs.mockReset().mockResolvedValue(false);
  mockIsAndroidTv.mockReset().mockResolvedValue(false);
});

describe("button tool — per-platform validation", () => {
  it("rejects `back` on iOS (no hardware back button) instead of a silent no-op", async () => {
    const { registry } = makeRegistry();
    await expect(
      createButtonTool(registry).execute!({}, { udid: iosUdid, button: "back" })
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
  });

  it("rejects `actionButton` on Android", async () => {
    const { registry } = makeRegistry();
    await expect(
      createButtonTool(registry).execute!({}, { udid: androidUdid, button: "actionButton" })
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
  });

  it("accepts `back` on Android (it is a real hardware key there)", async () => {
    const { registry } = makeRegistry();
    await expect(
      createButtonTool(registry).execute!({}, { udid: androidUdid, button: "back" })
    ).resolves.toEqual({ pressed: "back" });
  });

  it("accepts every iOS-valid button", async () => {
    const { registry } = makeRegistry();
    for (const button of [
      "home",
      "power",
      "volumeUp",
      "volumeDown",
      "appSwitch",
      "actionButton",
    ] as const) {
      await expect(
        createButtonTool(registry).execute!({}, { udid: iosUdid, button })
      ).resolves.toEqual({ pressed: button });
    }
  });

  it("rejects a TV remote button on a phone", async () => {
    const { registry } = makeRegistry();
    await expect(
      createButtonTool(registry).execute!({}, { udid: iosUdid, button: "select" })
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
  });
});

describe("button tool — TV remote routing", () => {
  it("routes a remote button on an Apple TV target through the tv-control navigate", async () => {
    mockIsTvOs.mockResolvedValue(true);
    const { registry, navigate } = makeRegistry();

    await expect(
      createButtonTool(registry).execute!({}, { udid: tvosUdid, button: "select" })
    ).resolves.toEqual({ pressed: "select" });
    expect(navigate).toHaveBeenCalledWith("select");
  });

  it("routes a remote button on an Android TV target through the tv-control navigate", async () => {
    mockIsAndroidTv.mockResolvedValue(true);
    const { registry, navigate } = makeRegistry();

    await expect(
      createButtonTool(registry).execute!({}, { udid: androidUdid, button: "right" })
    ).resolves.toEqual({ pressed: "right" });
    expect(navigate).toHaveBeenCalledWith("right");
  });

  it("rejects a phone hardware button on a TV target", async () => {
    mockIsTvOs.mockResolvedValue(true);
    const { registry, navigate } = makeRegistry();

    await expect(
      createButtonTool(registry).execute!({}, { udid: tvosUdid, button: "volumeUp" })
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    expect(navigate).not.toHaveBeenCalled();
  });
});
