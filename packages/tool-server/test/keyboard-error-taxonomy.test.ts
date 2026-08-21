import { describe, it, expect, vi } from "vitest";
import {
  Registry,
  FAILURE_CODES,
  FailureError,
  getFailureSignal,
  type DeviceInfo,
} from "@argent/registry";
import { InvalidToolInputError } from "../src/utils/capability";
import { typeSimulatorServer } from "../src/tools/keyboard/simulator-server-keys";
import { makeChromiumImpl } from "../src/tools/keyboard/platforms/chromium";
import { vegaImpl } from "../src/tools/keyboard/platforms/vega";
import { typeTv } from "../src/tools/keyboard/platforms/tv";
import { injectVegaNamedKey, injectVegaText } from "../src/utils/vega-input";

// The android clear's own rejection is the one case in this file that has to
// reach the device transport before it can decide, so adb is stubbed: a legacy
// level (no `keycombination`) reporting a field longer than the delete run can
// cover. Every other android case here throws during validation, before any adb
// call, so the stub is inert for them.
const { adbShell, adbExecOutBinary } = vi.hoisted(() => ({
  adbShell: vi.fn(async (_serial: string, _cmd: string, _opts?: unknown): Promise<string> => ""),
  adbExecOutBinary: vi.fn(
    async (_serial: string, _cmd: string, _opts?: unknown): Promise<Buffer> => Buffer.from("")
  ),
}));
vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  adbShell,
  adbExecOutBinary,
}));

import {
  injectAndroidClear,
  injectAndroidNamedKey,
  injectAndroidText,
} from "../src/utils/android-input";

// The `keyboard` tool's `key` is a free `z.string()` and its `text` is a free
// string, so an unknown named key or an un-typeable character passes zod
// validation but is a *caller* mistake, not an internal fault. The HTTP layer
// maps InvalidToolInputError → 400 and anything else → 500. Before this, the
// non-Android backends threw a plain `Error` (pre-#420) / a `FailureError`
// (post-#420) — both surfaced as 500, so `key: "pageup"` returned 400 on Android
// but 500 on iOS / chromium / vega (hubgan review). These pins keep every
// keyboard backend's input-rejection uniform: a 400-mapping InvalidToolInputError
// that STILL carries #420's granular telemetry code (the 400 mapping keys off the
// error class, not the code — see InvalidToolInputError in utils/capability.ts).

/** Assert the error is a 400-class input error carrying the given telemetry code. */
async function expectInvalidInput(p: Promise<unknown>, code: string): Promise<void> {
  const err = await p.then(
    () => {
      throw new Error("expected the call to reject, but it resolved");
    },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(InvalidToolInputError);
  expect(getFailureSignal(err)?.error_code).toBe(code);
}

function iosRegistry(): Registry {
  const registry = new Registry();
  vi.spyOn(registry, "resolveService").mockResolvedValue({ pressKey: vi.fn() } as never);
  return registry;
}
function chromiumRegistry(): Registry {
  const registry = new Registry();
  vi.spyOn(registry, "resolveService").mockResolvedValue({
    dispatchKeyEvent: vi.fn(async () => {}),
  } as never);
  return registry;
}
const iosDevice = { id: "AAAA", platform: "ios", kind: "simulator" } as unknown as DeviceInfo;
const chromiumDevice = {
  id: "chromium-cdp-9222",
  platform: "chromium",
  kind: "app",
} as unknown as DeviceInfo;

describe("keyboard backends — input rejection is a 400 with a uniform telemetry taxonomy", () => {
  it("iOS: unknown key → 400 + KEYBOARD_KEY_UNSUPPORTED", async () => {
    await expectInvalidInput(
      typeSimulatorServer(iosRegistry(), iosDevice, { udid: iosDevice.id, key: "pageup" }),
      FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED
    );
  });

  it("iOS: un-typeable character → 400 + KEYBOARD_CHARACTER_UNSUPPORTED", async () => {
    await expectInvalidInput(
      typeSimulatorServer(iosRegistry(), iosDevice, { udid: iosDevice.id, text: "😀" }),
      FAILURE_CODES.KEYBOARD_CHARACTER_UNSUPPORTED
    );
  });

  it("chromium: unknown key → 400 + KEYBOARD_KEY_UNSUPPORTED", async () => {
    const impl = makeChromiumImpl(chromiumRegistry());
    await expectInvalidInput(
      impl.handler({}, { udid: chromiumDevice.id, key: "pageup" }, chromiumDevice),
      FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED
    );
  });

  it("chromium: un-typeable character → 400 + KEYBOARD_CHARACTER_UNSUPPORTED", async () => {
    const impl = makeChromiumImpl(chromiumRegistry());
    await expectInvalidInput(
      impl.handler({}, { udid: chromiumDevice.id, text: "😀" }, chromiumDevice),
      FAILURE_CODES.KEYBOARD_CHARACTER_UNSUPPORTED
    );
  });

  it("vega: unknown key → 400 + KEYBOARD_KEY_UNSUPPORTED", async () => {
    await expectInvalidInput(injectVegaNamedKey("pageup"), FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED);
  });

  it("vega: newline in text → 400 + VEGA_TEXT_INVALID", async () => {
    await expectInvalidInput(injectVegaText("a\nb"), FAILURE_CODES.VEGA_TEXT_INVALID);
  });

  it("android: unknown key → 400 + KEYBOARD_KEY_UNSUPPORTED", async () => {
    // adbShell is never reached — the unknown key is rejected before injection.
    await expectInvalidInput(
      injectAndroidNamedKey("emulator-5554", "pageup"),
      FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED
    );
  });

  it("android: un-typeable character → 400 + KEYBOARD_CHARACTER_UNSUPPORTED", async () => {
    // Same granular bucket as the iOS/chromium un-typeable-character
    // rejections above — not the generic TOOL_INPUT_INVALID (hubgan review).
    // adbShell is never reached: the guard rejects before injection.
    await expectInvalidInput(
      injectAndroidText("emulator-5554", "café"),
      FAILURE_CODES.KEYBOARD_CHARACTER_UNSUPPORTED
    );
  });

  it("android: newline in text → 400 + KEYBOARD_CHARACTER_UNSUPPORTED", async () => {
    // A newline is a character this backend can't type, so it buckets with the
    // un-typeable-character rejections.
    await expectInvalidInput(
      injectAndroidText("emulator-5554", "a\nb"),
      FAILURE_CODES.KEYBOARD_CHARACTER_UNSUPPORTED
    );
  });

  // `key` is a free string, so a prototype-chain name ("constructor",
  // "__proto__", …) must be rejected as an unknown key on every backend rather
  // than slipping through an object lookup with a garbage value and going over
  // the wire as a broken press. Pin the 400 + KEYBOARD_KEY_UNSUPPORTED bucket
  // for a representative prototype key on each backend.
  it("iOS: prototype-chain key name → 400 + KEYBOARD_KEY_UNSUPPORTED", async () => {
    await expectInvalidInput(
      typeSimulatorServer(iosRegistry(), iosDevice, { udid: iosDevice.id, key: "constructor" }),
      FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED
    );
  });

  it("chromium: prototype-chain key name → 400 + KEYBOARD_KEY_UNSUPPORTED", async () => {
    const impl = makeChromiumImpl(chromiumRegistry());
    await expectInvalidInput(
      impl.handler({}, { udid: chromiumDevice.id, key: "constructor" }, chromiumDevice),
      FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED
    );
  });

  it("vega: prototype-chain key name → 400 + KEYBOARD_KEY_UNSUPPORTED", async () => {
    await expectInvalidInput(
      injectVegaNamedKey("constructor"),
      FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED
    );
  });

  it("android: prototype-chain key name → 400 + KEYBOARD_KEY_UNSUPPORTED", async () => {
    await expectInvalidInput(
      injectAndroidNamedKey("emulator-5554", "constructor"),
      FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED
    );
  });

  // `clear`'s own rejections belong in the same taxonomy: they are states the
  // caller can fix (focus the field, shorten the value, pick a newer API
  // level), so they must be 400s carrying a code that distinguishes them from
  // the key/character rejections above — otherwise "clear could not run" is
  // indistinguishable in telemetry from "that key does not exist".
  it("chromium: clear with nothing editable focused → 400 + KEYBOARD_CLEAR_NO_EDITABLE_FOCUS", async () => {
    const registry = new Registry();
    vi.spyOn(registry, "resolveService").mockResolvedValue({
      dispatchKeyEvent: vi.fn(async () => {}),
      evaluate: vi.fn(async () => JSON.stringify({ verdict: "none" })),
    } as never);

    await expectInvalidInput(
      makeChromiumImpl(registry).handler(
        {},
        { udid: chromiumDevice.id, clear: true },
        chromiumDevice
      ),
      FAILURE_CODES.KEYBOARD_CLEAR_NO_EDITABLE_FOCUS
    );
  });

  it("chromium: clear of a readonly field → 400 + KEYBOARD_CLEAR_READ_ONLY", async () => {
    // Its OWN code, not the nothing-focused one: the two remedies are opposite
    // — tapping the field fixes one and can never fix the other — and
    // `failure_stage`, which was the only thing separating them, is not
    // serialized onto the wire.
    const registry = new Registry();
    vi.spyOn(registry, "resolveService").mockResolvedValue({
      dispatchKeyEvent: vi.fn(async () => {}),
      evaluate: vi.fn(async () =>
        JSON.stringify({ verdict: "read-only", label: "INPUT#total", mac: true })
      ),
    } as never);

    await expectInvalidInput(
      makeChromiumImpl(registry).handler(
        {},
        { udid: chromiumDevice.id, clear: true },
        chromiumDevice
      ),
      FAILURE_CODES.KEYBOARD_CLEAR_READ_ONLY
    );
  });

  it("chromium: clear that left the field populated → KEYBOARD_CLEAR_INEFFECTIVE", async () => {
    // Not a caller mistake — the page refused the edit — so this one is a 500
    // (`FailureError`), unlike its siblings here. Pinned in the same place so
    // the distinction is deliberate rather than incidental.
    const registry = new Registry();
    vi.spyOn(registry, "resolveService").mockResolvedValue({
      dispatchKeyEvent: vi.fn(async () => {}),
      // The clear runs three probes: resolve-and-park, a read-back that KEEPS
      // the element parked, then the release. Routed by call order, not by
      // matching text in the expression — the read-back and the release differ
      // only in whether they delete the slot.
      evaluate: (() => {
        let calls = 0;
        return vi.fn(async () => {
          calls++;
          return JSON.stringify(
            calls === 1
              ? { verdict: "editable", label: "INPUT#q", length: 7, mac: true }
              : { tracked: true, length: 7 }
          );
        });
      })(),
    } as never);

    const err = await makeChromiumImpl(registry)
      .handler({}, { udid: chromiumDevice.id, clear: true }, chromiumDevice)
      .then(
        () => {
          throw new Error("expected the call to reject, but it resolved");
        },
        (e: unknown) => e
      );
    expect(err).not.toBeInstanceOf(InvalidToolInputError);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.KEYBOARD_CLEAR_INEFFECTIVE);
  });

  it("chromium: clear that WORKED but lost focus → KEYBOARD_CLEAR_FOCUS_LOST, not INEFFECTIVE", async () => {
    // The opposite outcome to the case above, and it used to carry the same
    // code. The remedies are opposite too — "re-clear required" versus "the
    // field is already empty, send the rest without `clear`" — and
    // `failure_stage`, the only thing separating them, is not serialized onto
    // the wire, so a client keying on the signal could not tell them apart.
    const registry = new Registry();
    vi.spyOn(registry, "resolveService").mockResolvedValue({
      dispatchKeyEvent: vi.fn(async () => {}),
      evaluate: (() => {
        let calls = 0;
        return vi.fn(async () => {
          calls++;
          return JSON.stringify(
            calls === 1
              ? { verdict: "editable", label: "INPUT#q", mac: true, parked: true }
              : // Emptied — and the page moved focus off it in response.
                { tracked: true, length: 0, focused: false }
          );
        });
      })(),
    } as never);

    const err = await makeChromiumImpl(registry)
      .handler({}, { udid: chromiumDevice.id, clear: true, text: "hi" }, chromiumDevice)
      .then(
        () => {
          throw new Error("expected the call to reject, but it resolved");
        },
        (e: unknown) => e
      );
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.KEYBOARD_CLEAR_FOCUS_LOST);
    expect((err as Error).message).toMatch(/the field is already empty/);
  });

  it("vega: clear → 400 + KEYBOARD_CLEAR_UNSUPPORTED_TARGET, not the capability code", async () => {
    // `UnsupportedOperationError` hard-codes TOOL_CAPABILITY_UNSUPPORTED_OPERATION,
    // so a refused `clear` was filed under the same code as a tool that cannot
    // run on the target at all — and its message opens by saying the whole tool
    // is unsupported here, which contradicts the tool's own description and
    // `argent-tv-interact`, both of which send the agent to `keyboard` to type
    // on a Vega or TV target.
    const vegaDevice = {
      id: "vega-serial",
      platform: "vega",
      kind: "vvd",
    } as unknown as DeviceInfo;
    const err = await Promise.resolve(
      vegaImpl.handler({}, { udid: vegaDevice.id, clear: true, text: "hi" }, vegaDevice)
    ).then(
      () => {
        throw new Error("expected the call to reject, but it resolved");
      },
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(InvalidToolInputError);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.KEYBOARD_CLEAR_UNSUPPORTED_TARGET);
    expect((err as Error).message).not.toMatch(/tool 'keyboard' is not supported/i);
  });

  it("tv: clear → 400 + KEYBOARD_CLEAR_UNSUPPORTED_TARGET, and no tvOS device is called an iOS one", async () => {
    const appleTv = { id: "TV-UDID", platform: "ios", kind: "simulator" } as unknown as DeviceInfo;
    const err = await typeTv({} as never, appleTv, {
      udid: appleTv.id,
      clear: true,
      text: "hi",
    }).then(
      () => {
        throw new Error("expected the call to reject, but it resolved");
      },
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(InvalidToolInputError);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.KEYBOARD_CLEAR_UNSUPPORTED_TARGET);
    expect((err as Error).message).not.toMatch(/ios simulator/i);
  });

  it.each([
    [
      "tv",
      (device: DeviceInfo, params: Record<string, unknown>) =>
        typeTv({} as never, device, { udid: device.id, ...params } as never),
    ],
    [
      "vega",
      (device: DeviceInfo, params: Record<string, unknown>) =>
        vegaImpl.handler({}, { udid: device.id, ...params } as never, device),
    ],
  ])(
    "%s: a request invalid in BOTH halves reports the clear, not the key",
    async (_backend, call) => {
      // Both backends refuse `clear` AND a named `key`, so the order they check
      // them in decides what a doubly-invalid request reports. Taking the key
      // first sent `{ clear: true, key: "enter" }` back as
      // TOOL_CAPABILITY_UNSUPPORTED_OPERATION — "Tool 'keyboard' is not
      // supported on ios simulator …", the exact class `platforms/tv.ts` avoids
      // for `clear`, on the exact request that refusal exists for.
      const device = { id: "TV-UDID", platform: "ios", kind: "simulator" } as unknown as DeviceInfo;
      const err = await call(device, { clear: true, key: "enter" }).then(
        () => {
          throw new Error("expected the call to reject, but it resolved");
        },
        (e: unknown) => e
      );

      expect(getFailureSignal(err)?.error_code).toBe(
        FAILURE_CODES.KEYBOARD_CLEAR_UNSUPPORTED_TARGET
      );
    }
  );

  it("android: clear of a field too long to delete → 400 + KEYBOARD_CLEAR_FIELD_TOO_LONG", async () => {
    adbShell.mockReset();
    adbExecOutBinary.mockReset();
    // A level whose `input` has no `keycombination` reports it as a usage dump
    // and still exits 0 …
    adbShell.mockImplementationOnce(async () => "Usage: input …");
    // … and the focused field is longer than the delete run can cover.
    adbExecOutBinary.mockImplementationOnce(async () =>
      Buffer.from(
        `<hierarchy><node text="${"x".repeat(900)}" class="android.widget.EditText" ` +
          `password="false" focused="true" /></hierarchy>`
      )
    );

    await expectInvalidInput(
      injectAndroidClear("emulator-5554"),
      FAILURE_CODES.KEYBOARD_CLEAR_FIELD_TOO_LONG
    );
  });

  it("android: a delete run adb could not finish → KEYBOARD_CLEAR_INTERRUPTED, naming the field", async () => {
    // The one android clear failure that leaves the field CHANGED. `adbShell`'s
    // own error is filed under ANDROID_ADB_COMMAND_FAILED and its message is the
    // argv — a ~700-character `input keyevent 123 67 67 67 …` dump that never
    // mentions the field at all — so a caller reads a transport fault and
    // retries against a field it believes is untouched.
    adbShell.mockReset();
    adbExecOutBinary.mockReset();
    adbShell.mockImplementationOnce(async () => "Usage: input …");
    adbExecOutBinary.mockImplementationOnce(async () =>
      Buffer.from(
        `<hierarchy><node text="abcd" class="android.widget.EditText" ` +
          `password="false" focused="true" /></hierarchy>`
      )
    );
    adbShell.mockImplementationOnce(async () => {
      throw new FailureError("adb -s emulator-5554 shell input keyevent 123 67 67 … failed", {
        error_code: FAILURE_CODES.ANDROID_ADB_COMMAND_FAILED,
        failure_stage: "android_adb_command",
        failure_area: "tool_server",
        error_kind: "timeout",
      });
    });

    const err = await injectAndroidClear("emulator-5554").then(
      () => {
        throw new Error("expected the call to reject, but it resolved");
      },
      (e: unknown) => e as Error
    );

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.KEYBOARD_CLEAR_INTERRUPTED);
    // The kind is carried through, so a killed leg still reads as a timeout.
    expect(getFailureSignal(err)?.error_kind).toBe("timeout");
    expect(err.message).toMatch(/PARTLY emptied/);
    expect(err.message).not.toMatch(/input keyevent/);
    // The count is the field's measured length plus the public margin.
    expect(err.message).toMatch(/up to 12 backspaces were sent/);
  });

  it("android: an interrupted delete run does not assert a state it cannot know", async () => {
    // The same catch covers a cause that stopped the run before anything went
    // out — the device went offline, adb lost authorisation — where the field is
    // untouched. Only the `timeout` cause was ever exercised, so the message was
    // free to assert "the focused field IS partly emptied" for a run that never
    // started.
    adbShell.mockReset();
    adbExecOutBinary.mockReset();
    adbShell.mockImplementationOnce(async () => "Usage: input …");
    adbExecOutBinary.mockImplementationOnce(async () =>
      Buffer.from(
        `<hierarchy><node text="abcd" class="android.widget.EditText" ` +
          `password="false" focused="true" /></hierarchy>`
      )
    );
    adbShell.mockImplementationOnce(async () => {
      throw new FailureError("adb: device 'emulator-5554' not found", {
        error_code: FAILURE_CODES.ANDROID_ADB_COMMAND_FAILED,
        failure_stage: "android_adb_command",
        failure_area: "tool_server",
        error_kind: "subprocess",
      });
    });

    const err = await injectAndroidClear("emulator-5554").then(
      () => {
        throw new Error("expected the call to reject, but it resolved");
      },
      (e: unknown) => e as Error
    );

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.KEYBOARD_CLEAR_INTERRUPTED);
    // The kind of a cause that is not a timeout is carried through as well.
    expect(getFailureSignal(err)?.error_kind).toBe("subprocess");
    expect(err.message).toMatch(/may be PARTLY emptied/);
    expect(err.message).toMatch(/up to 12 backspaces/);
    // The remedy still stands — it is the assertion that was wrong.
    expect(err.message).toMatch(/Read the field's actual contents/);
  });

  it("android: an interrupted delete run says nothing about a SECRET field's length", async () => {
    // Same number, same reason as the over-length refusal above, which withholds
    // it: on a `{{secret:…}}` request the count is a credential's exact length,
    // and `redactSecretsFromError` substitutes the value string and cannot redact
    // a number.
    adbShell.mockReset();
    adbExecOutBinary.mockReset();
    adbShell.mockImplementationOnce(async () => "Usage: input …");
    adbExecOutBinary.mockImplementationOnce(async () =>
      Buffer.from(
        `<hierarchy><node text="${"x".repeat(31)}" class="android.widget.EditText" ` +
          `password="false" focused="true" /></hierarchy>`
      )
    );
    adbShell.mockImplementationOnce(async () => {
      throw new FailureError("adb … input keyevent 123 67 67 … failed", {
        error_code: FAILURE_CODES.ANDROID_ADB_COMMAND_FAILED,
        failure_stage: "android_adb_command",
        failure_area: "tool_server",
        error_kind: "timeout",
      });
    });

    const err = await injectAndroidClear("emulator-5554", { secretText: true }).then(
      () => {
        throw new Error("expected the call to reject, but it resolved");
      },
      (e: unknown) => e as Error
    );

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.KEYBOARD_CLEAR_INTERRUPTED);
    // Still says the field is part-emptied — that is the actionable half.
    expect(err.message).toMatch(/PARTLY emptied/);
    // 31 + DELETE_MARGIN, the number a plain request would have quoted.
    expect(err.message).not.toMatch(/\b39\b/);
    expect(err.message).not.toMatch(/\b31\b/);
  });
});
