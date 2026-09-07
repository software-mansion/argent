import { beforeEach, describe, it, expect, vi } from "vitest";

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

// HarmonyOS presses go over `uitest uiInput keyEvent` on the device; fake the
// hdc transport they leave on (same reason as the adb call above), so what the
// assertions read is the actual wire line. `harmonyDisplay`, the read the press
// is gated on, stays REAL behind that transport and parses whatever dump the
// fake serves — so the tests see the guard's own refusal, off a dump shaped like
// the ones a device prints.
vi.mock("../src/utils/harmony-hdc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-hdc")>()),
  runHdcShell: vi.fn(),
}));

// The Android branch preflights adb via `ensureDep("adb")` before injecting.
// Stub it (default: adb present, a no-op) so the happy-path tests don't depend
// on adb being installed on the test host (CI runs on a plain ubuntu image);
// individual tests override it to simulate a missing binary.
vi.mock("../src/utils/check-deps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/check-deps")>()),
  ensureDep: vi.fn(async () => {}),
}));

import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { buttonTool, BUTTONS_BY_PLATFORM } from "../src/tools/button";
import { UnsupportedOperationError } from "../src/utils/capability";
import { RunnerCommandError } from "../src/utils/ios-device/runner-client";
import { ANDROID_BUTTON_KEYCODES, injectAndroidKeycode } from "../src/utils/android-input";
import { DependencyMissingError, ensureDep } from "../src/utils/check-deps";
import { runHdcShell as realRunHdcShell } from "../src/utils/harmony-hdc";
import { HARMONY_INTERACTION_TIMEOUT_MS } from "../src/utils/harmony-uitest";
import { sendCommand } from "../src/utils/simulator-client";

const runHdcShell = vi.mocked(realRunHdcShell);

const iosUdid = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const androidUdid = "emulator-5554";
const harmonyConnectKey = "025DEK236V035771";
const harmonyUdid = `harmony-${harmonyConnectKey}`;
// Physical-iOS UDID shape (8 hex, dash, 16 hex) routes to the runner branch.
const deviceUdid = "00008110-000978540290401E";
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

/**
 * What `hidumper -s RenderService -a screen` prints, in the shape measured on a
 * HarmonyOS 6.1.1 guest: one `screen[N]:` line per panel carrying BOTH the power
 * state and the size — the pair `harmonyDisplay` reads off that one line.
 */
function screenDump(power = "POWER_STATUS_ON", size = "1216x2688"): string {
  return (
    `-- ScreenInfo\nscreen[0]: id=0, powerStatus=${power}, backlight=1, ` +
    `screenType=EXTERNAL_TYPE, render resolution=${size}, physical resolution=${size}, ` +
    `isVirtual=false`
  );
}

/** The `uitest uiInput …` lines the press put on the wire. */
const uiInputs = () =>
  runHdcShell.mock.calls.filter(([, command]) => command.startsWith("uitest uiInput"));

beforeEach(() => {
  runHdcShell.mockReset();
  runHdcShell.mockImplementation(async (_connectKey, command) =>
    command.startsWith("hidumper")
      ? { stdout: screenDump(), exitCode: 0 }
      : { stdout: "", exitCode: 0 }
  );
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
    expect(uiInputs()).toHaveLength(0);
  });

  it("injects the matching key name for EVERY HarmonyOS button, over hdc only", async () => {
    for (const button of BUTTONS_BY_PLATFORM.harmony) {
      runHdcShell.mockClear();
      vi.mocked(sendCommand).mockClear();
      vi.mocked(injectAndroidKeycode).mockClear();
      vi.mocked(ensureDep).mockClear();
      await expect(buttonTool.execute(services, { udid: harmonyUdid, button })).resolves.toEqual({
        pressed: button,
      });
      const expectedKey = HARMONY_KEY_NAMES[button];
      expect(expectedKey, `no uitest key name for "${button}"`).toBeTypeOf("string");
      // The whole wire line: a swapped pair or a reordered argument still exits
      // 0 on-device, so only the exact `uitest uiInput keyEvent <name>` catches
      // it. The connect key, not the `harmony-` prefixed device id — `uitest`
      // is addressed by what `hdc list targets` reports.
      const [connectKey, command] = uiInputs().at(-1) ?? [];
      expect(connectKey).toBe(harmonyConnectKey);
      expect(command).toBe(`uitest uiInput keyEvent ${expectedKey}`);
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
    runHdcShell.mockClear();
    vi.mocked(ensureDep).mockRejectedValueOnce(
      new DependencyMissingError(["hdc"], "install the HarmonyOS command line tools")
    );
    await expect(
      buttonTool.execute(services, { udid: harmonyUdid, button: "home" })
    ).rejects.toBeInstanceOf(DependencyMissingError);
    expect(uiInputs()).toHaveLength(0);
  });

  it("surfaces an hdc transport failure as a throw, not a silent `{ pressed }`", async () => {
    runHdcShell.mockImplementation(async (_connectKey, command) => {
      if (command.startsWith("hidumper")) return { stdout: screenDump(), exitCode: 0 };
      throw new Error("[Fail]Not match target found");
    });
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
    vi.mocked(ensureDep).mockClear();
  });

  for (const button of ["home", "back"] as const) {
    it(`refuses \`${button}\` while the display is suspended, injecting nothing`, async () => {
      runHdcShell.mockImplementation(async (_connectKey, command) =>
        command.startsWith("hidumper")
          ? { stdout: screenDump("POWER_STATUS_SUSPEND"), exitCode: 0 }
          : { stdout: "", exitCode: 0 }
      );
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
      expect(uiInputs()).toHaveLength(0);
    });
  }

  it("still presses `power` while the display is suspended — it is the way back", async () => {
    // The refusal above tells the caller to wake the device with `button`
    // (power). Gating power on the same check would make that advice
    // unfollowable, so it is carved out — and carved out before any display
    // read, so waking a device does not depend on the render service answering.
    runHdcShell.mockImplementation(async () => ({ stdout: "", exitCode: 0 }));
    await expect(
      buttonTool.execute(services, { udid: harmonyUdid, button: "power" })
    ).resolves.toEqual({ pressed: "power" });
    const [connectKey, command] = uiInputs().at(-1) ?? [];
    expect([connectKey, command]).toEqual([harmonyConnectKey, "uitest uiInput keyEvent Power"]);
    expect(runHdcShell.mock.calls.filter(([, c]) => c.startsWith("hidumper"))).toHaveLength(0);
  });

  it("presses `home` as usual once the display is awake", async () => {
    await expect(
      buttonTool.execute(services, { udid: harmonyUdid, button: "home" })
    ).resolves.toEqual({ pressed: "home" });
    const [, command] = uiInputs().at(-1) ?? [];
    expect(command).toBe("uitest uiInput keyEvent Home");
  });

  it("refuses `home` when the render service reports a 0x0 display", async () => {
    // A guest whose compositor has not come up answers `render resolution=0x0`,
    // and nothing about that read is trustworthy — including the power state
    // parsed off the same dump. The tap and swipe paths refuse it through the
    // same helper; a press that went ahead would inject against a device that
    // has no screen yet and still resolve `{ pressed: "home" }`.
    runHdcShell.mockImplementation(async (_connectKey, command) =>
      command.startsWith("hidumper")
        ? { stdout: screenDump("POWER_STATUS_ON", "0x0"), exitCode: 0 }
        : { stdout: "", exitCode: 0 }
    );

    const err = await buttonTool.execute(services, { udid: harmonyUdid, button: "home" }).then(
      () => {
        throw new Error("expected the press to reject, but it resolved");
      },
      (e: unknown) => e
    );

    expect(getFailureSignal(err)?.failure_stage).toBe("harmony_display_zero");
    expect((err as Error).message).toContain("press home");
    expect((err as Error).message).toContain("0x0 display");
    expect(uiInputs()).toHaveLength(0);
  });

  it("gives the press what is left of ONE budget shared with both display reads", async () => {
    // Legs handed fresh ceilings put a press's worst case at 60s, above the 30s
    // at which the MCP client aborts a call and REPLAYS it — a second `Back`
    // for one the caller believes never happened. Both reads (the fast prefilter
    // and the authoritative one inside the queue hold) are charged against the
    // same deadline, so the press gets what they left behind.
    const READ_MS = 60;
    runHdcShell.mockImplementation(async (_connectKey, command, timeoutMs) => {
      if (!command.startsWith("hidumper")) return { stdout: "", exitCode: 0 };
      await new Promise((r) => setTimeout(r, READ_MS));
      void timeoutMs;
      return { stdout: screenDump(), exitCode: 0 };
    });

    await buttonTool.execute(services, { udid: harmonyUdid, button: "home" });

    // Half a read of tolerance, not the millisecond: `setTimeout` can fire a
    // touch early. What has to discriminate is a press handed a FRESH ceiling,
    // which arrives as the untouched HARMONY_INTERACTION_TIMEOUT_MS.
    const budget = uiInputs()[0]?.[2];
    expect(budget).toBeLessThan(HARMONY_INTERACTION_TIMEOUT_MS - READ_MS);
    expect(budget).toBeGreaterThan(0);
  });
});

describe("button tool: physical iOS", () => {
  // The buttons XCUIDevice can press on hardware. volumeUp/volumeDown are
  // unavailable on the SIMULATOR SDK only, so hardware gets them; power and
  // appSwitch have no XCUIDevice API at all.
  const runnerButtons = ["home", "volumeUp", "volumeDown", "actionButton"] as const;

  function runnerRig() {
    const run = vi.fn().mockResolvedValue({});
    return { run, services: { iosDeviceRunner: { udid: deviceUdid, run } } as never };
  }

  it("presses every runner-capable button through the runner's `button` command", async () => {
    for (const button of runnerButtons) {
      const { run, services: runnerServices } = runnerRig();
      vi.mocked(sendCommand).mockClear();
      vi.mocked(injectAndroidKeycode).mockClear();
      await expect(
        buttonTool.execute(runnerServices, { udid: deviceUdid, button })
      ).resolves.toEqual({ pressed: button });
      // One device-scoped command carrying the button name: no appBundleId, and
      // no per-button command kind. Asserting the exact request keeps the wire
      // shape pinned to PROTOCOL.md's `button` entry.
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0][0]).toEqual({ command: "button", button });
      // Hardware never rides the simulator-server HID transport or adb.
      expect(sendCommand).not.toHaveBeenCalled();
      expect(injectAndroidKeycode).not.toHaveBeenCalled();
    }
  });

  it("rejects the buttons XCUITest exposes no API for", async () => {
    for (const button of ["power", "appSwitch"] as const) {
      const { run, services: runnerServices } = runnerRig();
      await expect(
        buttonTool.execute(runnerServices, { udid: deviceUdid, button })
      ).rejects.toBeInstanceOf(UnsupportedOperationError);
      expect(run).not.toHaveBeenCalled();
    }
  });

  it("maps the runner's UNSUPPORTED_OPERATION to the capability rejection, message kept", async () => {
    // Only the device knows whether it has an Action button: a non-Pro iPhone
    // answers UNSUPPORTED_OPERATION from the runner. That is the same verdict
    // as the platform gates above, so it must be a 400-class capability error,
    // not a raw runner failure surfacing as a 500.
    const { run, services: runnerServices } = runnerRig();
    run.mockRejectedValueOnce(
      new RunnerCommandError("this device has no action button", {
        code: "UNSUPPORTED_OPERATION",
      })
    );

    const error = await buttonTool
      .execute(runnerServices, { udid: deviceUdid, button: "actionButton" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnsupportedOperationError);
    expect((error as Error).message).toContain("this device has no action button");
    expect(getFailureSignal(error)?.error_code).toBe(
      FAILURE_CODES.TOOL_CAPABILITY_UNSUPPORTED_OPERATION
    );
  });

  it("passes every other runner failure through untouched", async () => {
    const { run, services: runnerServices } = runnerRig();
    const original = new RunnerCommandError("runner busy", { code: "RUNNER_BUSY" });
    run.mockRejectedValueOnce(original);

    await expect(
      buttonTool.execute(runnerServices, { udid: deviceUdid, button: "home" })
    ).rejects.toBe(original);
  });

  it("declares the runner service only for a button it can actually press", () => {
    for (const button of runnerButtons) {
      expect(buttonTool.services({ udid: deviceUdid, button })).toHaveProperty("iosDeviceRunner");
    }
    // A button `execute` refuses must not stand a runner up first: a cold start
    // is an xcodebuild build of up to 15 minutes plus a 120s ready-wait, paid
    // for a request that never reaches the device.
    for (const button of ["power", "appSwitch", "back"] as const) {
      expect(buttonTool.services({ udid: deviceUdid, button })).toEqual({});
    }
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
