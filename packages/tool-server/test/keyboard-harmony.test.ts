import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceInfo } from "@argent/registry";

// Only the hdc transport is faked, so the assertions here are about what left
// the host — which connect key was addressed, which keyID was sent, and whether
// anything was sent at all — while `harmonyDisplay` stays real behind it,
// parsing whatever dump the fake serves.
vi.mock("../src/utils/harmony-hdc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-hdc")>()),
  runHdcShell: vi.fn(),
}));

import { harmonyImpl } from "../src/tools/keyboard/platforms/harmony";
import { runHdcShell as realRunHdcShell } from "../src/utils/harmony-hdc";
import { HARMONY_INTERACTION_TIMEOUT_MS } from "../src/utils/harmony-uitest";

const runHdcShell = vi.mocked(realRunHdcShell);

const HARMONY_CONNECT_KEY = "025DEK236V035771";
const HARMONY: DeviceInfo = {
  id: `harmony-${HARMONY_CONNECT_KEY}`,
  platform: "harmony",
  kind: "device",
};

/** `uitest uiInput keyEvent` keyID for `enter`, watched submitting a real field. */
const HARMONY_ENTER_KEYID = "2054";

/**
 * What `hidumper -s RenderService -a screen` prints, in the shape measured on a
 * HarmonyOS 6.1.1 guest: one `screen[N]:` line per panel carrying BOTH the power
 * state and the size — the pair `harmonyDisplay` parses off that one line.
 */
function screenDump(power = "POWER_STATUS_ON", size = "1216x2688"): string {
  return (
    `-- ScreenInfo\nscreen[0]: id=0, powerStatus=${power}, backlight=1, ` +
    `screenType=EXTERNAL_TYPE, render resolution=${size}, physical resolution=${size}, ` +
    `isVirtual=false`
  );
}

/** The `uitest uiInput …` lines typing put on the wire. */
const uiInputs = () =>
  runHdcShell.mock.calls.filter(([, command]) => command.startsWith("uitest uiInput"));

beforeEach(() => {
  runHdcShell.mockReset();
  runHdcShell.mockImplementation(async (_connectKey, command) =>
    command.startsWith("hidumper")
      ? { stdout: screenDump(), exitCode: 0 }
      : { stdout: "", exitCode: 0 }
  );
});

// The HarmonyOS backend reaches the device over `hdc`, so every assertion here
// is about what left the host. `keyboard-text-key-exclusive` and
// `keyboard-backend-fidelity` cover the shared contract; this file covers what
// only this platform has — a panel that can be suspended or uncomposited, and a
// keyID table `uitest` accepts silently whatever it means.
describe("keyboard on HarmonyOS", () => {
  it("addresses the connect key, not the prefixed device id, and types the text verbatim", async () => {
    // "Hi", not "hi": an all-lowercase fixture cannot separate "types what it
    // was given" from "types a case-folded copy", and neither `typed` (which
    // echoes the unmutated request) nor `keys` (a count) can see the fold —
    // the same reason the chromium and vega fidelity fixtures are mixed-case.
    const result = await harmonyImpl.handler({}, { udid: HARMONY.id, text: "Hi" }, HARMONY);

    const [connectKey, command] = uiInputs()[0] ?? [];
    expect([connectKey, command]).toEqual([HARMONY_CONNECT_KEY, "uitest uiInput text 'Hi'"]);
    expect(result).toEqual({ typed: "Hi", keys: 2 });
  });

  it("sends the keyID rather than the key name", async () => {
    await harmonyImpl.handler({}, { udid: HARMONY.id, key: "enter" }, HARMONY);

    // `uitest` names only Home/Back/Power and takes a raw number for everything
    // else, so a name reaching it is accepted and does nothing.
    expect(uiInputs()[0]?.[1]).toBe(`uitest uiInput keyEvent ${HARMONY_ENTER_KEYID}`);
  });

  it("rejects an unknown key without touching the device", async () => {
    await expect(
      harmonyImpl.handler({}, { udid: HARMONY.id, key: "bogus" }, HARMONY)
    ).rejects.toThrow(/'bogus' is not available on HarmonyOS/);
    // The name check is pure, so an unreachable device cannot rewrite this 400
    // into a connection error about a key that will never be supported.
    expect(runHdcShell).not.toHaveBeenCalled();
  });

  it("rejects un-typeable text without touching the device", async () => {
    await expect(
      harmonyImpl.handler({}, { udid: HARMONY.id, text: "a\nb" }, HARMONY)
    ).rejects.toThrow(/cannot type a newline/);
    expect(runHdcShell).not.toHaveBeenCalled();
  });

  it("refuses to type while the display is suspended, injecting nothing", async () => {
    // `uitest uiInput text` answers `No Error` and exits 0 against a suspended
    // panel, so without the guard the call resolves `{ typed: "hi", keys: 2 }`
    // for characters that reached no field — the same refusal `gesture-tap`,
    // `gesture-swipe` and `button` make off this display read.
    runHdcShell.mockImplementation(async (_connectKey, command) =>
      command.startsWith("hidumper")
        ? { stdout: screenDump("POWER_STATUS_SUSPEND"), exitCode: 0 }
        : { stdout: "", exitCode: 0 }
    );

    await expect(
      harmonyImpl.handler({}, { udid: HARMONY.id, text: "hi" }, HARMONY)
    ).rejects.toThrow(/display is off/);
    expect(uiInputs()).toHaveLength(0);
  });

  it("refuses to type when the render service reports a 0x0 display", async () => {
    // A guest whose compositor has not come up answers `render resolution=0x0`.
    // `uitest uiInput text` would report `No Error` for characters that reached
    // no field, so this read is refused for typing exactly as it is for a tap.
    runHdcShell.mockImplementation(async (_connectKey, command) =>
      command.startsWith("hidumper")
        ? { stdout: screenDump("POWER_STATUS_ON", "0x0"), exitCode: 0 }
        : { stdout: "", exitCode: 0 }
    );

    await expect(
      harmonyImpl.handler({}, { udid: HARMONY.id, key: "enter" }, HARMONY)
    ).rejects.toThrow(/0x0 display/);
    expect(uiInputs()).toHaveLength(0);
  });

  it("case-folds the named key, like every other backend", async () => {
    await harmonyImpl.handler({}, { udid: HARMONY.id, key: "Enter" }, HARMONY);

    expect(uiInputs()[0]?.[1]).toBe(`uitest uiInput keyEvent ${HARMONY_ENTER_KEYID}`);
  });

  it("refuses a prototype key name instead of shelling it out", async () => {
    // `key` is a free string, so a bare index would resolve `constructor` to
    // `Object.prototype.constructor` and interpolate it, unquoted, into the
    // remote `uiInput keyEvent ${key}` line.
    for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      await expect(harmonyImpl.handler({}, { udid: HARMONY.id, key }, HARMONY)).rejects.toThrow(
        /is not available on HarmonyOS/
      );
    }
    expect(runHdcShell).not.toHaveBeenCalled();
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
      runHdcShell.mockClear();
      await harmonyImpl.handler({}, { udid: HARMONY.id, key }, HARMONY);
      expect(uiInputs()[0]?.[1], key).toBe(`uitest uiInput keyEvent ${keyId}`);
    }
  });

  it("no-ops on an empty request (neither key nor text), with zero device traffic", async () => {
    // The schema leaves both `key` and `text` optional with no refinement, so an
    // empty request is a no-op returning { typed:"", keys:0 } — the same
    // contract every other keyboard backend follows. Reaching the device first
    // costs a round trip for a step that injects nothing, and fails the whole
    // sequence when the panel happens to be suspended.
    const result = await harmonyImpl.handler({}, { udid: HARMONY.id }, HARMONY);

    expect(result).toEqual({ typed: "", keys: 0 });
    expect(runHdcShell).not.toHaveBeenCalled();
  });

  it("spends ONE budget across both display reads and the injection they feed", async () => {
    // A leg handed a fresh ceiling puts the call far past the point where the
    // MCP client aborts at 30s and REPLAYS — retyping into a field it cannot
    // see. So every leg comes out of one deadline: both display reads (the fast
    // prefilter and the authoritative one inside the queue hold) and the
    // injection after them.
    const LEG_MS = 60;
    runHdcShell.mockImplementation(async (_connectKey, command, timeoutMs) => {
      if (!command.startsWith("hidumper")) return { stdout: "", exitCode: 0 };
      await new Promise((r) => setTimeout(r, LEG_MS));
      void timeoutMs;
      return { stdout: screenDump(), exitCode: 0 };
    });

    await harmonyImpl.handler({}, { udid: HARMONY.id, text: "hi" }, HARMONY);

    const textBudget = uiInputs()[0]?.[2] as number;
    // Half a leg of tolerance, not the millisecond: `setTimeout` can fire a
    // touch early. What has to discriminate is an injection handed a FRESH
    // ceiling — and one charged for only one of the two reads.
    expect(textBudget).toBeLessThan(HARMONY_INTERACTION_TIMEOUT_MS - LEG_MS * 1.5);
    expect(textBudget).toBeGreaterThan(0);
  });
});
