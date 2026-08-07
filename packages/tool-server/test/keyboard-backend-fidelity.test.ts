import { describe, expect, it, vi, beforeEach } from "vitest";
import type { DeviceInfo } from "@argent/registry";
import { typeSimulatorServer } from "../src/tools/keyboard/simulator-server-keys";
import { makeChromiumImpl } from "../src/tools/keyboard/platforms/chromium";
import { vegaImpl } from "../src/tools/keyboard/platforms/vega";
import { injectAndroidNamedKey } from "../src/utils/android-input";

const { adbShell } = vi.hoisted(() => ({
  adbShell: vi.fn(async (_serial: string, _cmd: string, _opts?: unknown): Promise<string> => ""),
}));
vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  adbShell,
}));

vi.mock("../src/utils/vega-input", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/vega-input")>()),
  injectVegaText: vi.fn(async () => {}),
  injectVegaNamedKey: vi.fn(async () => {}),
}));

import { injectVegaNamedKey, injectVegaText } from "../src/utils/vega-input";

const IOS_SIM: DeviceInfo = { id: "TEST-UDID", platform: "ios", kind: "simulator" };
const CHROMIUM: DeviceInfo = { id: "chromium-cdp-9222", platform: "chromium", kind: "app" };
const VEGA: DeviceInfo = { id: "vega-serial", platform: "vega", kind: "vvd" };
const SERIAL = "emulator-5554";

// HID usage IDs (key-codes.ts): letters are 0x04 + (c - 'a'), so h=11, i=12.
// Written as literals, not read back out of the map under test.
const HID_H = 11;
const HID_I = 12;
const HID_ENTER = 40;
const HID_LEFT_SHIFT = 225;

function registryWith(api: unknown) {
  return { resolveService: vi.fn(async () => api) } as never;
}

/** Records the ordered HID stream the simulator-server backend emits. */
function hidRecorder() {
  const events: Array<[direction: string, keyCode: number]> = [];
  return {
    events,
    api: {
      pressKey: (direction: "Down" | "Up", keyCode: number) => events.push([direction, keyCode]),
    },
  };
}

/** Records the ordered CDP events the chromium backend dispatches. */
function cdpRecorder() {
  const events: Array<{ type: string; key?: string; text?: string }> = [];
  return {
    events,
    api: {
      dispatchKeyEvent: async (e: { type: string; key?: string; text?: string }) => {
        events.push(e);
      },
    },
  };
}

// `text` and `key` are mutually exclusive (#579), so ORDERING between the two is
// no longer a thing any backend can express — the tests that pinned it went away
// with the combination. What those tests also happened to pin, and what nothing
// else covers, is that each backend faithfully emits the ONE action it was
// given: the whole string rather than a prefix, one press per character rather
// than two, no modifier held across a lowercase run, a real keyDown for a named
// key rather than a bare keyUp, and the offending name in an unknown-key 400.
//
// Those are single-parameter properties, so they survive the exclusivity rule.
// They are pinned here against literal expectations — never against the same map
// the code reads, which any value in that map would satisfy.
describe("keyboard backends — emit exactly the action they were given", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("simulator-server (iOS)", () => {
    it("types every character once, with no modifier held on a lowercase run", async () => {
      const { events, api } = hidRecorder();

      const result = await typeSimulatorServer(registryWith(api), IOS_SIM, {
        udid: IOS_SIM.id,
        text: "hi",
        delayMs: 0,
      });

      // The exact ordered stream, so a backend that types a prefix, doubles a
      // press, or holds Shift for the whole string cannot answer a success
      // shape — none of which `typed` can distinguish, since it just echoes the
      // request back.
      expect(events).toEqual([
        ["Down", HID_H],
        ["Up", HID_H],
        ["Down", HID_I],
        ["Up", HID_I],
      ]);
      expect(result).toEqual({ typed: "hi", keys: 2 });
    });

    it("shifts only the character that needs it", async () => {
      const { events, api } = hidRecorder();

      await typeSimulatorServer(registryWith(api), IOS_SIM, {
        udid: IOS_SIM.id,
        text: "Hi",
        delayMs: 0,
      });

      // Positive control for the modifier: Shift wraps the "H" press and is
      // released before "i" — so "no modifier held" above is a real observation
      // about lowercase, not a backend that cannot shift at all.
      expect(events).toEqual([
        ["Down", HID_LEFT_SHIFT],
        ["Down", HID_H],
        ["Up", HID_H],
        ["Up", HID_LEFT_SHIFT],
        ["Down", HID_I],
        ["Up", HID_I],
      ]);
    });

    it("presses the named key it was asked for, by its own keycode", async () => {
      const { events, api } = hidRecorder();

      const result = await typeSimulatorServer(registryWith(api), IOS_SIM, {
        udid: IOS_SIM.id,
        key: "enter",
        delayMs: 0,
      });

      // The literal is the point: comparing against NAMED_KEYS.enter would be
      // satisfied by any value that map happens to hold. `enter` is the key the
      // flow `type` directive submits with and the one the two-call path
      // documents everywhere, so a wrong code here is a silent mis-submit.
      expect(events).toEqual([
        ["Down", HID_ENTER],
        ["Up", HID_ENTER],
      ]);
      expect(result.keys).toBe(1);
    });

    it("names the offending key when it is unknown", async () => {
      const { api } = hidRecorder();

      await expect(
        typeSimulatorServer(registryWith(api), IOS_SIM, {
          udid: IOS_SIM.id,
          key: "bogus",
          delayMs: 0,
        })
      ).rejects.toThrow(/Unknown key "bogus"/);
    });
  });

  describe("chromium", () => {
    it("dispatches a keyDown per character, in order", async () => {
      const { events, api } = cdpRecorder();

      await makeChromiumImpl(registryWith(api)).handler(
        {},
        { udid: CHROMIUM.id, text: "hi", delayMs: 0 },
        CHROMIUM
      );

      // Filtered to keyDown: the backend puts the same `key` on the keyUp, so an
      // unfiltered `.some()` would be satisfied by the release alone.
      expect(events.filter((e) => e.type === "keyDown").map((e) => e.key)).toEqual(["h", "i"]);
      // The `char` event is what actually delivers the codepoint to the field;
      // a descriptor reduced to "Unidentified" would still emit the keyDowns.
      expect(events.filter((e) => e.type === "char").map((e) => e.text)).toEqual(["h", "i"]);
    });

    it("dispatches a real keyDown for a named key, not just a keyUp", async () => {
      const { events, api } = cdpRecorder();

      await makeChromiumImpl(registryWith(api)).handler(
        {},
        { udid: CHROMIUM.id, key: "enter", delayMs: 0 },
        CHROMIUM
      );

      // A dropped keyDown is a no-op for any `keydown` or submit-on-Enter
      // listener while still answering a success shape.
      expect(events.filter((e) => e.type === "keyDown").map((e) => e.key)).toEqual(["Enter"]);
    });

    it("names the offending key when it is unknown", async () => {
      const { api } = cdpRecorder();

      await expect(
        makeChromiumImpl(registryWith(api)).handler(
          {},
          { udid: CHROMIUM.id, key: "bogus", delayMs: 0 },
          CHROMIUM
        )
      ).rejects.toThrow(/Unknown key "bogus"/);
    });
  });

  describe("android", () => {
    it("names the offending key when it is unknown", async () => {
      // The surviving android assertion is the bare prefix /Unknown key/, which
      // a message carrying neither the name nor the supported list satisfies —
      // and the name is what a caller needs to retry a 400 on `key`.
      await expect(injectAndroidNamedKey(SERIAL, "bogus")).rejects.toThrow(/Unknown key "bogus"/);
      expect(adbShell).not.toHaveBeenCalled();
    });
  });

  describe("vega", () => {
    it("injects the text it was given, and nothing else", async () => {
      await vegaImpl.handler({}, { udid: VEGA.id, text: "hi" }, VEGA);

      expect(vi.mocked(injectVegaText).mock.calls.map((c) => c[0])).toEqual(["hi"]);
      expect(injectVegaNamedKey).not.toHaveBeenCalled();
    });

    it("names the offending key when it is unknown", async () => {
      // Unmock the injector for this one: the rejection lives inside the real
      // `injectVegaNamedKey`, so the module-level stub would swallow it.
      const { injectVegaNamedKey: realInject } =
        await vi.importActual<typeof import("../src/utils/vega-input")>("../src/utils/vega-input");

      await expect(realInject("bogus")).rejects.toThrow(/Unknown Vega key "bogus"/);
    });
  });
});
