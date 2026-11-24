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

/** Captured off a 6.1.1 emulator, including the `supportedMode` size lines a looser parse would misread. */
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

/** `physical` is settable so the test can tell which size field was read. */
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

describe("harmonyDisplay", () => {
  it("reads the size and the power state a booted device reports", async () => {
    answer(dump(AWAKE));

    await expect(harmonyDisplay(CONNECT_KEY)).resolves.toEqual({
      width: 1320,
      height: 2856,
      screenOn: true,
    });
  });

  it("takes the render resolution, not the physical one beside it", async () => {
    answer(dump(screenLine(0, "POWER_STATUS_ON", "1320x2856", "2640x5712")));

    await expect(harmonyDisplay(CONNECT_KEY)).resolves.toEqual({
      width: 1320,
      height: 2856,
      screenOn: true,
    });
  });

  it("reports a suspended panel from the same dump", async () => {
    answer(dump(screenLine(0, "POWER_STATUS_OFF", "1320x2856")));

    await expect(harmonyDisplay(CONNECT_KEY)).resolves.toEqual({
      width: 1320,
      height: 2856,
      screenOn: false,
    });
  });

  it("treats every power state but the two on ones as unable to receive input", async () => {
    // The whole `ScreenPowerStatus` enum. `ON_ADVANCED` is on because a wake
    // passes through it.
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
      ["POWER_STATUS_SOMETHING_NEW", false],
    ];

    for (const [status, screenOn] of states) {
      answer(dump(screenLine(0, status, "1320x2856")));
      await expect(harmonyDisplay(CONNECT_KEY), status).resolves.toMatchObject({ screenOn });
    }
  });

  it("takes the size and the power state off the SAME panel", async () => {
    // E.g. a foldable's second half sleeping while the driven panel is awake.
    answer(dump(AWAKE, screenLine(1, "POWER_STATUS_OFF", "720x1200")));

    await expect(harmonyDisplay(CONNECT_KEY)).resolves.toEqual({
      width: 1320,
      height: 2856,
      screenOn: true,
    });

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
    answer(dump("screen[0]: id=0, render resolution=1320x2856"));

    const err = await harmonyDisplay(CONNECT_KEY).then(
      () => {
        throw new Error("expected a power-less dump to be refused");
      },
      (e: unknown) => e as Error
    );
    expect(getFailureSignal(err)?.failure_stage).toBe("harmony_display_size");
    expect(getFailureSignal(err)?.error_code).toBe("HARMONY_DISPLAY_UNREADABLE");
    expect(err.message).toContain(CONNECT_KEY);
  });

  it("refuses a dump with no panel line at all", async () => {
    answer(dump());

    await expect(harmonyDisplay(CONNECT_KEY)).rejects.toThrow(
      /Could not read the display size and power state/
    );
  });

  describe("in landscape", () => {
    /** The display manager's session for one screen, trimmed from a 6.1.1 emulator showing a fullscreen video. */
    function dmsScreen(screenId: number, rsScreenId: number, rotation: number): string {
      const [w, h] = rotation % 180 === 90 ? [2856, 1320] : [1320, 2856];
      return [
        `---------------- Screen ID: ${screenId} ----------------`,
        "[SCREEN SESSION]",
        `RSScreenId:                   ${rsScreenId}`,
        "activeModes<id, W, H, RS>:    0, 1320, 2856, 60",
        `Rotation:                     ${rotation / 90}`,
        "[SCREEN PROPERTY]",
        `Rotation:                     ${rotation}`,
        `ScreenRotation:               ${rotation}`,
        `Bounds<L,T,W,H>:              0, 0, ${w}, ${h}, `,
        "PhyBounds<L,T,W,H>:           0, 0, 1320, 2856, ",
      ].join("\r\n");
    }
    const DMS_HEADER = [
      "----------------------------------DisplayManagerService----------------------------------",
      "-------------- DMS KEY EVENTS LIST  --------------",
      "[10-21 00:06:40.457]: screenId: 0 rotation: 270 width: 2856 height: 1320 type: ROTATION_BEGIN",
    ].join("\n");

    it("swaps the panel's portrait resolution into the rotated space taps and layout bounds use", async () => {
      answer(`${dump(AWAKE)}\n${DMS_HEADER}\n${dmsScreen(0, 0, 270)}\n`);

      await expect(harmonyDisplay(CONNECT_KEY)).resolves.toEqual({
        width: 2856,
        height: 1320,
        screenOn: true,
      });
      expect(runHdcShell.mock.calls[0]?.[1]).toContain("hidumper -s DisplayManagerService -a -a");
    });

    it("keeps an upside-down display's size", async () => {
      answer(`${dump(AWAKE)}\n${DMS_HEADER}\n${dmsScreen(0, 0, 180)}\n`);

      await expect(harmonyDisplay(CONNECT_KEY)).resolves.toMatchObject({
        width: 1320,
        height: 2856,
      });
    });

    it("reads the rotation of the screen whose size it reports", async () => {
      // A foldable: the suspended outer screen is listed first and rotated, the awake one is not.
      answer(
        `${dump(screenLine(0, "POWER_STATUS_OFF", "1080x2504"), screenLine(1, "POWER_STATUS_ON", "1320x2856"))}\n` +
          `${DMS_HEADER}\n${dmsScreen(0, 0, 90)}\n${dmsScreen(5, 1, 0)}\n`
      );

      await expect(harmonyDisplay(CONNECT_KEY)).resolves.toMatchObject({
        width: 1320,
        height: 2856,
      });
    });
  });
});
