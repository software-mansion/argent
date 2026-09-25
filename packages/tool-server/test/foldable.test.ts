import { describe, it, expect, vi, beforeEach } from "vitest";

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
  activeScreenForCommand,
  activeScreenOrMain,
  awaitActiveScreen,
  crossCheckDescribedScreen,
  crossCheckTreeScreen,
  foldablePostureHint,
  getCachedActiveScreen,
  holdActiveScreen,
  panelForHingeAngle,
  parseDisplaysPayload,
  queryActiveScreen,
  READ_RETRY_AFTER_MS,
  readActiveScreenOrMain,
  readActiveScreenOrMemo,
  refreshActiveScreen,
  rememberServerPanels,
  screenLabel,
  streamUrlForScreen,
} from "../src/utils/foldable";

const DUO = "B6C52FD4-5408-402B-9369-EF7C66B98E6F";

/** CoreDevice's `device info displays` payload for the iPhone Duo, as measured. */
function duoPayload(active: 1 | 3, orientation = "portrait"): unknown {
  return {
    info: { outcome: "success" },
    result: {
      backlightState: "activeOn",
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

beforeEach(() => {
  execFileMock.mockReset();
  isFoldableSimulatorMock.mockReset().mockResolvedValue(true);
  __resetFoldableStateForTests();
});

describe("parseDisplaysPayload", () => {
  it("reads the active integrated panel, every panel's size and the orientation", () => {
    const state = parseDisplaysPayload(duoPayload(3, "landscapeRight"), 42);
    expect(state).toEqual({
      activeScreen: 3,
      panels: [
        { screenId: 1, width: 1398, height: 2034 },
        { screenId: 3, width: 2007, height: 2853 },
      ],
      orientation: "landscapeRight",
      readAt: 42,
    });
  });

  it("is null when no integrated panel is active, or the shape is not CoreDevice's", () => {
    const payload = duoPayload(1) as { result: { displays: Array<{ active: boolean }> } };
    for (const d of payload.result.displays) d.active = false;
    expect(parseDisplaysPayload(payload)).toBeNull();
    expect(parseDisplaysPayload({ result: {} })).toBeNull();
    expect(parseDisplaysPayload(null)).toBeNull();
    expect(parseDisplaysPayload("not json")).toBeNull();
  });
});

describe("queryActiveScreen", () => {
  it("asks CoreDevice for the device's displays with the selected Xcode", async () => {
    mockDevicectl([duoPayload(1)]);
    const state = await queryActiveScreen(DUO);
    expect(state?.activeScreen).toBe(1);
    const call = execFileMock.mock.calls.find(([cmd, args]) =>
      isDevicectl(cmd as string, args as string[])
    );
    expect(call).toBeDefined();
    const [, args, options] = call!;
    expect(args as string[]).toEqual(
      expect.arrayContaining(["device", "info", "displays", "--device", DUO, "--json-output", "-"])
    );
    expect((options as { env: NodeJS.ProcessEnv }).env.DEVELOPER_DIR).toBe(
      "/Applications/Xcode.app/Contents/Developer"
    );
  });

  it("queries a provider's device by its raw UDID", async () => {
    mockDevicectl([duoPayload(1)]);
    await queryActiveScreen(`ext:acme-3f2a9c:${DUO}`);
    const call = execFileMock.mock.calls.find(([cmd, args]) =>
      isDevicectl(cmd as string, args as string[])
    );
    expect(call![1] as string[]).toContain(DUO);
    expect(call![1] as string[]).not.toContain(`ext:acme-3f2a9c:${DUO}`);
  });

  it("is null when CoreDevice fails or answers something else", async () => {
    mockDevicectl([new Error("devicectl: device not found")]);
    expect(await queryActiveScreen(DUO)).toBeNull();
    execFileMock.mockImplementation((cmd: string) =>
      cmd === "xcode-select" ? { stdout: "/x\n" } : { stdout: "not json" }
    );
    expect(await queryActiveScreen(DUO)).toBeNull();
  });
});

describe("the active-screen memo", () => {
  it("is empty until a read, and answers the main screen meanwhile", () => {
    expect(getCachedActiveScreen(DUO)).toBeUndefined();
    expect(activeScreenOrMain(DUO)).toBe(1);
  });

  it("is filled by a successful read and kept across a failed one", async () => {
    mockDevicectl([duoPayload(3)]);
    expect((await refreshActiveScreen(DUO))?.activeScreen).toBe(3);
    expect(activeScreenOrMain(DUO)).toBe(3);

    mockDevicectl([new Error("CoreDevice went away")]);
    expect(await refreshActiveScreen(DUO)).toBeNull();
    // A transient failure must not snap every touch back to the cover panel.
    expect(activeScreenOrMain(DUO)).toBe(3);
  });

  it("answers a read that fails with the memo, and with the main screen only without one", async () => {
    vi.useFakeTimers();
    try {
      mockDevicectl([new Error("no")]);
      expect(await readActiveScreenOrMain(DUO)).toBe(1);
      // CoreDevice recovers. Within the back-off nothing asks it; past it, the
      // capture still answers at once and the read lands behind it.
      mockDevicectl([duoPayload(3)]);
      expect(await readActiveScreenOrMain(DUO)).toBe(1);
      expect(devicectlCalls()).toBe(1);
      vi.advanceTimersByTime(READ_RETRY_AFTER_MS);
      expect(await readActiveScreenOrMain(DUO)).toBe(1);
      expect(devicectlCalls()).toBe(2);
      await refreshActiveScreen(DUO);
      expect(await readActiveScreenOrMain(DUO)).toBe(3);
      mockDevicectl([new Error("no")]);
      expect(await readActiveScreenOrMain(DUO)).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells a follower whether the panel it answers was read or is the memo's", async () => {
    vi.useFakeTimers();
    try {
      mockDevicectl([new Error("no")]);
      // Nothing known: the follower stays where it is.
      expect(await readActiveScreenOrMemo(DUO)).toBeNull();
      // CoreDevice answers again: past the back-off a poll starts the read,
      // and once it has landed the polls are answered fresh.
      mockDevicectl([duoPayload(1)]);
      vi.advanceTimersByTime(READ_RETRY_AFTER_MS);
      expect(await readActiveScreenOrMemo(DUO)).toBeNull();
      await refreshActiveScreen(DUO);
      expect(await readActiveScreenOrMemo(DUO)).toEqual({ screen: 1, fresh: true });
      // CoreDevice stops answering and a describe moves the memo to the inner
      // panel: the follower goes where the touches go.
      mockDevicectl([new Error("no")]);
      expect(await readActiveScreenOrMemo(DUO)).toEqual({ screen: 1, fresh: false });
      await crossCheckDescribedScreen(DUO, 3);
      expect(await readActiveScreenOrMemo(DUO)).toEqual({ screen: 3, fresh: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares a read in flight, so a slow CoreDevice is asked once for everyone", async () => {
    const hang = mockHangingDevicectl();
    const first = refreshActiveScreen(DUO);
    const second = refreshActiveScreen(DUO);
    const touch = activeScreenForCommand(DUO);
    const capture = readActiveScreenOrMain(DUO);
    // The query is spawned once the developer dir has resolved.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(devicectlCalls()).toBe(1);
    hang.answer(duoPayload(3));
    expect((await first)?.activeScreen).toBe(3);
    expect(await second).toBe(await first);
    expect(await touch).toBe(3);
    expect(await capture).toBe(3);
    expect(devicectlCalls()).toBe(1);
  });

  it("does not hold a capture up while CoreDevice is failing, and reads again once it answers", async () => {
    vi.useFakeTimers();
    try {
      mockDevicectl([duoPayload(3)]);
      await refreshActiveScreen(DUO);
      // The first failure is waited for: nothing said CoreDevice was down.
      mockDevicectl([new Error("no")]);
      expect(await readActiveScreenOrMain(DUO)).toBe(3);
      expect(devicectlCalls()).toBe(2);
      // From then on a capture takes the memo without asking...
      expect(await readActiveScreenOrMain(DUO)).toBe(3);
      expect(await readActiveScreenOrMemo(DUO)).toEqual({ screen: 3, fresh: false });
      expect(devicectlCalls()).toBe(2);
      // ...and past the back-off it asks in the background, still answering
      // the memo at once, with one query in flight however often it asks.
      vi.advanceTimersByTime(READ_RETRY_AFTER_MS);
      const hang = mockHangingDevicectl();
      expect(await readActiveScreenOrMain(DUO)).toBe(3);
      expect(devicectlCalls()).toBe(3);
      vi.advanceTimersByTime(READ_RETRY_AFTER_MS);
      expect(await readActiveScreenOrMain(DUO)).toBe(3);
      expect(await readActiveScreenOrMemo(DUO)).toEqual({ screen: 3, fresh: false });
      expect(devicectlCalls()).toBe(3);
      // The device was folded meanwhile. The read that lands says so, and the
      // capture after it waits for a fresh read again.
      const landed = refreshActiveScreen(DUO); // shares the read in flight
      hang.answer(duoPayload(1));
      expect((await landed)?.activeScreen).toBe(1);
      mockDevicectl([duoPayload(1)]);
      expect(await readActiveScreenOrMemo(DUO)).toEqual({ screen: 1, fresh: true });
      expect(devicectlCalls()).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("activeScreenForCommand", () => {
  it("answers the memo without a read", async () => {
    mockDevicectl([duoPayload(3)]);
    await refreshActiveScreen(DUO);
    expect(await activeScreenForCommand(DUO)).toBe(3);
    expect(devicectlCalls()).toBe(1);
  });

  it("reads for itself while the memo is empty, without waiting on a CoreDevice that is failing", async () => {
    vi.useFakeTimers();
    try {
      // The attach-time read failed: nothing memoized, a failure on record.
      mockDevicectl([new Error("no")]);
      expect(await refreshActiveScreen(DUO)).toBeNull();
      // The back-off is running: main screen, no read.
      expect(await activeScreenForCommand(DUO)).toBe(1);
      expect(devicectlCalls()).toBe(1);
      // Past the back-off the touch still answers at once, and the read it
      // starts runs behind it — a wedged CoreDevice costs it nothing.
      vi.advanceTimersByTime(READ_RETRY_AFTER_MS);
      const hang = mockHangingDevicectl();
      expect(await activeScreenForCommand(DUO)).toBe(1);
      expect(devicectlCalls()).toBe(2);
      // While that read hangs, nothing else asks.
      vi.advanceTimersByTime(READ_RETRY_AFTER_MS);
      expect(await activeScreenForCommand(DUO)).toBe(1);
      expect(await readActiveScreenOrMain(DUO)).toBe(1);
      expect(devicectlCalls()).toBe(2);
      // It lands, and from then on the memo answers.
      const landed = refreshActiveScreen(DUO); // shares the read in flight
      hang.answer(duoPayload(3));
      expect((await landed)?.activeScreen).toBe(3);
      expect(getCachedActiveScreen(DUO)?.activeScreen).toBe(3);
      expect(await activeScreenForCommand(DUO)).toBe(3);
      expect(devicectlCalls()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads at once when nothing has failed yet", async () => {
    mockDevicectl([duoPayload(3)]);
    expect(await activeScreenForCommand(DUO)).toBe(3);
    expect(devicectlCalls()).toBe(1);
  });
});

describe("awaitActiveScreen", () => {
  it("polls until a read satisfies the predicate, memoizing every read", async () => {
    mockDevicectl([duoPayload(1), duoPayload(1), duoPayload(3)]);
    const state = await awaitActiveScreen(DUO, (s) => s.activeScreen === 3, {
      pollMs: 1,
      timeoutMs: 1000,
    });
    expect(state?.activeScreen).toBe(3);
    expect(execFileMock.mock.calls.filter(([c, a]) => isDevicectl(c, a)).length).toBe(3);
    expect(getCachedActiveScreen(DUO)?.activeScreen).toBe(3);
  });

  it("answers with the last state read when the predicate never holds", async () => {
    mockDevicectl([duoPayload(1)]);
    const state = await awaitActiveScreen(DUO, (s) => s.activeScreen === 3, {
      pollMs: 1,
      timeoutMs: 5,
    });
    // The caller tells a settled read from the last one by applying the predicate again.
    expect(state?.activeScreen).toBe(1);
    expect(getCachedActiveScreen(DUO)?.activeScreen).toBe(1);
  });

  it("is null only when every read failed", async () => {
    mockDevicectl([new Error("no")]);
    expect(await awaitActiveScreen(DUO, () => true, { pollMs: 1, timeoutMs: 5 })).toBeNull();
  });

  it("stops at an abort with what it read so far", async () => {
    mockDevicectl([duoPayload(1)]);
    const controller = new AbortController();
    const state = await awaitActiveScreen(
      DUO,
      (s) => {
        // The run is cancelled as the first read comes in.
        controller.abort();
        return s.activeScreen === 3;
      },
      { pollMs: 1, timeoutMs: 1000, signal: controller.signal }
    );
    expect(state?.activeScreen).toBe(1);
    expect(devicectlCalls()).toBe(1);
    // Cancelled before it starts, it reads nothing.
    expect(
      await awaitActiveScreen(DUO, () => true, { pollMs: 1, signal: controller.signal })
    ).toBeNull();
    expect(devicectlCalls()).toBe(1);
  });

  it("keeps its budget as wall clock when CoreDevice hangs; the read lands in the memo when it comes", async () => {
    const hang = mockHangingDevicectl();
    const started = Date.now();
    const state = await awaitActiveScreen(DUO, () => true, { pollMs: 5, timeoutMs: 600 });
    expect(state).toBeNull();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(590);
    expect(elapsed).toBeLessThan(1500);
    // One query hung the whole wait; it is still the one in flight.
    expect(devicectlCalls()).toBe(1);
    const landed = refreshActiveScreen(DUO);
    expect(devicectlCalls()).toBe(1);
    hang.answer(duoPayload(3));
    expect((await landed)?.activeScreen).toBe(3);
    expect(getCachedActiveScreen(DUO)?.activeScreen).toBe(3);
  });
});

describe("holdActiveScreen", () => {
  it("keeps polling through the hold and answers the state it ended on", async () => {
    mockDevicectl([duoPayload(3)]);
    const state = await holdActiveScreen(DUO, { activeScreen: 3, panels: [], readAt: 0 }, 20, {
      pollMs: 5,
    });
    expect(state?.activeScreen).toBe(3);
    expect(devicectlCalls()).toBeGreaterThanOrEqual(2);
  });

  it("restarts the hold when the panel changes under it, so a transient hand-over is not latched", async () => {
    // From closed to 78°: the wait saw the inner panel; during the hold the
    // device returns to the cover. The hold starts over on the cover and ends
    // there, and the memo follows.
    const reads: number[] = [];
    execFileMock.mockImplementation((cmd: string, args: readonly string[]) => {
      if (cmd === "xcode-select") return { stdout: "/x\n" };
      if (isDevicectl(cmd, args)) {
        reads.push(Date.now());
        // The first read still sees the transient inner panel; the second, the cover.
        const payload = reads.length === 1 ? duoPayload(3) : duoPayload(1);
        return { stdout: JSON.stringify(payload) };
      }
      return new Error("unexpected");
    });
    const holdMs = 30;
    const state = await holdActiveScreen(DUO, { activeScreen: 3, panels: [], readAt: 0 }, holdMs, {
      pollMs: 5,
    });
    const finished = Date.now();
    expect(state?.activeScreen).toBe(1);
    expect(getCachedActiveScreen(DUO)?.activeScreen).toBe(1);
    // A whole hold ran again from the read that saw the change (the second one).
    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect(finished - reads[1]!).toBeGreaterThanOrEqual(holdMs - 2);
  });

  it("bounds the restarts", async () => {
    let flip = 1;
    execFileMock.mockImplementation((cmd: string, args: readonly string[]) => {
      if (cmd === "xcode-select") return { stdout: "/x\n" };
      if (isDevicectl(cmd, args)) {
        flip = flip === 1 ? 3 : 1;
        return { stdout: JSON.stringify(duoPayload(flip as 1 | 3)) };
      }
      return new Error("unexpected");
    });
    const started = Date.now();
    const state = await holdActiveScreen(DUO, { activeScreen: 1, panels: [], readAt: 0 }, 20, {
      pollMs: 5,
      maxMs: 60,
    });
    expect(state).not.toBeNull();
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("answers what it was given when no read succeeds, and ends early on an abort", async () => {
    mockDevicectl([new Error("no")]);
    const initial = { activeScreen: 3, panels: [], readAt: 0 };
    expect(await holdActiveScreen(DUO, initial, 10, { pollMs: 2 })).toBe(initial);
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    expect(
      await holdActiveScreen(DUO, initial, 1000, { pollMs: 5, signal: controller.signal })
    ).toBe(initial);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("keeps its clock when CoreDevice hangs, and answers what it was given", async () => {
    const hang = mockHangingDevicectl();
    const initial = { activeScreen: 3, panels: [], readAt: 0 };
    const started = Date.now();
    // The one read of the hold is waited for the hold's remainder plus the
    // read grace, not CoreDevice's whole timeout.
    expect(await holdActiveScreen(DUO, initial, 20, { pollMs: 5 })).toBe(initial);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(devicectlCalls()).toBe(1);
    hang.answer(duoPayload(3));
  });
});

describe("panelForHingeAngle", () => {
  const panels = [
    { screenId: 1, width: 1398, height: 2034 },
    { screenId: 3, width: 2007, height: 2853 },
  ];

  it("names the cover panel up to 75°, the inner panel from 90°, and nothing in between", () => {
    expect(panelForHingeAngle(0, panels)).toBe(1);
    expect(panelForHingeAngle(75, panels)).toBe(1);
    expect(panelForHingeAngle(80, panels)).toBeUndefined();
    expect(panelForHingeAngle(90, panels)).toBe(3);
    expect(panelForHingeAngle(120, panels)).toBe(3);
    expect(panelForHingeAngle(180, panels)).toBe(3);
  });

  it("has no inner panel to name without a panel list", () => {
    expect(panelForHingeAngle(180, [])).toBeUndefined();
    expect(panelForHingeAngle(0, [])).toBe(1);
  });
});

describe("labels", () => {
  it("names the cover and inner panels, with their size when known", () => {
    const panels = [
      { screenId: 1, width: 1398, height: 2034 },
      { screenId: 3, width: 2007, height: 2853 },
    ];
    expect(screenLabel(1, panels)).toBe("screen 1 (cover panel, 1398x2034)");
    expect(screenLabel(3, panels)).toBe("screen 3 (inner panel, 2007x2853)");
    expect(screenLabel(3)).toBe("screen 3 (inner panel)");
  });

  it("keeps the bare stream URL for the main screen and names any other", () => {
    expect(streamUrlForScreen("http://127.0.0.1:1/stream.mjpeg", 1)).toBe(
      "http://127.0.0.1:1/stream.mjpeg"
    );
    expect(streamUrlForScreen("http://127.0.0.1:1/stream.mjpeg", 3)).toBe(
      "http://127.0.0.1:1/stream.mjpeg?screen=3"
    );
    expect(streamUrlForScreen("http://127.0.0.1:1/stream.mjpeg?x=1", 3)).toBe(
      "http://127.0.0.1:1/stream.mjpeg?x=1&screen=3"
    );
  });
});

describe("crossCheckDescribedScreen", () => {
  it("has nothing to say without a memo, or when the memo agrees", async () => {
    expect(await crossCheckDescribedScreen(DUO, 3)).toBeUndefined();
    // Nothing ever tried to read: no simulator-server targets a panel.
    expect(execFileMock.mock.calls.filter(([c, a]) => isDevicectl(c, a)).length).toBe(0);
    mockDevicectl([duoPayload(3)]);
    await refreshActiveScreen(DUO);
    expect(await crossCheckDescribedScreen(DUO, 3)).toBeUndefined();
    // No re-query for an agreeing memo: one read, the refresh above.
    expect(execFileMock.mock.calls.filter(([c, a]) => isDevicectl(c, a)).length).toBe(1);
  });

  it("seeds an empty memo left by a failed read from the tree, without waiting on CoreDevice", async () => {
    vi.useFakeTimers();
    try {
      // The attach-time read failed; CoreDevice has recovered since.
      mockDevicectl([new Error("no"), duoPayload(3)]);
      await refreshActiveScreen(DUO);
      // A describe runs on every interaction: it does not wait for a
      // CoreDevice that just failed, it takes the tree's panel and says so.
      expect(await crossCheckDescribedScreen(DUO, 3)).toContain("commands now target screen 3");
      expect(getCachedActiveScreen(DUO)?.activeScreen).toBe(3);
      expect(devicectlCalls()).toBe(1);
      // Past the back-off, a tree on another panel (a fold made outside argent)
      // moves the memo at once and starts the read behind it.
      vi.advanceTimersByTime(READ_RETRY_AFTER_MS);
      mockDevicectl([duoPayload(1)]);
      expect(await crossCheckDescribedScreen(DUO, 1)).toContain("commands now target screen 1");
      expect(getCachedActiveScreen(DUO)?.activeScreen).toBe(1);
      expect(devicectlCalls()).toBe(2);
      await refreshActiveScreen(DUO);
      // CoreDevice answers again: the next disagreement is settled by a fresh read.
      mockDevicectl([duoPayload(3)]);
      expect(await crossCheckDescribedScreen(DUO, 3)).toBeUndefined();
      expect(getCachedActiveScreen(DUO)?.activeScreen).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes the panel the tree was read on when CoreDevice still does not answer", async () => {
    mockDevicectl([new Error("no")]);
    await refreshActiveScreen(DUO);
    const note = await crossCheckDescribedScreen(DUO, 3);
    expect(note).toContain("CoreDevice did not report");
    expect(note).toContain("commands now target screen 3 (inner panel)");
    expect(getCachedActiveScreen(DUO)?.activeScreen).toBe(3);
    expect(activeScreenOrMain(DUO)).toBe(3);
    // The next describe on the same panel has nothing to add, and reads nothing.
    const reads = execFileMock.mock.calls.filter(([c, a]) => isDevicectl(c, a)).length;
    expect(await crossCheckDescribedScreen(DUO, 3)).toBeUndefined();
    expect(execFileMock.mock.calls.filter(([c, a]) => isDevicectl(c, a)).length).toBe(reads);
  });

  it("moves a stale memo to the tree's panel when the re-read fails, keeping the panel list", async () => {
    mockDevicectl([duoPayload(3), new Error("no")]);
    await refreshActiveScreen(DUO);
    const note = await crossCheckDescribedScreen(DUO, 1);
    expect(note).toContain("commands now target screen 1 (cover panel, 1398x2034)");
    expect(getCachedActiveScreen(DUO)?.activeScreen).toBe(1);
    expect(getCachedActiveScreen(DUO)?.panels).toHaveLength(2);
  });

  it("re-reads once on a stale memo and says nothing when the fresh read agrees", async () => {
    // A fold made outside argent: the memo says 1, the tree was read on 3.
    mockDevicectl([duoPayload(1), duoPayload(3)]);
    await refreshActiveScreen(DUO);
    expect(await crossCheckDescribedScreen(DUO, 3)).toBeUndefined();
    // The one action caught the stale memo: it now targets the inner panel.
    expect(getCachedActiveScreen(DUO)?.activeScreen).toBe(3);
  });

  it("notes a describe that still disagrees after the re-read (mid-fold)", async () => {
    mockDevicectl([duoPayload(1)]);
    await refreshActiveScreen(DUO);
    const note = await crossCheckDescribedScreen(DUO, 3);
    expect(note).toContain("screen 3 (inner panel, 2007x2853)");
    expect(note).toContain("screen 1 (cover panel, 1398x2034)");
    expect(note).toContain("await-screen-idle");
  });
});

describe("crossCheckTreeScreen", () => {
  // The flow tree's screen, in points in the fixed orientation.
  const COVER_PT = { width: 466, height: 678 };
  const INNER_PT = { width: 669, height: 951 };
  const reads = () => execFileMock.mock.calls.filter(([c, a]) => isDevicectl(c, a)).length;

  it("reads nothing while the tree's screen has the memo's panel's shape", async () => {
    mockDevicectl([duoPayload(3)]);
    await refreshActiveScreen(DUO);
    await crossCheckTreeScreen(DUO, INNER_PT);
    expect(reads()).toBe(1);
    expect(getCachedActiveScreen(DUO)?.activeScreen).toBe(3);
  });

  it("re-reads a memo left stale by a fold made outside argent", async () => {
    mockDevicectl([duoPayload(1), duoPayload(3)]);
    await refreshActiveScreen(DUO);
    await crossCheckTreeScreen(DUO, INNER_PT);
    expect(reads()).toBe(2);
    expect(getCachedActiveScreen(DUO)?.activeScreen).toBe(3);
  });

  it("takes the panel of the tree's shape when CoreDevice does not answer", async () => {
    mockDevicectl([duoPayload(3), new Error("no")]);
    await refreshActiveScreen(DUO);
    await crossCheckTreeScreen(DUO, COVER_PT);
    expect(getCachedActiveScreen(DUO)?.activeScreen).toBe(1);
    expect(getCachedActiveScreen(DUO)?.panels).toHaveLength(2);
    // The next read of the same screen agrees and costs nothing.
    await crossCheckTreeScreen(DUO, COVER_PT);
    expect(reads()).toBe(2);
  });

  it("seeds an empty memo left by a failed read from the server's panel list", async () => {
    // The simulator-server attached while CoreDevice was not answering, and
    // the device was opened since: without a memo every touch goes to screen 1.
    rememberServerPanels(DUO, [
      { screenId: 1, width: 1398, height: 2034 },
      { screenId: 3, width: 2007, height: 2853 },
    ]);
    mockDevicectl([new Error("no")]);
    await refreshActiveScreen(DUO);
    await crossCheckTreeScreen(DUO, INNER_PT);
    expect(getCachedActiveScreen(DUO)?.activeScreen).toBe(3);
    expect(activeScreenOrMain(DUO)).toBe(3);
    // Seeded, the next read of the same screen asks CoreDevice nothing.
    const before = reads();
    await crossCheckTreeScreen(DUO, INNER_PT);
    expect(reads()).toBe(before);
  });

  it("leaves an empty memo nothing tried to read, and a shape that is no panel's, alone", async () => {
    rememberServerPanels(DUO, [
      { screenId: 1, width: 1398, height: 2034 },
      { screenId: 3, width: 2007, height: 2853 },
    ]);
    await crossCheckTreeScreen(DUO, INNER_PT);
    expect(reads()).toBe(0);
    expect(getCachedActiveScreen(DUO)).toBeUndefined();
    mockDevicectl([duoPayload(1)]);
    await refreshActiveScreen(DUO);
    // A framework that predates the fixed-space screen size reports the
    // landscape window's instead: no panel has that shape.
    await crossCheckTreeScreen(DUO, { width: 951, height: 669 });
    expect(reads()).toBe(1);
    expect(getCachedActiveScreen(DUO)?.activeScreen).toBe(1);
  });
});

describe("foldablePostureHint", () => {
  const closed = { width: 1398, height: 2034 };
  const open = { width: 2007, height: 2853 };

  it("names the posture behind each size on a foldable", async () => {
    mockDevicectl([duoPayload(1)]);
    const hint = await foldablePostureHint(DUO, closed, open);
    expect(hint).toContain("baseline belongs to the posture that produced it");
    expect(hint).toContain("1398x2034 is the cover panel (closed)");
    expect(hint).toContain("2007x2853 is the inner panel (half-open or open)");
  });

  it("matches a downscaled capture of a panel by aspect", async () => {
    mockDevicectl([duoPayload(1)]);
    const hint = await foldablePostureHint(DUO, { width: 350, height: 509 }, open);
    expect(hint).toContain("350x509 is the cover panel (closed)");
  });

  it("says nothing for a device that is not foldable", async () => {
    isFoldableSimulatorMock.mockResolvedValue(false);
    expect(await foldablePostureHint("emulator-5554", closed, open)).toBeUndefined();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("still says baselines are per posture when the panels cannot be read", async () => {
    mockDevicectl([new Error("no")]);
    const hint = await foldablePostureHint(DUO, closed, open);
    expect(hint).toContain("posture under test");
  });
});
