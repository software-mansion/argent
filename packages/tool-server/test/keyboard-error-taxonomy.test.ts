import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Registry, FAILURE_CODES, getFailureSignal, type DeviceInfo } from "@argent/registry";

// The harmony backend rejects an unknown key before injecting, so these tests
// never reach the device — stub the transport anyway, so a regression that
// dropped the guard fails on the assertion rather than shelling out to `hdc`.
vi.mock("../src/utils/harmony-hdc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-hdc")>()),
  runHdcShell: vi.fn(),
}));

import { InvalidToolInputError } from "../src/utils/capability";
import { typeSimulatorServer } from "../src/tools/keyboard/simulator-server-keys";
import { makeChromiumImpl } from "../src/tools/keyboard/platforms/chromium";
import { harmonyImpl } from "../src/tools/keyboard/platforms/harmony";
import { runHdcShell as realRunHdcShell } from "../src/utils/harmony-hdc";
import { makeIosDeviceImpl } from "../src/tools/keyboard/platforms/ios-device";
import { RunnerCommandError } from "../src/utils/ios-device/runner-client";
import {
  clearCurrentIosDeviceApp,
  setCurrentIosDeviceApp,
} from "../src/utils/ios-device/app-session";
import { injectVegaNamedKey, injectVegaText } from "../src/utils/vega-input";
import { injectAndroidNamedKey, injectAndroidText } from "../src/utils/android-input";

const runHdcShell = vi.mocked(realRunHdcShell);

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
const iosPhysicalDevice = {
  id: "00008030-000A1B2C3D4E5F60",
  platform: "ios",
  kind: "device",
} as unknown as DeviceInfo;

beforeEach(() => {
  runHdcShell.mockReset();
  // An awake panel, so the tests that DO reach the display guard get past it
  // and the ones pinned to pure validation stay pure.
  runHdcShell.mockImplementation(async (_key, command) =>
    command.startsWith("hidumper")
      ? {
          stdout:
            "-- ScreenInfo\nscreen[0]: id=0, powerStatus=POWER_STATUS_ON, backlight=1, " +
            "render resolution=1216x2688, physical resolution=1216x2688\n",
          exitCode: 0,
        }
      : { stdout: "", exitCode: 0 }
  );
});

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

  // android's prototype-chain guard is pinned in keyboard-android.test.ts,
  // which additionally asserts adb is never reached.

  // The physical-iOS backend normalizes `key` through a trim(), so a
  // whitespace-only name collapsed to "" and slipped past its named-key guard
  // into the empty-request no-op below it: a 200 { typed: "", keys: 0 } with no
  // device contact, which the caller cannot tell apart from a real press (the
  // very outcome ../src/tools/keyboard/index.ts's empty-key guard exists to
  // prevent). It rejects like every sibling instead.
  it("iOS device: whitespace-only key -> 400 + KEYBOARD_KEY_UNSUPPORTED", async () => {
    const impl = makeIosDeviceImpl(new Registry());
    await expectInvalidInput(
      impl.handler({}, { udid: iosPhysicalDevice.id, key: "   " }, iosPhysicalDevice),
      FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED
    );
  });

  it("harmony: prototype-chain key name → 400 + KEYBOARD_KEY_UNSUPPORTED", async () => {
    const harmonyDevice: DeviceInfo = { id: "harmony-KEY", platform: "harmony", kind: "device" };
    // `String(keycode)` reaches `uiInput keyEvent ${key}` unquoted, so a
    // prototype value would be interpolated into the remote shell line rather
    // than pressing anything — and with `text` alongside it, the reject must
    // still land before a single character is typed.
    for (const key of ["constructor", "__proto__", "toString"]) {
      runHdcShell.mockClear();
      await expectInvalidInput(
        harmonyImpl.handler({}, { udid: harmonyDevice.id, text: "hi", key }, harmonyDevice),
        FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED
      );
      expect(runHdcShell).not.toHaveBeenCalled();
    }
  });

  it("harmony: newline in text → 400 + KEYBOARD_CHARACTER_UNSUPPORTED", async () => {
    const harmonyDevice: DeviceInfo = { id: "harmony-KEY", platform: "harmony", kind: "device" };
    // `uitest uiInput text` validates almost nothing and answers `No Error`
    // whether or not anything landed, so a newline must be rejected up front —
    // every sibling backend (android above, vega) already is.
    await expectInvalidInput(
      harmonyImpl.handler({}, { udid: harmonyDevice.id, text: "a\nb" }, harmonyDevice),
      FAILURE_CODES.KEYBOARD_CHARACTER_UNSUPPORTED
    );
    expect(runHdcShell).not.toHaveBeenCalled();
    // The newline shares its failure code with every other un-typeable
    // character, so the code alone cannot tell whether its own branch still
    // exists — and that branch is there only for the recovery it names.
    await expect(
      harmonyImpl.handler({}, { udid: harmonyDevice.id, text: "a\nb" }, harmonyDevice)
    ).rejects.toThrow(/Submit with `key: "enter"` after typing instead/);
    // Decided without asking the device: see the unsupported-key case below.
    expect(runHdcShell).not.toHaveBeenCalled();
  });

  it("harmony: a control character in text → 400 + KEYBOARD_CHARACTER_UNSUPPORTED", async () => {
    const harmonyDevice: DeviceInfo = { id: "harmony-KEY", platform: "harmony", kind: "device" };
    await expectInvalidInput(
      harmonyImpl.handler({}, { udid: harmonyDevice.id, text: "a\x07b" }, harmonyDevice),
      FAILURE_CODES.KEYBOARD_CHARACTER_UNSUPPORTED
    );
    expect(runHdcShell).not.toHaveBeenCalled();
  });

  it("harmony: an unsupported key is diagnosed without reaching the device", async () => {
    const harmonyDevice: DeviceInfo = { id: "harmony-KEY", platform: "harmony", kind: "device" };
    // `tab` is one of the keys this backend deliberately does not map, so the
    // answer never depends on the device — the unreachable transport stubbed
    // below stands in for one that is unhappy. A device round trip ahead of the
    // key check turns this 400 into `hdc could not reach HarmonyOS device …:
    // Device not found or connected`, sending the caller to check a cable over
    // a key that will never be supported (hubgan review).
    runHdcShell.mockRejectedValue(new Error("[Fail][E001005] Device not found or connected"));
    await expectInvalidInput(
      harmonyImpl.handler({}, { udid: harmonyDevice.id, key: "tab" }, harmonyDevice),
      FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED
    );
    expect(runHdcShell).not.toHaveBeenCalled();
  });

  it("harmony: every unsupported-input rejection carries the shared `unsupported` kind", async () => {
    const harmonyDevice: DeviceInfo = { id: "harmony-KEY", platform: "harmony", kind: "device" };
    // The android twin tags all three of these `unsupported`
    // (utils/android-input.ts), and telemetry groups by kind before code — so a
    // harmony rejection without one lands in the untyped bucket and the same
    // failure reads as two different things depending on the platform.
    for (const params of [{ text: "a\nb" }, { text: "a\x07b" }, { key: "tab" }]) {
      runHdcShell.mockClear();
      const err = await harmonyImpl
        .handler({}, { udid: harmonyDevice.id, ...params }, harmonyDevice)
        .then(
          () => {
            throw new Error("expected the call to reject, but it resolved");
          },
          (e: unknown) => e
        );
      expect(getFailureSignal(err)?.error_kind).toBe("unsupported");
      expect(runHdcShell).not.toHaveBeenCalled();
    }
  });

  it("iOS device: unknown key -> 400 rejection naming both supported keys", async () => {
    const impl = makeIosDeviceImpl(new Registry());
    const err = await impl
      .handler({}, { udid: iosPhysicalDevice.id, key: "pageup" }, iosPhysicalDevice)
      .then(
        () => {
          throw new Error("expected the call to reject, but it resolved");
        },
        (e: unknown) => e
      );

    expect(err).toBeInstanceOf(InvalidToolInputError);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED);
    // The message is the caller's whole named-key contract on hardware, so it
    // must list both keys the backend accepts.
    expect((err as Error).message).toContain("only 'enter' and 'backspace'");
  });
});

describe("keyboard (ios-device): named-key routing", () => {
  beforeEach(() => {
    setCurrentIosDeviceApp(iosPhysicalDevice.id, "com.example.app");
  });

  afterEach(() => {
    clearCurrentIosDeviceApp(iosPhysicalDevice.id);
  });

  // Positive control for the rejection above, pinned at the api.run seam: the
  // key that was asked for is the runner command that goes over the wire.
  it.each([
    { key: "enter", command: "keyboardReturn" },
    { key: "backspace", command: "keyboardDelete" },
  ])("routes key '$key' to the runner's $command command", async ({ key, command }) => {
    const run = vi.fn().mockResolvedValue({ message: "ok" });
    const registry = new Registry();
    vi.spyOn(registry, "resolveService").mockResolvedValue({
      udid: iosPhysicalDevice.id,
      run,
    } as never);

    const impl = makeIosDeviceImpl(registry);
    const result = await impl.handler({}, { udid: iosPhysicalDevice.id, key }, iosPhysicalDevice);

    expect(result).toEqual({ typed: key, keys: 1 });
    expect(run).toHaveBeenCalledWith({ command, appBundleId: "com.example.app" });
  });
});

describe("keyboard (ios-device): typing with nothing focused", () => {
  // The runner probes keyboard focus before typing and answers
  // TEXT_INPUT_NOT_FOCUSED; audited on an iPhone 15, the pre-probe behavior
  // was the generic "XCTest recorded a failure while executing type", which
  // named neither the cause nor the fix.
  function notFocusedRegistry(): Registry {
    const registry = new Registry();
    vi.spyOn(registry, "resolveService").mockResolvedValue({
      udid: iosPhysicalDevice.id,
      run: vi.fn().mockRejectedValue(
        new RunnerCommandError("no text input has keyboard focus", {
          code: "TEXT_INPUT_NOT_FOCUSED",
        })
      ),
    } as never);
    return registry;
  }

  beforeEach(() => {
    setCurrentIosDeviceApp(iosPhysicalDevice.id, "com.example.app");
  });

  afterEach(() => {
    clearCurrentIosDeviceApp(iosPhysicalDevice.id);
  });

  it.each([{ text: "hello" }, { key: "enter" }, { key: "backspace" }])(
    "maps TEXT_INPUT_NOT_FOCUSED to the retype instruction for %j",
    async (input) => {
      const impl = makeIosDeviceImpl(notFocusedRegistry());
      const err = await impl
        .handler({}, { udid: iosPhysicalDevice.id, ...input }, iosPhysicalDevice)
        .then(
          () => {
            throw new Error("expected the call to reject, but it resolved");
          },
          (e: unknown) => e
        );

      expect(err).toBeInstanceOf(InvalidToolInputError);
      expect((err as Error).message).toBe(
        "Nothing on screen has keyboard focus. Tap the text field first, then retype."
      );
      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.KEYBOARD_INPUT_NOT_FOCUSED);
    }
  );

  it("passes other runner failures through untouched", async () => {
    const registry = new Registry();
    const original = new RunnerCommandError("app 'com.example.app' is not running", {
      code: "APP_NOT_AVAILABLE",
    });
    vi.spyOn(registry, "resolveService").mockResolvedValue({
      udid: iosPhysicalDevice.id,
      run: vi.fn().mockRejectedValue(original),
    } as never);

    const impl = makeIosDeviceImpl(registry);
    const err = await impl
      .handler({}, { udid: iosPhysicalDevice.id, text: "hello" }, iosPhysicalDevice)
      .then(
        () => {
          throw new Error("expected the call to reject, but it resolved");
        },
        (e: unknown) => e
      );

    expect(err).toBe(original);
  });
});
