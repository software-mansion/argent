import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AXServiceApi, AXDescribeResponse } from "../src/blueprints/ax-service";
import type { AndroidDevtoolsApi } from "../src/blueprints/android-devtools";
import type { ChromiumCdpApi } from "../src/blueprints/chromium-cdp";
import { createAwaitUiElementTool, evaluateMatches } from "../src/tools/await-ui-element";
import { findAll } from "../src/utils/ui-tree-match";
import type { DescribeNode } from "../src/tools/describe/contract";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";

// execute() resolves the target's form factor before polling: isTvOsSimulator()
// shells out to `xcrun simctl list` (the fake UDID is never listed, so it never
// caches and re-probes on EVERY test) and isAndroidTv() probes the serial via
// real adb round-trips. Both take seconds under the parallel suite load — enough
// to trip the 5s per-test timeout. The devices here are plain phone shapes, so
// pin both probes to false and keep the rest of each module real.
vi.mock("../src/utils/ios-devices", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/ios-devices")>(
    "../src/utils/ios-devices"
  );
  return { ...actual, isTvOsSimulator: async () => false };
});
vi.mock("../src/utils/adb", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/adb")>("../src/utils/adb");
  return { ...actual, isAndroidTv: async () => false };
});

const IOS_UDID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const ANDROID_SERIAL = "emulator-5554";
const CHROMIUM_ID = "chromium-cdp-9222";

// An AX service whose describe() walks through `responses` one call at a time,
// repeating the last entry. Lets a test simulate a screen that changes between
// polls (element appears / disappears / text updates). `degraded` mirrors the
// real service flag the iOS describe path turns into the boot hint.
function makeSequencedAXService(
  responses: AXDescribeResponse[],
  opts: { degraded?: boolean } = {}
): {
  api: AXServiceApi;
  calls: () => number;
} {
  let i = 0;
  const api: AXServiceApi = {
    degraded: opts.degraded ?? false,
    describe: async () => responses[Math.min(i++, responses.length - 1)],
    alertCheck: async () => false,
    ping: async () => true,
  };
  return { api, calls: () => i };
}

// An AX service whose describe() always throws — the "AX backend down" case the
// iOS describe path swallows into an empty tree + boot hint.
function makeFailingAXService(): AXServiceApi {
  return {
    degraded: true,
    describe: async () => {
      throw new Error("ax service unreachable");
    },
    alertCheck: async () => false,
    ping: async () => false,
  };
}

function axResponse(elements: AXDescribeResponse["elements"]): AXDescribeResponse {
  return { alertVisible: false, screenFrame: { width: 440, height: 956 }, elements };
}

const FRAME = { x: 0.1, y: 0.4, width: 0.8, height: 0.05 };

// Registry mock that can serve the iOS AX service and (optionally) the Android
// devtools service. native-devtools (the iOS fallback) intentionally throws so
// an empty AX tree surfaces as a degraded read rather than a hung fallback.
function makeMockRegistry(opts: { ax?: AXServiceApi; android?: AndroidDevtoolsApi }) {
  return {
    resolveService: vi.fn(async (urn: string) => {
      if (urn.startsWith("AXService:")) {
        if (!opts.ax) throw new Error("no AX service configured");
        return opts.ax;
      }
      if (urn.startsWith("AndroidDevtools:")) {
        if (!opts.android) throw new Error("no Android devtools configured");
        return opts.android;
      }
      // native-devtools fallback etc. — fail so the iOS path returns the empty
      // AX tree instead of waiting on a fallback that isn't mocked.
      throw new Error(`unexpected service: ${urn}`);
    }),
  } as any;
}

function iosRegistry(ax: AXServiceApi) {
  return makeMockRegistry({ ax });
}

describe("await-ui-element tool", () => {
  beforeEach(() => {
    __resetDepCacheForTests();
    __primeDepCacheForTests(["xcrun", "adb"]);
  });

  it("exposes the await-ui-element id", () => {
    expect(createAwaitUiElementTool(iosRegistry({} as AXServiceApi)).id).toBe("await-ui-element");
  });

  // ── iOS happy paths ──────────────────────────────────────────────────────

  it("`visible` succeeds once the element appears across polls", async () => {
    const { api, calls } = makeSequencedAXService([
      axResponse([]),
      axResponse([{ label: "Submit", frame: FRAME, traits: ["button"] }]),
    ]);
    const tool = createAwaitUiElementTool(iosRegistry(api));

    const result = await tool.execute(
      {},
      {
        udid: IOS_UDID,
        condition: "visible",
        selector: { text: "Submit" },
        timeoutMs: 2000,
        pollIntervalMs: 10,
      }
    );

    expect(result.success).toBe(true);
    expect(calls()).toBeGreaterThan(1);
  });

  it("`visible` times out with a diagnostic note when the element never appears", async () => {
    const { api } = makeSequencedAXService([axResponse([])]);
    const tool = createAwaitUiElementTool(iosRegistry(api));

    const result = await tool.execute(
      {},
      {
        udid: IOS_UDID,
        condition: "visible",
        selector: { text: "Nope" },
        timeoutMs: 30,
        pollIntervalMs: 10,
      }
    );

    expect(result.success).toBe(false);
    expect(result.elapsed).toBeGreaterThanOrEqual(30);
    expect(result.note).toMatch(/no element matched/i);
  });

  it("clamps the poll sleep to the deadline so a large pollIntervalMs can't overshoot timeoutMs", async () => {
    // Element never appears; pollIntervalMs (1000) dwarfs timeoutMs (100). Without
    // clamping, the first sleep alone would run the full 1000ms past the initial
    // poll. With the clamp, elapsed should land just past the 100ms deadline.
    const { api } = makeSequencedAXService([axResponse([])]);
    const tool = createAwaitUiElementTool(iosRegistry(api));

    const result = await tool.execute(
      {},
      {
        udid: IOS_UDID,
        condition: "visible",
        selector: { text: "Nope" },
        timeoutMs: 100,
        pollIntervalMs: 1000,
      }
    );

    expect(result.success).toBe(false);
    expect(result.elapsed).toBeGreaterThanOrEqual(100);
    expect(result.elapsed).toBeLessThan(600);
  });

  it("`exists` succeeds when the element is in the tree", async () => {
    const { api } = makeSequencedAXService([
      axResponse([{ label: "Widget", frame: FRAME, traits: [] }]),
    ]);
    const tool = createAwaitUiElementTool(iosRegistry(api));

    const result = await tool.execute(
      {},
      {
        udid: IOS_UDID,
        condition: "exists",
        selector: { text: "Widget" },
        timeoutMs: 2000,
        pollIntervalMs: 10,
      }
    );

    expect(result.success).toBe(true);
  });

  it("`hidden` returns an instant success but flags a selector that never matched", async () => {
    const { api } = makeSequencedAXService([
      axResponse([{ label: "Other", frame: FRAME, traits: [] }]),
    ]);
    const tool = createAwaitUiElementTool(iosRegistry(api));

    const result = await tool.execute(
      {},
      {
        udid: IOS_UDID,
        condition: "hidden",
        selector: { text: "Ghost" },
        timeoutMs: 2000,
        pollIntervalMs: 10,
      }
    );

    expect(result.success).toBe(true);
    expect(result.note).toMatch(/never matched/i);
  });

  it("`hidden` succeeds once the element disappears", async () => {
    // Second poll is a real re-rendered screen WITHOUT the Spinner (other content
    // remains) — a genuinely-hidden element leaves the rest of the screen behind.
    // (A wholly-empty second tree is the ambiguous transient-blank case, covered
    // separately below — it must NOT confirm `hidden`.)
    const { api } = makeSequencedAXService([
      axResponse([{ label: "Spinner", frame: FRAME, traits: [] }]),
      axResponse([{ label: "Content", frame: FRAME, traits: [] }]),
    ]);
    const tool = createAwaitUiElementTool(iosRegistry(api));

    const result = await tool.execute(
      {},
      {
        udid: IOS_UDID,
        condition: "hidden",
        selector: { text: "Spinner" },
        timeoutMs: 2000,
        pollIntervalMs: 10,
      }
    );

    expect(result.success).toBe(true);
    // It actually matched before disappearing, so it must NOT carry the
    // "never matched" caveat.
    expect(result.note ?? "").not.toMatch(/never matched/i);
  });

  it("does NOT confirm `hidden` on a transient empty tree after the element was seen", async () => {
    // The element matched on the first poll; every later poll lands on a wholly
    // empty tree (a blank frame mid-navigation). That emptiness must not read as
    // "element hidden" — otherwise a gated tap fires against a screen that only
    // briefly went blank. So the wait keeps polling and times out with the
    // "could not confirm … empty or unreadable" note rather than a false success.
    const { api } = makeSequencedAXService([
      axResponse([{ label: "Spinner", frame: FRAME, traits: [] }]),
      axResponse([]),
    ]);
    const tool = createAwaitUiElementTool(iosRegistry(api));

    const result = await tool.execute(
      {},
      {
        udid: IOS_UDID,
        condition: "hidden",
        selector: { text: "Spinner" },
        timeoutMs: 60,
        pollIntervalMs: 10,
      }
    );

    expect(result.success).toBe(false);
    expect(result.note).toMatch(/empty or unreadable/i);
  });

  it("`hidden` resolves once a real (non-empty) screen without the element renders after a blank", async () => {
    // Spinner → transient blank → a real screen without the Spinner. The blank
    // must not confirm `hidden`, but the subsequent populated tree (Spinner gone)
    // must. Proves the guard delays rather than blocks a legitimate disappearance.
    const { api } = makeSequencedAXService([
      axResponse([{ label: "Spinner", frame: FRAME, traits: [] }]),
      axResponse([]),
      axResponse([{ label: "Loaded", frame: FRAME, traits: [] }]),
    ]);
    const tool = createAwaitUiElementTool(iosRegistry(api));

    const result = await tool.execute(
      {},
      {
        udid: IOS_UDID,
        condition: "hidden",
        selector: { text: "Spinner" },
        timeoutMs: 2000,
        pollIntervalMs: 10,
      }
    );

    expect(result.success).toBe(true);
    expect(result.note ?? "").not.toMatch(/never matched/i);
  });

  it("`text` succeeds once the matched element contains the expected substring", async () => {
    const { api } = makeSequencedAXService([
      axResponse([{ label: "Status", value: "Loading", frame: FRAME, traits: [] }]),
      axResponse([{ label: "Status", value: "Done", frame: FRAME, traits: [] }]),
    ]);
    const tool = createAwaitUiElementTool(iosRegistry(api));

    const result = await tool.execute(
      {},
      {
        udid: IOS_UDID,
        condition: "text",
        selector: { text: "Status" },
        expectedText: "done",
        timeoutMs: 2000,
        pollIntervalMs: 10,
      }
    );

    expect(result.success).toBe(true);
  });

  it("`text` timeout note reports the last-seen text", async () => {
    const { api } = makeSequencedAXService([
      axResponse([{ label: "Status", value: "Loading", frame: FRAME, traits: [] }]),
    ]);
    const tool = createAwaitUiElementTool(iosRegistry(api));

    const result = await tool.execute(
      {},
      {
        udid: IOS_UDID,
        condition: "text",
        selector: { text: "Status" },
        expectedText: "Done",
        timeoutMs: 30,
        pollIntervalMs: 10,
      }
    );

    expect(result.success).toBe(false);
    expect(result.note).toMatch(/Loading/);
  });

  it("`text` check and timeout note both read the visible match, not a zero-area shadow", async () => {
    // A stale zero-area "Total 0" sits above the visible "Total 42". Both the
    // condition and the note must read the visible node — otherwise the check
    // fails against the shadow while the note quotes the visible element,
    // producing a self-contradictory message. Driven through the Chromium path
    // because the iOS AX adapter prunes zero-area elements before they reach
    // the tree, while Chromium deliberately keeps zero-height anchors.
    const tree = {
      role: "html",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        {
          role: "generic",
          label: "Total 0",
          frame: { x: 0.1, y: 0.1, width: 0, height: 0 },
          children: [],
        },
        {
          role: "generic",
          label: "Total 42",
          frame: { x: 0.1, y: 0.5, width: 0.5, height: 0.05 },
          children: [],
        },
      ],
    };
    const tool = createAwaitUiElementTool(makeMockRegistry({}));

    const met = await tool.execute(
      { chromium: makeChromiumApi(tree) },
      {
        udid: CHROMIUM_ID,
        condition: "text",
        selector: { text: "Total" },
        expectedText: "42",
        timeoutMs: 60,
        pollIntervalMs: 10,
      }
    );
    expect(met.success).toBe(true);

    const unmet = await tool.execute(
      { chromium: makeChromiumApi(tree) },
      {
        udid: CHROMIUM_ID,
        condition: "text",
        selector: { text: "Total" },
        expectedText: "99",
        timeoutMs: 60,
        pollIntervalMs: 10,
      }
    );
    expect(unmet.success).toBe(false);
    expect(unmet.note).toMatch(/its text was "Total 42"/);
    expect(unmet.note).not.toMatch(/Total 0/);
  });

  // ── Cancellation ─────────────────────────────────────────────────────────

  it("aborts promptly when the request signal fires mid-wait", async () => {
    // Tree never matches, so without cancellation this would run the full 5s.
    const { api } = makeSequencedAXService([axResponse([])]);
    const tool = createAwaitUiElementTool(iosRegistry(api));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);

    const result = await tool.execute(
      {},
      {
        udid: IOS_UDID,
        condition: "visible",
        selector: { text: "Nope" },
        timeoutMs: 5000,
        pollIntervalMs: 10,
      },
      { signal: controller.signal } as never
    );

    expect(result.success).toBe(false);
    expect(result.note).toMatch(/cancel/i);
    expect(result.elapsed).toBeLessThan(2000);
  });

  // ── Synthetic-root exclusion (matching must mirror describe's ROOT line) ───

  describe("synthetic root is never matched", () => {
    it("`visible` does not instantly succeed on a role selector matching the AXGroup root", async () => {
      // Empty screen → tree is just the synthetic AXGroup root, no children.
      const { api } = makeSequencedAXService([axResponse([])]);
      const tool = createAwaitUiElementTool(iosRegistry(api));

      const result = await tool.execute(
        {},
        {
          udid: IOS_UDID,
          condition: "visible",
          selector: { role: "AXGroup" },
          timeoutMs: 40,
          pollIntervalMs: 10,
        }
      );

      // Previously the 1×1 root matched and returned instant success.
      expect(result.success).toBe(false);
    });

    it("`hidden` can succeed for a role selector that would otherwise pin the root", async () => {
      const { api } = makeSequencedAXService([axResponse([])]);
      const tool = createAwaitUiElementTool(iosRegistry(api));

      const result = await tool.execute(
        {},
        {
          udid: IOS_UDID,
          condition: "hidden",
          selector: { role: "AXGroup" },
          timeoutMs: 2000,
          pollIntervalMs: 10,
        }
      );

      // The root never disappears, so before the fix `hidden` could never hold.
      expect(result.success).toBe(true);
    });
  });

  // ── Android branch ───────────────────────────────────────────────────────

  it("drives the Android devtools path and matches a node", async () => {
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<hierarchy rotation="0">` +
      `<node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">` +
      `<node text="Sign in" resource-id="com.demo:id/signin" class="android.widget.Button" clickable="true" bounds="[100,200][980,320]" />` +
      `</node>` +
      `</hierarchy>`;
    const android: AndroidDevtoolsApi = {
      getHierarchy: async () => ({ xml }),
      getScreenSize: async () => ({ width: 1080, height: 2400, rotation: 0 }),
    } as unknown as AndroidDevtoolsApi;
    const tool = createAwaitUiElementTool(makeMockRegistry({ android }));

    const result = await tool.execute(
      {},
      {
        udid: ANDROID_SERIAL,
        condition: "visible",
        selector: { text: "Sign in" },
        timeoutMs: 2000,
        pollIntervalMs: 10,
      }
    );

    expect(result.success).toBe(true);
  });

  it("`hidden` on Android succeeds when the node is gone", async () => {
    const emptyXml = `<hierarchy rotation="0"><node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]" /></hierarchy>`;
    const android: AndroidDevtoolsApi = {
      getHierarchy: async () => ({ xml: emptyXml }),
      getScreenSize: async () => ({ width: 1080, height: 2400, rotation: 0 }),
    } as unknown as AndroidDevtoolsApi;
    const tool = createAwaitUiElementTool(makeMockRegistry({ android }));

    const result = await tool.execute(
      {},
      {
        udid: ANDROID_SERIAL,
        condition: "hidden",
        selector: { text: "Sign in" },
        timeoutMs: 1000,
        pollIntervalMs: 10,
      }
    );

    expect(result.success).toBe(true);
  });

  it("does NOT confirm `hidden` on Android when a seen element is followed by an empty tree", async () => {
    // Android never sets hint / should_restart, so before the everMatched guard a
    // transient empty `uiautomator dump` after the element had appeared would let
    // `hidden` resolve on a blank frame. Poll 1 shows the button; later polls
    // return an empty hierarchy. The wait must keep polling and time out, not
    // confirm hidden.
    const withButton =
      `<hierarchy rotation="0">` +
      `<node text="Sign in" resource-id="com.demo:id/signin" class="android.widget.Button" clickable="true" bounds="[100,200][980,320]" />` +
      `</hierarchy>`;
    const empty = `<hierarchy rotation="0"></hierarchy>`;
    let i = 0;
    const android: AndroidDevtoolsApi = {
      getHierarchy: async () => ({ xml: i++ === 0 ? withButton : empty }),
      getScreenSize: async () => ({ width: 1080, height: 2400, rotation: 0 }),
    } as unknown as AndroidDevtoolsApi;
    const tool = createAwaitUiElementTool(makeMockRegistry({ android }));

    const result = await tool.execute(
      {},
      {
        udid: ANDROID_SERIAL,
        condition: "hidden",
        selector: { text: "Sign in" },
        timeoutMs: 60,
        pollIntervalMs: 10,
      }
    );

    expect(result.success).toBe(false);
    expect(result.note).toMatch(/empty or unreadable/i);
  });

  // ── Chromium branch ──────────────────────────────────────────────────────

  function makeChromiumApi(treeJson: unknown): ChromiumCdpApi {
    return {
      refreshViewport: async () => ({ width: 1024, height: 768 }),
      cdp: {
        send: async (method: string) => {
          if (method === "Runtime.evaluate") {
            return { result: { value: JSON.stringify({ tree: treeJson, truncated: false }) } };
          }
          return {};
        },
      },
    } as unknown as ChromiumCdpApi;
  }

  it("drives the Chromium CDP path and matches a DOM node", async () => {
    const tree = {
      role: "html",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        {
          role: "button",
          label: "Continue",
          clickable: true,
          frame: { x: 0.4, y: 0.8, width: 0.2, height: 0.05 },
          children: [],
        },
      ],
    };
    const tool = createAwaitUiElementTool(makeMockRegistry({}));

    const result = await tool.execute(
      { chromium: makeChromiumApi(tree) },
      {
        udid: CHROMIUM_ID,
        condition: "visible",
        selector: { text: "Continue" },
        timeoutMs: 2000,
        pollIntervalMs: 10,
      }
    );

    expect(result.success).toBe(true);
  });

  it("surfaces a Chromium fetch failure in the timeout note (last tree fetch failed)", async () => {
    const failingApi = {
      refreshViewport: async () => ({ width: 1024, height: 768 }),
      cdp: {
        send: async () => {
          throw new Error("renderer detached");
        },
      },
    } as unknown as ChromiumCdpApi;
    const tool = createAwaitUiElementTool(makeMockRegistry({}));

    const result = await tool.execute(
      { chromium: failingApi },
      {
        udid: CHROMIUM_ID,
        condition: "visible",
        selector: { text: "Continue" },
        timeoutMs: 40,
        pollIntervalMs: 10,
      }
    );

    expect(result.success).toBe(false);
    expect(result.note).toMatch(/last tree fetch failed/i);
    expect(result.note).toMatch(/renderer detached/);
  });

  // ── Degraded iOS AX (backend down) ───────────────────────────────────────

  it("does NOT report `hidden` success while the AX backend is down", async () => {
    // describe() throws → iOS path returns an empty tree + boot hint. Absence in
    // that tree is not evidence the element is gone, so hidden must not succeed.
    const tool = createAwaitUiElementTool(iosRegistry(makeFailingAXService()));

    const result = await tool.execute(
      {},
      {
        udid: IOS_UDID,
        condition: "hidden",
        selector: { text: "Spinner" },
        timeoutMs: 40,
        pollIntervalMs: 10,
      }
    );

    expect(result.success).toBe(false);
    // The boot hint is surfaced so the agent learns the real cause.
    expect(result.note).toMatch(/boot-device/i);
  });

  it("surfaces the degraded boot hint in a timeout note even when the tree has elements", async () => {
    const { api } = makeSequencedAXService(
      [axResponse([{ label: "Header", frame: FRAME, traits: [] }])],
      { degraded: true }
    );
    const tool = createAwaitUiElementTool(iosRegistry(api));

    const result = await tool.execute(
      {},
      {
        udid: IOS_UDID,
        condition: "visible",
        selector: { text: "Nope" },
        timeoutMs: 40,
        pollIntervalMs: 10,
      }
    );

    expect(result.success).toBe(false);
    expect(result.note).toMatch(/boot-device/i);
  });

  // ── Per-fetch deadline ───────────────────────────────────────────────────

  it("bounds a single slow fetch to the wait budget instead of its internal timeout", async () => {
    // describe() hangs far longer than timeoutMs. The wait must give up at ~its
    // own deadline, not block on the slow fetch.
    const slowApi: AXServiceApi = {
      degraded: false,
      describe: () => new Promise(() => {}), // never resolves
      alertCheck: async () => false,
      ping: async () => true,
    };
    const tool = createAwaitUiElementTool(iosRegistry(slowApi));

    const start = Date.now();
    const result = await tool.execute(
      {},
      {
        udid: IOS_UDID,
        condition: "visible",
        selector: { text: "Nope" },
        timeoutMs: 80,
        pollIntervalMs: 10,
      }
    );
    const elapsed = Date.now() - start;

    expect(result.success).toBe(false);
    expect(elapsed).toBeLessThan(1000);
    expect(result.note).toMatch(/did not complete within/i);
  });

  it("a final fetch straddling the deadline still reports the condition note, not a fetch failure", async () => {
    // First poll returns a usable (empty) tree; later polls hang. The wait must
    // give up at the deadline, and because it already read the screen once, the
    // note must be the normal "no element matched" — not "tree fetch did not
    // complete" (that's reserved for never having read the screen at all).
    let i = 0;
    const api: AXServiceApi = {
      degraded: false,
      describe: () =>
        i++ === 0
          ? Promise.resolve(axResponse([{ label: "Header", frame: FRAME, traits: [] }]))
          : new Promise(() => {}),
      alertCheck: async () => false,
      ping: async () => true,
    };
    const tool = createAwaitUiElementTool(iosRegistry(api));

    const result = await tool.execute(
      {},
      {
        udid: IOS_UDID,
        condition: "visible",
        selector: { text: "Nope" },
        timeoutMs: 120,
        pollIntervalMs: 30,
      }
    );

    expect(result.success).toBe(false);
    expect(result.note).toMatch(/no element matched/i);
    expect(result.note ?? "").not.toMatch(/did not complete/i);
  });

  it("aborts promptly even while a fetch is in flight", async () => {
    const slowApi: AXServiceApi = {
      degraded: false,
      describe: () => new Promise(() => {}), // never resolves
      alertCheck: async () => false,
      ping: async () => true,
    };
    const tool = createAwaitUiElementTool(iosRegistry(slowApi));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);

    const result = await tool.execute(
      {},
      {
        udid: IOS_UDID,
        condition: "visible",
        selector: { text: "Nope" },
        timeoutMs: 5000,
        pollIntervalMs: 10,
      },
      { signal: controller.signal } as never
    );

    expect(result.success).toBe(false);
    expect(result.note).toMatch(/cancel/i);
    expect(result.elapsed).toBeLessThan(2000);
  });

  // ── Pure matching / ordering units ───────────────────────────────────────

  // The selector is a substring match, so it can hit more than one node. These
  // pin the "evaluate across all matches" behaviour and the reading-order
  // "first" used by `text`.
  describe("multi-match condition evaluation", () => {
    const VISIBLE = { x: 0.1, y: 0.4, width: 0.5, height: 0.05 };
    const ZERO = { x: 0.1, y: 0.4, width: 0, height: 0 };
    const node = (
      label: string,
      frame: { x: number; y: number; width: number; height: number },
      children: DescribeNode[] = []
    ): DescribeNode => ({ role: "AXStaticText", frame, children, label });
    const tree = (children: DescribeNode[]): DescribeNode => ({
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children,
    });
    type EvalParams = Parameters<typeof evaluateMatches>[0];
    const params = (condition: string, expectedText?: string): EvalParams =>
      ({ condition, selector: { text: "Item" }, expectedText }) as unknown as EvalParams;

    it("findAll collects every match, including nested ones, but NOT the root", () => {
      const t = tree([node("Row", VISIBLE, [node("Item", VISIBLE)]), node("Item", ZERO)]);
      expect(findAll(t, { text: "Item" })).toHaveLength(2);
    });

    it("findAll never matches the synthetic root node itself", () => {
      // Root role is AXGroup; a role:"AXGroup" selector must skip the root.
      const t = tree([node("Leaf", VISIBLE)]);
      expect(findAll(t, { role: "AXGroup" })).toHaveLength(0);
    });

    it("`visible` succeeds when a later match is visible even if an earlier match is zero-area", () => {
      const matches = findAll(tree([node("Item", ZERO), node("Item", VISIBLE)]), { text: "Item" });
      expect(matches).toHaveLength(2);
      expect(evaluateMatches(params("visible"), matches)).toBe(true);
    });

    it("`hidden` stays unsatisfied while any match is still visible (earlier match zero-area)", () => {
      const matches = findAll(tree([node("Item", ZERO), node("Item", VISIBLE)]), { text: "Item" });
      expect(evaluateMatches(params("hidden"), matches)).toBe(false);
    });

    it("`visible` fails when every match is zero-area", () => {
      const matches = findAll(tree([node("Item", ZERO), node("Item", ZERO)]), { text: "Item" });
      expect(evaluateMatches(params("visible"), matches)).toBe(false);
    });

    it("`hidden` succeeds when every match is zero-area", () => {
      const matches = findAll(tree([node("Item", ZERO)]), { text: "Item" });
      expect(evaluateMatches(params("hidden"), matches)).toBe(true);
    });

    it("`text` inspects the first match in READING order, not DFS order", () => {
      // DFS order reaches "Item bottom" (higher y) first because it appears
      // earlier in the children array. Reading order must pick the visually
      // topmost node (smaller y) — mirroring how describe lists them.
      const bottom = node("Item bottom", { x: 0.1, y: 0.8, width: 0.5, height: 0.05 });
      const top = node("Item top", { x: 0.1, y: 0.2, width: 0.5, height: 0.05 });
      const matches = findAll(tree([bottom, top]), { text: "Item" });
      expect(evaluateMatches(params("text", "top"), matches)).toBe(true);
      expect(evaluateMatches(params("text", "bottom"), matches)).toBe(false);
    });
  });

  // ── Schema ───────────────────────────────────────────────────────────────

  describe("schema validation", () => {
    const schema = createAwaitUiElementTool(iosRegistry({} as AXServiceApi)).zodSchema!;

    it("rejects the removed `time` condition", () => {
      expect(schema.safeParse({ condition: "time", udid: IOS_UDID, durationMs: 100 }).success).toBe(
        false
      );
    });

    it("requires udid for every condition", () => {
      expect(schema.safeParse({ condition: "visible", selector: { text: "x" } }).success).toBe(
        false
      );
    });

    it("requires a selector", () => {
      expect(schema.safeParse({ condition: "visible", udid: IOS_UDID }).success).toBe(false);
    });

    it("rejects `text` without expectedText", () => {
      expect(
        schema.safeParse({ condition: "text", udid: IOS_UDID, selector: { text: "x" } }).success
      ).toBe(false);
    });

    it("rejects a selector with no fields", () => {
      expect(schema.safeParse({ condition: "exists", udid: IOS_UDID, selector: {} }).success).toBe(
        false
      );
    });

    it("rejects unknown selector constraints instead of silently dropping them", () => {
      const result = schema.safeParse({
        condition: "visible",
        udid: IOS_UDID,
        selector: { text: "Order", textMatches: "^Order #\\d+$" },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({
            code: "unrecognized_keys",
            path: ["selector"],
            keys: ["textMatches"],
          })
        );
      }
    });

    it("rejects a selector containing only an unknown field with a pointed error", () => {
      const result = schema.safeParse({
        condition: "exists",
        udid: IOS_UDID,
        selector: { roel: "button" },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({
            code: "unrecognized_keys",
            path: ["selector"],
            keys: ["roel"],
          })
        );
      }
    });

    it.each([
      { text: "Order" },
      { identifier: "order-row" },
      { role: "button" },
      { text: "Order", identifier: "order-row", role: "button" },
    ])("accepts the documented selector fields: %j", (selector) => {
      expect(schema.safeParse({ condition: "visible", udid: IOS_UDID, selector }).success).toBe(
        true
      );
    });
  });
});
