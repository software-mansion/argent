import { beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFailureSignal } from "@argent/registry";

// Only the hdc transport is faked. Everything between the tool and the wire -
// the render-service parse, the normalized-to-pixel conversion, the duration-to-
// velocity conversion and the velocity clamp - runs for real and is read back
// off the `uitest` command line these tests capture.
vi.mock("../src/utils/harmony-hdc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-hdc")>()),
  runHdcShell: vi.fn(),
}));

// Keep the real module (blueprints import from it too) but neutralise the
// fire-and-forget WebSocket send, so a HarmonyOS swipe that wrongly reached this
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

// Deliberately non-square: a transposed width/height moves all four coordinates
// below, so a `toDevicePoint` fed the wrong axis cannot pass.
const DISPLAY_WIDTH = 1200;
const DISPLAY_HEIGHT = 2000;

// 0.25/0.9 lands on (300, 1800) and 0.75/0.5 on (900, 1000) - four distinct
// values, so a swapped x/y is visible too. The 600x800 leg makes the travel
// exactly 1000px, which keeps every expected velocity below a whole number.
const base = { udid: HARMONY_UDID, fromX: 0.25, fromY: 0.9, toX: 0.75, toY: 0.5 };

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

    // 1000px of travel in 0.5s is 2000px/s. The whole line is asserted because
    // `uitest` validates almost nothing: a swapped from/to, a transposed display
    // axis or a reordered velocity argument all still exit 0 on-device.
    expect(uiInput().command).toBe("uitest uiInput fling 300 1800 900 1000 2000");

    runHdcShell.mockClear();
    await gestureSwipeTool.execute(services, { ...base, durationMs: 500, momentum: true });
    expect(uiInput().command).toBe("uitest uiInput fling 300 1800 900 1000 2000");
  });

  it("sends the `swipe` verb for a momentum-free swipe, despite the name", async () => {
    await gestureSwipeTool.execute(services, { ...base, durationMs: 500, momentum: false });

    // The mapping reads backwards at a glance, so it is pinned rather than left
    // to review: `momentum: false` asks for no fling, so it takes `swipe` (a drag
    // ending where it ends) and leaves `fling` (which hands the scroller a release
    // velocity to coast on) as the default. Inverting the ternary is silent -
    // both verbs exist, both exit 0, and only the coast distance differs.
    expect(uiInput().command).toBe("uitest uiInput swipe 300 1800 900 1000 2000");
  });

  it("clamps a too-fast swipe to uitest's velocity ceiling", async () => {
    // 1000px in 10ms is 100_000px/s. Unclamped, `uitest` answers `Invalid
    // parameters.` and the gesture does not happen at all - so this is the
    // difference between a swipe that is merely capped and one that fails.
    await gestureSwipeTool.execute(services, { ...base, durationMs: 10 });

    expect(velocity()).toBe(40_000);
  });

  it("clamps a too-slow swipe to uitest's velocity floor", async () => {
    // The other rejected end: 1000px over 20s is 50px/s. A clamp written with
    // only one bound leaves this one out of range.
    await gestureSwipeTool.execute(services, { ...base, durationMs: 20_000 });

    expect(velocity()).toBe(200);
  });

  it("addresses the device by its hdc connect key, and never over the sim-server", async () => {
    await gestureSwipeTool.execute(services, { ...base, durationMs: 500 });

    // `hdc -t` takes what `hdc list targets` reports, not argent's `harmony-`
    // prefixed id - passing the id through reaches no target at all.
    expect(uiInput().connectKey).toBe(CONNECT_KEY);
    // Preflighted, so a missing connector is a 424 install hint rather than a
    // 500 from deeper in the hdc path.
    expect(ensureDep).toHaveBeenCalledWith("hdc");
    // Dropping the branch's `return` would fall through to the interpolation
    // loop and push a Down/Move/Up train at a `services.simulatorServer` no
    // HarmonyOS device is behind, while still resolving `{ swiped: true }`.
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("keeps edge-normalized endpoints off the zero coordinate `uitest` refuses", async () => {
    // Measured on a HarmonyOS 6.1.1 emulator (1320x2856): `uiInput fling
    // 660 2285 660 0 <v>` exits 1 refusing the coordinate, so a scroll that
    // ends at the top edge (toY 0) or an edge-swipe back gesture (fromX 0)
    // would fail hard — yet both are documented-valid requests ("left=0").
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
    // The screen-power check and the injection are two separate round trips.
    // Everything between them is unbounded by anything but the budget: another
    // caller's slow `uitest` work holds this device's queue while the swipe has
    // already read an awake panel — and anything that does NOT go through
    // `uitest` (power-shell, the physical key, the OS timeout) can suspend the
    // panel in that window. Measured: the injection 5.9s later answered
    // `No Error` into POWER_STATUS_OFF. The state that holds when the injection
    // runs is the one to check, so the read is repeated inside the queue slot,
    // immediately before the wire.
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
    // Handler attached NOW, before anything can reject: the refusal below is
    // expected, and an unhandled window between release and this await would
    // fail the run as an unhandled rejection rather than an assertion.
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
    // Whatever took the vacated queue slot next — on the code without the
    // in-slot re-read, that IS the injection — gets released too, so the
    // per-device queue this file's tests share is left fully drained.
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
    // `uitest uiInput` answers `No Error` and exits 0 against a suspended panel
    // (measured), so without the guard the swipe resolves `{swiped: true}` for a
    // gesture that landed nowhere — and a scroll-until-found loop runs to its
    // limit against a screen that never moved. Driven through the real
    // `powerStatus` parse rather than a stubbed struct, since that string is the
    // only thing standing between the two outcomes.
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
    // What a guest prints while its compositor is still coming up — parsed here
    // rather than stubbed, since `render resolution=0x0` is a line the parser
    // accepts without complaint. Both endpoints would clamp onto the same corner
    // pixel, so the swipe would go out as a gesture from one spot to itself,
    // reported as `{ swiped: true }`.
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
    // Two legs on `UITEST_TIMEOUT_MS` put a swipe's worst case at 40s, above the
    // 30s at which the MCP client (`FETCH_TIMEOUT_MS` in argent-mcp) aborts a
    // call and REPLAYS it — a second scroll of a list the caller believes never
    // moved. The read gets a ceiling sized to what it was measured at, and the
    // injection gets what is left of the one shared budget.
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
    // Half a read of tolerance, not the millisecond: `setTimeout` can fire a
    // touch early. What has to discriminate is an injection handed a FRESH
    // ceiling.
    expect(injection?.[2]).toBeLessThan(HARMONY_INTERACTION_TIMEOUT_MS - READ_MS / 2);
    expect(injection?.[2]).toBeGreaterThan(0);
    // The magnitudes themselves, not just the wiring: the whole interaction has
    // to finish inside the MCP client's 30s cap, and the read has to stay a
    // small slice of it — it was measured at 50-190ms, against an `hdc shell`
    // round trip of 0.1-0.8s.
    expect(HARMONY_INTERACTION_TIMEOUT_MS).toBeLessThanOrEqual(25_000);
    expect(HARMONY_DISPLAY_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });

  it("does not declare the simulator-server service for a HarmonyOS target", () => {
    // Resolving the blueprint would spawn a backend this path never uses and
    // block on its ready-wait before the hdc call could start.
    expect(gestureSwipeTool.services(base)).toEqual({});
  });
});
