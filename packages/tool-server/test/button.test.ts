import { beforeEach, describe, it, expect, vi } from "vitest";
import { getFailureSignal } from "@argent/registry";

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

// HarmonyOS presses go over `uitest uiInput keyEvent` on the device; neutralise
// it for the same reason as the adb call above. `harmonyDisplay` is the read the
// press is gated on, stubbed awake by default (see beforeEach);
// `assertHarmonyDisplayReady` stays real so the tests see the guard's own refusal.
vi.mock("../src/utils/harmony-uitest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-uitest")>()),
  harmonyKeyEvent: vi.fn(),
  harmonyDisplay: vi.fn(),
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
import {
  HARMONY_INTERACTION_TIMEOUT_MS,
  harmonyDisplay,
  harmonyKeyEvent,
} from "../src/utils/harmony-uitest";
import { sendCommand } from "../src/utils/simulator-client";

const iosUdid = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const androidUdid = "emulator-5554";
const harmonyConnectKey = "025DEK236V035771";
const harmonyUdid = `harmony-${harmonyConnectKey}`;
const services = { simulatorServer: {} } as never;

/**
 * The `uitest uiInput keyEvent` name each HarmonyOS button must reach the device
 * as, spelled out rather than derived, so a swapped pair (home ↔ back) fails.
 * The loop below indexes this by every entry of `BUTTONS_BY_PLATFORM.harmony`
 * and asserts the lookup HIT before comparing - without that, a button added to
 * the accepted set with no key name would inject `undefined` and still match,
 * since the expectation would be `undefined` too.
 */
const HARMONY_KEY_NAMES: Record<string, string> = {
  home: "Home",
  back: "Back",
  power: "Power",
};

/** A Mate 60's render resolution, awake. */
const HARMONY_AWAKE = { width: 1216, height: 2688, screenOn: true };
const HARMONY_SUSPENDED = { ...HARMONY_AWAKE, screenOn: false };

beforeEach(() => {
  vi.mocked(harmonyDisplay).mockReset().mockResolvedValue(HARMONY_AWAKE);
});

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

  it("rejects `volumeUp` on HarmonyOS — `uitest` names only Home/Back/Power", async () => {
    // `uitest uiInput keyEvent` answers `No Error` to any keyID it is handed, so
    // an unnamed button would inject something unverified and still resolve
    // `{ pressed }`. It has to be refused here or not at all.
    await expect(
      buttonTool.execute(services, { udid: harmonyUdid, button: "volumeUp" })
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    // The refusal names what IS available, like the sibling keyboard tool's
    // unsupported-key message — four of the seven buttons are refused here, so
    // a message that only names the failing one leaves the caller guessing.
    await expect(
      buttonTool.execute(services, { udid: harmonyUdid, button: "volumeUp" })
    ).rejects.toThrow(/Supported: home, back, power/);
    expect(harmonyKeyEvent).not.toHaveBeenCalled();
  });

  it("injects the matching key name for EVERY HarmonyOS button, over hdc only", async () => {
    for (const button of BUTTONS_BY_PLATFORM.harmony) {
      vi.mocked(harmonyKeyEvent).mockClear();
      vi.mocked(sendCommand).mockClear();
      vi.mocked(injectAndroidKeycode).mockClear();
      vi.mocked(ensureDep).mockClear();
      await expect(buttonTool.execute(services, { udid: harmonyUdid, button })).resolves.toEqual({
        pressed: button,
      });
      const expectedKey = HARMONY_KEY_NAMES[button];
      expect(expectedKey, `no uitest key name for "${button}"`).toBeTypeOf("string");
      // The connect key, not the `harmony-` prefixed device id — `uitest` is
      // addressed by what `hdc list targets` reports.
      expect(harmonyKeyEvent).toHaveBeenCalledWith(
        harmonyConnectKey,
        expectedKey,
        expect.any(Number)
      );
      // hdc is preflighted so a missing connector fails with a 424 install hint.
      expect(ensureDep).toHaveBeenCalledWith("hdc");
      // Neither of the other backends is touched — in particular the press must
      // not fall through to the sim-server HID path, which no HarmonyOS device
      // is behind.
      expect(sendCommand).not.toHaveBeenCalled();
      expect(injectAndroidKeycode).not.toHaveBeenCalled();
    }
  });

  it("preflights hdc before injecting so a missing connector surfaces as 424, not 500", async () => {
    vi.mocked(harmonyKeyEvent).mockClear();
    vi.mocked(ensureDep).mockRejectedValueOnce(
      new DependencyMissingError(["hdc"], "install the HarmonyOS command line tools")
    );
    await expect(
      buttonTool.execute(services, { udid: harmonyUdid, button: "home" })
    ).rejects.toBeInstanceOf(DependencyMissingError);
    expect(harmonyKeyEvent).not.toHaveBeenCalled();
  });

  it("surfaces an hdc transport failure as a throw, not a silent `{ pressed }`", async () => {
    vi.mocked(ensureDep).mockResolvedValueOnce(undefined);
    vi.mocked(harmonyKeyEvent).mockRejectedValueOnce(new Error("[Fail]Not match target found"));
    await expect(
      buttonTool.execute(services, { udid: harmonyUdid, button: "home" })
    ).rejects.toThrow(/Not match target found/);
  });
});

describe("button tool — a suspended HarmonyOS panel", () => {
  // `uitest uiInput keyEvent` answers `No Error` against a display that is OFF
  // or SUSPEND while the press lands nowhere: measured on a 6.1.1 emulator, a
  // `Home` keyEvent injected into a suspended panel left Settings foreground
  // after waking. `gesture-tap`, `gesture-swipe` and `keyboard` all refuse in
  // that state, and `home`/`back` are the keys an agent reaches for to recover
  // from a screen timeout.
  beforeEach(() => {
    vi.mocked(harmonyKeyEvent).mockClear();
    vi.mocked(ensureDep).mockClear();
  });

  for (const button of ["home", "back"] as const) {
    it(`refuses \`${button}\` while the display is suspended, injecting nothing`, async () => {
      vi.mocked(harmonyDisplay).mockResolvedValue(HARMONY_SUSPENDED);
      const err = await buttonTool.execute(services, { udid: harmonyUdid, button }).then(
        () => {
          throw new Error("expected the press to reject, but it resolved");
        },
        (e: unknown) => e
      );
      // The same guard the tap refusal comes from, so the two agree at the
      // moment it matters — not a second, divergent message.
      expect(getFailureSignal(err)?.failure_stage).toBe("harmony_screen_off");
      expect((err as Error).message).toMatch(/display is off/);
      // The refusal names the button, not "tap": the shared helper takes the
      // verb from its caller.
      expect((err as Error).message).toContain(`press ${button}`);
      expect(harmonyKeyEvent).not.toHaveBeenCalled();
    });
  }

  it("still presses `power` while the display is suspended — it is the way back", async () => {
    // The refusal above tells the caller to wake the device with `button`
    // (power). Gating power on the same check would make that advice
    // unfollowable, so it is carved out — and carved out before the display
    // read, so waking a device does not depend on the render service answering.
    vi.mocked(harmonyDisplay).mockResolvedValue(HARMONY_SUSPENDED);
    await expect(
      buttonTool.execute(services, { udid: harmonyUdid, button: "power" })
    ).resolves.toEqual({ pressed: "power" });
    expect(harmonyKeyEvent).toHaveBeenCalledWith(harmonyConnectKey, "Power", expect.any(Number));
    expect(harmonyDisplay).not.toHaveBeenCalled();
  });

  it("presses `home` as usual once the display is awake", async () => {
    await expect(
      buttonTool.execute(services, { udid: harmonyUdid, button: "home" })
    ).resolves.toEqual({ pressed: "home" });
    expect(harmonyKeyEvent).toHaveBeenCalledWith(harmonyConnectKey, "Home", expect.any(Number));
  });

  it("refuses `home` when the render service reports a 0x0 display", async () => {
    // A guest whose compositor has not come up answers `render resolution=0x0`,
    // and nothing about that read is trustworthy — including the power state
    // parsed off the same dump. The tap and swipe paths refuse it through the
    // same helper; a press that went ahead would inject against a device that
    // has no screen yet and still resolve `{ pressed: "home" }`.
    vi.mocked(harmonyDisplay).mockResolvedValue({ width: 0, height: 0, screenOn: true });

    const err = await buttonTool.execute(services, { udid: harmonyUdid, button: "home" }).then(
      () => {
        throw new Error("expected the press to reject, but it resolved");
      },
      (e: unknown) => e
    );

    expect(getFailureSignal(err)?.failure_stage).toBe("harmony_display_zero");
    expect((err as Error).message).toContain("press home");
    expect((err as Error).message).toContain("0x0 display");
    expect(harmonyKeyEvent).not.toHaveBeenCalled();
  });

  it("gives the press what is left of ONE budget shared with the display read", async () => {
    // Both legs on `UITEST_TIMEOUT_MS` put a press's worst case at 40s, above
    // the 30s at which the MCP client aborts a call and REPLAYS it — a second
    // `Back` for one the caller believes never happened. The read is charged
    // against the same deadline, so the press gets what it left behind.
    const READ_MS = 60;
    vi.mocked(harmonyDisplay).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, READ_MS));
      return HARMONY_AWAKE;
    });

    await buttonTool.execute(services, { udid: harmonyUdid, button: "home" });

    const budget = vi.mocked(harmonyKeyEvent).mock.calls[0][2];
    // Not pinned to the millisecond — `setTimeout` can fire a touch early, and
    // under a loaded suite this boundary has come back 1ms over. What has to
    // discriminate is a press handed a FRESH ceiling, which arrives as 20000.
    expect(budget).toBeLessThan(HARMONY_INTERACTION_TIMEOUT_MS - READ_MS / 2);
    expect(budget).toBeGreaterThan(0);
  });
});

describe("button tool — service declaration", () => {
  it("does not declare the simulator-server service for an Android target", () => {
    // Android presses go over adb; declaring sim-server would needlessly resolve +
    // spawn it (up to a 30s ready-wait) and could throw before the adb path runs.
    expect(buttonTool.services({ udid: androidUdid, button: "back" })).toEqual({});
  });

  it("does not declare the simulator-server service for a HarmonyOS target", () => {
    // Same reason as Android: the press goes over hdc, and no simulator-server
    // controller exists for a HarmonyOS device to spawn one against.
    expect(buttonTool.services({ udid: harmonyUdid, button: "home" })).toEqual({});
  });

  it("still declares the simulator-server service eagerly for an iOS target", () => {
    expect(buttonTool.services({ udid: iosUdid, button: "home" })).toHaveProperty(
      "simulatorServer"
    );
  });
});
