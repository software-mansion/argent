import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  Registry,
  FAILURE_CODES,
  FailureError,
  getFailureSignal,
  subprocessFailureMetadata,
  type DeviceInfo,
} from "@argent/registry";

// Capture the adb command strings instead of shelling out to a real device.
// Keep `shellQuote` real (android-input relies on it) — only stub the transport
// and the `isAndroidTv` runtime probe (so the phone/TV branch is deterministic).
// `vi.hoisted` so the mock fns exist when the hoisted `vi.mock` factory runs.
const { adbShell, isAndroidTv, getAndroidRuntimeKind } = vi.hoisted(() => ({
  // Typed params so `adbShell.mock.calls[0]` is a `[serial, cmd, opts?]` tuple
  // (an untyped `vi.fn(async () => "")` infers a zero-arg call and TS2493s on
  // destructuring — vitest transforms tests with esbuild, so only `tsc` catches it).
  adbShell: vi.fn(async (_serial: string, _cmd: string, _opts?: unknown): Promise<string> => ""),
  isAndroidTv: vi.fn(async (_serial: string): Promise<boolean> => false),
  // The keyboard branch reads the kind three-valued (`undefined` = "could not
  // tell"), so an indeterminate probe cannot fall through to the phone path and
  // burst 200 delete keys at a TV. Kept in step with `isAndroidTv` so the
  // existing cases still say what they meant.
  getAndroidRuntimeKind: vi.fn(
    async (_serial: string): Promise<"mobile" | "tv" | undefined> => "mobile"
  ),
}));
vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  adbShell,
  isAndroidTv,
  getAndroidRuntimeKind,
}));

// Stub the TV backend so the routing test can prove a TV target goes here and a
// phone target does not, without driving the real focus daemon.
// Typed params, so `typeTv.mock.calls[0]` is a `[registry, device, params]`
// tuple — an untyped `vi.fn(async () => …)` infers a zero-arg call and TS2493s
// on the index (vitest transforms tests with esbuild, so only `tsc` catches it).
const { typeTv } = vi.hoisted(() => ({
  typeTv: vi.fn(
    async (
      _registry: unknown,
      _device: unknown,
      _params: Record<string, unknown>
    ): Promise<{ typed: string; keys: number }> => ({ typed: "TV", keys: 0 })
  ),
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
  ADB_CLEAR_TIMEOUT_MS,
  injectAndroidClear,
  injectAndroidText,
  injectAndroidNamedKey,
} from "../src/utils/android-input";
import { CLEAR_KEY_PAIRS, NAMED_KEYS } from "../src/tools/keyboard/key-codes";
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

  it("types the text's case verbatim (no fold at the `input text` sink)", async () => {
    // No other fixture carries an uppercase letter INTO `injectAndroidText`.
    // The two that are not all-lowercase reach it by neither route: "ENTER"
    // goes to `injectAndroidNamedKey`, which folds case deliberately, and
    // "hello WORLD 123 …" calls `assertTypeableAndroidText` on its own. So a
    // `toLowerCase()` slip inside `injectAndroidText` — after the assert, where
    // a shared normalise with the sibling `injectAndroidNamedKey`'s fold would
    // land — was green against the whole suite.
    // Nothing downstream guarantees case either: `shellQuote` only quotes and
    // `assertTypeableAndroidText` accepts A-Z untouched, so the mirror-image
    // `toUpperCase()` is the only direction that was red.
    //
    // `typed` echoes `params.text` rather than reading the device
    // (platforms/android.ts:46), so a case regression answers
    // `{ typed: "Passw0rd!", keys: 9 }` while the field holds `passw0rd!` —
    // success to every consumer, android-only, and exactly where case-sensitive
    // login fields and `{{secret:…}}` injection land.
    adbShell.mockClear();
    await injectAndroidText(SERIAL, "Passw0rd!");
    expect(adbShell.mock.calls.map((c) => c[1])).toEqual(["input text 'Passw0rd!'"]);
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

  it("presses each named key with its own keycode (not one hardcoded value)", async () => {
    // The map's literal values are pinned above; this pins that the lookup
    // READS the map, for every entry in it, and that the resolved code reaches
    // the wire. The other injection tests only ever press `enter` and
    // `backspace`, so a lookup that mistyped one of the other 22 names — the
    // realistic lookup/switch refactor slip — is green everywhere except here.
    for (const [name, keycode] of Object.entries(ANDROID_NAMED_KEYCODES)) {
      adbShell.mockClear();
      await injectAndroidNamedKey(SERIAL, name);
      expect(
        adbShell.mock.calls.map((c) => c[1]),
        `wrong keycode for "${name}"`
      ).toEqual([`input keyevent ${keycode}`]);
    }
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
    // The NAME is part of the contract: it is what a caller needs to retry, and
    // a bare `/Unknown key/` prefix left stripping it green in this file.
    await expect(injectAndroidNamedKey(SERIAL, "nope")).rejects.toThrow(/Unknown key "nope"/);
    await expect(injectAndroidNamedKey(SERIAL, "nope")).rejects.toBeInstanceOf(
      InvalidToolInputError
    );
  });

  it("rejects newlines as invalid input (→ HTTP 400) rather than silently truncating", () => {
    expect(() => assertTypeableAndroidText("line1\nline2")).toThrow(/newline/);
    expect(() => assertTypeableAndroidText("line1\nline2")).toThrow(InvalidToolInputError);
    expect(() => assertTypeableAndroidText("ok")).not.toThrow();
  });

  it("rejects a prototype-chain key name as an unknown key, issuing no adb call", async () => {
    // `key` is a free string, so a lookup on the plain keycode object would let
    // `Object.prototype` members through: `ANDROID_NAMED_KEYCODES["constructor"]`
    // is a function (not nullish), so without an own-property guard it would
    // shell out `input keyevent <garbage>` (a 500) instead of a clean 400.
    adbShell.mockClear();
    for (const proto of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      await expect(injectAndroidNamedKey(SERIAL, proto)).rejects.toBeInstanceOf(
        InvalidToolInputError
      );
    }
    expect(adbShell).not.toHaveBeenCalled();
  });
});

// The `clear` burst. It is the one injection whose exact argv IS the contract:
// the design turns on it being plain `input keyevent` (never `keycombination`),
// on both delete directions being present, and on the whole burst travelling in
// ONE invocation.
describe("android-input — the `clear` key burst", () => {
  it("sends CLEAR_KEY_PAIRS × (KEYCODE_DEL, KEYCODE_FORWARD_DEL) in one `input keyevent`", async () => {
    adbShell.mockClear();
    await injectAndroidClear(SERIAL);

    // ONE call. `input` boots an app-process VM per invocation (~0.2s), so a
    // per-key loop would take a minute and — measured on a busy Flutter field —
    // back the input queue up for 5-8s. The whole burst is one command line.
    expect(adbShell).toHaveBeenCalledTimes(1);
    const [serial, cmd] = adbShell.mock.calls[0]!;
    expect(serial).toBe(SERIAL);
    // Literal keycodes, not the constants: 67 is KEYCODE_DEL (backspace) and
    // 112 is KEYCODE_FORWARD_DEL, and reading them back out of a map under test
    // would be satisfied by whatever that map happens to hold.
    const expected = `input keyevent ${Array.from({ length: CLEAR_KEY_PAIRS }, () => "67 112").join(" ")}`;
    expect(cmd).toBe(expected);
  });

  it("interleaves the two directions rather than sending 100 of each in turn", async () => {
    // Order is load-bearing, and a burst of 100 backspaces followed by 100
    // forward-deletes passes a count-only assertion. With the caret in the
    // middle of a field, the interleaved form empties it from both sides at
    // once; the grouped form deletes everything behind the caret and only then
    // starts ahead of it — identical for a short field, and identical again for
    // a field short enough to fit twice over, which is every fixture. It
    // diverges exactly at the documented boundary: a field with more than 100
    // characters on ONE side keeps text the interleaved burst would have taken.
    adbShell.mockClear();
    await injectAndroidClear(SERIAL);
    const codes = adbShell.mock.calls[0]![1].replace("input keyevent ", "").split(" ");
    expect(codes.length).toBe(CLEAR_KEY_PAIRS * 2);
    expect(codes.slice(0, 6)).toEqual(["67", "112", "67", "112", "67", "112"]);
    expect(codes.filter((c) => c === "67").length).toBe(CLEAR_KEY_PAIRS);
    expect(codes.filter((c) => c === "112").length).toBe(CLEAR_KEY_PAIRS);
  });

  it("uses no `keycombination` and holds no modifier", async () => {
    // The whole reason this design exists. `input keycombination 113 29`
    // (Ctrl+A) is swallowed outright by Flutter on Android — the trailing DEL
    // then removes ONE character — is intermittently missed by React Native
    // (#821), and carries no metaState at all on API 31/32, where
    // `TextView.onKeyShortcut` therefore never fires. A select-all that can
    // silently no-op is what forced the read-backs, length measurement and
    // budgets this replaces, so its absence is pinned rather than assumed.
    adbShell.mockClear();
    await injectAndroidClear(SERIAL);
    const cmd = adbShell.mock.calls[0]![1];
    expect(cmd).not.toMatch(/keycombination/);
    expect(cmd).toMatch(/^input keyevent [0-9 ]+$/);
    // KEYCODE_CTRL_LEFT (113) and KEYCODE_MOVE_END (123) are the two codes the
    // chord variants used; neither may appear.
    const codes = cmd.replace("input keyevent ", "").split(" ");
    expect(codes).not.toContain("113");
    expect(codes).not.toContain("123");
  });

  it("surfaces an adb failure instead of reporting a clear that never landed", async () => {
    adbShell.mockClear();
    adbShell.mockRejectedValueOnce(new Error("adb: device offline"));
    await expect(injectAndroidClear(SERIAL)).rejects.toThrow(/device offline/);
  });

  it("says the field may be PARTIALLY emptied, under its own code", async () => {
    // The burst is one command carrying 200 injections, and it is not atomic: a
    // command killed partway leaves the field emptied by however many pairs got
    // through. "adb command failed" reads as "nothing happened", after which an
    // agent types over a field that is now half its old length.
    adbShell.mockClear();
    adbShell.mockRejectedValueOnce(
      new Error("Command failed: adb ... (killed=true signal=SIGKILL)")
    );
    const err = await injectAndroidClear(SERIAL).then(
      () => {
        throw new Error("expected the clear to reject, but it resolved");
      },
      (e: unknown) => e as Error
    );
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.KEYBOARD_CLEAR_UNCONFIRMED);
    expect(err.message).toMatch(/PARTIALLY emptied/);
    expect(err.message).toMatch(/Read the field back/);
  });

  it("does not repeat the 200 keycodes into the caller's context", async () => {
    // `formatSubprocessFailure` puts the whole command line in the message and
    // node's own nested `Command failed:` puts it there again — ~1.5KB of
    // keycodes, twice, straight into an agent transcript and the event log.
    adbShell.mockClear();
    const codes = Array.from({ length: CLEAR_KEY_PAIRS }, () => "67 112").join(" ");
    adbShell.mockRejectedValueOnce(
      new Error(`adb -s ${SERIAL} shell input keyevent ${codes} failed: Command failed: adb`)
    );
    const err = await injectAndroidClear(SERIAL).then(
      () => {
        throw new Error("expected the clear to reject, but it resolved");
      },
      (e: unknown) => e as Error
    );
    expect(err.message).not.toMatch(/67 112 67/);
    expect(err.message.length).toBeLessThan(600);
  });

  it("gets a budget sized for 200 blocking injections, not for one", async () => {
    // `input` injects with INJECT_INPUT_EVENT_MODE_WAIT_FOR_FINISH, so the adb
    // child blocks on the app once per event: the burst's cost is the app's
    // per-keystroke cost times 200, not one VM start. Measured on a Pixel 7 AVD
    // (API 36) against a debug Flutter field: 14.9s idle — already at the 15s
    // single-injection budget — and 16.3s under light guest load, where adb was
    // SIGKILLed with the field emptied from 300 characters to 200.
    adbShell.mockClear();
    await injectAndroidClear(SERIAL);
    const opts = adbShell.mock.calls[0]![2] as { timeoutMs?: number } | undefined;
    // Pinned outright, not just bracketed: a range of 60s-300s admits every
    // value anyone would plausibly set, so it could only ever catch a wholesale
    // mistake. The number is a measured decision.
    expect(ADB_CLEAR_TIMEOUT_MS).toBe(90_000);
    expect(opts?.timeoutMs).toBe(ADB_CLEAR_TIMEOUT_MS);
    expect(opts?.timeoutMs).toBeGreaterThanOrEqual(60_000);
    // ...and still bounded, so a hung adb child cannot wedge the tool-server.
    expect(opts?.timeoutMs).toBeLessThanOrEqual(300_000);
  });

  it("sends the SAME keycode `backspace` names, so the two cannot drift apart", async () => {
    // The burst's backward half is read from ANDROID_NAMED_KEYCODES rather than
    // redeclared, so a change to the named key reaches the burst too.
    adbShell.mockClear();
    await injectAndroidClear(SERIAL);
    const codes = adbShell.mock.calls[0]![1].replace("input keyevent ", "").split(" ");
    expect(codes[0]).toBe(String(ANDROID_NAMED_KEYCODES.backspace));
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
    // `mockReset`, not `mockClear`: several tests below queue one-shot values
    // (`mockResolvedValueOnce` / `mockRejectedValueOnce`) to drive the failure
    // paths, and `mockClear` empties `mock.calls` WITHOUT dropping an
    // unconsumed queue entry. Every entry happens to be consumed today, so a
    // leak is invisible — until one of those tests fails early, at which point
    // its leftover rejection would surface in an unrelated test and hide the
    // real failure. `mockReset` also restores the `async () => ""` given to
    // `vi.fn`, so the default transport still resolves. Matches `isAndroidTv`
    // on the next line.
    adbShell.mockReset();
    typeTv.mockClear();
    isAndroidTv.mockReset();
    getAndroidRuntimeKind.mockReset();
    isAndroidTv.mockResolvedValue(false);
    getAndroidRuntimeKind.mockResolvedValue("mobile");
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
    getAndroidRuntimeKind.mockResolvedValue("tv");
    const sentinel = { typed: "TV", keys: 0 };
    typeTv.mockResolvedValue(sentinel);
    const res = await impl.handler({}, { udid: SERIAL, text: "hi" } as KeyboardParams, phone);
    expect(res).toBe(sentinel);
    // Phone injection must not fire for a TV target.
    expect(adbShell).not.toHaveBeenCalled();
  });

  it("routes a CLEAR on an android TV target to typeTv, firing no keyevent burst", async () => {
    // Correct today by composition — the phone path's clear early-return sits
    // below the `isAndroidTv` probe — but nothing observed it as a ROUTE, so
    // hoisting that early-return above the probe would fire 200 keyevents at a
    // TV with the whole suite green. `typeTv` is module-mocked here, so its own
    // refusal cannot stand in for the routing.
    isAndroidTv.mockResolvedValue(true);
    getAndroidRuntimeKind.mockResolvedValue("tv");
    // A neutral sentinel, not a message this test wrote itself: asserting the
    // rejection text against a string the mock was just handed only proves the
    // mock. What is being pinned is the ROUTE — that the request reached
    // `typeTv` with the clear intact, and that nothing was injected. `typeTv`'s
    // own refusal wording is pinned in keyboard-tv.test.ts, against the real
    // implementation.
    const refusal = new Error("routed-to-typeTv");
    typeTv.mockRejectedValue(refusal);
    await expect(
      impl.handler({}, { udid: SERIAL, clear: true } as KeyboardParams, phone)
    ).rejects.toBe(refusal);
    expect(typeTv).toHaveBeenCalledTimes(1);
    expect(typeTv.mock.calls[0]![2]).toMatchObject({ clear: true });
    expect(adbShell).not.toHaveBeenCalled();
  });

  it("treats `{ clear: false }` as an omitted clear on the phone path", async () => {
    // `clear` is a switch, not a payload: `false` means what omitting it means.
    // A backend written over presence (`params.clear !== undefined`) — the
    // natural symmetry with `text` — would fire the burst here.
    const res = await impl.handler({}, { udid: SERIAL, clear: false } as KeyboardParams, phone);
    expect(res).toEqual({ typed: "", keys: 0 });
    expect(adbShell).not.toHaveBeenCalled();
  });

  it("reports `keys` as the literal 200 the tool description promises callers", async () => {
    // Not `CLEAR_KEY_PAIRS * 2`: every other assertion in the suite imports the
    // constant, so setting it to 3 leaves them all green — while "100
    // backspaces... 100 forward-deletes" and "`keys` is 200" are caller-facing
    // contract in the parameter description, the tool description, the
    // run-sequence table and the docs.
    const res = await impl.handler({}, { udid: SERIAL, clear: true } as KeyboardParams, phone);
    expect(res).toEqual({ typed: "", keys: 200, cleared: true });
    const codes = adbShell.mock.calls[0]![1].replace("input keyevent ", "").split(" ");
    expect(codes.length).toBe(200);
  });

  it("no-ops on an empty request (neither key nor text): { typed:'', keys:0 }, zero adb", async () => {
    // The tool's rule on `text`/`key` is at-most-one, not exactly-one, so an
    // empty request stays a silent no-op returning { typed:"", keys:0 } and
    // issuing no adb call — the same contract every keyboard backend
    // (simulator-server, tv, vega) follows. Pin it so a future change to that
    // behaviour (e.g. making it throw) is a deliberate, visible edit rather than
    // an unnoticed drift.
    const res = await impl.handler({}, { udid: SERIAL } as KeyboardParams, phone);
    expect(res).toEqual({ typed: "", keys: 0 });
    expect(adbShell).not.toHaveBeenCalled();
  });

  it("counts a named key as 1 and returns it as `typed` when no text is given", async () => {
    const res = await impl.handler({}, { udid: SERIAL, key: "enter" } as KeyboardParams, phone);
    expect(res).toEqual({ typed: "enter", keys: 1 });
    expect(adbShell).toHaveBeenCalledWith(SERIAL, "input keyevent 66", expect.anything());
  });

  it("counts every codepoint of `%`-split text, across all its segments", async () => {
    // `%`-bearing text becomes one `input text` per segment, so `keys` is the
    // one value that can silently become a per-segment count instead of a
    // per-character one. The split itself is pinned above, against
    // `injectAndroidText`; this is the backend's arithmetic over it.
    adbShell.mockClear();
    const res = await impl.handler({}, { udid: SERIAL, text: "100%safe" } as KeyboardParams, phone);
    expect(adbShell.mock.calls.map((c) => c[1])).toEqual([
      "input text '100%'",
      "input text 'safe'",
    ]);
    expect(res).toEqual({ typed: "100%safe", keys: 8 });
  });

  it("returns { typed:'', cleared: true } for a clear, and types nothing", async () => {
    // `typed: ""` because nothing was typed — echoing anything else would put a
    // value in the result of a call whose whole point is that the field's
    // contents are unknown (and may have been a secret). `keys` counts what was
    // SENT: two key events per pair.
    //
    // Written against the CONSTANT on purpose, and titled that way: the literal
    // 200 that reaches callers is pinned once, in "reports `keys` as the literal
    // 200 the tool description promises callers" below. A title promising a
    // number this assertion does not check would leave a test NAMED 200 green
    // for a constant set to 3.
    adbShell.mockClear();
    const res = await impl.handler({}, { udid: SERIAL, clear: true } as KeyboardParams, phone);
    expect(res).toEqual({ typed: "", keys: CLEAR_KEY_PAIRS * 2, cleared: true });
    // One `input keyevent`, and no `input text` — a clear must never type.
    expect(adbShell.mock.calls.map((c) => c[1].split(" ")[1])).toEqual(["keyevent"]);
  });

  it.each([
    ["clear", { clear: true }, /burst 200 delete keys/],
    ["key", { key: "backspace" }, /a named key is navigation on a TV/],
  ])("refuses %s when the form factor could not be determined", async (_label, extra, reason) => {
    // `readRuntimeKind` answers undefined when `pm list features` misses its 5s
    // budget and `ro.build.characteristics` carries no `tv` token — which is
    // what the Google ATV emulator reports (`emulator`). Collapsed to `false` by
    // `isAndroidTv`, that aimed the 200-key burst at a TV, the one thing
    // platforms/tv.ts exists to refuse, and `undefined` is never cached so every
    // call was exposed.
    adbShell.mockClear();
    getAndroidRuntimeKind.mockResolvedValue(undefined);
    const err = await impl.handler({}, { udid: SERIAL, ...extra } as KeyboardParams, phone).then(
      () => undefined,
      (e: unknown) => e as Error
    );
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.KEYBOARD_TARGET_KIND_UNKNOWN);
    // The justification is templated with the field name, not only the name: a
    // refused `{ key: "backspace" }` used to be told the request would have
    // burst 200 delete keys, which is the other request's reason.
    expect(err?.message).toMatch(reason);
    // Not "timeout": the same undefined comes back for a serial that is not in
    // the `device` state, where no probe ran at all.
    expect(getFailureSignal(err)?.error_kind).toBe("not_found");
    // Nothing reached the device.
    expect(adbShell).not.toHaveBeenCalled();
    // It re-probes once first: an indeterminate verdict is not cached, so a
    // probe that timed out under a load spike usually resolves on the retry.
    expect(getAndroidRuntimeKind).toHaveBeenCalledTimes(2);
    getAndroidRuntimeKind.mockResolvedValue("mobile");
  });

  it("still types `text` when the form factor could not be determined", async () => {
    // The positive control, and the reason the guard is per shape: on Android TV
    // `TvControlApi.type` IS `adb shell input text`, the same channel the phone
    // path uses, so an unknown kind changes nothing for `text`.
    adbShell.mockClear();
    getAndroidRuntimeKind.mockResolvedValue(undefined);
    const res = await impl.handler({}, { udid: SERIAL, text: "hi" } as KeyboardParams, phone);
    expect(res).toEqual({ typed: "hi", keys: 2 });
    expect(adbShell.mock.calls.map((c) => c[1])).toEqual(["input text 'hi'"]);
    // And no re-probe was paid for a shape that does not need the answer.
    expect(getAndroidRuntimeKind).toHaveBeenCalledTimes(1);
    getAndroidRuntimeKind.mockResolvedValue("mobile");
  });

  it("hands the request's abort signal to the clear burst", async () => {
    // The burst is ONE `adb shell input keyevent <200 codes>` under a 90s
    // budget, so without a signal an abandoned call blocked for that whole
    // budget and nothing killed the adb child. Measured on an API 36 emulator
    // against a 100-character native EditText: a client gone at 150ms now
    // leaves the field byte-identical (the command had not reached the guest).
    // Once on-device `input` is running the guest finishes it — the abort kills
    // the host-side client, not the injection — which is why the wording says
    // "may be PARTIALLY emptied".
    adbShell.mockClear();
    const controller = new AbortController();
    await impl.handler({}, { udid: SERIAL, clear: true } as KeyboardParams, phone, {
      signal: controller.signal,
    });
    const opts = adbShell.mock.calls[0]![2] as { signal?: AbortSignal } | undefined;
    expect(opts?.signal).toBe(controller.signal);
  });

  it("clears without a `text`/`key` value present, and does not fall through to typing", async () => {
    // The clear branch returns early. Without that early return the `typed`
    // arithmetic below it runs on an empty request and answers
    // `{ typed: "", keys: 0 }` — a success shape indistinguishable from the
    // documented no-op, for a call that did send 200 keys.
    adbShell.mockClear();
    const res = await impl.handler({}, { udid: SERIAL, clear: true } as KeyboardParams, phone);
    expect(res.keys).toBe(CLEAR_KEY_PAIRS * 2);
    expect(adbShell).toHaveBeenCalledTimes(1);
  });

  it("treats `clear: false` as absent, injecting nothing", async () => {
    // `clear` is a switch: `false` reads as omitted, both in the tool's guard
    // and here. A backend branching on presence would burst 200 delete keys
    // into the focused field for a request that explicitly asked for no clear.
    adbShell.mockClear();
    const res = await impl.handler({}, { udid: SERIAL, clear: false } as KeyboardParams, phone);
    expect(res).toEqual({ typed: "", keys: 0 });
    expect(adbShell).not.toHaveBeenCalled();
  });

  it("surfaces an adb failure during a clear (no silent success)", async () => {
    adbShell.mockClear();
    adbShell.mockRejectedValueOnce(new Error("adb: device offline"));
    await expect(
      impl.handler({}, { udid: SERIAL, clear: true } as KeyboardParams, phone)
    ).rejects.toThrow(/device offline/);
  });

  it.each([
    ["a device adb cannot reach", "adb: device 'emulator-5554' not found"],
    ["a device that went offline", "adb: device offline"],
    ["an unauthorized device", "adb: device unauthorized"],
  ])("does not claim a partial clear for %s", async (_label, adbMessage) => {
    // The adb CLIENT prints these before it delivers anything, so no event
    // reached the guest and the field is untouched. "may be PARTIALLY emptied"
    // is the leading, authoritative sentence — an agent that believes it
    // re-reads a field that never changed, with a `describe` that fails on the
    // same dead device.
    adbShell.mockClear();
    adbShell.mockRejectedValueOnce(new Error(adbMessage));
    const err = await impl.handler({}, { udid: SERIAL, clear: true } as KeyboardParams, phone).then(
      () => undefined,
      (e: unknown) => e as Error
    );
    expect(err?.message).toMatch(/NO delete key was sent/);
    expect(err?.message).not.toMatch(/PARTIALLY emptied/);
    // And the repair points at the device, not at a field read that would fail
    // on the same device.
    expect(err?.message).toMatch(/list-devices/);
    expect(err?.message).not.toMatch(/Read the field back/);
  });

  it("does not claim a partial clear for a burst the abort stopped before it was sent", async () => {
    // The one case the code can PROVE: Node's `execFile` with an ALREADY-aborted
    // signal never spawns the child and rejects with `code: "ABORT_ERR"`, which
    // is not a spawn failure and matches no adb client refusal — so the helper
    // written to prevent exactly this inversion answered "delivered". Confirmed
    // on a real API 36 emulator through the real registry with a pre-aborted
    // signal: "the focused field may be PARTIALLY emptied", for a command adb
    // never started.
    adbShell.mockClear();
    adbShell.mockImplementationOnce(async () => {
      throw Object.assign(new Error("The operation was aborted"), { code: "ABORT_ERR" });
    });
    const controller = new AbortController();
    controller.abort();
    const err = await impl
      .handler({}, { udid: SERIAL, clear: true } as KeyboardParams, phone, {
        signal: controller.signal,
      })
      .then(
        () => undefined,
        (e: unknown) => e as Error
      );
    expect(err?.message).toMatch(/cancelled before it was sent/);
    expect(err?.message).not.toMatch(/PARTIALLY emptied/);
    expect(err?.message).not.toMatch(/Read the field back/);
  });

  it("still claims a partial clear when the abort arrives after the child started", async () => {
    // The positive control for the branch above: an abort during the run kills a
    // child that was already delivering, so the field may well be half empty.
    adbShell.mockClear();
    const controller = new AbortController();
    adbShell.mockImplementationOnce(async () => {
      controller.abort();
      throw Object.assign(new Error("The operation was aborted"), { code: "ABORT_ERR" });
    });
    const err = await impl
      .handler({}, { udid: SERIAL, clear: true } as KeyboardParams, phone, {
        signal: controller.signal,
      })
      .then(
        () => undefined,
        (e: unknown) => e as Error
      );
    expect(err?.message).toMatch(/PARTIALLY emptied/);
  });

  it("still claims a partial clear for a burst that was cut short", async () => {
    // The positive control: `input` was running on the guest and stopped
    // partway, which is what the 90s cap's SIGKILL produces. Measured on an API
    // 36 emulator by killing the adb child 700ms in.
    adbShell.mockClear();
    adbShell.mockRejectedValueOnce(
      Object.assign(new Error("adb: killed by signal"), { signal: "SIGKILL" })
    );
    const err = await impl.handler({}, { udid: SERIAL, clear: true } as KeyboardParams, phone).then(
      () => undefined,
      (e: unknown) => e as Error
    );
    expect(err?.message).toMatch(/PARTIALLY emptied/);
    expect(err?.message).toMatch(/Read the field back/);
  });

  it("keeps the subprocess telemetry every other adb re-statement keeps", async () => {
    // `failure_exit_code` and `failure_signal` must survive the re-statement,
    // including the SIGKILL from the 90s cap that this budget exists to bound.
    //
    // The rejection is shaped as PRODUCTION shapes it: `adbShell` goes through
    // `runAdb`, which throws an already-wrapped `FailureError` carrying its
    // signal behind a symbol. A raw `execFile` error here would let a
    // re-statement that reads own `.code` / `.signal` properties pass, and
    // against the real adb that re-statement recovers nothing.
    adbShell.mockClear();
    const raw = Object.assign(new Error("adb: killed"), { code: null, signal: "SIGKILL" });
    adbShell.mockRejectedValueOnce(
      new FailureError("adb -s emulator-5554 shell input keyevent … failed: adb: killed", {
        error_code: FAILURE_CODES.ANDROID_ADB_COMMAND_FAILED,
        failure_stage: "android_adb_command",
        failure_area: "tool_server",
        error_kind: "timeout",
        ...subprocessFailureMetadata(raw, "adb"),
      })
    );
    const err = await impl.handler({}, { udid: SERIAL, clear: true } as KeyboardParams, phone).then(
      () => undefined,
      (e: unknown) => e as Error
    );
    const signal = getFailureSignal(err);
    expect(signal?.error_code).toBe(FAILURE_CODES.KEYBOARD_CLEAR_UNCONFIRMED);
    expect(signal?.failure_command).toBe("adb");
    expect(signal?.failure_signal).toBe("SIGKILL");
    // And still no `cause`: the message chain reaches agent context, and the adb
    // error quotes the whole 200-keycode command line that `firstLine` exists to
    // strip. The metadata is what carries the diagnosis.
    expect((err as Error & { cause?: Error }).cause).toBeUndefined();
    expect(err?.message).not.toMatch(/67 112 67 112/);
  });

  it("presses the key it was asked for, not a hardcoded Enter", async () => {
    // Every other named-key assertion on this backend uses `key:"enter"`, so a
    // path that ignored `params.key` and always pressed Enter would pass them
    // all. `backspace` (67) is a second, distinct literal, so no single fixed
    // keycode satisfies both. keyboard-backend-fidelity.test.ts holds the same
    // property for the other three backends; android's lives here because its
    // transport is a command line rather than an event stream.
    adbShell.mockClear();
    const res = await impl.handler({}, { udid: SERIAL, key: "backspace" } as KeyboardParams, phone);
    expect(adbShell.mock.calls.map((c) => c[1])).toEqual(["input keyevent 67"]);
    expect(res).toEqual({ typed: "backspace", keys: 1 });
  });

  it("rejects un-typeable text with NO on-device side effect", async () => {
    // Android checks the whole string up front (unlike the iOS simulator and
    // Chromium, which reject mid-string and leave a prefix), so a rejected
    // request must leave the field byte-identical — the tool description says
    // exactly that, and a per-segment check would break it without changing any
    // success shape.
    adbShell.mockClear();
    await expect(
      impl.handler({}, { udid: SERIAL, text: "café" } as KeyboardParams, phone)
    ).rejects.toBeInstanceOf(InvalidToolInputError);
    expect(adbShell).not.toHaveBeenCalled();
  });

  it("surfaces an adb transport failure as a throw (no silent success — the #449 fix)", async () => {
    // The whole point of moving off the fire-and-forget HID transport: a failed
    // inject must propagate, not resolve `{ typed }` while nothing was typed.
    adbShell.mockClear();
    adbShell.mockRejectedValueOnce(new Error("adb: device offline"));
    await expect(
      impl.handler({}, { udid: SERIAL, text: "hi" } as KeyboardParams, phone)
    ).rejects.toThrow(/device offline/);
  });
});

// The routing/injection tests above call `makeAndroidImpl().handler` directly,
// which bypasses `dispatchByPlatform`'s host-binary preflight — so nothing there
// pins the `requires: ["adb"]` on the android branch. Drive the tool's real
// `execute` (which IS `dispatchByPlatform`) so removing that declaration is a red
// test rather than a silent regression to a deep ENOENT on an adb-less host.
describe("keyboard tool — android adb preflight (via dispatchByPlatform)", () => {
  beforeEach(() => {
    // Same reason as the describe above — this one also has to survive a
    // one-shot value left behind by the last test to run there.
    adbShell.mockReset();
    ensureDeps.mockClear();
    ensureDeps.mockResolvedValue(undefined);
    isAndroidTv.mockReset();
    getAndroidRuntimeKind.mockReset();
    isAndroidTv.mockResolvedValue(false);
    getAndroidRuntimeKind.mockResolvedValue("mobile");
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
