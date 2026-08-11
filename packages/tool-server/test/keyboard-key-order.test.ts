import { describe, expect, it, vi } from "vitest";
import type { DeviceInfo } from "@argent/registry";
import { typeSimulatorServer } from "../src/tools/keyboard/simulator-server-keys";
import { makeChromiumImpl } from "../src/tools/keyboard/platforms/chromium";
import { vegaImpl } from "../src/tools/keyboard/platforms/vega";

vi.mock("../src/utils/vega-input", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/vega-input")>();
  return {
    ...actual,
    injectVegaText: vi.fn(async () => {}),
    injectVegaNamedKey: vi.fn(async () => {}),
  };
});

// Android injects over `adb shell input`, so its ordering is observable as the
// command sequence. Stub the transport and the TV probe (a phone target here);
// `shellQuote` stays real so the asserted strings are the real command lines.
const { adbShell, isAndroidTv } = vi.hoisted(() => ({
  adbShell: vi.fn(async (_serial: string, _cmd: string, _opts?: unknown): Promise<string> => ""),
  isAndroidTv: vi.fn(async (_serial: string): Promise<boolean> => false),
}));
vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  adbShell,
  isAndroidTv,
}));

import { injectVegaNamedKey, injectVegaText } from "../src/utils/vega-input";
import { makeAndroidImpl } from "../src/tools/keyboard/platforms/android";

const IOS_SIM: DeviceInfo = { id: "TEST-UDID", platform: "ios", kind: "simulator" };
const CHROMIUM: DeviceInfo = { id: "chromium-cdp-9222", platform: "chromium", kind: "app" };
const VEGA: DeviceInfo = { id: "vega-serial", platform: "vega", kind: "vvd" };
const ANDROID: DeviceInfo = { id: "emulator-5554", platform: "android", kind: "emulator" };

const ENTER_HID_KEYCODE = 40;

function registryWith(api: unknown) {
  return { resolveService: vi.fn(async () => api) } as any;
}

// A combined text+key call means "type, then submit". Pressing the key first
// fires enter into the still-empty field, which blurs it and leaks the text to
// app-level key commands (the React Native dev menu opens on a bare "d" when
// nothing is focused) — the regression behind these tests.
//
// These are not order-only, so do not reduce them to a "did the key come last"
// check. The exact sequences and counts below (the HID stream's length plus its
// last down, the chromium keyDown list, the android command pair) are what catch
// a named key dispatched as a bare keyUp, and the four unknown-key tests are the
// only place the offending key's NAME in the 400 is pinned on any backend — the
// surviving assertions elsewhere match bare prefixes.
// keyboard-backend-fidelity.test.ts covers the single-parameter properties these
// cannot see; it deliberately does not repeat what is pinned here.
describe("keyboard text+key ordering", () => {
  it("simulator-server: presses the named key after the text", async () => {
    const downs: number[] = [];
    const api = {
      pressKey: (direction: "Down" | "Up", keyCode: number) => {
        if (direction === "Down") downs.push(keyCode);
      },
    };

    const result = await typeSimulatorServer(registryWith(api), IOS_SIM, {
      udid: IOS_SIM.id,
      text: "hi",
      key: "enter",
      delayMs: 0,
    });

    expect(downs).toHaveLength(3);
    expect(downs[downs.length - 1]).toBe(ENTER_HID_KEYCODE);
    expect(result.keys).toBe(3);
  });

  it("simulator-server: rejects an unknown key before typing any text", async () => {
    const pressKey = vi.fn();

    await expect(
      typeSimulatorServer(registryWith({ pressKey }), IOS_SIM, {
        udid: IOS_SIM.id,
        text: "hi",
        key: "bogus",
        delayMs: 0,
      })
    ).rejects.toThrow(/Unknown key "bogus"/);
    expect(pressKey).not.toHaveBeenCalled();
  });

  it("chromium: dispatches the named key after the text", async () => {
    const events: Array<{ type: string; key?: string }> = [];
    const api = {
      dispatchKeyEvent: async (event: { type: string; key?: string }) => {
        events.push(event);
      },
    };

    await makeChromiumImpl(registryWith(api)).handler(
      {},
      { udid: CHROMIUM.id, text: "hi", key: "enter", delayMs: 0 },
      CHROMIUM
    );

    const keyDowns = events.filter((e) => e.type === "keyDown").map((e) => e.key);
    expect(keyDowns).toEqual(["h", "i", "Enter"]);
  });

  it("chromium: rejects an unknown key before typing any text", async () => {
    const dispatchKeyEvent = vi.fn(async () => {});

    await expect(
      makeChromiumImpl(registryWith({ dispatchKeyEvent })).handler(
        {},
        { udid: CHROMIUM.id, text: "hi", key: "bogus", delayMs: 0 },
        CHROMIUM
      )
    ).rejects.toThrow(/Unknown key "bogus"/);
    expect(dispatchKeyEvent).not.toHaveBeenCalled();
  });

  it("vega: injects the named key after the text", async () => {
    const order: string[] = [];
    vi.mocked(injectVegaText).mockImplementationOnce(async () => {
      order.push("text");
    });
    vi.mocked(injectVegaNamedKey).mockImplementationOnce(async () => {
      order.push("key");
    });

    await vegaImpl.handler({}, { udid: VEGA.id, text: "hi", key: "enter" }, VEGA);

    expect(order).toEqual(["text", "key"]);
  });

  it("vega: rejects an unknown key before typing any text", async () => {
    vi.mocked(injectVegaText).mockClear();
    vi.mocked(injectVegaNamedKey).mockClear();

    await expect(
      vegaImpl.handler({}, { udid: VEGA.id, text: "hi", key: "bogus" }, VEGA)
    ).rejects.toThrow(/Unknown Vega key "bogus"/);
    expect(injectVegaText).not.toHaveBeenCalled();
    expect(injectVegaNamedKey).not.toHaveBeenCalled();
  });

  it("android: presses the named key after the text", async () => {
    adbShell.mockClear();

    await makeAndroidImpl({} as never).handler(
      {},
      { udid: ANDROID.id, text: "hi", key: "enter" },
      ANDROID
    );

    const cmds = adbShell.mock.calls.map((c) => c[1]);
    expect(cmds).toEqual(["input text 'hi'", "input keyevent 66"]);
  });

  it("android: rejects an unknown key before typing any text", async () => {
    adbShell.mockClear();

    await expect(
      makeAndroidImpl({} as never).handler(
        {},
        { udid: ANDROID.id, text: "hi", key: "bogus" },
        ANDROID
      )
    ).rejects.toThrow(/Unknown key "bogus"/);
    expect(adbShell).not.toHaveBeenCalled();
  });
});
