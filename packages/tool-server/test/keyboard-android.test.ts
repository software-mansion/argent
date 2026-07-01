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

  it("maps `delete` to backspace (KEYCODE_DEL), matching iOS and the HID vocabulary", () => {
    // NAMED_KEYS (key-codes.ts) gives both `backspace` and `delete` HID usage 42
    // (Keyboard DELETE/Backspace), and iOS types `delete` as a backspace — so a
    // named key means the same thing on every platform. Android must therefore map
    // `delete` to KEYCODE_DEL (67, backspace), NOT KEYCODE_FORWARD_DEL (112).
    expect(ANDROID_NAMED_KEYCODES.delete).toBe(67);
    expect(ANDROID_NAMED_KEYCODES.delete).toBe(ANDROID_NAMED_KEYCODES.backspace);
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

describe("android-input — `%` types verbatim (no `%s`→space corruption)", () => {
  // `adb input text`'s InputShellCommand.sendText rewrites `%s`→space and does NOT
  // unescape `%%`, so a single `input text` corrupts `%`-bearing input. We split so
  // every `%` ends a segment (one `input text` per segment) — a `%` is then never
  // immediately followed by `s` on the device, and the segments re-join verbatim.
  it("splits `100%safe` so `%` never precedes `s` at the device boundary", async () => {
    adbShell.mockClear();
    await injectAndroidText(SERIAL, "100%safe");
    expect(adbShell.mock.calls.map((c) => c[1])).toEqual([
      "input text '100%'",
      "input text 'safe'",
    ]);
  });

  it("types the literal sequence `%s` instead of a space", async () => {
    adbShell.mockClear();
    await injectAndroidText(SERIAL, "%s");
    expect(adbShell.mock.calls.map((c) => c[1])).toEqual(["input text '%'", "input text 's'"]);
  });

  it("does not collapse `%%`", async () => {
    adbShell.mockClear();
    await injectAndroidText(SERIAL, "%%");
    expect(adbShell.mock.calls.map((c) => c[1])).toEqual(["input text '%'", "input text '%'"]);
  });

  it("keeps a trailing `%` in its own segment (`50% off`)", async () => {
    adbShell.mockClear();
    await injectAndroidText(SERIAL, "50% off");
    expect(adbShell.mock.calls.map((c) => c[1])).toEqual(["input text '50%'", "input text ' off'"]);
  });

  it("uses a single `input text` for `%`-free text", async () => {
    adbShell.mockClear();
    await injectAndroidText(SERIAL, "hello world");
    expect(adbShell.mock.calls.map((c) => c[1])).toEqual(["input text 'hello world'"]);
  });
});

describe("android-input — shell-metachar safety (single quoted argv token)", () => {
  // shellQuote wraps the text in single quotes so the device's /bin/sh treats it
  // as one inert token — quotes / `&` / `$(...)` / backticks never execute.
  it.each([
    ["single quotes", "o'brien", "input text 'o'\\''brien'"],
    ["ampersand", "a&b && c", "input text 'a&b && c'"],
    ["command substitution", "$(id) `id`", "input text '$(id) `id`'"],
    ["redirect / pipe / glob", "a | b > c *", "input text 'a | b > c *'"],
  ])("quotes %s so the device shell can't interpret it", async (_label, text, expected) => {
    adbShell.mockClear();
    await injectAndroidText(SERIAL, text);
    expect(adbShell.mock.calls.map((c) => c[1])).toEqual([expected]);
  });
});

describe("android-input — rejects text `adb input text` can't type", () => {
  it("rejects emoji with a clear error naming the character", async () => {
    await expect(injectAndroidText(SERIAL, "hi 😀")).rejects.toThrow(/😀/);
    await expect(injectAndroidText(SERIAL, "hi 😀")).rejects.toThrow(/printable ASCII/);
  });

  it("rejects accented / non-ASCII letters (silently dropped by input text)", async () => {
    await expect(injectAndroidText(SERIAL, "café")).rejects.toThrow(/é/);
  });

  it("does not shell out at all when the text is rejected", async () => {
    adbShell.mockClear();
    await expect(injectAndroidText(SERIAL, "😀")).rejects.toThrow();
    expect(adbShell).not.toHaveBeenCalled();
  });

  it("still accepts the full printable-ASCII range (letters, digits, punctuation)", () => {
    expect(() =>
      assertTypeableAndroidText("hello WORLD 123 !@#$%^&*()_+-=[]{};:'\",.<>/?`~|\\")
    ).not.toThrow();
  });
});
