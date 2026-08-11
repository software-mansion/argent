import { describe, expect, it, vi, beforeEach } from "vitest";
import type { DeviceInfo } from "@argent/registry";
import { typeSimulatorServer } from "../src/tools/keyboard/simulator-server-keys";
import { makeChromiumImpl } from "../src/tools/keyboard/platforms/chromium";
import { vegaImpl } from "../src/tools/keyboard/platforms/vega";

vi.mock("../src/utils/vega-input", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/vega-input")>()),
  injectVegaText: vi.fn(async () => {}),
  injectVegaNamedKey: vi.fn(async () => {}),
}));

import { injectVegaNamedKey, injectVegaText } from "../src/utils/vega-input";

const IOS_SIM: DeviceInfo = { id: "TEST-UDID", platform: "ios", kind: "simulator" };
const CHROMIUM: DeviceInfo = { id: "chromium-cdp-9222", platform: "chromium", kind: "app" };
const VEGA: DeviceInfo = { id: "vega-serial", platform: "vega", kind: "vvd" };

// HID usage IDs (key-codes.ts): letters are 0x04 + (c - 'a'), so h=11, i=12.
// Written as literals, not read back out of the map under test.
const HID_H = 11;
const HID_I = 12;
const HID_ENTER = 40;
const HID_ESCAPE = 41;
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

// keyboard-key-order.test.ts pins the RELATIVE order of `text` and `key` in a
// combined call. That is a two-parameter property, and it is green against a
// backend that emits the two actions in the right order but emits either of them
// wrongly — a prefix instead of the whole string, two presses per character, a
// modifier held across a lowercase run, a bare keyUp for a named key, or an
// unknown-key 400 that omits the name the caller has to correct.
//
// Those are single-parameter properties, so they belong beside the ordering
// tests rather than inside them, one action per call. They are pinned here
// against literal expectations — never against the same map the code reads,
// which any value in that map would satisfy.
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

    // TWO keys, because one cannot tell "presses the key it was asked for" from
    // "always presses Enter" — every other named-key assertion on this backend
    // uses `enter`, so `await pressKeyCode(NAMED_KEYS.enter)` in place of the
    // resolved code is green across the whole suite. With `escape` here it is
    // red, and `key: "escape"` silently submitting the dialog the caller was
    // dismissing stays caught.
    it.each([
      ["enter", HID_ENTER],
      ["escape", HID_ESCAPE],
    ])("presses %s by its own keycode, not a hardcoded Enter", async (key, code) => {
      const { events, api } = hidRecorder();

      const result = await typeSimulatorServer(registryWith(api), IOS_SIM, {
        udid: IOS_SIM.id,
        key,
        delayMs: 0,
      });

      // The literals are the point: comparing against NAMED_KEYS[key] would be
      // satisfied by any value that map happens to hold.
      expect(events).toEqual([
        ["Down", code],
        ["Up", code],
      ]);
      // The whole result, not just `keys`: with no text given, `typed` echoes
      // the key name, so `typed: params.text ?? ""` is caught here too.
      expect(result).toEqual({ typed: key, keys: 1 });
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

    // Two keys, for the same reason as the simulator-server pair above: pinning
    // only `enter` cannot separate "dispatches the key it was asked for" from a
    // branch that overwrites `named` with CHROMIUM_NAMED_KEYS.enter.
    it.each([
      ["enter", "Enter"],
      ["escape", "Escape"],
    ])("dispatches %s itself, not a hardcoded Enter", async (key, domKey) => {
      const { events, api } = cdpRecorder();

      const result = await makeChromiumImpl(registryWith(api)).handler(
        {},
        { udid: CHROMIUM.id, key, delayMs: 0 },
        CHROMIUM
      );

      // A dropped keyDown is a no-op for any `keydown` or submit-on-Enter
      // listener while still answering a success shape.
      expect(events.filter((e) => e.type === "keyDown").map((e) => e.key)).toEqual([domKey]);
      expect(result).toEqual({ typed: key, keys: 1 });
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

  // No android section: `adb shell input` is a command line rather than an event
  // stream, so keyboard-android.test.ts already pins the exact strings this file
  // pins for the other three backends.

  describe("vega", () => {
    it("injects the text it was given, and nothing else", async () => {
      await vegaImpl.handler({}, { udid: VEGA.id, text: "hi" }, VEGA);

      expect(vi.mocked(injectVegaText).mock.calls.map((c) => c[0])).toEqual(["hi"]);
      expect(injectVegaNamedKey).not.toHaveBeenCalled();
    });

    it("forwards the key it was given to the injector, not a hardcoded one", async () => {
      // vega-injection.test.ts drives `injectVegaNamedKey` directly, so nothing
      // there pins that the BACKEND passes `params.key` through — replacing it
      // with a literal "enter" is green everywhere else. On Fire TV `escape`
      // maps to KEY_BACK, so that slip turns "go back" into select on the
      // focused tile.
      const result = await vegaImpl.handler({}, { udid: VEGA.id, key: "escape" }, VEGA);

      expect(vi.mocked(injectVegaNamedKey).mock.calls.map((c) => c[0])).toEqual(["escape"]);
      expect(injectVegaText).not.toHaveBeenCalled();
      expect(result).toEqual({ typed: "escape", keys: 1 });
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
