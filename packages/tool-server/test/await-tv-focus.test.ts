import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";
import type { TvControlApi, TvDescribeResponse } from "../src/blueprints/tv-control-types";

/**
 * Issue #620: on an Apple TV both wait tools polled `describeIos`, which
 * short-circuits every tvOS read to an empty tree. `await-screen-idle` therefore
 * could never settle — it reset on every poll and burned the whole budget
 * without saying why — and no selector could ever match.
 *
 * These pin the routing (focus view, not the iOS AX service) and the two
 * properties that make it safe: the tvOS daemon is never repaired from inside a
 * poll loop, and Android TV keeps its full uiautomator tree.
 */

// Pin the form-factor probe: the real one shells out to `xcrun simctl list`.
vi.mock("../src/utils/ios-devices", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/ios-devices")>(
    "../src/utils/ios-devices"
  );
  return { ...actual, isTvOsSimulator: async () => true };
});

// Pin the Android-TV probe too: the real one shells out to `adb`, which hangs
// or answers for whatever emulator happens to be running on the host.
vi.mock("../src/utils/adb", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/adb")>("../src/utils/adb");
  return { ...actual, isAndroidTv: async () => true };
});

const describeAndroidMock = vi.fn();
vi.mock("../src/tools/describe/platforms/android", async () => {
  const actual = await vi.importActual<typeof import("../src/tools/describe/platforms/android")>(
    "../src/tools/describe/platforms/android"
  );
  return { ...actual, describeAndroid: (...a: unknown[]) => describeAndroidMock(...a) };
});

// describeIos must NOT be reached for a tvOS target — that is the bug.
const describeIosMock = vi.fn();
vi.mock("../src/tools/describe/platforms/ios", async () => {
  const actual = await vi.importActual<typeof import("../src/tools/describe/platforms/ios")>(
    "../src/tools/describe/platforms/ios"
  );
  return { ...actual, describeIos: (...a: unknown[]) => describeIosMock(...a) };
});

const resolveTvApiMock = vi.fn();
vi.mock("../src/tools/tv/tv-service", () => ({
  resolveTvApi: (...a: unknown[]) => resolveTvApiMock(...a),
  tvServiceRef: vi.fn(),
}));

import { createAwaitScreenIdleTool } from "../src/tools/await-screen-idle";
import { createAwaitUiElementTool } from "../src/tools/await-ui-element";

const TV_UDID = "DDDDDDDD-DDDD-DDDD-DDDD-DDDDDDDDDDDD";

function row(label: string, y: number, extra: Record<string, unknown> = {}) {
  return {
    label,
    frame: { x: 0.55, y, width: 0.4, height: 0.06 },
    traits: ["button", "_focusGuide"],
    ...extra,
  };
}

const SCREEN: TvDescribeResponse = {
  bundleId: "com.apple.TVSettings",
  focused: row("About", 0.175, { isFocused: true }),
  focusable: [
    row("About", 0.175, { isFocused: true }),
    row("Appearance", 0.249, { value: "Dark" }),
  ],
};

/** The screen a push leaves: the new list is there, and the cursor lands later. */
const NO_CURSOR: TvDescribeResponse = {
  bundleId: "com.apple.TVSettings",
  focused: null,
  focusable: [row("About", 0.175), row("Appearance", 0.249, { value: "Dark" })],
};

/** A TvControlApi that walks `frames`, repeating the last. */
function makeTvApi(frames: TvDescribeResponse[]): TvControlApi & { calls: () => number } {
  let i = 0;
  const describe = vi.fn(async () => frames[Math.min(i++, frames.length - 1)]!);
  const recycleAx = vi.fn(async () => {});
  return {
    describe,
    recycleAx,
    navigate: vi.fn(),
    type: vi.fn(),
    calls: () => describe.mock.calls.length,
  } as unknown as TvControlApi & { calls: () => number };
}

const registry = { resolveService: vi.fn() } as never;

beforeEach(() => {
  vi.clearAllMocks();
  __primeDepCacheForTests(["xcrun", "adb"]);
});

afterEach(() => {
  __resetDepCacheForTests();
});

async function runIdle(api: TvControlApi, params: Record<string, unknown> = {}) {
  resolveTvApiMock.mockResolvedValue(api);
  const tool = createAwaitScreenIdleTool(registry);
  return tool.execute({}, { udid: TV_UDID, timeoutMs: 2000, ...params } as never);
}

async function runElement(api: TvControlApi, params: Record<string, unknown>) {
  resolveTvApiMock.mockResolvedValue(api);
  const tool = createAwaitUiElementTool(registry);
  return tool.execute({}, { udid: TV_UDID, timeoutMs: 1500, ...params } as never);
}

describe("await-screen-idle on an Apple TV", () => {
  it("settles on a static focus view", async () => {
    // Was structurally impossible: every poll saw an empty tree and reset.
    const api = makeTvApi([SCREEN]);

    const res = await runIdle(api);

    expect(res.settled).toBe(true);
    expect(res.note).toBeUndefined();
    expect(describeIosMock).not.toHaveBeenCalled();
  });

  it("does not settle while the cursor is still moving", async () => {
    // Only the cursor differs between the two reads.
    const moved: TvDescribeResponse = {
      ...SCREEN,
      focused: row("Appearance", 0.249, { value: "Dark", isFocused: true }),
      focusable: [
        row("About", 0.175),
        row("Appearance", 0.249, { value: "Dark", isFocused: true }),
      ],
    };
    // Alternate so the fingerprint never repeats.
    const api = makeTvApi([SCREEN, moved, SCREEN, moved, SCREEN, moved, SCREEN, moved]);

    expect((await runIdle(api, { timeoutMs: 900 })).settled).toBe(false);
  });

  it("does not settle while the focusable set is still growing", async () => {
    const grown: TvDescribeResponse = {
      ...SCREEN,
      focusable: [...SCREEN.focusable, row("Region", 0.323, { value: "Poland" })],
    };
    const api = makeTvApi([SCREEN, grown, SCREEN, grown, SCREEN, grown, SCREEN, grown]);

    expect((await runIdle(api, { timeoutMs: 900 })).settled).toBe(false);
  });

  it("explains an empty focus view instead of stalling silently", async () => {
    // The reported symptom was `{settled:false}` with no note at all after a
    // full 30s — nothing for the agent to act on.
    const api = makeTvApi([{ focused: null, focusable: [] }]);

    const res = await runIdle(api, { timeoutMs: 600 });

    expect(res.settled).toBe(false);
    expect(res.note).toMatch(/nothing on screen/);
    // …and not the old advice to go and use describe instead of this tool.
    expect(res.note).not.toMatch(/accessibility service does not support/i);
  });

  it("does not settle on a list whose cursor has not landed", async () => {
    // A remote press sent before the cursor lands is lost. Reads every 100ms.
    const landed = { ...NO_CURSOR, focused: row("About", 0.175, { isFocused: true }) };
    landed.focusable = [row("About", 0.175, { isFocused: true }), NO_CURSOR.focusable[1]!];
    const api = makeTvApi([...Array(7).fill(NO_CURSOR), landed]);

    const res = await runIdle(api, { pollIntervalMs: 100 });

    expect(res.settled).toBe(true);
    expect(res.note).toBeUndefined();
    expect(api.calls()).toBeGreaterThanOrEqual(8);
  });

  it("settles on a screen that never gets a cursor, and says so", async () => {
    const res = await runIdle(makeTvApi([NO_CURSOR]), { timeoutMs: 3000, pollIntervalMs: 100 });

    expect(res.settled).toBe(true);
    expect(res.waitedMs).toBeGreaterThanOrEqual(1200);
    expect(res.note).toMatch(/no element holds focus/);
  });

  it("does not settle before the bound when the timeout is shorter, and says why", async () => {
    const res = await runIdle(makeTvApi([NO_CURSOR]), { timeoutMs: 600, pollIntervalMs: 100 });

    expect(res.settled).toBe(false);
    expect(res.note).toMatch(/no element holds focus/);
  });

  it("keeps an explicit minStableMs 0 immediate, with no cursor", async () => {
    const res = await runIdle(makeTvApi([NO_CURSOR]), { minStableMs: 0 });

    expect(res.settled).toBe(true);
    expect(res.polls).toBe(1);
  });

  it("settles a screen with text and nothing focusable", async () => {
    const api = makeTvApi([{ focused: null, focusable: [] }]);
    api.hierarchy = async () => ({
      screenFrame: { width: 1920, height: 1080 },
      tree: {
        children: [{ label: "Nothing to focus", frame: { x: 0, y: 0, width: 400, height: 80 } }],
      },
    });

    const res = await runIdle(api, { timeoutMs: 3000, pollIntervalMs: 100 });

    expect(res.settled).toBe(true);
  });

  it("does not settle while non-focusable text keeps changing", async () => {
    const api = makeTvApi([SCREEN]);
    let n = 0;
    api.hierarchy = async () => ({
      screenFrame: { width: 1920, height: 1080 },
      tree: {
        children: [{ label: `Loading ${n++}`, frame: { x: 0, y: 0, width: 400, height: 80 } }],
      },
    });

    expect((await runIdle(api, { timeoutMs: 700, pollIntervalMs: 100 })).settled).toBe(false);
  });

  it("skips a poll whose hierarchy read fails, and reports a hierarchy that never answers", async () => {
    const api = makeTvApi([SCREEN]);
    let calls = 0;
    api.hierarchy = async () => {
      // Every third call fails: a refused connection under load.
      if (++calls % 3 === 0) throw new Error("connect ECONNREFUSED");
      return { tree: { children: [] } };
    };
    expect((await runIdle(api)).settled).toBe(true);

    api.hierarchy = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const res = await runIdle(api, { timeoutMs: 600 });
    expect(res.settled).toBe(false);
    expect(res.note).toMatch(/ECONNREFUSED/);
  });

  it("retries a refused hierarchy read once within the same poll", async () => {
    const api = makeTvApi([SCREEN]);
    let calls = 0;
    api.hierarchy = async () => {
      if (++calls === 1) throw new Error("connect ECONNREFUSED");
      return { tree: { children: [] } };
    };

    const res = await runIdle(api, { minStableMs: 0 });

    expect(res.settled).toBe(true);
    expect(res.polls).toBe(1);
  });

  it("names a reader that stopped answering", async () => {
    // Without this a hung read looks exactly like a screen that kept moving.
    const api = makeTvApi([SCREEN]);
    let reads = 0;
    api.describe = async () => {
      if (++reads > 1) return new Promise<TvDescribeResponse>(() => {});
      return SCREEN;
    };

    const res = await runIdle(api, { timeoutMs: 1000, minStableMs: 900, pollIntervalMs: 100 });

    expect(res.settled).toBe(false);
    expect(res.note).toMatch(/stopped answering/);
  });

  it("stays quiet on a moving screen whose last read merely straddled the deadline", async () => {
    const other = { ...SCREEN, focusable: [...SCREEN.focusable, row("Region", 0.323)] };
    const api = makeTvApi([SCREEN, other, SCREEN, other, SCREEN, other, SCREEN, other]);

    const res = await runIdle(api, { timeoutMs: 700, pollIntervalMs: 100 });

    expect(res.settled).toBe(false);
    expect(res.note).toBeUndefined();
  });

  it("does not charge the daemon spawn to the timeout", async () => {
    // The first resolution starts the tvOS daemons and takes seconds on a cold
    // simulator; a static screen must not come back unsettled because of it.
    const api = makeTvApi([SCREEN]);
    resolveTvApiMock.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(api), 300))
    );

    const tool = createAwaitScreenIdleTool(registry);
    const res = await tool.execute({}, {
      udid: TV_UDID,
      timeoutMs: 100,
      minStableMs: 0,
    } as never);

    expect(res.settled).toBe(true);
  });

  it("throws when the tvOS daemons cannot start", async () => {
    resolveTvApiMock.mockRejectedValue(new Error("tv daemon exited"));

    const tool = createAwaitScreenIdleTool(registry);
    await expect(tool.execute({}, { udid: TV_UDID } as never)).rejects.toThrow("tv daemon exited");
  });

  it("never repairs the read path from inside the poll loop", async () => {
    // describeTv retries and can respawn the tvOS ax daemon. Doing that mid-wait
    // would drop the very state being watched, so the wait path takes one bare
    // read per poll and points at `describe` for the repair.
    const api = makeTvApi([{ focused: null, focusable: [] }]);

    const res = await runIdle(api, { timeoutMs: 600 });

    expect(
      (api as unknown as { recycleAx: { mock: { calls: unknown[] } } }).recycleAx.mock.calls
    ).toHaveLength(0);
    expect(api.calls()).toBe(res.polls);
  });
});

describe("await-ui-element on an Apple TV", () => {
  it("matches a focusable by label", async () => {
    const res = await runElement(makeTvApi([SCREEN]), {
      condition: "exists",
      selector: { text: "Appearance" },
    });

    expect(res.success).toBe(true);
    expect(describeIosMock).not.toHaveBeenCalled();
  });

  it("treats an on-screen element as visible without the cursor on it", async () => {
    const res = await runElement(makeTvApi([SCREEN]), {
      condition: "visible",
      selector: { text: "Appearance" },
    });

    expect(res.success).toBe(true);
  });

  it("reads a row's value for the text condition", async () => {
    const res = await runElement(makeTvApi([SCREEN]), {
      condition: "text",
      selector: { text: "Appearance" },
      expectedText: "Dark",
    });

    expect(res.success).toBe(true);
  });

  it("waits for the cursor to land on a specific element", async () => {
    const moved: TvDescribeResponse = {
      ...SCREEN,
      focused: row("Appearance", 0.249, { isFocused: true }),
      focusable: [row("About", 0.175), row("Appearance", 0.249, { isFocused: true })],
    };
    const api = makeTvApi([SCREEN, SCREEN, moved]);

    const res = await runElement(api, {
      condition: "exists",
      selector: { text: "Appearance", role: "focused" },
      pollIntervalMs: 50,
    });

    expect(res.success).toBe(true);
    expect(api.calls()).toBe(3);
  });

  it("does not report `hidden` satisfied on an empty focus view", async () => {
    // The dangerous false pass: a still-launching app reports nothing, and
    // "nothing matched" would read as "the element is gone" — releasing an
    // interaction that was deliberately gated.
    const api = makeTvApi([{ focused: null, focusable: [] }]);

    const res = await runElement(api, {
      condition: "hidden",
      selector: { text: "About" },
      timeoutMs: 600,
    });

    expect(res.success).toBe(false);
    expect(res.note).toMatch(/nothing on screen/);
  });

  it("reports `hidden` satisfied when the last focusable leaves text behind", async () => {
    const text = {
      screenFrame: { width: 1920, height: 1080 },
      tree: { children: [{ label: "Done", frame: { x: 0, y: 0, width: 400, height: 80 } }] },
    };
    const api = makeTvApi([SCREEN, { focused: null, focusable: [] }]);
    api.hierarchy = async () => text;

    const res = await runElement(api, { condition: "hidden", selector: { text: "About" } });

    expect(res.success).toBe(true);
    expect(res.note).toBeUndefined();
  });

  it("does not report non-focusable text hidden when the hierarchy read fails", async () => {
    // The focus view alone still has the button, so the read would not look
    // blind, and the label would seem gone.
    const api = makeTvApi([SCREEN]);
    let calls = 0;
    api.hierarchy = async () => {
      if (++calls > 2) throw new Error("connect ECONNREFUSED");
      return {
        screenFrame: { width: 1920, height: 1080 },
        tree: {
          children: [{ label: "Scene covered", frame: { x: 0, y: 0, width: 400, height: 80 } }],
        },
      };
    };

    const res = await runElement(api, {
      condition: "hidden",
      selector: { text: "Scene covered" },
      timeoutMs: 400,
      pollIntervalMs: 50,
    });

    expect(res.success).toBe(false);
  });

  it("does not take a miss on a hierarchy cut at its node cap as absence", async () => {
    const api = makeTvApi([SCREEN]);
    api.hierarchy = async () => ({
      nodeCount: 801,
      screenFrame: { width: 1920, height: 1080 },
      tree: { children: [{ label: "Row 1", frame: { x: 0, y: 0, width: 400, height: 80 } }] },
    });

    const hidden = await runElement(api, {
      condition: "hidden",
      selector: { text: "Tail" },
      timeoutMs: 300,
      pollIntervalMs: 50,
    });
    expect(hidden.success).toBe(false);
    expect(hidden.cause).toBe("unreadable");
    expect(hidden.note).toMatch(/800-element cap/);

    // What it did read still counts.
    expect(
      (await runElement(api, { condition: "exists", selector: { text: "Row 1" } })).success
    ).toBe(true);
    const missing = await runElement(api, {
      condition: "exists",
      selector: { text: "Tail" },
      timeoutMs: 300,
      pollIntervalMs: 50,
    });
    expect(missing.cause).toBe("unreadable");
  });

  it("lets a zero-area match satisfy `exists` on a capped read, but not `hidden`", async () => {
    // A scrolled-away row: present, zero-area once off-screen.
    const api = makeTvApi([SCREEN]);
    api.hierarchy = async () => ({
      nodeCount: 801,
      screenFrame: { width: 1920, height: 1080 },
      tree: {
        children: [{ label: "Far row", frame: { x: 0, y: 1200, width: 400, height: 80 } }],
      },
    });

    expect(
      (await runElement(api, { condition: "exists", selector: { text: "Far row" } })).success
    ).toBe(true);
    const hidden = await runElement(api, {
      condition: "hidden",
      selector: { text: "Far row" },
      timeoutMs: 300,
      pollIntervalMs: 50,
    });
    expect(hidden.success).toBe(false);
    expect(hidden.cause).toBe("unreadable");
  });

  it("matches non-focusable text, and waits for it to go", async () => {
    const loading = {
      screenFrame: { width: 1920, height: 1080 },
      tree: { children: [{ label: "Loading 3", frame: { x: 0, y: 0, width: 400, height: 80 } }] },
    };
    const api = makeTvApi([SCREEN]);
    api.hierarchy = async () => loading;

    expect(
      (await runElement(api, { condition: "exists", selector: { text: "Loading" } })).success
    ).toBe(true);
    const hidden = await runElement(api, {
      condition: "hidden",
      selector: { text: "Loading" },
      timeoutMs: 300,
      pollIntervalMs: 50,
    });
    expect(hidden.success).toBe(false);
    expect(hidden.cause).toBe("unmet");
  });

  it("reports `hidden` satisfied when the element leaves a populated view", async () => {
    const without: TvDescribeResponse = {
      ...SCREEN,
      focused: row("Appearance", 0.249, { isFocused: true }),
      focusable: [row("Appearance", 0.249, { value: "Dark", isFocused: true })],
    };
    const api = makeTvApi([SCREEN, without]);

    const res = await runElement(api, { condition: "hidden", selector: { text: "About" } });

    expect(res.success).toBe(true);
  });

  it("reports a scrolled-away element as hidden", async () => {
    const res = await runElement(
      makeTvApi([{ ...SCREEN, focusable: [...SCREEN.focusable, row("Below", 1.069)] }]),
      { condition: "hidden", selector: { text: "Below" } }
    );

    expect(res.success).toBe(true);
  });

  it("reports a selector that matches nothing as `unmet`", async () => {
    const res = await runElement(makeTvApi([SCREEN]), {
      condition: "exists",
      selector: { text: "Nonexistent" },
      timeoutMs: 300,
      pollIntervalMs: 50,
    });

    expect(res.success).toBe(false);
    expect(res.cause).toBe("unmet");
  });

  it("reports a view that stays empty as `unreadable`", async () => {
    const res = await runElement(makeTvApi([{ focused: null, focusable: [] }]), {
      condition: "exists",
      selector: { text: "About" },
      timeoutMs: 300,
      pollIntervalMs: 50,
    });

    expect(res.success).toBe(false);
    expect(res.cause).toBe("unreadable");
  });
});

describe("Android TV keeps its full tree", () => {
  it("is not routed onto the focus view", async () => {
    // An empty focus set is STEADY STATE on Android TV — react-native-tvos
    // screens drive focus with RN's own engine, invisible to the OS tree. Moving
    // it onto the focus source would import the never-settles bug onto a
    // platform that works.
    describeAndroidMock.mockResolvedValue({
      tree: { role: "root", frame: { x: 0, y: 0, width: 1, height: 1 }, children: [] },
      source: "uiautomator",
    });
    const api = makeTvApi([SCREEN]);
    resolveTvApiMock.mockResolvedValue(api);

    const tool = createAwaitScreenIdleTool(registry);
    await tool.execute({}, { udid: "emulator-5554", timeoutMs: 400 } as never);

    expect(describeAndroidMock).toHaveBeenCalled();
    expect(api.calls()).toBe(0);
  });
});
