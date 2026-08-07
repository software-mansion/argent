import { describe, expect, it, vi } from "vitest";
import type { Registry } from "@argent/registry";
import type { AndroidDevtoolsApi, GetHierarchyOptions } from "../src/blueprints/android-devtools";
import { getHierarchyRequestParams } from "../src/blueprints/android-devtools";
import { describeAndroid } from "../src/tools/describe/platforms/android";
import { createAwaitScreenIdleTool } from "../src/tools/await-screen-idle";
import { createAwaitUiElementTool } from "../src/tools/await-ui-element";
import { fetchTree } from "../src/utils/ui-tree-match";
import { queryAndroidFullHierarchy } from "../src/tools/flows/flow-android-tree";
import { resolveDevice } from "../src/utils/device-info";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";

// The wait tools resolve the target's form factor before polling; isAndroidTv()
// costs real adb round-trips against a serial that is never listed. Pin it so
// these tests exercise the phone path without shelling out.
vi.mock("../src/utils/adb", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/adb")>("../src/utils/adb");
  return { ...actual, isAndroidTv: async () => false };
});

const ANDROID_SERIAL = "emulator-5554";

/** Every label in the tree, so a test can prove the fixture actually parsed. */
function nodeLabels(node: { label?: string; children?: unknown[] }): string[] {
  const self = node.label ? [node.label] : [];
  const kids = (node.children ?? []) as { label?: string; children?: unknown[] }[];
  return [...self, ...kids.flatMap(nodeLabels)];
}

// One labelled, clickable node — enough for `describe` to return a non-empty
// tree, for a selector to match, and for await-screen-idle to see content.
const XML =
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<hierarchy rotation="0">` +
  `<node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">` +
  `<node text="Sign in" resource-id="com.demo:id/signin" class="android.widget.Button" ` +
  `clickable="true" bounds="[100,200][980,320]" />` +
  `</node>` +
  `</hierarchy>`;

/**
 * Registry serving a stub android-devtools whose getHierarchy records the
 * options each caller passed. `optionsSeen` is what these tests assert on: the
 * helper only bypasses its AccessibilityNodeInfo cache when asked to, so the
 * request is the observable behaviour.
 */
function makeRecordingRegistry(): {
  registry: Registry;
  optionsSeen: () => (GetHierarchyOptions | undefined)[];
} {
  const optionsSeen: (GetHierarchyOptions | undefined)[] = [];
  const android = {
    isReady: () => true,
    getHierarchy: vi.fn(async (opts?: GetHierarchyOptions) => {
      optionsSeen.push(opts);
      return {
        xml: XML,
        captureMode: "interactive-windows",
        windowCount: 1,
        nodeCount: 2,
        truncated: false,
        elapsedMs: 1,
      };
    }),
    getScreenSize: async () => ({ width: 1080, height: 2400, rotation: 0 }),
    ping: async () => ({ ok: true, idleMs: 0, protocol: "1" }),
  } as unknown as AndroidDevtoolsApi;

  const registry = {
    resolveService: vi.fn(async (urn: string) => {
      if (urn.startsWith("AndroidDevtools:")) return android;
      throw new Error(`unexpected service ${urn}`);
    }),
  } as unknown as Registry;

  return { registry, optionsSeen: () => optionsSeen };
}

/**
 * Coherence is guarded twice over: the reader names `clearCache` at its call
 * site, and the blueprint supplies `true` to anything that omits it. Either one
 * alone puts a coherent request on the wire, which is exactly why each needs its
 * own assertion — checking only the effective request lets the call site be
 * deleted with every test still green, and checking only the call site lets the
 * default be flipped back unnoticed. So each reader below asserts both: the raw
 * options it passed, and the request those options produce.
 */
function expectCoherentRequest(opts: GetHierarchyOptions | undefined): void {
  expect(opts?.clearCache).toBe(true);
  expect(getHierarchyRequestParams(opts).clearCache).toBe(true);
}

describe("Android describe reads bypass the helper's node cache", () => {
  it("describeAndroid asks getHierarchy for an uncached capture", async () => {
    const { registry, optionsSeen } = makeRecordingRegistry();

    const result = await describeAndroid(registry, ANDROID_SERIAL, undefined, false);

    expect(optionsSeen()).toHaveLength(1);
    expectCoherentRequest(optionsSeen()[0]);
    // The capture has to survive the round trip as a usable tree, or a reader
    // could "request coherence" and still hand its caller nothing to act on.
    // This is what makes the XML fixture load-bearing rather than decorative.
    expect(result.source).toBe("android-devtools");
    expect(nodeLabels(result.tree)).toContain("Sign in");
  });

  // The defect this pins: the helper's cache serves a node's first-seen text
  // once its event-driven invalidation stops (observed after the inspected app
  // restarts under the long-lived connection), so a cached read reports a screen
  // that has already moved on. Every agent-facing reader below turns this tree
  // into an answer about the current screen — a settled verdict, a selector
  // match, tap coordinates — so each one must request coherence.
  it("await-screen-idle polls uncached trees", async () => {
    const { registry, optionsSeen } = makeRecordingRegistry();
    __primeDepCacheForTests(["adb"]);
    try {
      const tool = createAwaitScreenIdleTool(registry);
      await tool.execute(
        {},
        { udid: ANDROID_SERIAL, timeoutMs: 300, pollIntervalMs: 10, minStableMs: 0 }
      );
    } finally {
      __resetDepCacheForTests();
    }

    const seen = optionsSeen();
    expect(seen.length).toBeGreaterThan(0);
    seen.forEach(expectCoherentRequest);
  });

  it("await-ui-element polls uncached trees", async () => {
    const { registry, optionsSeen } = makeRecordingRegistry();
    __primeDepCacheForTests(["adb"]);
    try {
      const tool = createAwaitUiElementTool(registry);
      await tool.execute(
        {},
        {
          udid: ANDROID_SERIAL,
          condition: "visible",
          selector: { text: "Sign in" },
          timeoutMs: 300,
          pollIntervalMs: 10,
        }
      );
    } finally {
      __resetDepCacheForTests();
    }

    const seen = optionsSeen();
    expect(seen.length).toBeGreaterThan(0);
    seen.forEach(expectCoherentRequest);
  });

  // `fetchTree` is the selector-matching entry point shared by the flow
  // directives and the recorder. Its Android branch delegates to
  // `describeAndroid`, so this covers the delegation rather than a second
  // call site — the Lens/preview describe route and `match-element-frame`
  // reach the helper through `describeAndroid` directly, not through here.
  it("the shared ui-tree fetchTree reads uncached", async () => {
    const { registry, optionsSeen } = makeRecordingRegistry();

    await fetchTree(registry, resolveDevice(ANDROID_SERIAL));

    expect(optionsSeen()).toHaveLength(1);
    expectCoherentRequest(optionsSeen()[0]);
  });

  // The one reader that does NOT route through `describeAndroid`: flows resolve
  // testID selectors against the full hierarchy via their own call site, so a
  // `clearCache` regression there is invisible to every test above.
  it("the flow full-hierarchy read is uncached and keeps its node cap", async () => {
    const { registry, optionsSeen } = makeRecordingRegistry();

    await queryAndroidFullHierarchy(registry, resolveDevice(ANDROID_SERIAL));

    expect(optionsSeen()).toHaveLength(1);
    expectCoherentRequest(optionsSeen()[0]);
    // The flow path caps nodes well below the blueprint default; assert it so
    // the coherence fix can't be "fixed" by dropping to the shared options.
    expect(optionsSeen()[0]?.maxNodes).toBeGreaterThan(0);
    expect(getHierarchyRequestParams(optionsSeen()[0]).maxNodes).toBe(optionsSeen()[0]?.maxNodes);
  });
});

/**
 * The stale read this suite guards against is silent: a caller that omits
 * `clearCache` gets a plausible-looking tree, no error and no failing test. So
 * the coherent capture is the default and a caller must opt out of it — these
 * pin that default, and fail if it is ever flipped back.
 */
describe("getHierarchy request defaults", () => {
  it("defaults clearCache to true when no options are given", () => {
    expect(getHierarchyRequestParams().clearCache).toBe(true);
    expect(getHierarchyRequestParams({}).clearCache).toBe(true);
  });

  it("keeps clearCache on when an unrelated option is set", () => {
    // The device-side helper reads `params.optBoolean("clearCache", false)`, so
    // an options object that omits the key must still put `true` on the wire
    // rather than letting the request fall through to that device-side default.
    const params = getHierarchyRequestParams({ maxNodes: 1200 });
    expect(params.clearCache).toBe(true);
    expect(params.maxNodes).toBe(1200);
  });

  it("sends every field the helper understands, so no device-side default applies", () => {
    expect(Object.keys(getHierarchyRequestParams()).sort()).toEqual([
      "clearCache",
      "maxDepth",
      "maxNodes",
      "waitForIdleMs",
    ]);
    expect(getHierarchyRequestParams()).toEqual({
      waitForIdleMs: 500,
      maxDepth: 128,
      maxNodes: 5000,
      clearCache: true,
    });
  });

  it("still honours an explicit opt-out", () => {
    expect(getHierarchyRequestParams({ clearCache: false }).clearCache).toBe(false);
  });
});
