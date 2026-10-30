import { beforeEach, describe, expect, it, vi } from "vitest";

// HarmonyOS is behind the `harmonyos` flag; these cases drive it with the flag on.
vi.mock("../src/utils/harmony-flag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-flag")>()),
  isHarmonyEnabled: () => true,
}));
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFailureSignal } from "@argent/registry";

// Only the hdc transport is faked; the tool's parsing and geometry run for real.
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

import { gesturePinchTool } from "../src/tools/gesture-pinch";
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

// A horizontal pinch-out about (0.5, 0.4), with four distinct x values.
const base = {
  udid: HARMONY_UDID,
  centerX: 0.5,
  centerY: 0.4,
  startDistance: 0.2,
  endDistance: 0.6,
};

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
      : { stdout: "", exitCode: 0 }
  );
});

/** Let every microtask that can run, run — without releasing any device call. */
const settle = () => new Promise((r) => setImmediate(r));

/** The `uinput …` lines the pinch put on the wire, and who they went to. */
function uinputs(): { connectKey: string; command: string }[] {
  return runHdcShell.mock.calls
    .filter(([, command]) => command.startsWith("uinput "))
    .map(([connectKey, command]) => ({ connectKey, command }));
}

/** The single injection this pinch was supposed to be. */
function uinput(): { connectKey: string; command: string } {
  const calls = uinputs();
  expect(calls).toHaveLength(1);
  return calls[0];
}

/** The trailing move-time argument, which the device spends interpolating. */
function moveTimeMs(): number {
  return Number(uinput().command.split(" ").at(-1));
}

describe("gesture-pinch on HarmonyOS", () => {
  it("puts both contacts on the wire in ONE `uinput -T -m`, as start/end per finger", async () => {
    await expect(
      gesturePinchTool.execute(services, { ...base, durationMs: 500 })
    ).resolves.toMatchObject({ pinched: true });

    // One call: contacts only coexist inside a single invocation.
    expect(uinput().command).toBe("uinput -T -m 480 800 240 800 720 800 960 800 500");
  });

  it("pinches in by moving the fingers together — the reverse of pinching out", async () => {
    await gesturePinchTool.execute(services, {
      ...base,
      startDistance: 0.6,
      endDistance: 0.2,
      durationMs: 500,
    });

    expect(uinput().command).toBe("uinput -T -m 240 800 480 800 960 800 720 800 500");
  });

  it("places the fingers on the vertical axis for angle 90", async () => {
    await gesturePinchTool.execute(services, { ...base, angle: 90, durationMs: 500 });

    expect(uinput().command).toBe("uinput -T -m 600 600 600 200 600 1000 600 1400 500");
  });

  it("drifts the centroid into the end points when endCenterX is given", async () => {
    await gesturePinchTool.execute(services, { ...base, endCenterX: 0.6, durationMs: 500 });

    expect(uinput().command).toBe("uinput -T -m 480 800 360 800 720 800 1080 800 500");
  });

  it("clamps the move time into the 1–15000ms window `uinput` accepts", async () => {
    await gesturePinchTool.execute(services, { ...base, durationMs: 60_000 });
    expect(moveTimeMs()).toBe(15_000);

    runHdcShell.mockClear();
    await gesturePinchTool.execute(services, { ...base, durationMs: 0 });
    expect(moveTimeMs()).toBe(1);
  });

  it("keeps a finger that reaches the screen edge off the zero coordinate", async () => {
    // 0.0 is refused by the device and 1.0 lands one pixel off-panel.
    await expect(
      gesturePinchTool.execute(services, {
        ...base,
        startDistance: 0.2,
        endDistance: 1.0,
        durationMs: 500,
      })
    ).resolves.toMatchObject({ pinched: true });

    const [, , , ...args] = uinput().command.split(" ");
    const xs = [args[0], args[2], args[4], args[6]].map(Number);
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(1);
      expect(x).toBeLessThanOrEqual(DISPLAY_WIDTH - 1);
    }
  });

  it("addresses the device by its hdc connect key, and never over the sim-server", async () => {
    await gesturePinchTool.execute(services, { ...base, durationMs: 500 });

    expect(uinput().connectKey).toBe(CONNECT_KEY);
    expect(ensureDep).toHaveBeenCalledWith("hdc");
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("fails the pinch when `uinput` refuses it, quoting the device's own diagnostic", async () => {
    runHdcShell.mockImplementation(async (_connectKey, command) =>
      command.startsWith("hidumper")
        ? { stdout: screenDump(DISPLAY_WIDTH, DISPLAY_HEIGHT), exitCode: 0 }
        : {
            // The echo precedes the refusal, which spans two lines.
            stdout:
              "startX:480, startY:800, endX:240, endY:800\n" +
              "startX:720, startY:800, endX:960, endY:800\n" +
              "fingerCount:2\nkeepTimeMs:0\nsmoothTimeMs:20000\n" +
              "total time is out of range:\n1 <= total times <= 15000",
            exitCode: 2,
          }
    );

    const err = await gesturePinchTool.execute(services, base).then(
      () => {
        throw new Error("expected the pinch to reject, but it resolved");
      },
      (e: unknown) => e
    );

    expect(getFailureSignal(err)?.failure_stage).toBe("harmony_uinput");
    expect((err as Error).message).toContain(
      "total time is out of range: 1 <= total times <= 15000"
    );
    expect((err as Error).message).not.toContain("startX:");
  });

  it("still names the exit status when the device sends back no diagnostic at all", async () => {
    // A 6.0.0.110 handset forwards no stderr: success and refusal both print nothing.
    runHdcShell.mockImplementation(async (_connectKey, command) =>
      command.startsWith("hidumper")
        ? { stdout: screenDump(DISPLAY_WIDTH, DISPLAY_HEIGHT), exitCode: 0 }
        : { stdout: "", exitCode: 255 }
    );

    const err = await gesturePinchTool.execute(services, base).then(
      () => {
        throw new Error("expected the pinch to reject, but it resolved");
      },
      (e: unknown) => e
    );

    expect((err as Error).message).toContain("exit 255");
    expect((err as Error).message).toContain("printed no diagnostic");
  });

  it("succeeds on a build that prints nothing for a move it performed", async () => {
    runHdcShell.mockImplementation(async (_connectKey, command) =>
      command.startsWith("hidumper")
        ? { stdout: screenDump(DISPLAY_WIDTH, DISPLAY_HEIGHT), exitCode: 0 }
        : { stdout: "", exitCode: 0 }
    );

    await expect(gesturePinchTool.execute(services, base)).resolves.toMatchObject({
      pinched: true,
    });
    expect(uinputs()).toHaveLength(1);
  });

  it("re-reads the panel inside the queue slot, refusing instead of injecting into a panel that went dark while the call waited", async () => {
    // The panel suspends while the pinch waits in the queue.
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
    harmonyScreenCap(CONNECT_KEY, join(tmpdir(), `argent-pinch-window-${process.pid}.png`)).catch(
      () => {}
    );
    await settle();
    // …the pinch reads an awake panel and queues behind it…
    const pinch = gesturePinchTool.execute(services, base);
    // Handled now, so the expected rejection is never unhandled.
    const outcome = pinch.then(
      () => null,
      (e: unknown) => e
    );
    await settle();
    expect(uinputs()).toHaveLength(0);

    // …and the panel is suspended while both wait.
    power = "POWER_STATUS_SUSPEND";
    blocked.shift()?.();
    await settle();
    // Drain the shared per-device queue.
    blocked.shift()?.();
    await settle();

    const err = await outcome;
    expect(getFailureSignal(err)?.failure_stage).toBe("harmony_screen_off");
    expect(uinputs()).toHaveLength(0);
    while (blocked.length > 0) {
      blocked.shift()?.();
      await settle();
    }
  });

  it("refuses to pinch while the display is suspended, injecting nothing", async () => {
    runHdcShell.mockImplementation(async (_connectKey, command) =>
      command.startsWith("hidumper")
        ? {
            stdout: screenDump(DISPLAY_WIDTH, DISPLAY_HEIGHT, "POWER_STATUS_SUSPEND"),
            exitCode: 0,
          }
        : { stdout: "", exitCode: 0 }
    );

    const err = await gesturePinchTool.execute(services, base).then(
      () => {
        throw new Error("expected the pinch to reject, but it resolved");
      },
      (e: unknown) => e
    );

    expect(getFailureSignal(err)?.failure_stage).toBe("harmony_screen_off");
    expect((err as Error).message).toMatch(/Wake it with `button` \(power\)/);
    expect(uinputs()).toHaveLength(0);
  });

  it("refuses to pinch when the render service reports a 0x0 render resolution", async () => {
    runHdcShell.mockImplementation(async (_connectKey, command) =>
      command.startsWith("hidumper")
        ? { stdout: screenDump(0, 0), exitCode: 0 }
        : { stdout: "", exitCode: 0 }
    );

    const err = await gesturePinchTool.execute(services, base).then(
      () => {
        throw new Error("expected the pinch to reject, but it resolved");
      },
      (e: unknown) => e
    );

    expect(getFailureSignal(err)?.failure_stage).toBe("harmony_display_zero");
    expect(uinputs()).toHaveLength(0);
  });

  it("reads the display on its own small ceiling and gives the injection the rest", async () => {
    const READ_MS = 60;
    runHdcShell.mockImplementation(async (_connectKey, command) => {
      if (!command.startsWith("hidumper")) return { stdout: "", exitCode: 0 };
      await new Promise((r) => setTimeout(r, READ_MS));
      return { stdout: screenDump(DISPLAY_WIDTH, DISPLAY_HEIGHT), exitCode: 0 };
    });

    await gesturePinchTool.execute(services, { ...base, durationMs: 500 });

    const read = runHdcShell.mock.calls.find(([, c]) => c.startsWith("hidumper"));
    expect(read?.[2]).toBe(HARMONY_DISPLAY_TIMEOUT_MS);
    const injection = runHdcShell.mock.calls.find(([, c]) => c.startsWith("uinput "));
    // Half a read of tolerance: `setTimeout` can fire early.
    expect(injection?.[2]).toBeLessThan(HARMONY_INTERACTION_TIMEOUT_MS - READ_MS / 2);
    expect(injection?.[2]).toBeGreaterThan(0);
  });

  it("does not declare the simulator-server service for a HarmonyOS target", () => {
    expect(gesturePinchTool.services(base)).toEqual({});
  });
});
