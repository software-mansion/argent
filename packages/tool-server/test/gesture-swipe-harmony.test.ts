import { beforeEach, describe, expect, it, vi } from "vitest";

// HarmonyOS is behind the `harmonyos` flag; these cases drive it with the flag on.
vi.mock("../src/utils/harmony-flag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-flag")>()),
  isHarmonyEnabled: () => true,
}));
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFailureSignal } from "@argent/registry";

// Only the hdc transport is faked; parsing, geometry and velocity clamping run for real.
vi.mock("../src/utils/harmony-hdc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-hdc")>()),
  runHdcShell: vi.fn(),
  hdcFileRecv: vi.fn(async () => {}),
}));

vi.mock("../src/utils/simulator-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/simulator-client")>()),
  sendCommand: vi.fn(),
}));

vi.mock("../src/utils/check-deps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/check-deps")>()),
  ensureDep: vi.fn(async () => {}),
}));

import { gestureSwipeTool } from "../src/tools/gesture-swipe";
import { ensureDep } from "../src/utils/check-deps";
import { runHdcShell as realRunHdcShell } from "../src/utils/harmony-hdc";
import {
  HARMONY_DISPLAY_TIMEOUT_MS,
  HARMONY_INTERACTION_TIMEOUT_MS,
  harmonyScreenCap,
} from "../src/utils/harmony-uitest";
import { sendCommand } from "../src/utils/simulator-client";

const runHdcShell = vi.mocked(realRunHdcShell);

const CONNECT_KEY = "025DEK236V035771";
const HARMONY_UDID = `harmony-${CONNECT_KEY}`;
const services = {} as never;

// Non-square, so a transposed axis moves every coordinate.
const DISPLAY_WIDTH = 1200;
const DISPLAY_HEIGHT = 2000;

// (300,1800) -> (900,1000): 1000px of travel, so expected velocities are exact.
const base = { udid: HARMONY_UDID, fromX: 0.25, fromY: 0.9, toX: 0.75, toY: 0.5 };

/** One `screen[N]:` line carrying both power state and size, as a guest prints it. */
function screenDump(width: number, height: number, power = "POWER_STATUS_ON"): string {
  return (
    `-- ScreenInfo\nscreen[0]: id=0, powerStatus=${power}, backlight=1, ` +
    `screenType=EXTERNAL_TYPE, render resolution=${width}x${height}, ` +
    `physical resolution=${width}x${height}, isVirtual=false`
  );
}

beforeEach(() => {
  vi.mocked(sendCommand).mockClear();
  vi.mocked(ensureDep).mockClear();
  runHdcShell.mockReset();
  runHdcShell.mockImplementation(async (_connectKey, command) =>
    command.startsWith("hidumper")
      ? { stdout: screenDump(DISPLAY_WIDTH, DISPLAY_HEIGHT), exitCode: 0 }
      : { stdout: "No Error", exitCode: 0 }
  );
});

/** Let every microtask that can run, run — without releasing any device call. */
const settle = () => new Promise((r) => setImmediate(r));

/** The single `uitest uiInput …` line the swipe put on the wire, and who it went to. */
function uiInput(): { connectKey: string; command: string } {
  const calls = runHdcShell.mock.calls.filter(([, cmd]) => cmd.startsWith("uitest uiInput"));
  expect(calls).toHaveLength(1);
  return { connectKey: calls[0][0], command: calls[0][1] };
}

/** The trailing velocity argument, which `uitest` takes in place of a duration. */
function velocity(): number {
  return Number(uiInput().command.split(" ").at(-1));
}

describe("gesture-swipe on HarmonyOS", () => {
  it("sends the `fling` verb with momentum, at the converted pixel endpoints", async () => {
    await expect(
      gestureSwipeTool.execute(services, { ...base, durationMs: 500 })
    ).resolves.toMatchObject({ swiped: true });

    // Whole line asserted: `uitest` exits 0 on a swapped or transposed gesture.
    expect(uiInput().command).toBe("uitest uiInput fling 300 1800 900 1000 2000");

    runHdcShell.mockClear();
    await gestureSwipeTool.execute(services, { ...base, durationMs: 500, momentum: true });
    expect(uiInput().command).toBe("uitest uiInput fling 300 1800 900 1000 2000");
  });

  it("sends the `swipe` verb for a momentum-free swipe, despite the name", async () => {
    await gestureSwipeTool.execute(services, { ...base, durationMs: 500, momentum: false });

    // `momentum: false` maps to `swipe`; inverting it is silent on-device.
    expect(uiInput().command).toBe("uitest uiInput swipe 300 1800 900 1000 2000");
  });

  it("clamps a too-fast swipe to uitest's velocity ceiling", async () => {
    // 100_000px/s unclamped makes `uitest` answer `Invalid parameters.`
    await gestureSwipeTool.execute(services, { ...base, durationMs: 10 });

    expect(velocity()).toBe(40_000);
  });

  it("clamps a too-slow swipe to uitest's velocity floor", async () => {
    await gestureSwipeTool.execute(services, { ...base, durationMs: 20_000 });

    expect(velocity()).toBe(200);
  });

  it("addresses the device by its hdc connect key, and never over the sim-server", async () => {
    await gestureSwipeTool.execute(services, { ...base, durationMs: 500 });

    expect(uiInput().connectKey).toBe(CONNECT_KEY);
    expect(ensureDep).toHaveBeenCalledWith("hdc");
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("keeps edge-normalized endpoints off the zero coordinate `uitest` refuses", async () => {
    // The device refuses edge coordinates, yet 0 is a documented-valid input.
    await expect(
      gestureSwipeTool.execute(services, {
        udid: HARMONY_UDID,
        fromX: 0,
        fromY: 0.8,
        toX: 0.5,
        toY: 0,
        durationMs: 500,
      })
    ).resolves.toMatchObject({ swiped: true });

    const [, , verb, fromX, fromY, toX, toY] = uiInput().command.split(" ");
    expect(verb).toMatch(/fling|swipe/);
    for (const [field, value] of [
      ["fromX", fromX],
      ["fromY", fromY],
      ["toX", toX],
      ["toY", toY],
    ] as const) {
      expect(Number(value), field).toBeGreaterThanOrEqual(1);
    }
  });

  it("re-reads the panel inside the queue slot, refusing instead of injecting into a panel that went dark while the call waited", async () => {
    // The panel can suspend between the power read and the injection, and
    // `uitest` answers `No Error` into a suspended panel, so the read is
    // repeated inside the queue slot.
    let power = "POWER_STATUS_ON";
    const blocked: (() => void)[] = [];
    runHdcShell.mockImplementation(async (_connectKey, command) => {
      if (command.startsWith("hidumper")) {
        return { stdout: screenDump(DISPLAY_WIDTH, DISPLAY_HEIGHT, power), exitCode: 0 };
      }
      if (command.startsWith("uitest ")) {
        await new Promise<void>((resolve) => blocked.push(resolve));
      }
      return { stdout: "", exitCode: 0 };
    });

    // Another caller's `uitest` work holds the queue…
    harmonyScreenCap(CONNECT_KEY, join(tmpdir(), `argent-swipe-window-${process.pid}.png`)).catch(
      () => {}
    );
    await settle();
    // …the swipe reads an awake panel and queues behind it…
    const swipe = gestureSwipeTool.execute(services, base);
    // Handled now, so the expected rejection is never unhandled.
    const outcome = swipe.then(
      () => null,
      (e: unknown) => e
    );
    await settle();
    expect(runHdcShell.mock.calls.filter(([, c]) => c.startsWith("uitest uiInput"))).toHaveLength(
      0
    );

    // …and the panel is suspended while both wait.
    power = "POWER_STATUS_SUSPEND";
    blocked.shift()?.();
    await settle();
    // Drain the shared per-device queue.
    blocked.shift()?.();
    await settle();

    const err = await outcome;
    expect(getFailureSignal(err)?.failure_stage).toBe("harmony_screen_off");
    expect((err as Error).message).toMatch(/Wake it with `button` \(power\)/);
    expect(runHdcShell.mock.calls.filter(([, c]) => c.startsWith("uitest uiInput"))).toHaveLength(
      0
    );
    while (blocked.length > 0) {
      blocked.shift()?.();
      await settle();
    }
  });

  it("refuses to swipe while the display is suspended, injecting nothing", async () => {
    // `uitest uiInput` exits 0 against a suspended panel.
    runHdcShell.mockImplementation(async (_connectKey, command) =>
      command.startsWith("hidumper")
        ? {
            stdout: screenDump(DISPLAY_WIDTH, DISPLAY_HEIGHT, "POWER_STATUS_SUSPEND"),
            exitCode: 0,
          }
        : { stdout: "No Error", exitCode: 0 }
    );

    const err = await gestureSwipeTool.execute(services, base).then(
      () => {
        throw new Error("expected the swipe to reject, but it resolved");
      },
      (e: unknown) => e
    );

    expect(getFailureSignal(err)?.failure_stage).toBe("harmony_screen_off");
    expect((err as Error).message).toMatch(/Wake it with `button` \(power\)/);
    expect(runHdcShell.mock.calls.filter(([, c]) => c.startsWith("uitest uiInput"))).toHaveLength(
      0
    );
  });

  it("refuses to swipe when the render service reports a 0x0 render resolution", async () => {
    // A guest whose compositor is still coming up reports 0x0.
    runHdcShell.mockImplementation(async (_connectKey, command) =>
      command.startsWith("hidumper")
        ? { stdout: screenDump(0, 0), exitCode: 0 }
        : { stdout: "No Error", exitCode: 0 }
    );

    const err = await gestureSwipeTool.execute(services, base).then(
      () => {
        throw new Error("expected the swipe to reject, but it resolved");
      },
      (e: unknown) => e
    );

    expect(getFailureSignal(err)?.failure_stage).toBe("harmony_display_zero");
    expect((err as Error).message).toContain("0x0 display");
    expect(runHdcShell.mock.calls.filter(([, c]) => c.startsWith("uitest uiInput"))).toHaveLength(
      0
    );
  });

  it("reads the display on its own small ceiling and gives the injection the rest", async () => {
    // Read and injection share one budget that must stay under the MCP client's 30s replay cap.
    const READ_MS = 60;
    runHdcShell.mockImplementation(async (_connectKey, command) => {
      if (!command.startsWith("hidumper")) return { stdout: "No Error", exitCode: 0 };
      await new Promise((r) => setTimeout(r, READ_MS));
      return { stdout: screenDump(DISPLAY_WIDTH, DISPLAY_HEIGHT), exitCode: 0 };
    });

    await gestureSwipeTool.execute(services, { ...base, durationMs: 500 });

    const read = runHdcShell.mock.calls.find(([, c]) => c.startsWith("hidumper"));
    expect(read?.[2]).toBe(HARMONY_DISPLAY_TIMEOUT_MS);
    const injection = runHdcShell.mock.calls.find(([, c]) => c.startsWith("uitest uiInput"));
    // Half a read of tolerance: `setTimeout` can fire early.
    expect(injection?.[2]).toBeLessThan(HARMONY_INTERACTION_TIMEOUT_MS - READ_MS / 2);
    expect(injection?.[2]).toBeGreaterThan(0);
    expect(HARMONY_INTERACTION_TIMEOUT_MS).toBeLessThanOrEqual(25_000);
    expect(HARMONY_DISPLAY_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });

  it("does not declare the simulator-server service for a HarmonyOS target", () => {
    expect(gestureSwipeTool.services(base)).toEqual({});
  });
});
