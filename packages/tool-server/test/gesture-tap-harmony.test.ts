import { beforeEach, describe, expect, it, vi } from "vitest";
import { getFailureSignal } from "@argent/registry";

// Only the hdc transport is faked. Everything between the tool and the wire -
// the render-service parse, the normalized-to-pixel conversion - runs for real,
// so the asserted pixel values are the ones a device would actually be handed.
vi.mock("../src/utils/harmony-hdc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-hdc")>()),
  runHdcShell: vi.fn(),
}));

// Keep the real module (blueprints import from it too) but neutralise the
// fire-and-forget WebSocket send, so a HarmonyOS tap that wrongly reached this
// transport shows up as an unexpected call rather than a socket error.
vi.mock("../src/utils/simulator-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/simulator-client")>()),
  sendCommand: vi.fn(),
}));

// The harmony branch preflights hdc; stub it so the tests don't need the
// HarmonyOS toolchain on the test host.
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

/** No service is resolved for a HarmonyOS tap; see the `services` block below. */
const noServices = {} as never;

/** A Mate 60's render resolution — portrait, so a swapped axis is visible. */
const DISPLAY_WIDTH = 1216;
const DISPLAY_HEIGHT = 2688;

/**
 * What `hidumper -s RenderService -a screen` prints, in the shape measured on a
 * HarmonyOS 6.1.1 guest: one `screen[N]:` line per panel carrying BOTH the power
 * state and the size — the pair `harmonyDisplay` parses off that one line.
 */
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

/** The `uitest uiInput …` lines the tap put on the wire, as `[verb, point]`. */
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
    // Preflighted so a missing connector fails with a 424 install hint rather
    // than a generic 500 from deeper in the hdc path.
    expect(ensureDep).toHaveBeenCalledWith("hdc");
  });

  it("sends clickCount 2 as ONE native doubleClick, not two clicks", async () => {
    await gestureTapTool.execute(noServices, {
      udid: HARMONY_UDID,
      x: 0.5,
      y: 0.5,
      clickCount: 2,
    });
    // Two timed `click` injections are not guaranteed to land inside the OS
    // double-tap window, which is the whole reason `clickCount` exists — a
    // degradation to the generic loop would still resolve `{ tapped: true }`
    // while never producing a double-tap on-device.
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
    // `uitest` has no native triple-click; three clicks on the same point are
    // the only available form. A `doubleClick` slipping in here (or a dropped
    // iteration) would send the app a different gesture than was asked for.
    expect(touchCalls()).toEqual([
      ["click", { x: 608, y: 1344 }],
      ["click", { x: 608, y: 1344 }],
      ["click", { x: 608, y: 1344 }],
    ]);
    // Lower bound on the two inter-tap gaps: back-to-back injections are not a
    // multi-tap the OS can count. Load only widens this, never narrows it.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
  });

  it("converts normalized coordinates to pixels of the display it just read", async () => {
    await gestureTapTool.execute(noServices, { udid: HARMONY_UDID, x: 0.6, y: 0.35 });
    // 0.6*1216 and 0.35*2688, each rounded. The fractions are chosen so a
    // swapped axis (941, 730), a width/height mix-up (1613, 426) and a scale
    // off by one pixel (729, 940) all differ from the expected pair.
    expect(touchCalls()).toEqual([["click", { x: 730, y: 941 }]]);
  });

  it("lands a screen-edge tap on pixel 1, not on the zero `uitest` refuses", async () => {
    // Measured on a HarmonyOS 6.1.1 emulator: `uitest uiInput click 660 0` exits
    // 1 with "Please confirm that the coordinate values are correct." — yet
    // {x: 0.5, y: 0.0} is a documented-valid request ("top=0"), and an edge tap
    // that hard-fails breaks every caller aiming at the top row.
    await expect(
      gestureTapTool.execute(noServices, { udid: HARMONY_UDID, x: 0.5, y: 0 })
    ).resolves.toMatchObject({ tapped: true });
    expect(touchCalls()).toEqual([["click", { x: 608, y: 1 }]]);
  });

  it("addresses the device by its hdc connect key, not the `harmony-` prefixed id", async () => {
    await gestureTapTool.execute(noServices, { udid: HARMONY_UDID, x: 0.5, y: 0.5 });
    // `hdc -t` only knows the key it reported in `list targets`; the prefix is
    // argent's own, and passing it through reaches no device at all.
    const read = runHdcShell.mock.calls.find(([, c]) => c.startsWith("hidumper"));
    expect(read?.[0]).toBe(CONNECT_KEY);
    expect(runHdcShell.mock.calls.find(([, c]) => c.startsWith("uitest uiInput"))?.[0]).toBe(
      CONNECT_KEY
    );
  });

  it("refuses to tap while the display is suspended, injecting nothing", async () => {
    // `uitest uiInput click` answers `No Error` and exits 0 against a suspended
    // panel (measured), so without this guard the tap resolves `{tapped: true}`
    // for input that landed nowhere — and the agent goes on to assert against a
    // screen it believes it just touched. `button` pins the same refusal for
    // its own presses; the two must not drift apart.
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
    // What the render service prints while the guest's compositor is still
    // coming up. `toDevicePoint` clamps every normalized coordinate into a
    // 0-wide, 0-tall panel, so the tap below would go out pinned to the same
    // corner pixel — a tap the caller never asked for, reported as
    // `{ tapped: true }`.
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
    // The fast pre-filter before the queue plus the authoritative re-read inside
    // the queue hold: two, whatever the click count. Reading per CLICK would
    // insert a 50-190ms hidumper round trip between taps, on top of the gap the
    // OS multi-tap window is being paced against.
    await gestureTapTool.execute(noServices, { udid: HARMONY_UDID, x: 0.5, y: 0.5, clickCount: 3 });
    const reads = runHdcShell.mock.calls.filter(([, c]) => c.startsWith("hidumper"));
    expect(reads).toHaveLength(2);
  });

  it("spends ONE budget across both display reads and every click of a multi-tap", async () => {
    // Each leg handed a fresh ceiling puts a triple-tap far past the MCP
    // client's abort-and-replay cap — where the replay is more taps on the same
    // point, for taps the caller believes never landed. Every leg comes out of
    // one deadline instead.
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
    // The FIRST click is handed what both reads left — strictly less than a
    // budget minus a single read, which is what charging only one of them (or
    // neither) would arrive at.
    expect(budgets[0]).toBeLessThan(HARMONY_INTERACTION_TIMEOUT_MS - READ_MS * 1.5);
    // …and each inter-tap gap is charged too, so the last click cannot be
    // handed a ceiling that ignores the two before it.
    expect(budgets[2]).toBeLessThan(budgets[0] - 100);
    expect(budgets[2]).toBeGreaterThan(0);
  });
});

/** The `timeoutMs` each injection was handed, in wire order. */
function touchCallBudgets(): number[] {
  return runHdcShell.mock.calls
    .filter(([, command]) => command.startsWith("uitest uiInput "))
    .map((call) => call[2] as number);
}

describe("gesture-tap service declaration", () => {
  it("declares no simulator-server for a HarmonyOS target", () => {
    // There is no simulator-server controller behind a HarmonyOS device, so
    // declaring the blueprint would spawn a backend the tap never uses and
    // block on its ready-wait before the hdc path ever runs.
    expect(gestureTapTool.services({ udid: HARMONY_UDID, x: 0.5, y: 0.5 })).toEqual({});
  });

  it("still declares the simulator-server for an Android target", () => {
    expect(gestureTapTool.services({ udid: "emulator-5554", x: 0.5, y: 0.5 })).toHaveProperty(
      "simulatorServer"
    );
  });
});
