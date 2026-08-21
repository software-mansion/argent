import { describe, expect, it, vi } from "vitest";
import type { DeviceInfo } from "@argent/registry";

vi.mock("../src/utils/harmony-uitest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-uitest")>()),
  harmonyTypeText: vi.fn(async () => {}),
  harmonyKeyEvent: vi.fn(async () => {}),
  // The screen-awake guard reads the display first; stub it ON so these tests
  // exercise the key path, not the panel check.
  harmonyDisplay: vi.fn(async () => ({ width: 1216, height: 2688, screenOn: true })),
}));

import { harmonyImpl } from "../src/tools/keyboard/platforms/harmony";
import {
  HARMONY_INTERACTION_TIMEOUT_MS,
  harmonyDisplay,
  harmonyKeyEvent,
  harmonyTypeText,
} from "../src/utils/harmony-uitest";

const HARMONY_CONNECT_KEY = "025DEK236V035771";
const HARMONY: DeviceInfo = {
  id: `harmony-${HARMONY_CONNECT_KEY}`,
  platform: "harmony",
  kind: "device",
};

/** `uitest uiInput keyEvent` keyID for `enter`, watched submitting a real field. */
const HARMONY_ENTER_KEYID = "2054";

function clearTransport(): void {
  vi.mocked(harmonyDisplay).mockClear();
  vi.mocked(harmonyTypeText).mockClear();
  vi.mocked(harmonyKeyEvent).mockClear();
}

// The HarmonyOS backend reaches the device over `hdc`, so every assertion here
// is about what left the host: which connect key was addressed, which keyID was
// sent, and whether anything was sent at all. `keyboard-text-key-exclusive` and
// `keyboard-backend-fidelity` cover the shared contract; this file covers what
// only this platform has — a panel that can be suspended or uncomposited, and a
// keyID table `uitest` accepts silently whatever it means.
describe("keyboard on HarmonyOS", () => {
  it("addresses the connect key, not the prefixed device id, and types the text verbatim", async () => {
    clearTransport();

    // "Hi", not "hi": an all-lowercase fixture cannot separate "types what it
    // was given" from "types a case-folded copy", and neither `typed` (which
    // echoes the unmutated request) nor `keys` (a count) can see the fold —
    // the same reason the chromium and vega fidelity fixtures are mixed-case.
    const result = await harmonyImpl.handler({}, { udid: HARMONY.id, text: "Hi" }, HARMONY);

    expect(harmonyTypeText).toHaveBeenCalledWith(HARMONY_CONNECT_KEY, "Hi", expect.any(Number));
    expect(result).toEqual({ typed: "Hi", keys: 2 });
  });

  it("sends the keyID rather than the key name", async () => {
    clearTransport();

    await harmonyImpl.handler({}, { udid: HARMONY.id, key: "enter" }, HARMONY);

    // `uitest` names only Home/Back/Power and takes a raw number for everything
    // else, so a name reaching it is accepted and does nothing.
    expect(harmonyKeyEvent).toHaveBeenCalledWith(
      HARMONY_CONNECT_KEY,
      HARMONY_ENTER_KEYID,
      expect.any(Number)
    );
  });

  it("rejects an unknown key without touching the device", async () => {
    clearTransport();

    await expect(
      harmonyImpl.handler({}, { udid: HARMONY.id, key: "bogus" }, HARMONY)
    ).rejects.toThrow(/'bogus' is not available on HarmonyOS/);
    // The name check is pure, so an unreachable device cannot rewrite this 400
    // into a connection error about a key that will never be supported.
    expect(harmonyDisplay).not.toHaveBeenCalled();
    expect(harmonyKeyEvent).not.toHaveBeenCalled();
  });

  it("rejects un-typeable text without touching the device", async () => {
    clearTransport();

    await expect(
      harmonyImpl.handler({}, { udid: HARMONY.id, text: "a\nb" }, HARMONY)
    ).rejects.toThrow(/cannot type a newline/);
    expect(harmonyDisplay).not.toHaveBeenCalled();
    expect(harmonyTypeText).not.toHaveBeenCalled();
  });

  it("refuses to type while the display is suspended, injecting nothing", async () => {
    // `uitest uiInput text` answers `No Error` and exits 0 against a suspended
    // panel, so without the guard the call resolves `{ typed: "hi", keys: 2 }`
    // for characters that reached no field — the same refusal `gesture-tap`,
    // `gesture-swipe` and `button` make off this display read.
    clearTransport();
    vi.mocked(harmonyDisplay).mockResolvedValueOnce({
      width: 1216,
      height: 2688,
      screenOn: false,
    });

    await expect(
      harmonyImpl.handler({}, { udid: HARMONY.id, text: "hi" }, HARMONY)
    ).rejects.toThrow(/display is off/);
    expect(harmonyTypeText).not.toHaveBeenCalled();
  });

  it("refuses to type when the render service reports a 0x0 display", async () => {
    // A guest whose compositor has not come up answers `render resolution=0x0`.
    // `uitest uiInput text` would report `No Error` for characters that reached
    // no field, so this read is refused for typing exactly as it is for a tap.
    clearTransport();
    vi.mocked(harmonyDisplay).mockResolvedValueOnce({ width: 0, height: 0, screenOn: true });

    await expect(
      harmonyImpl.handler({}, { udid: HARMONY.id, key: "enter" }, HARMONY)
    ).rejects.toThrow(/0x0 display/);
    expect(harmonyKeyEvent).not.toHaveBeenCalled();
  });

  it("case-folds the named key, like every other backend", async () => {
    clearTransport();

    await harmonyImpl.handler({}, { udid: HARMONY.id, key: "Enter" }, HARMONY);

    expect(harmonyKeyEvent).toHaveBeenCalledWith(
      HARMONY_CONNECT_KEY,
      HARMONY_ENTER_KEYID,
      expect.any(Number)
    );
  });

  it("refuses a prototype key name instead of shelling it out", async () => {
    clearTransport();

    // `key` is a free string, so a bare index would resolve `constructor` to
    // `Object.prototype.constructor` and interpolate it, unquoted, into the
    // remote `uiInput keyEvent ${key}` line.
    for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      await expect(harmonyImpl.handler({}, { udid: HARMONY.id, key }, HARMONY)).rejects.toThrow(
        /is not available on HarmonyOS/
      );
    }
    expect(harmonyKeyEvent).not.toHaveBeenCalled();
  });

  it("sends each supported key its own measured keyID", async () => {
    // Literal keyIDs, not the source table: `uitest` answers `No Error` to any
    // number it is handed, so a swapped pair would invert the arrows on a real
    // device and nothing else in the suite would notice. Each was watched
    // against a text field on a HarmonyOS 6.0.1 handset.
    const expected: Record<string, string> = {
      "enter": "2054",
      "backspace": "2055",
      "space": "2050",
      "arrow-left": "2014",
      "arrow-right": "2015",
      // The aliases iOS and Android take for these two. A step that spells the
      // submit key `return` runs on both of them and must not stop here.
      "return": "2054",
      "delete": "2055",
    };

    for (const [key, keyId] of Object.entries(expected)) {
      vi.mocked(harmonyKeyEvent).mockClear();
      await harmonyImpl.handler({}, { udid: HARMONY.id, key }, HARMONY);
      expect(harmonyKeyEvent, key).toHaveBeenCalledWith(
        HARMONY_CONNECT_KEY,
        keyId,
        expect.any(Number)
      );
    }
  });

  it("no-ops on an empty request (neither key nor text), with zero device traffic", async () => {
    // The schema leaves both `key` and `text` optional with no refinement, so an
    // empty request is a no-op returning { typed:"", keys:0 } — the same
    // contract every other keyboard backend follows. Reaching the device first
    // costs a round trip for a step that injects nothing, and fails the whole
    // sequence when the panel happens to be suspended.
    clearTransport();

    const result = await harmonyImpl.handler({}, { udid: HARMONY.id }, HARMONY);

    expect(result).toEqual({ typed: "", keys: 0 });
    expect(harmonyDisplay).not.toHaveBeenCalled();
    expect(harmonyTypeText).not.toHaveBeenCalled();
    expect(harmonyKeyEvent).not.toHaveBeenCalled();
  });

  it("spends ONE budget across the display read and the injection it feeds", async () => {
    // A leg handed a fresh ceiling puts the pair at 40s, and the MCP client
    // aborts at 30s and REPLAYS — retyping into a field it cannot see. So the
    // injection is charged what the display read left, not a ceiling of its own.
    const LEG_MS = 60;
    clearTransport();
    vi.mocked(harmonyDisplay).mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, LEG_MS));
      return { width: 1216, height: 2688, screenOn: true };
    });

    await harmonyImpl.handler({}, { udid: HARMONY.id, text: "hi" }, HARMONY);

    const textBudget = vi.mocked(harmonyTypeText).mock.calls[0][2];
    // Half a leg of tolerance, not the millisecond: `setTimeout` can fire a
    // touch early. What has to discriminate is a leg handed a FRESH ceiling.
    expect(textBudget).toBeLessThan(HARMONY_INTERACTION_TIMEOUT_MS - LEG_MS / 2);
    expect(textBudget).toBeGreaterThan(0);
  });
});
