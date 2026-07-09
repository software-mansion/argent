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

// The Android branch preflights adb via `ensureDep("adb")` before injecting.
// Stub it (default: adb present, a no-op) so the happy-path tests don't depend
// on adb being installed on the test host (CI runs on a plain ubuntu image);
// individual tests override it to simulate a missing binary.
vi.mock("../src/utils/check-deps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/check-deps")>()),
  ensureDep: vi.fn(async () => {}),
}));

import { buttonTool, BUTTONS_BY_PLATFORM } from "../src/tools/button";
import { UnsupportedOperationError } from "../src/utils/capability";
import { ANDROID_BUTTON_KEYCODES, injectAndroidKeycode } from "../src/utils/android-input";
import { DependencyMissingError, ensureDep } from "../src/utils/check-deps";
import { sendCommand } from "../src/utils/simulator-client";

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

  it("accepts `back` on Android and injects KEYCODE_BACK over adb (never the sim-server HID path)", async () => {
    vi.mocked(injectAndroidKeycode).mockClear();
    vi.mocked(ensureDep).mockClear();
    vi.mocked(sendCommand).mockClear();
    await expect(
      buttonTool.execute(services, { udid: androidUdid, button: "back" })
    ).resolves.toEqual({ pressed: "back" });
    // Routed to adb (not the HID sim-server path) so a stripped AVD can't drop it.
    expect(injectAndroidKeycode).toHaveBeenCalledWith(androidUdid, ANDROID_BUTTON_KEYCODES.back);
    // adb is preflighted so a missing binary fails with a 424 install hint
    // rather than a generic 500 from deeper in the adb path.
    expect(ensureDep).toHaveBeenCalledWith("adb");
    // The mirror of the iOS test's `injectAndroidKeycode not called`: the Android
    // press must NOT go over the simulator-server HID transport. Without this,
    // dropping the android branch's `return` (so control falls through to the
    // sim-server Down/Up path) would double-inject yet still resolve `{ pressed }`
    // and stay green — silently moving the press back onto the transport #449
    // exists to leave.
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("injects the matching keycode for EVERY Android button, not a hardcoded one", async () => {
    // The `back` case above only proves one button. Drive every button the tool
    // accepts on Android and assert each maps to its OWN keycode — a hardcoded
    // index (e.g. always ANDROID_BUTTON_KEYCODES.back) would pass a single-button
    // test while silently misfiring home / power / volume / appSwitch.
    for (const button of BUTTONS_BY_PLATFORM.android) {
      vi.mocked(injectAndroidKeycode).mockClear();
      vi.mocked(sendCommand).mockClear();
      await expect(buttonTool.execute(services, { udid: androidUdid, button })).resolves.toEqual({
        pressed: button,
      });
      expect(injectAndroidKeycode).toHaveBeenCalledWith(
        androidUdid,
        ANDROID_BUTTON_KEYCODES[button]
      );
      // Every Android button goes over adb only — never the sim-server HID path.
      expect(sendCommand).not.toHaveBeenCalled();
    }
  });

  it("preflights adb before injecting so a missing binary surfaces as 424, not 500", async () => {
    vi.mocked(injectAndroidKeycode).mockClear();
    vi.mocked(ensureDep).mockRejectedValueOnce(
      new DependencyMissingError(["adb"], "install android-platform-tools")
    );
    await expect(
      buttonTool.execute(services, { udid: androidUdid, button: "home" })
    ).rejects.toBeInstanceOf(DependencyMissingError);
    // Preflight fails closed: no keyevent is injected when adb is missing.
    expect(injectAndroidKeycode).not.toHaveBeenCalled();
  });

  it("surfaces an adb transport failure as a throw (no silent success — the #449 fix)", async () => {
    // Moving off the fire-and-forget HID transport means a failed press must
    // propagate, not resolve `{ pressed }` while nothing happened on-device.
    vi.mocked(ensureDep).mockResolvedValueOnce(undefined);
    vi.mocked(injectAndroidKeycode).mockRejectedValueOnce(new Error("adb: device offline"));
    await expect(
      buttonTool.execute(services, { udid: androidUdid, button: "home" })
    ).rejects.toThrow(/device offline/);
  });

  it("accepts every iOS-valid button and drives it over the sim-server as Down then Up (not adb)", async () => {
    // Derive from the SOURCE set (mirroring the Android button test) so a future
    // iOS button added to BUTTONS_BY_PLATFORM.ios is auto-covered here rather
    // than silently skipped by a hardcoded list.
    for (const button of BUTTONS_BY_PLATFORM.ios) {
      vi.mocked(sendCommand).mockClear();
      vi.mocked(injectAndroidKeycode).mockClear();
      await expect(buttonTool.execute(services, { udid: iosUdid, button })).resolves.toEqual({
        pressed: button,
      });
      // iOS presses go over the simulator-server HID transport as an ordered
      // Down→Up pair. Assert the exact pair (not just `{ pressed }`) so dropping
      // or reordering an event — or misrouting an iOS press into the Android adb
      // branch — turns this red instead of passing on the result alone.
      expect(vi.mocked(sendCommand).mock.calls.map((c) => c[1])).toEqual([
        { cmd: "button", direction: "Down", button },
        { cmd: "button", direction: "Up", button },
      ]);
      expect(injectAndroidKeycode).not.toHaveBeenCalled();
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
