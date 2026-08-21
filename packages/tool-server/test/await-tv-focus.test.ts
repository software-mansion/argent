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
    const moved: TvDescribeResponse = {
      ...SCREEN,
      focused: row("Appearance", 0.249, { isFocused: true }),
      focusable: [row("About", 0.175), row("Appearance", 0.249, { isFocused: true })],
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
    expect(res.note).toMatch(/no focusable elements|launching|transition/i);
    // …and not the old advice to go and use describe instead of this tool.
    expect(res.note).not.toMatch(/accessibility service does not support/i);
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

  it("treats every enumerated element as visible", async () => {
    // A focus view has no "present but invisible" state — what it reports is
    // exactly the on-screen, D-pad-reachable set. So `visible` matches an
    // element the cursor is not on.
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
    });

    expect(res.success).toBe(true);
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
    expect(res.note).toMatch(/focus|launching|empty/i);
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
