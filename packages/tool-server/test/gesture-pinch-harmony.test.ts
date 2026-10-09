import { beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFailureSignal } from "@argent/registry";

// Only the hdc transport is faked. Everything between the tool and the wire -
// the render-service parse, the two-contact geometry, the normalized-to-pixel
// conversion and the move-time clamp - runs for real and is read back off the
// `uinput` command line these tests capture.
vi.mock("../src/utils/harmony-hdc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-hdc")>()),
  runHdcShell: vi.fn(),
}));

// Keep the real module (blueprints import from it too) but neutralise the
// fire-and-forget WebSocket send, so a HarmonyOS pinch that wrongly reached this
// transport shows up as an unexpected call rather than a socket error.
vi.mock("../src/utils/simulator-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/simulator-client")>()),
  sendCommand: vi.fn(),
}));

// The HarmonyOS branch preflights `hdc`; stub it so these tests don't depend on
// a HarmonyOS toolchain being installed on the test host.
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

// Deliberately non-square: a transposed width/height moves every coordinate
// below, so geometry fed the wrong axis cannot pass.
const DISPLAY_WIDTH = 1200;
const DISPLAY_HEIGHT = 2000;

// A horizontal pinch-out about (0.5, 0.4): fingers start 0.2 apart and end 0.6
// apart, which is x 0.4→0.2 and 0.6→0.8 against a fixed y. Four distinct x
// values and a y that is neither 0.5 nor a width fraction, so a swapped
// start/end, a swapped pair of fingers and a transposed axis are each visible.
const base = {
  udid: HARMONY_UDID,
  centerX: 0.5,
  centerY: 0.4,
  startDistance: 0.2,
  endDistance: 0.6,
};

/**
 * What `hidumper -s RenderService -a screen` prints, in the shape measured on a
 * HarmonyOS 6.1.1 guest: one `screen[N]:` line per panel carrying BOTH the power
 * state and the size. `harmonyDisplay` reads the pair off that one line, so a
 * fixture that split them across two would exercise a format no device emits.
 */
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

    // The whole line, because `uinput` validates almost nothing about it: a
    // swapped from/to, a transposed display axis or the two fingers in the
    // other order all still exit 0 on-device. The single call is the load-
    // bearing part — contacts only coexist inside one invocation, so a pinch
    // split into a call per finger injects two separate one-finger drags and
    // still resolves `{ pinched: true }`.
    expect(uinput().command).toBe("uinput -T -m 480 800 240 800 720 800 960 800 500");
  });

  it("pinches in by moving the fingers together — the reverse of pinching out", async () => {
    // Same geometry with the distances exchanged. Nothing about the argument
    // order says which end is the start, so an implementation that emitted the
    // pair in a fixed order would pass the pinch-out case above and silently
    // zoom the wrong way here.
    await gesturePinchTool.execute(services, {
      ...base,
      startDistance: 0.6,
      endDistance: 0.2,
      durationMs: 500,
    });

    expect(uinput().command).toBe("uinput -T -m 240 800 480 800 960 800 720 800 500");
  });

  it("places the fingers on the vertical axis for angle 90", async () => {
    // The axis has to reach the device through the geometry, not through a
    // separate `uinput` flag it has none of — so a dropped `angle` is a pinch
    // that runs, reports success, and zooms along the wrong axis.
    await gesturePinchTool.execute(services, { ...base, angle: 90, durationMs: 500 });

    expect(uinput().command).toBe("uinput -T -m 600 600 600 200 600 1000 600 1400 500");
  });

  it("drifts the centroid into the end points when endCenterX is given", async () => {
    // The one parameter a two-endpoint injection could quietly lose: with a
    // fixed centre the ends are symmetric about it, and flows pass a drift
    // whenever the clamp moved the centre to keep an expanding finger on-screen.
    await gesturePinchTool.execute(services, { ...base, endCenterX: 0.6, durationMs: 500 });

    expect(uinput().command).toBe("uinput -T -m 480 800 360 800 720 800 1080 800 500");
  });

  it("clamps the move time into the 1–15000ms window `uinput` accepts", async () => {
    // Outside it the binary exits 2 with `total time is out of range:` and the
    // gesture does not happen at all — so this is the difference between a
    // pinch that is merely capped and one that fails.
    await gesturePinchTool.execute(services, { ...base, durationMs: 60_000 });
    expect(moveTimeMs()).toBe(15_000);

    runHdcShell.mockClear();
    // The other rejected end: `smoothTimeMs:0` is refused the same way, and a
    // clamp written with one bound leaves it out of range.
    await gesturePinchTool.execute(services, { ...base, durationMs: 0 });
    expect(moveTimeMs()).toBe(1);
  });

  it("keeps a finger that reaches the screen edge off the zero coordinate", async () => {
    // `endDistance: 1.0` about the centre puts the left finger at exactly 0.0
    // and the right at 1.0 — the first is a coordinate `uitest` refuses outright
    // and the second is one pixel past the panel, which injects silently and
    // lands nowhere. Both are clamped into the addressable range.
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

    // `hdc -t` takes what `hdc list targets` reports, not argent's `harmony-`
    // prefixed id — passing the id through reaches no target at all.
    expect(uinput().connectKey).toBe(CONNECT_KEY);
    // Preflighted, so a missing connector is a 424 install hint rather than a
    // 500 from deeper in the hdc path.
    expect(ensureDep).toHaveBeenCalledWith("hdc");
    // Dropping the branch's `return` would fall through to the per-frame loop
    // and push a Down/Move/Up train at a `services.simulatorServer` no
    // HarmonyOS device is behind, while still resolving `{ pinched: true }`.
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("fails the pinch when `uinput` refuses it, quoting the device's own diagnostic", async () => {
    // `hdc` exits 0 for everything, so the remote status recovered by
    // `runHdcShell` is all that separates an injected pinch from a refused one.
    // Without it the tool reports `{ pinched: true }` for a gesture the device
    // rejected outright.
    runHdcShell.mockImplementation(async (_connectKey, command) =>
      command.startsWith("hidumper")
        ? { stdout: screenDump(DISPLAY_WIDTH, DISPLAY_HEIGHT), exitCode: 0 }
        : {
            // The shape a HarmonyOS 6.1.1 emulator prints: the arguments it
            // parsed, echoed BEFORE it validated them, then the refusal over
            // two lines. Neither the first line nor the last is the diagnostic.
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
    // The echo is the argument list going in, not the problem; surfacing it
    // buries the one line that names the problem.
    expect((err as Error).message).not.toContain("startX:");
  });

  it("still names the exit status when the device sends back no diagnostic at all", async () => {
    // Measured on a HarmonyOS 6.0.0.110 handset: `uinput` writes to stderr and
    // that build's `hdc shell` does not forward it, so BOTH a successful move
    // and a refused one come back with empty stdout. The status is the only
    // thing left to report, and a failure that says nothing at all is a support
    // question rather than a bug report.
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
    // The other half of the same measurement, and the reason the exit status
    // alone decides: a success check keyed on anything `uinput` prints refuses
    // every pinch on the handset, where it prints nothing at all.
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
    // The screen-power check and the injection are two separate round trips.
    // Everything between them is unbounded by anything but the budget: another
    // caller's slow `uitest` work holds this device's queue while the pinch has
    // already read an awake panel — and anything that does NOT go through that
    // queue (power-shell, the physical key, the OS timeout) can suspend the
    // panel in that window. The state that holds when the injection runs is the
    // one to check, so the read is repeated inside the slot.
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
    // Handler attached NOW, before anything can reject: the refusal below is
    // expected, and an unhandled window between release and this await would
    // fail the run as an unhandled rejection rather than an assertion.
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
    // Whatever took the vacated queue slot next — on the code without the
    // in-slot re-read, that IS the injection — gets released too, so the
    // per-device queue this file's tests share is left fully drained.
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
    // `uinput` exits 0 against a suspended panel exactly as `uitest` does, so
    // without the guard the pinch resolves `{ pinched: true }` for a gesture
    // that landed nowhere. Driven through the real `powerStatus` parse rather
    // than a stubbed struct, since that string is the only thing standing
    // between the two outcomes.
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
    // What a guest prints while its compositor is still coming up. Every
    // coordinate would clamp onto the same corner pixel, so the pinch would go
    // out as four fingers on one spot, reported as `{ pinched: true }`.
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
    // Two legs on a full ceiling each would put a pinch's worst case above the
    // 30s at which the MCP client aborts a call and REPLAYS it — a second zoom
    // of a view the caller believes never moved.
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
    // Half a read of tolerance, not the millisecond: `setTimeout` can fire
    // early. What has to discriminate is an injection handed a FRESH ceiling.
    expect(injection?.[2]).toBeLessThan(HARMONY_INTERACTION_TIMEOUT_MS - READ_MS / 2);
    expect(injection?.[2]).toBeGreaterThan(0);
  });

  it("does not declare the simulator-server service for a HarmonyOS target", () => {
    // Resolving the blueprint would spawn a backend this path never uses and
    // block on its ready-wait before the hdc call could start.
    expect(gesturePinchTool.services(base)).toEqual({});
  });
});
