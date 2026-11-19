import { beforeEach, describe, expect, it, vi } from "vitest";

// HarmonyOS is behind the `harmonyos` flag; these cases drive it with the flag on.
vi.mock("../src/utils/harmony-flag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-flag")>()),
  isHarmonyEnabled: () => true,
}));
import { getFailureSignal } from "@argent/registry";

// Only the hdc transport is faked; parsing and geometry run for real.
vi.mock("../src/utils/harmony-hdc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-hdc")>()),
  runHdcShell: vi.fn(),
}));

vi.mock("../src/utils/simulator-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/simulator-client")>()),
  sendCommand: vi.fn(),
}));

vi.mock("../src/utils/check-deps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/check-deps")>()),
  ensureDep: vi.fn(async () => {}),
}));

import { gestureTapTool } from "../src/tools/gesture-tap";
import { ensureDep } from "../src/utils/check-deps";
import { runHdcShell as realRunHdcShell } from "../src/utils/harmony-hdc";
import { HARMONY_INTERACTION_TIMEOUT_MS } from "../src/utils/harmony-uitest";
import { sendCommand } from "../src/utils/simulator-client";

const runHdcShell = vi.mocked(realRunHdcShell);

const CONNECT_KEY = "025DEK236V035771";
const HARMONY_UDID = `harmony-${CONNECT_KEY}`;

const noServices = {} as never;

/** Portrait, so a swapped axis is visible. */
const DISPLAY_WIDTH = 1216;
const DISPLAY_HEIGHT = 2688;

/** One `screen[N]:` line carrying both power state and size, as a guest prints it. */
function screenDump(
  power = "POWER_STATUS_ON",
  size = `${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}`
): string {
  return (
    `-- ScreenInfo\nscreen[0]: id=0, powerStatus=${power}, backlight=1, ` +
    `screenType=EXTERNAL_TYPE, render resolution=${size}, physical resolution=${size}, ` +
    `isVirtual=false`
  );
}

const touchCalls = () =>
  runHdcShell.mock.calls
    .filter(([, command]) => command.startsWith("uitest uiInput "))
    .map(([, command]) => {
      const [, , verb, x, y] = command.split(" ");
      return [verb, { x: Number(x), y: Number(y) }] as const;
    });

beforeEach(() => {
  vi.mocked(sendCommand).mockClear();
  vi.mocked(ensureDep).mockClear();
  runHdcShell.mockReset();
  runHdcShell.mockImplementation(async (_connectKey, command) =>
    command.startsWith("hidumper")
      ? { stdout: screenDump(), exitCode: 0 }
      : { stdout: "", exitCode: 0 }
  );
});

describe("gesture-tap on HarmonyOS", () => {
  it("taps once with the plain `click` verb by default", async () => {
    await expect(
      gestureTapTool.execute(noServices, { udid: HARMONY_UDID, x: 0.5, y: 0.5 })
    ).resolves.toMatchObject({ tapped: true });
    expect(touchCalls()).toEqual([["click", { x: 608, y: 1344 }]]);
    expect(ensureDep).toHaveBeenCalledWith("hdc");
  });

  it("sends clickCount 2 as ONE native doubleClick, not two clicks", async () => {
    await gestureTapTool.execute(noServices, {
      udid: HARMONY_UDID,
      x: 0.5,
      y: 0.5,
      clickCount: 2,
    });
    // Two timed clicks are not guaranteed to land inside the OS double-tap window.
    expect(touchCalls()).toEqual([["doubleClick", { x: 608, y: 1344 }]]);
  });

  it("falls back to that many `click` injections above 2, paced apart", async () => {
    const startedAt = Date.now();
    await gestureTapTool.execute(noServices, {
      udid: HARMONY_UDID,
      x: 0.5,
      y: 0.5,
      clickCount: 3,
    });
    expect(touchCalls()).toEqual([
      ["click", { x: 608, y: 1344 }],
      ["click", { x: 608, y: 1344 }],
      ["click", { x: 608, y: 1344 }],
    ]);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
  });

  it("converts normalized coordinates to pixels of the display it just read", async () => {
    await gestureTapTool.execute(noServices, { udid: HARMONY_UDID, x: 0.6, y: 0.35 });
    // A swapped axis would give (941, 730).
    expect(touchCalls()).toEqual([["click", { x: 730, y: 941 }]]);
  });

  it("lands a screen-edge tap on pixel 1, not on the zero `uitest` refuses", async () => {
    // The device refuses edge coordinates, yet 0 is a documented-valid input.
    await expect(
      gestureTapTool.execute(noServices, { udid: HARMONY_UDID, x: 0.5, y: 0 })
    ).resolves.toMatchObject({ tapped: true });
    expect(touchCalls()).toEqual([["click", { x: 608, y: 1 }]]);
  });

  it("addresses the device by its hdc connect key, not the `harmony-` prefixed id", async () => {
    await gestureTapTool.execute(noServices, { udid: HARMONY_UDID, x: 0.5, y: 0.5 });
    const read = runHdcShell.mock.calls.find(([, c]) => c.startsWith("hidumper"));
    expect(read?.[0]).toBe(CONNECT_KEY);
    expect(runHdcShell.mock.calls.find(([, c]) => c.startsWith("uitest uiInput"))?.[0]).toBe(
      CONNECT_KEY
    );
  });

  it("refuses to tap while the display is suspended, injecting nothing", async () => {
    // `uitest uiInput click` exits 0 against a suspended panel.
    runHdcShell.mockImplementation(async (_connectKey, command) =>
      command.startsWith("hidumper")
        ? { stdout: screenDump("POWER_STATUS_SUSPEND"), exitCode: 0 }
        : { stdout: "", exitCode: 0 }
    );

    const err = await gestureTapTool
      .execute(noServices, { udid: HARMONY_UDID, x: 0.5, y: 0.5 })
      .then(
        () => {
          throw new Error("expected the tap to reject, but it resolved");
        },
        (e: unknown) => e
      );

    expect(getFailureSignal(err)?.failure_stage).toBe("harmony_screen_off");
    expect((err as Error).message).toMatch(/Wake it with `button` \(power\)/);
    expect(touchCalls()).toEqual([]);
  });

  it("refuses to tap when the render service reports a 0x0 display", async () => {
    // A guest whose compositor is still coming up reports 0x0.
    runHdcShell.mockImplementation(async (_connectKey, command) =>
      command.startsWith("hidumper")
        ? { stdout: screenDump("POWER_STATUS_ON", "0x0"), exitCode: 0 }
        : { stdout: "", exitCode: 0 }
    );

    const err = await gestureTapTool
      .execute(noServices, { udid: HARMONY_UDID, x: 0.83, y: 0.42 })
      .then(
        () => {
          throw new Error("expected the tap to reject, but it resolved");
        },
        (e: unknown) => e
      );

    expect(getFailureSignal(err)?.failure_stage).toBe("harmony_display_zero");
    expect((err as Error).message).toContain("0x0 display");
    expect(touchCalls()).toEqual([]);
  });

  it("re-reads the display exactly twice per tap, not per click", async () => {
    // Reading per click would add a hidumper round trip between taps.
    await gestureTapTool.execute(noServices, { udid: HARMONY_UDID, x: 0.5, y: 0.5, clickCount: 3 });
    const reads = runHdcShell.mock.calls.filter(([, c]) => c.startsWith("hidumper"));
    expect(reads).toHaveLength(2);
  });

  it("spends ONE budget across both display reads and every click of a multi-tap", async () => {
    // Every leg comes out of one deadline, under the MCP client's 30s replay cap.
    const READ_MS = 60;
    runHdcShell.mockImplementation(async (_connectKey, command, timeoutMs) => {
      if (!command.startsWith("hidumper")) return { stdout: "", exitCode: 0 };
      await new Promise((r) => setTimeout(r, READ_MS));
      void timeoutMs;
      return { stdout: screenDump(), exitCode: 0 };
    });

    await gestureTapTool.execute(noServices, {
      udid: HARMONY_UDID,
      x: 0.5,
      y: 0.5,
      clickCount: 3,
    });

    const budgets = touchCallBudgets();
    expect(budgets).toHaveLength(3);
    expect(budgets[0]).toBeLessThan(HARMONY_INTERACTION_TIMEOUT_MS - READ_MS * 1.5);
    expect(budgets[2]).toBeLessThan(budgets[0] - 100);
    expect(budgets[2]).toBeGreaterThan(0);
  });
});

function touchCallBudgets(): number[] {
  return runHdcShell.mock.calls
    .filter(([, command]) => command.startsWith("uitest uiInput "))
    .map((call) => call[2] as number);
}

describe("gesture-tap service declaration", () => {
  it("declares no simulator-server for a HarmonyOS target", () => {
    expect(gestureTapTool.services({ udid: HARMONY_UDID, x: 0.5, y: 0.5 })).toEqual({});
  });

  it("still declares the simulator-server for an Android target", () => {
    expect(gestureTapTool.services({ udid: "emulator-5554", x: 0.5, y: 0.5 })).toHaveProperty(
      "simulatorServer"
    );
  });
});
