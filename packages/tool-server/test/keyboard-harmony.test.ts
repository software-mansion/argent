import { beforeEach, describe, expect, it, vi } from "vitest";

// HarmonyOS is behind the `harmonyos` flag; these cases drive it with the flag on.
vi.mock("../src/utils/harmony-flag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-flag")>()),
  isHarmonyEnabled: () => true,
}));
import type { DeviceInfo } from "@argent/registry";

// Only the hdc transport is faked; `harmonyDisplay` parses the served dump for real.
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

const HARMONY_ENTER_KEYID = "2054";

/** One `screen[N]:` line carrying both power state and size, as a guest prints it. */
function screenDump(power = "POWER_STATUS_ON", size = "1216x2688"): string {
  return (
    `-- ScreenInfo\nscreen[0]: id=0, powerStatus=${power}, backlight=1, ` +
    `screenType=EXTERNAL_TYPE, render resolution=${size}, physical resolution=${size}, ` +
    `isVirtual=false`
  );
}

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

describe("keyboard on HarmonyOS", () => {
  it("addresses the connect key, not the prefixed device id, and types the text verbatim", async () => {
    // Mixed case, so a case-folded copy fails.
    const result = await harmonyImpl.handler({}, { udid: HARMONY.id, text: "Hi" }, HARMONY);

    const [connectKey, command] = uiInputs()[0] ?? [];
    expect([connectKey, command]).toEqual([HARMONY_CONNECT_KEY, "uitest uiInput text 'Hi'"]);
    expect(result).toEqual({ typed: "Hi", keys: 2 });
  });

  it("sends the keyID rather than the key name", async () => {
    await harmonyImpl.handler({}, { udid: HARMONY.id, key: "enter" }, HARMONY);

    // `uitest` accepts a key name it does not know and does nothing.
    expect(uiInputs()[0]?.[1]).toBe(`uitest uiInput keyEvent ${HARMONY_ENTER_KEYID}`);
  });

  it("rejects an unknown key without touching the device", async () => {
    await expect(
      harmonyImpl.handler({}, { udid: HARMONY.id, key: "bogus" }, HARMONY)
    ).rejects.toThrow(/'bogus' is not available on HarmonyOS/);
    expect(runHdcShell).not.toHaveBeenCalled();
  });

  it("rejects un-typeable text without touching the device", async () => {
    await expect(
      harmonyImpl.handler({}, { udid: HARMONY.id, text: "a\nb" }, HARMONY)
    ).rejects.toThrow(/cannot type a newline/);
    expect(runHdcShell).not.toHaveBeenCalled();
  });

  it("refuses to type while the display is suspended, injecting nothing", async () => {
    // `uitest uiInput text` exits 0 against a suspended panel.
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
    // A bare index would resolve these to `Object.prototype` members.
    for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      await expect(harmonyImpl.handler({}, { udid: HARMONY.id, key }, HARMONY)).rejects.toThrow(
        /is not available on HarmonyOS/
      );
    }
    expect(runHdcShell).not.toHaveBeenCalled();
  });

  it("sends each supported key its own measured keyID", async () => {
    // Literal keyIDs: `uitest` accepts any number, so a swapped pair would pass silently.
    const expected: Record<string, string> = {
      "enter": "2054",
      "backspace": "2055",
      "space": "2050",
      "arrow-left": "2014",
      "arrow-right": "2015",
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
    const result = await harmonyImpl.handler({}, { udid: HARMONY.id }, HARMONY);

    expect(result).toEqual({ typed: "", keys: 0 });
    expect(runHdcShell).not.toHaveBeenCalled();
  });

  it("spends ONE budget across both display reads and the injection they feed", async () => {
    // Both reads and the injection share one deadline, under the MCP client's 30s replay cap.
    const LEG_MS = 60;
    runHdcShell.mockImplementation(async (_connectKey, command, timeoutMs) => {
      if (!command.startsWith("hidumper")) return { stdout: "", exitCode: 0 };
      await new Promise((r) => setTimeout(r, LEG_MS));
      void timeoutMs;
      return { stdout: screenDump(), exitCode: 0 };
    });

    await harmonyImpl.handler({}, { udid: HARMONY.id, text: "hi" }, HARMONY);

    const textBudget = uiInputs()[0]?.[2] as number;
    // Half a leg of tolerance: `setTimeout` can fire early.
    expect(textBudget).toBeLessThan(HARMONY_INTERACTION_TIMEOUT_MS - LEG_MS * 1.5);
    expect(textBudget).toBeGreaterThan(0);
  });
});
