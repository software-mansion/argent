import { describe, expect, it, vi, beforeEach } from "vitest";
import { FAILURE_CODES, getFailureSignal, type DeviceInfo } from "@argent/registry";
import {
  CLEAR_KEY_CADENCE_MS,
  CLEAR_SETTLE_MS,
  clearSimulatorServer,
  typeSimulatorServer,
} from "../src/tools/keyboard/simulator-server-keys";
import {
  CLEAR_FOCUSED_EDITABLE_SCRIPT,
  makeChromiumImpl,
} from "../src/tools/keyboard/platforms/chromium";
import { vegaImpl } from "../src/tools/keyboard/platforms/vega";
import { UnsupportedOperationError } from "../src/utils/capability";
import { CLEAR_KEY_PAIRS, FORWARD_DELETE_KEYCODE } from "../src/tools/keyboard/key-codes";

vi.mock("../src/utils/vega-input", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/vega-input")>()),
  injectVegaText: vi.fn(async () => {}),
  injectVegaNamedKey: vi.fn(async () => {}),
}));

// Both ios branches probe the runtime kind by shelling out; stub them so the
// routing tests below are not host-dependent. Three-valued, as the impls read
// them: `undefined` is "the listing did not answer", which is a different
// verdict from "mobile".
type RuntimeKind = "mobile" | "tv" | undefined;
const { getRemoteSimulatorRuntimeKind } = vi.hoisted(() => ({
  getRemoteSimulatorRuntimeKind: vi.fn(async (_udid: string): Promise<RuntimeKind> => "mobile"),
}));
vi.mock("../src/utils/sim-remote", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/sim-remote")>()),
  getRemoteSimulatorRuntimeKind,
}));
const { getSimulatorRuntimeKind } = vi.hoisted(() => ({
  getSimulatorRuntimeKind: vi.fn(async (_udid: string): Promise<RuntimeKind> => "mobile"),
}));
vi.mock("../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-devices")>()),
  getSimulatorRuntimeKind,
}));

import { injectVegaNamedKey, injectVegaText } from "../src/utils/vega-input";
import { makeIosImpl, makeIosRemoteImpl } from "../src/tools/keyboard/platforms/ios";

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
// Keyboard DELETE/Backspace (0x2A) and Keyboard DELETE Forward (0x4C) — the two
// keys the `clear` burst pairs, again as literals.
const HID_BACKSPACE = 42;
const HID_FORWARD_DELETE = 76;

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
const CDP_H = { key: "h", code: "KeyH", windowsVirtualKeyCode: 72 };
const CDP_H_UPPER = { key: "H", code: "KeyH", windowsVirtualKeyCode: 72 };
const CDP_I = { key: "i", code: "KeyI", windowsVirtualKeyCode: 73 };
const CDP_ENTER = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
const CDP_ESCAPE = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 };

// Single-parameter fidelity: does each backend emit exactly the action it was
// given? Every request here carries exactly ONE of `text`, `key` and `clear` —
// the tool rejects any combination of them (keyboard-text-key-exclusive.test.ts),
// so one action per call is the only shape a backend ever sees, and there is no
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
        ["Down", HID_H],
        ["Up", HID_H],
        ["Down", HID_I],
        ["Up", HID_I],
      ]);
      expect(result).toEqual({ typed: "hi", keys: 2 });
    });

    it("leaves the characters before an un-typeable one on the device", async () => {
      // This backend validates per character inside the dispatch loop, so a
      // rejection is NOT all-or-nothing: "h" is already pressed when "é"
      // throws. The tool description tells agents exactly that, and nothing
      // pinned it in either direction — hoisting a whole-string pre-check up
      // here (the other reasonable design, and what Android/Vega/TV do) was
      // green across the whole suite while making the description false.
      const { events, api } = hidRecorder();

      await expect(
        typeSimulatorServer(registryWith(api), IOS_SIM, {
          udid: IOS_SIM.id,
          text: "hé",
          delayMs: 0,
        })
      ).rejects.toThrow(/No keycode for character "é"/);

      expect(events).toEqual([
        ["Down", HID_H],
        ["Up", HID_H],
      ]);
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

    it("clears with an exact alternating backspace / forward-delete burst", async () => {
      const { events, api } = hidRecorder();

      const result = await clearSimulatorServer(registryWith(api), IOS_SIM);

      // The whole ordered stream, built independently of the code under test.
      // Both directions have to be there and they have to alternate: a burst of
      // backspaces alone leaves everything ahead of the caret (the field looks
      // cleared in a screenshot taken with the caret at the end), and a grouped
      // 100+100 burst diverges from this one exactly at the documented
      // 100-character boundary.
      const expected: Array<[string, number]> = [];
      for (let i = 0; i < CLEAR_KEY_PAIRS; i++) {
        expected.push(["Down", HID_BACKSPACE], ["Up", HID_BACKSPACE]);
        expected.push(["Down", HID_FORWARD_DELETE], ["Up", HID_FORWARD_DELETE]);
      }
      expect(events).toEqual(expected);
      expect(result).toEqual({ typed: "", keys: CLEAR_KEY_PAIRS * 2, cleared: true });
    });

    it("holds no modifier anywhere in the burst", async () => {
      // The reason the burst is delete keys and not Cmd+A: `pressKey` is
      // fire-and-forget and this backend awaits between presses, so a held
      // Left-GUI outlives any throw in between and latches — a later
      // `{ text: "w" }` then becomes Cmd+W and closes the simulator window.
      // Stated separately from the exact-stream assertion above so the reason
      // survives a rewrite of the expectation.
      const { events, api } = hidRecorder();
      await clearSimulatorServer(registryWith(api), IOS_SIM);
      expect(events.some(([, code]) => code === HID_LEFT_SHIFT)).toBe(false);
      // Left GUI (0xE3) / Left Ctrl (0xE0) — the two select-all chords.
      expect(events.some(([, code]) => code === 227 || code === 224)).toBe(false);
    });

    it("releases every key it presses (no stuck auto-repeat)", async () => {
      // A Down without its Up leaves the guest repeating that key for as long
      // as the simulator lives, which on a delete key empties whatever is
      // focused next. The exact-stream test would catch it, but only as one
      // diff among 400 events; this states the property.
      const { events, api } = hidRecorder();
      await clearSimulatorServer(registryWith(api), IOS_SIM);
      const downs = events.filter(([d]) => d === "Down").length;
      const ups = events.filter(([d]) => d === "Up").length;
      expect(downs).toBe(CLEAR_KEY_PAIRS * 2);
      expect(ups).toBe(downs);
    });

    it("pins the forward-delete usage id (0x4C) against the shared constant", () => {
      // `FORWARD_DELETE_KEYCODE` is the only HID code in the tool with no name
      // in `NAMED_KEYS`, so nothing else in the suite would notice it drifting
      // to, say, 42 — which would turn the burst into backspaces alone and
      // leave every field's tail behind while every other assertion stayed
      // green.
      expect(FORWARD_DELETE_KEYCODE).toBe(0x4c);
      expect(FORWARD_DELETE_KEYCODE).not.toBe(HID_BACKSPACE);
    });

    it("sends the literal 200 key presses the tool description promises", async () => {
      // Every other assertion here is written as `CLEAR_KEY_PAIRS * 2`, so
      // setting the constant to 3 leaves them all green — while "100
      // backspaces... 100 forward-deletes" and "`keys` is 200" are caller-facing
      // contract in the parameter description, the tool description, the
      // run-sequence table and the docs. This is the only place the number
      // itself is stated.
      expect(CLEAR_KEY_PAIRS).toBe(100);
      const { events, api } = hidRecorder();
      const result = await clearSimulatorServer(registryWith(api), IOS_SIM);
      expect(result.keys).toBe(200);
      expect(events.length).toBe(400);
    });

    it("stops the burst when the request is aborted, and does not claim a clear", async () => {
      // The HTTP layer aborts on client disconnect, and run-sequence and a flow
      // run pass their own signal down. `gesture-swipe` already honours it for
      // the same shape, and for the reason quoted there: without it a cancelled
      // call keeps driving the device for the rest of the burst, its deletions
      // landing in whatever is sent to that device next. Measured on a booted
      // simulator against a 250-character field: a client gone at 150ms left the
      // full 100 deletions running, and now leaves 34.
      const { events, api } = hidRecorder();
      const controller = new AbortController();
      const pending = clearSimulatorServer(registryWith(api), IOS_SIM, controller.signal);
      await new Promise((r) => setTimeout(r, 25));
      controller.abort();
      const result = await pending;

      expect(events.length).toBeGreaterThan(0);
      expect(events.length).toBeLessThan(400);
      // `keys` reports what was actually sent, and `cleared` is absent: the
      // field is emptied by however many keys got through, which is exactly the
      // state that claim must not be made for.
      expect(result.keys).toBe(events.length / 2);
      expect(result.cleared).toBeUndefined();
    });

    it("a burst the transport stops accepting is NOT reported as a clear", async () => {
      // `pressKey` is fire-and-forget over the simulator-server's stdin pipe, so
      // a helper process that dies mid-burst (a concurrent
      // `stop-simulator-server`, a simulator shutdown, a crash) used to leave
      // the loop writing into nothing and the tool answering
      // `{ keys: 200, cleared: true }`. Measured on a booted simulator: `kill -9`
      // 50ms in delivered 9 of 200 keys against a 250-character field.
      //
      // Re-stated like the Android sibling, because the burst is not atomic: an
      // agent told only "the helper process is gone" reads that as "nothing
      // happened" and types over a field that is now shorter.
      const { events, api } = hidRecorder();
      let sent = 0;
      const dying = {
        ...api,
        pressKey: (direction: "Down" | "Up", keyCode: number) => {
          if (++sent > 20) throw new Error("the simulator-server input pipe closed");
          api.pressKey(direction, keyCode);
        },
      };
      const err = await clearSimulatorServer(registryWith(dying), IOS_SIM).then(
        () => undefined,
        (e: unknown) => e as Error
      );
      const signal = getFailureSignal(err);
      expect(signal?.error_code).toBe(FAILURE_CODES.KEYBOARD_CLEAR_UNCONFIRMED);
      expect(signal?.failure_stage).toBe("keyboard_clear_simulator_burst");
      expect(err?.message).toMatch(/PARTIALLY emptied/);
      // It stopped where the transport did rather than writing the rest.
      expect(events.length).toBe(20);
    });

    it("settles after the burst, so the auto-screenshot cannot race the deletions", async () => {
      // `pressKey` is fire-and-forget, so the burst returns before the app has
      // drained it. Without the settle, the tool's auto-screenshot is taken
      // mid-clear and hands back a picture of a field still emptying — and
      // nothing else in the suite goes red when the `await sleep(...)` is
      // deleted. Timed rather than mocked: a fake-timer version passes against
      // a settle of zero.
      const { api } = hidRecorder();
      const started = Date.now();
      await clearSimulatorServer(registryWith(api), IOS_SIM);
      const elapsed = Date.now() - started;
      // 200 cadence gaps (2ms each) plus the 300ms settle. Bounded below by
      // their SUM, so dropping either one goes red: without the settle the burst
      // finishes in ~400ms, and without the cadence in ~300ms.
      expect(elapsed).toBeGreaterThanOrEqual(650);
      // The sum alone cannot separate them: a cadence of 5 and a settle of 1000
      // each keep it green, and this settle-named case would go red for a
      // cadence change. Both values are their own decision — the cadence is what
      // keeps a 400-line write in order on a loaded host, the settle is what
      // keeps the auto-screenshot off a field still emptying — so both are
      // pinned outright.
      expect(CLEAR_KEY_CADENCE_MS).toBe(2);
      expect(CLEAR_SETTLE_MS).toBe(300);
      // And it is their sum this measured: 200 gaps plus one settle.
      expect(CLEAR_KEY_PAIRS * 2 * CLEAR_KEY_CADENCE_MS + CLEAR_SETTLE_MS).toBe(700);
    });
  });

  // `clear` is a switch, not a payload: `false` means what omitting it means, as
  // its own `.describe()` says. The guard in ../index.ts pins that for the
  // REQUEST shape, but it sends every shape to one android udid — so each
  // backend's own `params.clear === true` is unpinned, and widening any of them
  // to `!== undefined` (the natural symmetry with `text`) makes `{ clear: false }`
  // delete a field.
  describe("`clear: false` is an omitted clear on every backend", () => {
    it("chromium: dispatches nothing and evaluates nothing", async () => {
      const { events, api } = cdpRecorder();
      const evaluate = vi.fn(async () => ({ cleared: true }));
      const result = await makeChromiumImpl(registryWith({ ...api, evaluate })).handler(
        {},
        { udid: CHROMIUM.id, clear: false },
        CHROMIUM
      );
      expect(result).toEqual({ typed: "", keys: 0 });
      expect(events).toEqual([]);
      expect(evaluate).not.toHaveBeenCalled();
    });

    it("iOS simulator: presses no key", async () => {
      // Through `.handler`, not through `typeSimulatorServer`: that function
      // never reads `params.clear` at all (the decision lives in
      // platforms/ios.ts `runSimulatorServer`), so calling it directly proved
      // nothing — make the widening this block names and it stays green while
      // `{ clear: false }` fires a 200-key burst at a simulator. The chromium
      // and ios-remote siblings already go through their handlers.
      const { events, api } = hidRecorder();
      const result = await makeIosImpl(registryWith(api)).handler(
        {},
        { udid: IOS_SIM.id, clear: false },
        IOS_SIM
      );
      expect(result).toEqual({ typed: "", keys: 0 });
      expect(events).toEqual([]);
    });

    it("vega: injects nothing", async () => {
      const result = await vegaImpl.handler({}, { udid: VEGA.id, clear: false }, VEGA);
      expect(result).toEqual({ typed: "", keys: 0 });
      expect(injectVegaText).not.toHaveBeenCalled();
      expect(injectVegaNamedKey).not.toHaveBeenCalled();
    });
  });

  // The LOCAL Apple TV route, which no test reached: `makeIosImpl` appeared in
  // none, and the kind probe was pinned non-TV everywhere — so hoisting
  // `params.clear === true` above the probe would have aimed the 400-event burst
  // at a tvOS simulator with the whole suite green. (The route itself is
  // correct: on a real tvOS 26.5 simulator `clear` and `key` are both refused
  // with TOOL_CAPABILITY_UNSUPPORTED_OPERATION while `text` types.)
  describe("ios — the local Apple TV route", () => {
    const APPLE_TV: DeviceInfo = { id: "TVOS-UDID", platform: "ios", kind: "simulator" };

    it("refuses a clear on a tvOS simulator instead of bursting at it", async () => {
      getSimulatorRuntimeKind.mockResolvedValueOnce("tv");
      const { events, api } = hidRecorder();
      await expect(
        makeIosImpl(registryWith(api)).handler({}, { udid: APPLE_TV.id, clear: true }, APPLE_TV)
      ).rejects.toBeInstanceOf(UnsupportedOperationError);
      expect(events).toEqual([]);
    });

    it("refuses a named key on one too", async () => {
      getSimulatorRuntimeKind.mockResolvedValueOnce("tv");
      const { events, api } = hidRecorder();
      await expect(
        makeIosImpl(registryWith(api)).handler({}, { udid: APPLE_TV.id, key: "enter" }, APPLE_TV)
      ).rejects.toBeInstanceOf(UnsupportedOperationError);
      expect(events).toEqual([]);
    });

    it("probes the kind BEFORE it looks at `clear`", async () => {
      // The ordering is the whole guard: `clear` routed above the probe reaches
      // `clearSimulatorServer`, which resolves the simulator-server for a device
      // it cannot drive and bursts at it.
      getSimulatorRuntimeKind.mockClear();
      getSimulatorRuntimeKind.mockResolvedValue("mobile");
      const { api } = hidRecorder();
      await makeIosImpl(registryWith(api)).handler({}, { udid: IOS_SIM.id, clear: true }, IOS_SIM);
      expect(getSimulatorRuntimeKind).toHaveBeenCalledWith(IOS_SIM.id);
    });

    it("refuses a clear when the listing cannot say what the target is", async () => {
      // `undefined` is not "not a TV": `getSimulatorRuntimeKind` answers it for a
      // UDID missing from the listing, and `listIosSimulators` returns [] on ANY
      // failure of `xcrun simctl list devices --json`, its own 10s timeout
      // included. Collapsed onto `false`, a booted Apple TV took the burst and
      // the caller was told `{ keys: 200, cleared: true }` — reproduced on a
      // tvOS 26.5 simulator filtered out of the listing, with simulator-server
      // spawned at the tvOS UDID.
      getSimulatorRuntimeKind.mockResolvedValueOnce(undefined);
      const { events, api } = hidRecorder();
      const err = await makeIosImpl(registryWith(api))
        .handler({}, { udid: APPLE_TV.id, clear: true }, APPLE_TV)
        .then(
          () => undefined,
          (e: unknown) => e as Error
        );
      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.KEYBOARD_TARGET_KIND_UNKNOWN);
      expect(getFailureSignal(err)?.failure_stage).toBe("keyboard_ios_runtime_kind");
      expect(events).toEqual([]);
    });

    it("still types when the listing cannot say what the target is", async () => {
      // The refusal is scoped to `clear`. `text` reaches an Apple TV through the
      // same simulator-server HID transport it uses on a phone, so an unreadable
      // listing must not take typing away with it.
      getSimulatorRuntimeKind.mockResolvedValueOnce(undefined);
      const { events, api } = hidRecorder();
      const result = await makeIosImpl(registryWith(api)).handler(
        {},
        { udid: IOS_SIM.id, text: "hi", delayMs: 0 },
        IOS_SIM
      );
      expect(result).toEqual({ typed: "hi", keys: 2 });
      expect(events.length).toBeGreaterThan(0);
    });

    it("still types on a non-TV simulator", async () => {
      // The positive control: a probe that answered `true` for everything would
      // satisfy the two refusals above on its own.
      const { events, api } = hidRecorder();
      const result = await makeIosImpl(registryWith(api)).handler(
        {},
        { udid: IOS_SIM.id, text: "hi", delayMs: 0 },
        IOS_SIM
      );
      expect(result).toEqual({ typed: "hi", keys: 2 });
      expect(events.length).toBeGreaterThan(0);
    });
  });

  // The ios and ios-remote impls share one `runSimulatorServer`, and the remote
  // one is reached by no other test in the suite: reverting it to
  // `typeSimulatorServer` — deleting the clear routing for every remote sim —
  // breaks nothing, and `{ clear: true }` then returns `{ typed: "", keys: 0 }`
  // with no `cleared`, having sent nothing at all.
  describe("ios-remote", () => {
    const IOS_REMOTE: DeviceInfo = {
      id: "remote:REMOTE-UDID",
      platform: "ios-remote",
      kind: "simulator",
    };

    it("clears over the same HID transport as a local simulator", async () => {
      const { events, api } = hidRecorder();
      const registry = registryWith(api);
      const result = await makeIosRemoteImpl(registry).handler(
        {},
        { udid: IOS_REMOTE.id, clear: true },
        IOS_REMOTE
      );
      expect(result).toEqual({ typed: "", keys: CLEAR_KEY_PAIRS * 2, cleared: true });
      expect(events.length).toBe(CLEAR_KEY_PAIRS * 4);
      expect(events.slice(0, 4)).toEqual([
        ["Down", HID_BACKSPACE],
        ["Up", HID_BACKSPACE],
        ["Down", HID_FORWARD_DELETE],
        ["Up", HID_FORWARD_DELETE],
      ]);
    });

    it("treats `{ clear: false }` as an omitted clear, sending nothing", async () => {
      const { events, api } = hidRecorder();
      const result = await makeIosRemoteImpl(registryWith(api)).handler(
        {},
        { udid: IOS_REMOTE.id, clear: false },
        IOS_REMOTE
      );
      expect(result).toEqual({ typed: "", keys: 0 });
      expect(events).toEqual([]);
    });

    it("refuses a clear on a REMOTE tvOS simulator instead of bursting at it", async () => {
      // A remote tvOS sim is `ios-remote` by udid shape exactly as a local one is
      // `ios`, so without the probe a remote Apple TV took the 400-event burst —
      // the one thing platforms/tv.ts documents as unsupported on a TV.
      getRemoteSimulatorRuntimeKind.mockResolvedValueOnce("tv");
      const { events, api } = hidRecorder();
      await expect(
        makeIosRemoteImpl(registryWith(api)).handler(
          {},
          { udid: IOS_REMOTE.id, clear: true },
          IOS_REMOTE
        )
      ).rejects.toBeInstanceOf(UnsupportedOperationError);
      expect(events).toEqual([]);
    });

    it("refuses a remote clear when the device list cannot say what the target is", async () => {
      // The remote listing collapses the same way the local one does — a failed
      // `sim-remote simctl list devices --json`, or one without this UDID, is
      // indistinguishable from a phone unless the kind is read three-valued.
      getRemoteSimulatorRuntimeKind.mockResolvedValueOnce(undefined);
      const { events, api } = hidRecorder();
      const err = await makeIosRemoteImpl(registryWith(api))
        .handler({}, { udid: IOS_REMOTE.id, clear: true }, IOS_REMOTE)
        .then(
          () => undefined,
          (e: unknown) => e as Error
        );
      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.KEYBOARD_TARGET_KIND_UNKNOWN);
      expect(events).toEqual([]);
    });

    it("does not probe the TV kind for a plain typing call", async () => {
      // The probe is a round-trip to the orchestrator's device list. `text`
      // keeps the transport it already had, so it must not pay for it.
      getRemoteSimulatorRuntimeKind.mockClear();
      const { api } = hidRecorder();
      await makeIosRemoteImpl(registryWith(api)).handler(
        {},
        { udid: IOS_REMOTE.id, text: "hi", delayMs: 0 },
        IOS_REMOTE
      );
      expect(getRemoteSimulatorRuntimeKind).not.toHaveBeenCalled();
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

    it("leaves the characters before an un-typeable one on the device", async () => {
      // The mirror of the simulator-server case above: chromium also validates
      // per character inside the loop, so the whole triple for "h" is already
      // dispatched when "é" throws.
      const { events, api } = cdpRecorder();

      await expect(
        makeChromiumImpl(registryWith(api)).handler(
          {},
          { udid: CHROMIUM.id, text: "hé", delayMs: 0 },
          CHROMIUM
        )
      ).rejects.toThrow(/No CDP key descriptor for character "é"/);

      expect(events).toEqual([
        { type: "keyDown", ...CDP_H },
        { type: "char", text: "h" },
        { type: "keyUp", ...CDP_H },
      ]);
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

    it("marks a Chromium clear as verified, and the key backends as not", async () => {
      // `cleared` means two different things — "sent" on the key backends,
      // "seen empty" here — and the only discriminator in the result was `keys`
      // (0 vs 200), which is documented as the count of key presses issued, not
      // as a verification flag. A flow assertion or a caller branching on the
      // result had nothing structural to read.
      const { api } = cdpRecorder();
      const evaluate = vi.fn(async (_expr: string, _opts?: unknown) =>
        _expr === CLEAR_FOCUSED_EDITABLE_SCRIPT
          ? { cleared: true, focus: "input type=text" }
          : { focus: "input type=text", same: true, changed: false, remaining: 0, embeds: 0 }
      );
      const chromium = await makeChromiumImpl(registryWith({ ...api, evaluate })).handler(
        {},
        { udid: CHROMIUM.id, clear: true },
        CHROMIUM
      );
      expect(chromium).toEqual({ typed: "", keys: 0, cleared: true, clearVerified: true });

      // The key backends send a fixed burst and read nothing, so the flag must
      // be ABSENT there rather than false — the claim is not made at all.
      const ios = await clearSimulatorServer(registryWith(hidRecorder().api), IOS_SIM);
      expect(ios).toEqual({ typed: "", keys: CLEAR_KEY_PAIRS * 2, cleared: true });
      expect(ios.clearVerified).toBeUndefined();
    });

    it("clears through TWO renderer evaluations and no key events at all", async () => {
      const { events, api } = cdpRecorder();
      const evaluate = vi.fn(async (_expr: string, _opts?: unknown) =>
        _expr === CLEAR_FOCUSED_EDITABLE_SCRIPT
          ? { cleared: true, focus: "input type=text" }
          : { focus: "input type=text", same: true, remaining: 0 }
      );

      const result = await makeChromiumImpl(registryWith({ ...api, evaluate })).handler(
        {},
        { udid: CHROMIUM.id, clear: true },
        CHROMIUM
      );

      // No key events is the point, not an accident of the transport: a
      // modifier-only Meta+A / Ctrl+A selects nothing in a Chromium renderer on
      // macOS, and a 200-key delete burst would deliver 200 keydowns to a page
      // whose own shortcut handler can cancel them. The DOM path delivers
      // one `input` event (inputType deleteContentBackward) and no keydown.
      expect(events).toEqual([]);
      // Two, and they must be two SEPARATE evaluates: an editor that restores
      // its model does so at the microtask checkpoint that ends the first one,
      // so a read-back folded into the clear script sees the emptied field and
      // reports a clear that did not survive.
      expect(evaluate).toHaveBeenCalledTimes(2);
      expect(evaluate.mock.calls[0]![0]).toBe(CLEAR_FOCUSED_EDITABLE_SCRIPT);
      expect(evaluate.mock.calls[1]![0]).not.toBe(CLEAR_FOCUSED_EDITABLE_SCRIPT);
      // `returnByValue` is load-bearing on both: without it CDP answers the
      // script's object as a RemoteObject handle with `value` undefined, the
      // backend reads no `cleared: true`, and every successful clear reports the
      // "nothing editable has focus" 400.
      expect(evaluate.mock.calls[0]![1]).toEqual({ returnByValue: true });
      expect(evaluate.mock.calls[1]![1]).toEqual({ returnByValue: true });
      // `keys: 0` — the count reports key events sent, and this backend sends
      // none. `clearVerified` is what says the field was SEEN empty, which is
      // the claim only this backend can make.
      expect(result).toEqual({ typed: "", keys: 0, cleared: true, clearVerified: true });
    });
  });

  // No android section: `adb shell input` is a command line rather than an event
  // stream, so keyboard-android.test.ts pins the exact strings there — including
  // the case-preservation property this file's iOS section covers as "shifts only
  // the character that needs it", which on android has no modifier to observe and
  // shows up only as the literal command line, and the unknown-key 400's name.

  describe("vega", () => {
    it("injects the text it was given, and nothing else", async () => {
      // "Hi" for the same reason as the chromium fixture: an all-lowercase
      // string cannot separate "injects the text it was given" from "injects a
      // case-folded copy", at `vega.ts`'s call or inside `injectVegaText`.
      await vegaImpl.handler({}, { udid: VEGA.id, text: "Hi" }, VEGA);

      expect(vi.mocked(injectVegaText).mock.calls.map((c) => c[0])).toEqual(["Hi"]);
      expect(injectVegaNamedKey).not.toHaveBeenCalled();
    });

    it("rejects `clear` outright, injecting nothing", async () => {
      // Vega has no measured delete transport: `inputd-cli` may be able to send
      // KEY_BACKSPACE, but nothing has verified it on a VVD, and a clear that
      // silently removes one character is worse than a refusal. Pinned here
      // rather than only in the taxonomy file so the "injects nothing" half is
      // observable on the same recorder the positive controls use.
      await expect(
        vegaImpl.handler({}, { udid: VEGA.id, clear: true }, VEGA)
      ).rejects.toBeInstanceOf(UnsupportedOperationError);
      expect(injectVegaText).not.toHaveBeenCalled();
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
