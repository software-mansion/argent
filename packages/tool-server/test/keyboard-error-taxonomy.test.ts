import { describe, it, expect, vi } from "vitest";
import { Registry, FAILURE_CODES, getFailureSignal, type DeviceInfo } from "@argent/registry";
import { InvalidToolInputError } from "../src/utils/capability";
import { typeSimulatorServer } from "../src/tools/keyboard/simulator-server-keys";
import { makeChromiumImpl } from "../src/tools/keyboard/platforms/chromium";
import { injectVegaNamedKey, injectVegaText } from "../src/utils/vega-input";
import { injectAndroidNamedKey, injectAndroidText } from "../src/utils/android-input";

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
});
