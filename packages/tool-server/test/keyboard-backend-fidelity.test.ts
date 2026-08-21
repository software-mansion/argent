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
const HID_LEFT_GUI = 227;

// Every ACCEPTED simulator-server run opens by releasing the two modifiers this
// backend is capable of holding, healing one left latched in the guest by a run
// that died mid-chord (see `releaseHeldModifiers`). HID `Up` on a key that is
// not down is a no-op, so this is a constant two-write prelude, not part of the
// action under test — but it is a device write, which is why a REJECTED run
// below emits nothing at all rather than this pair.
const HEAL: Array<[direction: string, keyCode: number]> = [
  ["Up", HID_LEFT_SHIFT],
  ["Up", HID_LEFT_GUI],
];

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

/**
 * Records the ordered CDP events the chromium backend dispatches, WHOLE — every
 * field, not a projection. A filtered view (`.filter(keyDown).map(key)`) cannot
 * see a dropped keyUp, a zeroed `windowsVirtualKeyCode`, or a `char` emitted
 * out of order, all of which the iOS section catches by pinning its full stream.
 */
function cdpRecorder() {
  const events: Array<Record<string, unknown>> = [];
  return {
    events,
    api: {
      dispatchKeyEvent: async (e: Record<string, unknown>) => {
        events.push(e);
      },
    },
  };
}

// CDP descriptors (chromium-keys.ts), written as literals rather than read back
// out of the maps under test. Letters: code Key<UPPER>, vk = uppercase charcode.
const CDP_H_UPPER = { key: "H", code: "KeyH", windowsVirtualKeyCode: 72 };
const CDP_I = { key: "i", code: "KeyI", windowsVirtualKeyCode: 73 };
const CDP_ENTER = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
const CDP_ESCAPE = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 };

// Single-parameter fidelity: does each backend emit exactly the action it was
// given? Every request here carries `text` or `key`, never both — the tool
// rejects the combined shape (keyboard-text-key-exclusive.test.ts), so one
// action per call is the only shape a backend ever sees, and there is no
// relative order left to pin.
//
// What a success shape cannot see is a backend that emits its one action
// wrongly: a prefix instead of the whole string, two presses per character, a
// modifier held across the lowercase remainder (the text is "hi", so it has no
// shift to lose), a named key that is always Enter whatever was asked for, a CDP
// event stream missing its releases or its `char`, or a `typed` echo that drops
// the key name. Those are pinned here, against literal expectations — never
// against the same map the code reads, which any value in that map would
// satisfy.
//
// The unknown-key 400 is pinned here too, WITH the offending name: it is what a
// caller needs to retry, and a bare `/Unknown key/` prefix leaves stripping it
// green. Only the two backends that throw from their own module are covered
// here — android's name is pinned in keyboard-android.test.ts and vega's in
// vega-injection.test.ts, since this file mocks `injectVegaNamedKey`, which is
// where vega's throw lives.
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
        ...HEAL,
        ["Down", HID_H],
        ["Up", HID_H],
        ["Down", HID_I],
        ["Up", HID_I],
      ]);
      expect(result).toEqual({ typed: "hi", keys: 2 });
    });

    it("sends nothing at all when one character is un-typeable", async () => {
      // All-or-nothing, and deliberately so: this backend resolves EVERY
      // character before its first device write. Validating per character
      // inside the dispatch loop instead — the shape this had before `clear`
      // existed — would let `{ clear, text }` empty the field and then reject
      // on character 4, leaving a fragment where the caller's original value
      // used to be. A 400 must never leave the caller worse off than before
      // the call, so the pre-check is what makes `clear` safe to combine.
      //
      // The empty stream is the assertion: not even the modifier heal goes out,
      // because that is the first device write and it sits AFTER validation.
      const { events, api } = hidRecorder();

      await expect(
        typeSimulatorServer(registryWith(api), IOS_SIM, {
          udid: IOS_SIM.id,
          text: "hé",
          delayMs: 0,
        })
      ).rejects.toThrow(/No keycode for character "é"/);

      expect(events).toEqual([]);
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
        ...HEAL,
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
      expect(events).toEqual([...HEAL, ["Down", code], ["Up", code]]);
      // The whole result, not just `keys`: with no text given, `typed` echoes
      // the key name, so `typed: params.text ?? ""` is caught here too.
      expect(result).toEqual({ typed: key, keys: 1 });
    });

    it("names the offending key when it is unknown, and presses nothing", async () => {
      const { events, api } = hidRecorder();

      await expect(
        typeSimulatorServer(registryWith(api), IOS_SIM, {
          udid: IOS_SIM.id,
          key: "bogus",
          delayMs: 0,
        })
      ).rejects.toThrow(/Unknown key "bogus"/);
      expect(events).toEqual([]);
    });
  });

  describe("chromium", () => {
    it("emits the whole keyDown/char/keyUp triple per character, in order", async () => {
      const { events, api } = cdpRecorder();

      // "Hi", not "hi": with an all-lowercase fixture a `.toLowerCase()` on the
      // way to `charToChromiumKey` emits the same stream, and neither `typed`
      // (which echoes the unmutated request) nor `keys` (a count) can see a
      // fold. That is the gap the sibling android test names — a case-sensitive
      // login field silently receiving `passw0rd` on the `{{secret:…}}` path.
      await makeChromiumImpl(registryWith(api)).handler(
        {},
        { udid: CHROMIUM.id, text: "Hi", delayMs: 0 },
        CHROMIUM
      );

      // The exact ordered stream, matching what the iOS section does with its
      // HID events. Three projections (keyDown->key, char->text, keyDown->key
      // for the named key) left four defect classes green against the whole
      // suite: deleting either keyUp dispatch, forcing every
      // `windowsVirtualKeyCode` to 0, and emitting `char` BEFORE `keyDown`.
      //
      // `char` carries the codepoint to the field, and the release matters to
      // any `keyup` listener. `windowsVirtualKeyCode` has its consequence
      // recorded at chromium-keys.ts:6-9 — apps on the deprecated keyCode API
      // (React Native Web's Pressable) see `keyCode === 0` and silently drop
      // the event — and no test under test/ asserted that field for this
      // backend.
      expect(events).toEqual([
        { type: "keyDown", ...CDP_H_UPPER },
        { type: "char", text: "H" },
        { type: "keyUp", ...CDP_H_UPPER },
        { type: "keyDown", ...CDP_I },
        { type: "char", text: "i" },
        { type: "keyUp", ...CDP_I },
      ]);
    });

    it("dispatches nothing at all when one character is un-typeable", async () => {
      // The mirror of the simulator-server case above: chromium also resolves
      // every character before its first dispatch, for the same reason — a
      // `{ clear, text }` that emptied the field and then rejected on character
      // 4 would leave a fragment where the original value was.
      const { events, api } = cdpRecorder();

      await expect(
        makeChromiumImpl(registryWith(api)).handler(
          {},
          { udid: CHROMIUM.id, text: "hé", delayMs: 0 },
          CHROMIUM
        )
      ).rejects.toThrow(/No CDP key descriptor for character "é"/);

      expect(events).toEqual([]);
    });

    // Two keys, for the same reason as the simulator-server pair above: pinning
    // only `enter` cannot separate "dispatches the key it was asked for" from a
    // branch that overwrites `named` with CHROMIUM_NAMED_KEYS.enter.
    it.each([
      ["enter", CDP_ENTER],
      ["escape", CDP_ESCAPE],
    ])("dispatches %s itself, not a hardcoded Enter", async (key, desc) => {
      const { events, api } = cdpRecorder();

      const result = await makeChromiumImpl(registryWith(api)).handler(
        {},
        { udid: CHROMIUM.id, key, delayMs: 0 },
        CHROMIUM
      );

      // Whole stream again: a dropped keyDown is a no-op for any `keydown` or
      // submit-on-Enter listener, and a dropped keyUp for any `keyup` one,
      // while both still answer a success shape. A named key emits no `char`
      // (chromium.ts:72-87) — pinning the exact pair records that too.
      expect(events).toEqual([
        { type: "keyDown", ...desc },
        { type: "keyUp", ...desc },
      ]);
      expect(result).toEqual({ typed: key, keys: 1 });
    });

    it("names the offending key when it is unknown, and dispatches nothing", async () => {
      const { events, api } = cdpRecorder();

      await expect(
        makeChromiumImpl(registryWith(api)).handler(
          {},
          { udid: CHROMIUM.id, key: "bogus", delayMs: 0 },
          CHROMIUM
        )
      ).rejects.toThrow(/Unknown key "bogus"/);
      expect(events).toEqual([]);
    });
  });

  // No android section: `adb shell input` is a command line rather than an event
  // stream, so keyboard-android.test.ts pins the exact strings there — including
  // the case-preservation property this file's iOS section covers as "shifts only
  // the character that needs it", which on android has no modifier to observe and
  // shows up only as the literal command line, and the unknown-key 400's name.

  // Every backend that holds state across awaits queues per device, so two
  // overlapping calls cannot land inside each other. iOS holds a modifier down
  // across its chord; android leaves the field SELECTED between the select-all
  // and the delete; chromium spreads the clear, the settle and one dispatch per
  // character over many CDP round trips. The android half is pinned in
  // keyboard-android.test.ts, against the adb command stream.
  describe("one run per device, chained", () => {
    it("does not interleave two overlapping chromium runs", async () => {
      // Measured on this branch before the chain covered chromium: two
      // `{ clear, text }` calls of `AAAA` and `BBBB` fired 0ms apart left
      // `ABABABAB` in the field, with BOTH returning 200, `cleared: true` and
      // their own four characters as `typed`. The mid-typing split check cannot
      // see it — the text did reach the targeted element, just not only that
      // call's text.
      const { events, api } = cdpRecorder();
      const impl = makeChromiumImpl(registryWith(api));

      await Promise.all([
        impl.handler({}, { udid: CHROMIUM.id, text: "HH", delayMs: 0 }, CHROMIUM),
        impl.handler({}, { udid: CHROMIUM.id, text: "ii", delayMs: 0 }, CHROMIUM),
      ]);

      // Unchained, the two typing loops suspend on alternate `sleep(delayMs)`
      // calls and this comes back H, i, H, i.
      expect(events.filter((e) => e.type === "char").map((e) => e.text)).toEqual([
        "H",
        "H",
        "i",
        "i",
      ]);
    });

    it("chains a run on ONE device without holding up another", async () => {
      // The queue is per device, not global: a slow run at one target must not
      // stall a second one elsewhere. Nothing releases the first call until the
      // test does, so the second can only finish if it took a different chain.
      const other: DeviceInfo = { id: "chromium-cdp-9333", platform: "chromium", kind: "app" };
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });

      const slow = makeChromiumImpl(registryWith({ dispatchKeyEvent: async () => held })).handler(
        {},
        { udid: CHROMIUM.id, text: "H", delayMs: 0 },
        CHROMIUM
      );
      const { events, api } = cdpRecorder();

      await makeChromiumImpl(registryWith(api)).handler(
        {},
        { udid: other.id, text: "i", delayMs: 0 },
        other
      );
      expect(events.filter((e) => e.type === "char")).toHaveLength(1);

      release();
      await slow;
    });

    it("leaves the chain immediately for a chromium call whose client has hung up", async () => {
      // Without this a queue of abandoned calls still types every one of them
      // out in full, at a page nobody is reading any more.
      const { events, api } = cdpRecorder();

      await expect(
        makeChromiumImpl(registryWith(api)).handler(
          {},
          { udid: CHROMIUM.id, text: "H", delayMs: 0 },
          CHROMIUM,
          { signal: AbortSignal.abort() }
        )
      ).rejects.toThrow();
      expect(events).toEqual([]);
    });
  });

  describe("vega", () => {
    it("injects the text it was given, and nothing else", async () => {
      // "Hi" for the same reason as the chromium fixture: an all-lowercase
      // string cannot separate "injects the text it was given" from "injects a
      // case-folded copy", at `vega.ts`'s call or inside `injectVegaText`.
      await vegaImpl.handler({}, { udid: VEGA.id, text: "Hi" }, VEGA);

      expect(vi.mocked(injectVegaText).mock.calls.map((c) => c[0])).toEqual(["Hi"]);
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
  });
});
