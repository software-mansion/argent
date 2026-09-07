import { describe, expect, it, vi } from "vitest";
import { getFailureSignal } from "@argent/registry";

const runHdcShell = vi.fn(async (_key: string, _cmd: string, _timeoutMs?: number) => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
}));

vi.mock("../src/utils/harmony-hdc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-hdc")>()),
  runHdcShell: (...args: Parameters<typeof runHdcShell>) => runHdcShell(...args),
}));

import { harmonyDisplay } from "../src/utils/harmony-uitest";

const CONNECT_KEY = "127.0.0.1:5557";

/**
 * The real `hidumper -s RenderService -a screen` output, captured off a booted
 * HarmonyOS 6.1.1 emulator — including the lines around the one that matters,
 * since `supportedMode[0]: 1320x2856` is a size on its own line and a looser
 * parse would read it as the panel.
 */
function dump(...screens: string[]): string {
  return [
    "",
    "-------------------------------[ability]-------------------------------",
    "",
    "----------------------------------RenderService----------------------------------",
    "-- ScreenInfo",
    ...screens,
    "supportedMode[0]: 1320x2856, refreshRate=60",
    "activeMode: 1320x2856, refreshRate=60",
    "name=express_display, phyWidth=78, phyHeight=163, supportLayers=10, virtualDispCount=1",
    "isSamplingOn=0, samplingScale=1.00, samplingTranslateX=0.00, samplingTranslateY=0.00",
    "",
  ].join("\n");
}

/**
 * One panel's line, in the field order the render service prints it.
 *
 * `physical` defaults to the render size because that is what the measured
 * emulator prints — which is also why it has to be settable: identical numbers
 * cannot show which of the two fields was read.
 */
function screenLine(index: number, power: string, size: string, physical = size): string {
  return (
    `screen[${index}]: id=${index}, powerStatus=${power}, backlight=1, ` +
    `screenType=EXTERNAL_TYPE, render resolution=${size}, physical resolution=${physical}, ` +
    `isVirtual=false, skipFrameInterval=1, expectedRefreshRate=-1, skipFrameStrategy=0`
  );
}

const AWAKE = screenLine(0, "POWER_STATUS_ON", "1320x2856");

function answer(stdout: string): void {
  runHdcShell.mockReset();
  runHdcShell.mockResolvedValue({ stdout, stderr: "", exitCode: 0 });
}

// Every HarmonyOS input tool gates on this one read, and `uitest uiInput`
// answers `No Error` for a touch that landed nowhere — so a misparse here is a
// tool reporting input it never delivered, or refusing input it could have.
describe("harmonyDisplay", () => {
  it("reads the size and the power state a booted device reports", async () => {
    answer(dump(AWAKE));

    // Literals, not a re-derivation of the fixture: the emulator was measured at
    // 1320x2856.
    await expect(harmonyDisplay(CONNECT_KEY)).resolves.toEqual({
      width: 1320,
      height: 2856,
      screenOn: true,
    });
  });

  it("takes the render resolution, not the physical one beside it", async () => {
    // The two agree on the measured emulator, so nothing there can tell which
    // field the parse read. They part company wherever the panel is scaled, and
    // the answer feeds `toDevicePoint` — read the wrong one and every tap and
    // swipe lands somewhere else.
    answer(dump(screenLine(0, "POWER_STATUS_ON", "1320x2856", "2640x5712")));

    await expect(harmonyDisplay(CONNECT_KEY)).resolves.toEqual({
      width: 1320,
      height: 2856,
      screenOn: true,
    });
  });

  it("reports a suspended panel from the same dump", async () => {
    // Measured: `power-shell suspend` flips this field and leaves every other
    // one — the resolution included — exactly as it was. So the size is still
    // readable while the screen is off, and the two states are distinguished by
    // this field alone.
    answer(dump(screenLine(0, "POWER_STATUS_OFF", "1320x2856")));

    await expect(harmonyDisplay(CONNECT_KEY)).resolves.toEqual({
      width: 1320,
      height: 2856,
      screenOn: false,
    });
  });

  it("treats every power state but the two on ones as unable to receive input", async () => {
    // The whole `ScreenPowerStatus` enum, read out of the HarmonyOS 6.1.1
    // `system.img`. A denylist of the two obvious ones (`OFF`, `SUSPEND`) lets a
    // dozing, standby or fake-off panel through, and `uitest uiInput` answers
    // `No Error` on all of them — so the tool reports a tap that reached nothing
    // on a screen the user is not even looking at.
    //
    // `ON_ADVANCED` is on the other side deliberately: a wake passes through it,
    // and refusing it would fail the retry the refusal itself prescribes.
    const states: Array<[status: string, screenOn: boolean]> = [
      ["POWER_STATUS_ON", true],
      ["POWER_STATUS_ON_ADVANCED", true],
      ["POWER_STATUS_OFF", false],
      ["POWER_STATUS_OFF_ADVANCED", false],
      ["POWER_STATUS_OFF_FAKE", false],
      ["POWER_STATUS_SUSPEND", false],
      ["POWER_STATUS_STANDBY", false],
      ["POWER_STATUS_DOZE", false],
      ["POWER_STATUS_DOZE_SUSPEND", false],
      ["POWER_STATUS_ERROR", false],
      ["POWER_STATUS_BUTT", false],
      // Not in the enum at all: an unlisted state has to refuse, which is the
      // reason this is an allowlist rather than a longer denylist.
      ["POWER_STATUS_SOMETHING_NEW", false],
    ];

    for (const [status, screenOn] of states) {
      answer(dump(screenLine(0, status, "1320x2856")));
      await expect(harmonyDisplay(CONNECT_KEY), status).resolves.toMatchObject({ screenOn });
    }
  });

  it("takes the size and the power state off the SAME panel", async () => {
    // A foldable's second half, or a cast display, sleeping while the panel
    // being driven is awake. Scanning the whole dump for `POWER_STATUS_OFF`
    // reports this device asleep and refuses every gesture on it, with advice
    // ("wake it with `button` (power)") that changes nothing.
    answer(dump(AWAKE, screenLine(1, "POWER_STATUS_OFF", "720x1200")));

    await expect(harmonyDisplay(CONNECT_KEY)).resolves.toEqual({
      width: 1320,
      height: 2856,
      screenOn: true,
    });

    // The awake panel first is the ordering where a whole-dump scan happens to
    // agree, so it cannot tell the two apart on its own. A sizeless panel ahead
    // of the driven one can: it is the shape the size clause of the line search
    // exists to skip, and its power state is the one a wider scan would take.
    answer(
      dump(
        "screen[0]: id=0, powerStatus=POWER_STATUS_OFF, isVirtual=true",
        screenLine(1, "POWER_STATUS_ON", "1320x2856")
      )
    );

    await expect(harmonyDisplay(CONNECT_KEY)).resolves.toEqual({
      width: 1320,
      height: 2856,
      screenOn: true,
    });
  });

  it("refuses a dump whose panel line carries no power state", async () => {
    // Both fields or neither. Defaulting an unparsed power state to "on" is the
    // one answer that lets a suspended panel through every input tool, so a
    // dump this parser does not understand is an error rather than a guess.
    answer(dump("screen[0]: id=0, render resolution=1320x2856"));

    const err = await harmonyDisplay(CONNECT_KEY).then(
      () => {
        throw new Error("expected a power-less dump to be refused");
      },
      (e: unknown) => e as Error
    );
    expect(getFailureSignal(err)?.failure_stage).toBe("harmony_display_size");
    // The DISPLAY code, not `HARMONY_UITEST_FAILED`: this read is a `hidumper`
    // dump and no `uitest` ran, so blaming `uitest` sends an agent looking at
    // the wrong binary. `failure_stage` is what separates this from the 0x0
    // read, which shares the code.
    expect(getFailureSignal(err)?.error_code).toBe("HARMONY_DISPLAY_UNREADABLE");
    expect(err.message).toContain(CONNECT_KEY);
  });

  it("refuses a dump with no panel line at all", async () => {
    // `supportedMode[0]: 1320x2856` and `activeMode: 1320x2856` are sizes on
    // their own lines; neither is a panel, and neither carries a power state.
    answer(dump());

    await expect(harmonyDisplay(CONNECT_KEY)).rejects.toThrow(
      /Could not read the display size and power state/
    );
  });
});
