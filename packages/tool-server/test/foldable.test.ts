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
      if (result instanceof Error) callback(result, { stdout: "", stderr: "" });
      else callback(null, result ?? { stdout: "", stderr: "" });
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
  activeScreenOrMain,
  awaitActiveScreen,
  crossCheckDescribedScreen,
  foldablePostureHint,
  getCachedActiveScreen,
  panelForHingeAngle,
  parseDisplaysPayload,
  queryActiveScreen,
  refreshActiveScreen,
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
});

describe("awaitActiveScreen", () => {
  const sleep = vi.fn(async () => {});

  it("polls until a read satisfies the predicate, memoizing every read", async () => {
    mockDevicectl([duoPayload(1), duoPayload(1), duoPayload(3)]);
    const state = await awaitActiveScreen(DUO, (s) => s.activeScreen === 3, {
      pollMs: 1,
      timeoutMs: 1000,
      sleep,
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
      sleep,
    });
    // The caller tells a settled read from the last one by applying the predicate again.
    expect(state?.activeScreen).toBe(1);
    expect(getCachedActiveScreen(DUO)?.activeScreen).toBe(1);
  });

  it("is null only when every read failed", async () => {
    mockDevicectl([new Error("no")]);
    expect(await awaitActiveScreen(DUO, () => true, { pollMs: 1, timeoutMs: 5, sleep })).toBeNull();
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
    mockDevicectl([duoPayload(3)]);
    await refreshActiveScreen(DUO);
    expect(await crossCheckDescribedScreen(DUO, 3)).toBeUndefined();
    // No re-query for an agreeing memo: one read, the refresh above.
    expect(execFileMock.mock.calls.filter(([c, a]) => isDevicectl(c, a)).length).toBe(1);
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
