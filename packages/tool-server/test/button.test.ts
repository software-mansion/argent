import { describe, it, expect, vi } from "vitest";

// Keep the real module (blueprints import from it too) but neutralise the
// fire-and-forget WebSocket send so no real socket is opened during the test.
vi.mock("../src/utils/simulator-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/simulator-client")>()),
  sendCommand: vi.fn(),
}));

// Android presses go over `adb shell input keyevent`; neutralise the real adb
// call so the test asserts wiring (which keycode) without a device attached.
vi.mock("../src/utils/android-input", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/android-input")>()),
  injectAndroidKeycode: vi.fn(),
}));

import { buttonTool } from "../src/tools/button";
import { UnsupportedOperationError } from "../src/utils/capability";
import { ANDROID_BUTTON_KEYCODES, injectAndroidKeycode } from "../src/utils/android-input";

const iosUdid = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const androidUdid = "emulator-5554";
const services = { simulatorServer: {} } as never;

describe("button tool — per-platform validation", () => {
  it("rejects `back` on iOS (no hardware back button) instead of a silent no-op", async () => {
    await expect(
      buttonTool.execute(services, { udid: iosUdid, button: "back" })
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
  });

  it("rejects `actionButton` on Android", async () => {
    await expect(
      buttonTool.execute(services, { udid: androidUdid, button: "actionButton" })
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
  });

  it("accepts `back` on Android and injects KEYCODE_BACK over adb", async () => {
    vi.mocked(injectAndroidKeycode).mockClear();
    await expect(
      buttonTool.execute(services, { udid: androidUdid, button: "back" })
    ).resolves.toEqual({ pressed: "back" });
    // Routed to adb (not the HID sim-server path) so a stripped AVD can't drop it.
    expect(injectAndroidKeycode).toHaveBeenCalledWith(androidUdid, ANDROID_BUTTON_KEYCODES.back);
  });

  it("accepts every iOS-valid button", async () => {
    for (const button of [
      "home",
      "power",
      "volumeUp",
      "volumeDown",
      "appSwitch",
      "actionButton",
    ] as const) {
      await expect(buttonTool.execute(services, { udid: iosUdid, button })).resolves.toEqual({
        pressed: button,
      });
    }
  });
});

describe("button tool — service declaration", () => {
  it("does not declare the simulator-server service for an Android target", () => {
    // Android presses go over adb; declaring sim-server would needlessly resolve +
    // spawn it (up to a 30s ready-wait) and could throw before the adb path runs.
    expect(buttonTool.services({ udid: androidUdid, button: "back" })).toEqual({});
  });

  it("still declares the simulator-server service eagerly for an iOS target", () => {
    expect(buttonTool.services({ udid: iosUdid, button: "home" })).toHaveProperty(
      "simulatorServer"
    );
  });
});
