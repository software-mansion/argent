import { describe, it, expect, beforeEach, vi } from "vitest";
import { Registry, type DeviceInfo } from "@argent/registry";

// Capture the adb command strings instead of shelling out to a real device.
// Keep `shellQuote` real (android-input relies on it) — only stub the transport
// and the `isAndroidTv` runtime probe (so the phone/TV branch is deterministic).
// `vi.hoisted` so the mock fns exist when the hoisted `vi.mock` factory runs.
const { adbShell, isAndroidTv } = vi.hoisted(() => ({
  // Typed params so `adbShell.mock.calls[0]` is a `[serial, cmd, opts?]` tuple
  // (an untyped `vi.fn(async () => "")` infers a zero-arg call and TS2493s on
  // destructuring — vitest transforms tests with esbuild, so only `tsc` catches it).
  adbShell: vi.fn(async (_serial: string, _cmd: string, _opts?: unknown): Promise<string> => ""),
  isAndroidTv: vi.fn(async (_serial: string): Promise<boolean> => false),
}));
vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  adbShell,
  isAndroidTv,
}));

// Stub the TV backend so the routing test can prove a TV target goes here and a
// phone target does not, without driving the real focus daemon.
const { typeTv } = vi.hoisted(() => ({
  typeTv: vi.fn(async (): Promise<{ typed: string; keys: number }> => ({ typed: "TV", keys: 0 })),
}));
vi.mock("../src/tools/keyboard/platforms/tv", () => ({ typeTv }));

// `dispatchByPlatform` preflights the android branch's declared `requires`
// (`["adb"]`) via `ensureDeps` BEFORE the handler runs. Stub it so it resolves
// by default (this file's handler-level tests never reach it); the preflight
// test below overrides it to reject. Keep `DependencyMissingError` real via the
// spread so `instanceof` works.
const { ensureDeps } = vi.hoisted(() => ({
  ensureDeps: vi.fn(async (_deps: readonly string[]): Promise<void> => {}),
}));
vi.mock("../src/utils/check-deps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/check-deps")>()),
  ensureDeps,
}));

import {
  ANDROID_NAMED_KEYCODES,
  ANDROID_BUTTON_KEYCODES,
  assertTypeableAndroidText,
  injectAndroidText,
  injectAndroidNamedKey,
} from "../src/utils/android-input";
import { NAMED_KEYS } from "../src/tools/keyboard/key-codes";
import { InvalidToolInputError } from "../src/utils/capability";
import { makeAndroidImpl } from "../src/tools/keyboard/platforms/android";
import { createKeyboardTool } from "../src/tools/keyboard";
import { DependencyMissingError } from "../src/utils/check-deps";
import type { KeyboardParams } from "../src/tools/keyboard/types";
import { BUTTONS_BY_PLATFORM } from "../src/tools/button";

const SERIAL = "emulator-5554";

describe("android-input — keycode maps", () => {
  it("covers every keyboard NAMED_KEYS entry (adb map ⊇ HID map vocabulary)", () => {
    for (const name of Object.keys(NAMED_KEYS)) {
      expect(ANDROID_NAMED_KEYCODES[name], `missing android keycode for "${name}"`).toBeTypeOf(
        "number"
      );
    }
  });

  it("has a keycode for every button the button tool accepts on Android", () => {
    // Derive from the SOURCE set (button/index.ts) rather than a hardcoded list,
    // so adding a button to BUTTONS_BY_PLATFORM.android without a matching
    // keycode fails here — otherwise button/index.ts would inject
    // `input keyevent undefined` (the `!` assertion hides it at compile time).
    for (const button of BUTTONS_BY_PLATFORM.android) {
      expect(ANDROID_BUTTON_KEYCODES[button], `missing keycode for "${button}"`).toBeTypeOf(
        "number"
      );
    }
    expect(ANDROID_BUTTON_KEYCODES.back).toBe(4); // KEYCODE_BACK
  });

  it("pins the exact android.view.KeyEvent code for every named key (not self-referential)", () => {
    // Assert against literal keycodes, independent of the source constant, so a
    // typo or a wrong value is caught — the injection tests below compare to the
    // constant itself and would pass even if the value were wrong.
    expect(ANDROID_NAMED_KEYCODES).toEqual({
      "enter": 66,
      "return": 66,
      "escape": 111,
      "esc": 111,
      "backspace": 67,
      "delete": 67,
      "tab": 61,
      "space": 62,
      "arrow-up": 19,
      "arrow-down": 20,
      "arrow-left": 21,
      "arrow-right": 22,
      "f1": 131,
      "f2": 132,
      "f3": 133,
      "f4": 134,
      "f5": 135,
      "f6": 136,
      "f7": 137,
      "f8": 138,
      "f9": 139,
      "f10": 140,
      "f11": 141,
      "f12": 142,
    });
  });

  it("pins the exact keycode for every Android hardware button (catches swapped codes)", () => {
    // `toEqual` (exact) so e.g. swapping volumeUp/volumeDown — green under a
    // presence-only check — turns this red.
    expect(ANDROID_BUTTON_KEYCODES).toEqual({
      home: 3,
      back: 4,
      power: 26,
      volumeUp: 24,
      volumeDown: 25,
      appSwitch: 187,
    });
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

  it("case-folds the named key so uppercase input works (parity with the sim-server path)", async () => {
    // `keyboard`'s `key` is a free `z.string()` (not a lowercase enum), and the
    // sim-server backend folds case (`NAMED_KEYS[key.toLowerCase()]`), so
    // `key: "Enter"` / "ENTER" is supported cross-platform input. The android path
    // must fold it too — dropping `.toLowerCase()` here would make uppercase keys
    // 400 as "Unknown key" on android only. Assert the literal keycode so the fold
    // (ENTER → enter → KEYCODE_ENTER) is what's verified, not the constant itself.
    adbShell.mockClear();
    await injectAndroidNamedKey(SERIAL, "ENTER");
    expect(adbShell).toHaveBeenCalledWith(SERIAL, "input keyevent 66", expect.anything());
  });

  it("rejects an unknown named key as invalid input (→ HTTP 400)", async () => {
    // InvalidToolInputError (not a plain Error) so the HTTP layer maps it to 400
    // — an unknown key is a caller mistake, not an internal server fault.
    await expect(injectAndroidNamedKey(SERIAL, "nope")).rejects.toThrow(/Unknown key/);
    await expect(injectAndroidNamedKey(SERIAL, "nope")).rejects.toBeInstanceOf(
      InvalidToolInputError
    );
  });

  it("rejects newlines as invalid input (→ HTTP 400) rather than silently truncating", () => {
    expect(() => assertTypeableAndroidText("line1\nline2")).toThrow(/newline/);
    expect(() => assertTypeableAndroidText("line1\nline2")).toThrow(InvalidToolInputError);
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

  it("rejects accented / non-ASCII letters (silently dropped by input text) as HTTP-400 input", async () => {
    await expect(injectAndroidText(SERIAL, "café")).rejects.toThrow(/é/);
    // Caller input error, not a 500: must be InvalidToolInputError so `keyboard`
    // with `café` on Android returns 400, not a generic internal error.
    await expect(injectAndroidText(SERIAL, "café")).rejects.toBeInstanceOf(InvalidToolInputError);
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

  it("rejects the exact control-char edges just outside printable ASCII (DEL, low controls)", () => {
    // The printable window is [0x20, 0x7e]. Pin BOTH boundaries with the chars one
    // step past each edge, so widening the bound (e.g. `> 0x7e` → `> 0x7f`, letting
    // DEL through, or `< 0x20` → `< 0x10`, letting low controls through) fails here
    // — the accept/reject tests otherwise only use codepoints far from the edges.
    expect(() => assertTypeableAndroidText("\x7f")).toThrow(InvalidToolInputError); // DEL, one past `~`
    expect(() => assertTypeableAndroidText("\x1f")).toThrow(InvalidToolInputError); // unit-separator, one below space
    expect(() => assertTypeableAndroidText("\x00")).toThrow(InvalidToolInputError); // NUL
    // ...and the two printable edges themselves stay accepted.
    expect(() => assertTypeableAndroidText(" ")).not.toThrow(); // 0x20 (space)
    expect(() => assertTypeableAndroidText("~")).not.toThrow(); // 0x7e (tilde)
  });
});

// Exercises `makeAndroidImpl().handler` end-to-end (the piece the low-level
// helper tests above never invoke): the isAndroidTv phone-vs-TV branch, the
// `keys` count, and the `{ typed, keys }` result shape.
describe("android keyboard impl — routing, keys count, result shape", () => {
  const impl = makeAndroidImpl(new Registry());
  const phone = { id: SERIAL, platform: "android", kind: "handset" } as unknown as DeviceInfo;

  beforeEach(() => {
    adbShell.mockClear();
    typeTv.mockClear();
    isAndroidTv.mockReset();
    isAndroidTv.mockResolvedValue(false);
  });

  it("routes a non-TV android target to the adb phone path (not typeTv)", async () => {
    const res = await impl.handler({}, { udid: SERIAL, text: "hi there" } as KeyboardParams, phone);
    // `keys` = 8 codepoints; `typed` echoes the text; text goes over `input text`.
    expect(res).toEqual({ typed: "hi there", keys: 8 });
    expect(typeTv).not.toHaveBeenCalled();
    expect(adbShell).toHaveBeenCalledWith(SERIAL, "input text 'hi there'", expect.anything());
  });

  it("routes an android TV target to typeTv (focus daemon), never the phone path", async () => {
    isAndroidTv.mockResolvedValue(true);
    const sentinel = { typed: "TV", keys: 0 };
    typeTv.mockResolvedValue(sentinel);
    const res = await impl.handler({}, { udid: SERIAL, text: "hi" } as KeyboardParams, phone);
    expect(res).toBe(sentinel);
    // Phone injection must not fire for a TV target.
    expect(adbShell).not.toHaveBeenCalled();
  });

  it("no-ops on an empty request (neither key nor text): { typed:'', keys:0 }, zero adb", async () => {
    // The schema leaves both `key` and `text` optional with no refinement, so an
    // empty request is a silent no-op returning { typed:"", keys:0 } and issuing
    // no adb call — the same contract every keyboard backend (simulator-server,
    // tv, vega) follows. Pin it so a future change to that behaviour (e.g. making
    // it throw) is a deliberate, visible edit rather than an unnoticed drift.
    const res = await impl.handler({}, { udid: SERIAL } as KeyboardParams, phone);
    expect(res).toEqual({ typed: "", keys: 0 });
    expect(adbShell).not.toHaveBeenCalled();
  });

  it("counts a named key as 1 and returns it as `typed` when no text is given", async () => {
    const res = await impl.handler({}, { udid: SERIAL, key: "enter" } as KeyboardParams, phone);
    expect(res).toEqual({ typed: "enter", keys: 1 });
    expect(adbShell).toHaveBeenCalledWith(SERIAL, "input keyevent 66", expect.anything());
  });

  it("counts key + text together (1 + codepoints), emits BOTH, returns text as `typed`", async () => {
    const res = await impl.handler(
      {},
      { udid: SERIAL, key: "enter", text: "abc" } as KeyboardParams,
      phone
    );
    expect(res).toEqual({ typed: "abc", keys: 4 });
    // Assert the exact ordered sequence, not just presence: the key fires BEFORE
    // the text (source contract — press the named key, then type, matching the
    // simulator-server / vega backends). `toEqual` catches both a dropped keyevent
    // when text co-occurs AND a silent reorder to text-before-key; a `toContain`
    // pair would miss the reorder.
    const cmds = adbShell.mock.calls.map((c) => c[1]);
    expect(cmds).toEqual(["input keyevent 66", "input text 'abc'"]); // KEYCODE_ENTER, then text
  });
});

// The routing/injection tests above call `makeAndroidImpl().handler` directly,
// which bypasses `dispatchByPlatform`'s host-binary preflight — so nothing there
// pins the `requires: ["adb"]` on the android branch. Drive the tool's real
// `execute` (which IS `dispatchByPlatform`) so removing that declaration is a red
// test rather than a silent regression to a deep ENOENT on an adb-less host.
describe("keyboard tool — android adb preflight (via dispatchByPlatform)", () => {
  beforeEach(() => {
    adbShell.mockClear();
    ensureDeps.mockClear();
    ensureDeps.mockResolvedValue(undefined);
    isAndroidTv.mockReset();
    isAndroidTv.mockResolvedValue(false);
  });

  it("preflights `adb` before the handler; a missing binary fails closed as a DependencyMissingError", async () => {
    ensureDeps.mockRejectedValueOnce(
      new DependencyMissingError(["adb"], "install android-platform-tools")
    );
    const tool = createKeyboardTool(new Registry());
    await expect(tool.execute({}, { udid: SERIAL, text: "hi" })).rejects.toBeInstanceOf(
      DependencyMissingError
    );
    // The preflight ran with the android branch's declared dep...
    expect(ensureDeps).toHaveBeenCalledWith(["adb"]);
    // ...and fails closed: no `adb input` is issued when the preflight rejects.
    // (Dropping `requires: ["adb"]` skips the preflight, the handler runs, and
    //  this `input text` fires — turning the assertions above red.)
    expect(adbShell).not.toHaveBeenCalled();
  });

  it("runs the handler over adb once the preflight passes", async () => {
    const tool = createKeyboardTool(new Registry());
    await expect(tool.execute({}, { udid: SERIAL, text: "hi" })).resolves.toEqual({
      typed: "hi",
      keys: 2,
    });
    expect(ensureDeps).toHaveBeenCalledWith(["adb"]);
    expect(adbShell).toHaveBeenCalledWith(SERIAL, "input text 'hi'", expect.anything());
  });
});
