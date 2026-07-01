import { describe, it, expect, vi } from "vitest";

// Capture the adb command strings instead of shelling out to a real device.
// Keep `shellQuote` real (android-input relies on it) — only stub the transport.
// `vi.hoisted` so the mock fn exists when the hoisted `vi.mock` factory runs.
const { adbShell } = vi.hoisted(() => ({
  // Typed params so `adbShell.mock.calls[0]` is a `[serial, cmd, opts?]` tuple
  // (an untyped `vi.fn(async () => "")` infers a zero-arg call and TS2493s on
  // destructuring — vitest transforms tests with esbuild, so only `tsc` catches it).
  adbShell: vi.fn(async (_serial: string, _cmd: string, _opts?: unknown): Promise<string> => ""),
}));
vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  adbShell,
}));

import {
  ANDROID_NAMED_KEYCODES,
  ANDROID_BUTTON_KEYCODES,
  assertTypeableAndroidText,
  injectAndroidText,
  injectAndroidNamedKey,
} from "../src/utils/android-input";
import { NAMED_KEYS } from "../src/tools/keyboard/key-codes";

const SERIAL = "emulator-5554";

describe("android-input — keycode maps", () => {
  it("covers every keyboard NAMED_KEYS entry (adb map ⊇ HID map vocabulary)", () => {
    for (const name of Object.keys(NAMED_KEYS)) {
      expect(ANDROID_NAMED_KEYCODES[name], `missing android keycode for "${name}"`).toBeTypeOf(
        "number"
      );
    }
  });

  it("maps the button tool's Android buttons to keycodes", () => {
    // Mirror BUTTONS_BY_PLATFORM.android in tools/button/index.ts.
    for (const button of ["home", "back", "power", "volumeUp", "volumeDown", "appSwitch"]) {
      expect(ANDROID_BUTTON_KEYCODES[button], `missing keycode for "${button}"`).toBeTypeOf(
        "number"
      );
    }
    expect(ANDROID_BUTTON_KEYCODES.back).toBe(4); // KEYCODE_BACK
  });
});

describe("android-input — injection", () => {
  it("types text via `input text`, shell-quoted, spaces preserved", async () => {
    adbShell.mockClear();
    await injectAndroidText(SERIAL, "wi fi");
    expect(adbShell).toHaveBeenCalledTimes(1);
    const [serial, cmd] = adbShell.mock.calls[0]!;
    expect(serial).toBe(SERIAL);
    expect(cmd).toBe("input text 'wi fi'");
  });

  it("does not shell out for empty text", async () => {
    adbShell.mockClear();
    await injectAndroidText(SERIAL, "");
    expect(adbShell).not.toHaveBeenCalled();
  });

  it("presses a named key via `input keyevent <code>`", async () => {
    adbShell.mockClear();
    await injectAndroidNamedKey(SERIAL, "enter");
    expect(adbShell).toHaveBeenCalledWith(
      SERIAL,
      `input keyevent ${ANDROID_NAMED_KEYCODES.enter}`,
      expect.anything()
    );
  });

  it("rejects an unknown named key", async () => {
    await expect(injectAndroidNamedKey(SERIAL, "nope")).rejects.toThrow(/Unknown key/);
  });

  it("rejects newlines rather than silently truncating", () => {
    expect(() => assertTypeableAndroidText("line1\nline2")).toThrow(/newline/);
    expect(() => assertTypeableAndroidText("ok")).not.toThrow();
  });
});
