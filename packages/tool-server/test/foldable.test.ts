import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const execFileMock = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: readonly string[],
      opts: unknown,
      cb?: (err: Error | null, out: { stdout: string; stderr: string }) => void
    ) => {
      const callback = typeof opts === "function" ? opts : cb!;
      const options = typeof opts === "function" ? undefined : opts;
      const result = execFileMock(cmd, args, options);
      const settle = (r: unknown): void => {
        if (r instanceof Error) callback(r, { stdout: "", stderr: "" });
        else
          callback(
            null,
            (r as { stdout: string; stderr: string } | undefined) ?? { stdout: "", stderr: "" }
          );
      };
      // A promise answers later: a CoreDevice that takes its time, or hangs.
      if (result instanceof Promise) void result.then(settle, settle);
      else settle(result);
    },
  };
});

const isFoldableSimulatorMock = vi.fn(async (_udid: string) => true);
vi.mock("../src/utils/ios-devices", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/ios-devices")>(
    "../src/utils/ios-devices"
  );
  return { ...actual, isFoldableSimulator: (udid: string) => isFoldableSimulatorMock(udid) };
});

import {
  __resetFoldableStateForTests,
  AX_LIVE_PANEL_TIMEOUT_MS,
  awaitLivePanel,
  DEVICECTL_TIMEOUT_MS,
  foldablePostureHint,
  holdLivePanel,
  panelForHingeAngle,
  parseDisplaysPayload,
  readCoreDeviceDisplays,
  resolveLivePanel,
  screenLabel,
  setLivePanelSourceProvider,
  streamUrlForScreen,
  unresolvedPanelNote,
  type LivePanel,
} from "../src/utils/foldable";

const DUO = "B6C52FD4-5408-402B-9369-EF7C66B98E6F";
const PANELS = [
  { screenId: 1, width: 1398, height: 2034 },
  { screenId: 3, width: 2007, height: 2853 },
];

/** CoreDevice's `device info displays` payload for the iPhone Duo, as measured. */
function duoPayload(active: 1 | 3, orientation = "portrait"): unknown {
  return {
    info: { outcome: "success" },
    result: {
      displays: [
        {
          active: active === 1,
          backlightState: active === 1 ? "activeOn" : "off",
          displayId: 1,
          nativeSize: [1398, 2034],
          currentOrientation: "rot0",
          primary: true,
          type: { integrated: {} },
        },
        {
          active: active === 3,
          backlightState: active === 3 ? "activeOn" : "off",
          displayId: 3,
          nativeSize: [2007, 2853],
          currentOrientation: "rot90",
          primary: false,
          type: { integrated: {} },
        },
        // Not panels: the tvOut / carPlay / scene surfaces.
        { active: false, displayId: 2, nativeSize: [1920, 1080], type: { external: {} } },
      ],
      orientation: { currentDeviceOrientation: orientation },
    },
  };
}

const isDevicectl = (cmd: string, args: readonly string[]): boolean =>
  cmd.endsWith("/devicectl") || (cmd === "xcrun" && args[0] === "devicectl");

/** Answer `xcode-select -p` and every devicectl query from a queue of payloads. */
function mockDevicectl(payloads: Array<unknown | Error>): void {
  const queue = [...payloads];
  execFileMock.mockImplementation((cmd: string, args: readonly string[]) => {
    if (cmd === "xcode-select") return { stdout: "/Applications/Xcode.app/Contents/Developer\n" };
    if (isDevicectl(cmd, args)) {
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) return next;
      return { stdout: JSON.stringify(next), stderr: "Current Displays:\n" };
    }
    return new Error(`unexpected command ${cmd} ${args.join(" ")}`);
  });
}

/**
 * A CoreDevice that hangs: every devicectl query waits until `answer` is
 * called with a payload (or an error) for all of them at once.
 */
function mockHangingDevicectl(): { answer: (payload: unknown | Error) => void } {
  const waiting: Array<(r: unknown) => void> = [];
  execFileMock.mockImplementation((cmd: string, args: readonly string[]) => {
    if (cmd === "xcode-select") return { stdout: "/Applications/Xcode.app/Contents/Developer\n" };
    if (isDevicectl(cmd, args)) return new Promise((resolve) => waiting.push(resolve));
    return new Error(`unexpected command ${cmd} ${args.join(" ")}`);
  });
  return {
    answer: (payload) => {
      for (const resolve of waiting.splice(0)) {
        resolve(
          payload instanceof Error ? payload : { stdout: JSON.stringify(payload), stderr: "" }
        );
      }
    },
  };
}

const devicectlCalls = (): number =>
  execFileMock.mock.calls.filter(([c, a]) => isDevicectl(c, a)).length;

/** The ax-service's `live_panel`, as the provider hands it to the resolver. */
const livePanelMock = vi.fn<() => Promise<number | null>>();
const providerMock = vi.fn(async (_udid: string) => ({ livePanel: livePanelMock }));

/** The error CoreDevice's timeout leaves: execFile kills the child with SIGKILL. */
function timeoutError(): Error {
  return Object.assign(new Error("spawnSync devicectl ETIMEDOUT"), {
    killed: true,
    signal: "SIGKILL",
  });
}

beforeEach(() => {
  execFileMock.mockReset();
  isFoldableSimulatorMock.mockReset().mockResolvedValue(true);
  livePanelMock.mockReset();
  providerMock.mockClear();
  setLivePanelSourceProvider(providerMock);
  __resetFoldableStateForTests();
});

afterEach(() => {
  setLivePanelSourceProvider(undefined);
  vi.useRealTimers();
});

describe("parseDisplaysPayload", () => {
  it("reads the lit integrated panel and every panel's size", () => {
    expect(parseDisplaysPayload(duoPayload(3))).toEqual({ activeScreen: 3, panels: PANELS });
    expect(parseDisplaysPayload(duoPayload(1))?.activeScreen).toBe(1);
  });

  it("goes by the backlight, which a regular iPhone reports without `active`", () => {
    const iphone = {
      result: {
        displays: [
          {
            backlightState: "activeOn",
            displayId: 1,
            nativeSize: [1206, 2622],
            type: { integrated: {} },
          },
        ],
        orientation: { currentDeviceOrientation: "unknown" },
      },
    };
    expect(parseDisplaysPayload(iphone)).toEqual({
      activeScreen: 1,
      panels: [{ screenId: 1, width: 1206, height: 2622 }],
    });
    // `active` alone, for a payload whose backlight states are not known.
    const noBacklight = {
      result: {
        displays: [
          { active: false, displayId: 1, nativeSize: [1398, 2034], type: { integrated: {} } },
          { active: true, displayId: 3, nativeSize: [2007, 2853], type: { integrated: {} } },
        ],
      },
    };
    expect(parseDisplaysPayload(noBacklight)?.activeScreen).toBe(3);
  });

  it("lets `active` break the tie while both panels are lit around a hand-over", () => {
    const handOver = {
      result: {
        displays: [
          {
            active: false,
            backlightState: "activeOn",
            displayId: 1,
            nativeSize: [1398, 2034],
            type: { integrated: {} },
          },
          {
            active: true,
            backlightState: "activeOn",
            displayId: 3,
            nativeSize: [2007, 2853],
            type: { integrated: {} },
          },
        ],
      },
    };
    expect(parseDisplaysPayload(handOver)?.activeScreen).toBe(3);
    // Both lit and nothing flagged: no answer, rather than a guess.
    const tie = JSON.parse(JSON.stringify(handOver)) as {
      result: { displays: Array<{ active: boolean }> };
    };
    tie.result.displays[1]!.active = false;
    expect(parseDisplaysPayload(tie)).toBeNull();
  });

  it("is null when no integrated panel is lit, or the shape is not CoreDevice's", () => {
    const dark = JSON.parse(JSON.stringify(duoPayload(1))) as {
      result: { displays: Array<{ active: boolean; backlightState: string }> };
    };
    dark.result.displays[0]!.backlightState = "off";
    expect(parseDisplaysPayload(dark)).toBeNull();
    expect(parseDisplaysPayload({ result: { displays: "nope" } })).toBeNull();
    expect(parseDisplaysPayload(null)).toBeNull();
    expect(parseDisplaysPayload({ result: { displays: [{ displayId: 1 }] } })).toBeNull();
  });
});

describe("readCoreDeviceDisplays", () => {
  it("asks CoreDevice for the device's displays with the selected Xcode", async () => {
    mockDevicectl([duoPayload(3)]);
    const { displays, reason } = await readCoreDeviceDisplays(DUO);
    expect(displays?.activeScreen).toBe(3);
    expect(reason).toBeUndefined();
    const call = execFileMock.mock.calls.find(([c, a]) => isDevicectl(c, a))!;
    const [cmd, args, opts] = call as [string, string[], { env: Record<string, string> }];
    const argv = cmd === "xcrun" ? args.slice(1) : args;
    expect(argv).toEqual(["device", "info", "displays", "--device", DUO, "--json-output", "-"]);
    expect(opts.env.DEVELOPER_DIR).toBe("/Applications/Xcode.app/Contents/Developer");
  });

  it("queries a provider's device by its raw UDID", async () => {
    mockDevicectl([duoPayload(1)]);
    await readCoreDeviceDisplays(`ext:acme-3f2a9c:${DUO}`);
    const call = execFileMock.mock.calls.find(([c, a]) => isDevicectl(c, a))!;
    expect(call[1] as string[]).toContain(DUO);
    expect(call[1] as string[]).not.toContain(`ext:acme-3f2a9c:${DUO}`);
  });

  it("says why when CoreDevice fails, times out, or answers something else", async () => {
    mockDevicectl([new Error("devicectl: no such device")]);
    expect((await readCoreDeviceDisplays(DUO)).reason).toBe(
      "CoreDevice failed (devicectl: no such device)"
    );
    mockDevicectl([timeoutError()]);
    expect((await readCoreDeviceDisplays(DUO)).reason).toBe(
      `CoreDevice did not answer within ${DEVICECTL_TIMEOUT_MS / 1000} s`
    );
    execFileMock.mockImplementation((cmd: string) =>
      cmd === "xcode-select" ? { stdout: "/x\n" } : { stdout: "not json" }
    );
    expect((await readCoreDeviceDisplays(DUO)).reason).toBe(
      "CoreDevice answered something that is not JSON"
    );
    mockDevicectl([{ result: { displays: [] } }]);
    expect((await readCoreDeviceDisplays(DUO)).reason).toBe(
      "CoreDevice reported no lit integrated panel"
    );
  });
});

describe("resolveLivePanel", () => {
  it("takes the ax-service's answer and asks CoreDevice nothing", async () => {
    livePanelMock.mockResolvedValue(3);
    mockDevicectl([duoPayload(1)]);
    expect(await resolveLivePanel(DUO)).toEqual({ screen: 3, source: "ax-service" });
    expect(providerMock).toHaveBeenCalledWith(DUO);
    expect(devicectlCalls()).toBe(0);
  });

  it("asks CoreDevice when the ax-service names no panel, fails, or is not wired in", async () => {
    mockDevicectl([duoPayload(3)]);
    livePanelMock.mockResolvedValue(null);
    expect(await resolveLivePanel(DUO)).toEqual({ screen: 3, source: "coredevice" });

    livePanelMock.mockRejectedValue(new Error("ax-service not connected"));
    expect(await resolveLivePanel(DUO)).toEqual({ screen: 3, source: "coredevice" });

    providerMock.mockRejectedValueOnce(new Error("could not spawn the daemon"));
    expect(await resolveLivePanel(DUO)).toEqual({ screen: 3, source: "coredevice" });

    setLivePanelSourceProvider(undefined);
    expect(await resolveLivePanel(DUO)).toEqual({ screen: 3, source: "coredevice" });
    expect(devicectlCalls()).toBe(4);
  });

  it("gives a hung ax-service its budget, then asks CoreDevice", async () => {
    vi.useFakeTimers();
    livePanelMock.mockReturnValue(new Promise(() => {}));
    mockDevicectl([duoPayload(3)]);
    const read = resolveLivePanel(DUO);
    await vi.advanceTimersByTimeAsync(AX_LIVE_PANEL_TIMEOUT_MS - 1);
    expect(devicectlCalls()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await read).toEqual({ screen: 3, source: "coredevice" });
  });

  it("falls back to the main screen, with both reasons, when neither source answers", async () => {
    livePanelMock.mockRejectedValue(new Error("ax-service query timed out: live_panel"));
    mockDevicectl([timeoutError()]);
    const panel = await resolveLivePanel(DUO);
    expect(panel.screen).toBe(1);
    expect(panel.source).toBe("unknown");
    if (panel.source !== "unknown") throw new Error("unreachable");
    expect(panel.reason).toBe(
      "the accessibility service failed (ax-service query timed out: live_panel); " +
        `CoreDevice did not answer within ${DEVICECTL_TIMEOUT_MS / 1000} s`
    );
    const note = unresolvedPanelNote(DUO, panel.reason, "this touch went to", PANELS);
    expect(note).toContain("could not be resolved (the accessibility service failed");
    expect(note).toContain("this touch went to screen 1 (cover panel, 1398x2034)");
    expect(note).toContain(`xcrun devicectl device info displays --device ${DUO}`);
  });

  it("remembers nothing: every call asks again", async () => {
    livePanelMock.mockResolvedValueOnce(1).mockResolvedValueOnce(3);
    expect((await resolveLivePanel(DUO)).screen).toBe(1);
    expect((await resolveLivePanel(DUO)).screen).toBe(3);
    expect(livePanelMock).toHaveBeenCalledTimes(2);
  });

  it("shares a read in flight, so a gesture and its capture ask once", async () => {
    let answer: (id: number) => void = () => {};
    livePanelMock.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const a = resolveLivePanel(DUO);
    const b = resolveLivePanel(DUO);
    const other = resolveLivePanel("11111111-2222-3333-4444-555555555555");
    // The provider is reached asynchronously; let the three calls get there.
    await new Promise((r) => setImmediate(r));
    expect(livePanelMock).toHaveBeenCalledTimes(2);
    answer(3);
    expect(await a).toEqual({ screen: 3, source: "ax-service" });
    expect(await b).toEqual({ screen: 3, source: "ax-service" });
    expect((await other).screen).toBe(3);
    // Landed: the next call reads anew.
    livePanelMock.mockResolvedValue(1);
    expect((await resolveLivePanel(DUO)).screen).toBe(1);
  });
});

describe("awaitLivePanel", () => {
  it("polls until a read satisfies the predicate", async () => {
    livePanelMock.mockResolvedValueOnce(1).mockResolvedValueOnce(1).mockResolvedValue(3);
    const panel = await awaitLivePanel(DUO, (screen) => screen === 3, {
      timeoutMs: 2_000,
      pollMs: 5,
    });
    expect(panel).toEqual({ screen: 3, source: "ax-service" });
    expect(livePanelMock).toHaveBeenCalledTimes(3);
  });

  it("answers with the last panel read when the predicate never holds", async () => {
    livePanelMock.mockResolvedValue(1);
    const panel = await awaitLivePanel(DUO, () => false, { timeoutMs: 40, pollMs: 5 });
    expect(panel).toEqual({ screen: 1, source: "ax-service" });
  });

  it("is null only when nothing resolved the panel", async () => {
    livePanelMock.mockResolvedValue(null);
    mockDevicectl([new Error("nope")]);
    expect(await awaitLivePanel(DUO, () => true, { timeoutMs: 30, pollMs: 5 })).toBeNull();
  });

  it("stops at an abort with what it read so far", async () => {
    livePanelMock.mockResolvedValue(1);
    const controller = new AbortController();
    const wait = awaitLivePanel(DUO, () => false, {
      timeoutMs: 5_000,
      pollMs: 5,
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 15));
    controller.abort();
    expect(await wait).toEqual({ screen: 1, source: "ax-service" });
  });

  it("keeps its budget as wall clock when both sources hang", async () => {
    livePanelMock.mockReturnValue(new Promise(() => {}));
    mockHangingDevicectl();
    const started = Date.now();
    const panel = await awaitLivePanel(DUO, () => true, { timeoutMs: 100, pollMs: 5 });
    expect(panel).toBeNull();
    // The one read outlives the budget by no more than the grace.
    expect(Date.now() - started).toBeLessThan(1_500);
  });
});

describe("holdLivePanel", () => {
  const initial: LivePanel = { screen: 1, source: "ax-service" };

  it("keeps polling through the hold and answers the panel it ended on", async () => {
    livePanelMock.mockResolvedValue(3);
    const panel = await holdLivePanel(DUO, initial, 40, { pollMs: 5 });
    expect(panel).toEqual({ screen: 3, source: "ax-service" });
    expect(livePanelMock.mock.calls.length).toBeGreaterThan(1);
  });

  it("restarts the hold when the panel changes under it, so a transient hand-over is not taken", async () => {
    // Inner for the first reads, then the cover again: the answer is the cover,
    // held for its own full hold.
    livePanelMock
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(1)
      .mockResolvedValue(1);
    const started = Date.now();
    const panel = await holdLivePanel(DUO, { screen: 3, source: "ax-service" }, 40, {
      pollMs: 5,
    });
    expect(panel?.screen).toBe(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  it("bounds the restarts", async () => {
    let flip = 1;
    livePanelMock.mockImplementation(async () => (flip = flip === 1 ? 3 : 1));
    const started = Date.now();
    await holdLivePanel(DUO, initial, 30, { pollMs: 5, maxMs: 80 });
    expect(Date.now() - started).toBeLessThan(400);
  });

  it("answers what it was given when no read succeeds, and ends early on an abort", async () => {
    livePanelMock.mockResolvedValue(null);
    mockDevicectl([new Error("nope")]);
    expect(await holdLivePanel(DUO, initial, 20, { pollMs: 5 })).toEqual(initial);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const started = Date.now();
    await holdLivePanel(DUO, initial, 5_000, { pollMs: 5, signal: controller.signal });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("panelForHingeAngle", () => {
  it("names the cover panel up to 75°, the inner panel from 90°, and nothing in between", () => {
    expect(panelForHingeAngle(0, PANELS)).toBe(1);
    expect(panelForHingeAngle(75, PANELS)).toBe(1);
    expect(panelForHingeAngle(80, PANELS)).toBeUndefined();
    expect(panelForHingeAngle(90, PANELS)).toBe(3);
    expect(panelForHingeAngle(180, PANELS)).toBe(3);
  });

  it("has no inner panel to name without a panel list", () => {
    expect(panelForHingeAngle(180, [])).toBeUndefined();
  });
});

describe("labels", () => {
  it("names the cover and inner panels, with their size when known", () => {
    expect(screenLabel(1, PANELS)).toBe("screen 1 (cover panel, 1398x2034)");
    expect(screenLabel(3, PANELS)).toBe("screen 3 (inner panel, 2007x2853)");
    expect(screenLabel(3)).toBe("screen 3 (inner panel)");
  });

  it("keeps the bare stream URL for the main screen and names any other", () => {
    expect(streamUrlForScreen("http://h/stream.mjpeg", 1)).toBe("http://h/stream.mjpeg");
    expect(streamUrlForScreen("http://h/stream.mjpeg", 3)).toBe("http://h/stream.mjpeg?screen=3");
    expect(streamUrlForScreen("http://h/stream.mjpeg?fps=30", 3)).toBe(
      "http://h/stream.mjpeg?fps=30&screen=3"
    );
  });
});

describe("foldablePostureHint", () => {
  it("names the posture behind each size on a foldable", async () => {
    mockDevicectl([duoPayload(1)]);
    const hint = await foldablePostureHint(
      DUO,
      { width: 1398, height: 2034 },
      { width: 2007, height: 2853 }
    );
    expect(hint).toContain("1398x2034 is the cover panel (closed)");
    expect(hint).toContain("2007x2853 is the inner panel (half-open or open)");
  });

  it("matches a downscaled capture of a panel by aspect", async () => {
    mockDevicectl([duoPayload(1)]);
    const hint = await foldablePostureHint(
      DUO,
      { width: 699, height: 1017 },
      { width: 1004, height: 1427 }
    );
    expect(hint).toContain("699x1017 is the cover panel (closed)");
  });

  it("says nothing for a device that is not foldable", async () => {
    isFoldableSimulatorMock.mockResolvedValue(false);
    expect(
      await foldablePostureHint(DUO, { width: 1, height: 2 }, { width: 2, height: 1 })
    ).toBeUndefined();
    expect(devicectlCalls()).toBe(0);
  });

  it("still says baselines are per posture when the panels cannot be read", async () => {
    mockDevicectl([new Error("no")]);
    const hint = await foldablePostureHint(DUO, { width: 1, height: 2 }, { width: 2, height: 1 });
    expect(hint).toContain("baseline belongs to the posture that produced it");
    expect(hint).toContain("Take the baseline in the posture under test");
  });
});
