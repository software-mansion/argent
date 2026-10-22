import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AXServiceApi, AXDescribeResponse } from "../src/blueprints/ax-service";
import { createAwaitScreenIdleTool } from "../src/tools/await-screen-idle";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";

// execute() probes the target's form factor (isTvOsSimulator) before polling —
// a real `xcrun simctl list` that never caches for this fake UDID, so it re-runs
// on every test and takes seconds under the parallel suite load. The device here
// is a plain phone shape, so pin the probe to false and keep the rest real.
vi.mock("../src/utils/ios-devices", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/ios-devices")>(
    "../src/utils/ios-devices"
  );
  return { ...actual, isTvOsSimulator: async () => false };
});

const IOS_UDID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const FRAME = { x: 0.1, y: 0.4, width: 0.8, height: 0.05 };

// AX service that walks `responses` one per call, repeating the last — lets a
// test simulate a screen that is blank, then renders, then holds still.
function makeSequencedAXService(responses: AXDescribeResponse[]): AXServiceApi {
  let i = 0;
  return {
    degraded: false,
    describe: async () => responses[Math.min(i++, responses.length - 1)],
    alertCheck: async () => false,
    livePanel: async () => null,
    foregroundApp: async () => ({ alertVisible: false }),
    fill: async () => ({ focused: false, verified: false }),
    tree: async () => ({ alertVisible: false, nodes: [], truncated: false }),
    ping: async () => true,
  };
}

function axResponse(elements: AXDescribeResponse["elements"]): AXDescribeResponse {
  return { alertVisible: false, screenFrame: { width: 440, height: 956 }, elements };
}

function iosRegistry(ax: AXServiceApi) {
  return {
    resolveService: vi.fn(async (urn: string) => {
      if (urn.startsWith("AXService:")) return ax;
      throw new Error(`unexpected service: ${urn}`);
    }),
  } as any;
}

const content = () => axResponse([{ label: "Settings", frame: FRAME, traits: ["button"] }]);

describe("await-screen-idle tool", () => {
  beforeEach(() => {
    __resetDepCacheForTests();
    __primeDepCacheForTests(["xcrun", "adb", "sim-remote"]);
  });

  it("exposes the await-screen-idle id", () => {
    expect(createAwaitScreenIdleTool(iosRegistry({} as AXServiceApi)).id).toBe("await-screen-idle");
  });

  it("settles once content renders and holds still", async () => {
    // blank, then the same content on every later poll → stable
    const tool = createAwaitScreenIdleTool(
      iosRegistry(makeSequencedAXService([axResponse([]), content()]))
    );

    const result = await tool.execute(
      {},
      { udid: IOS_UDID, timeoutMs: 2000, pollIntervalMs: 10, minStableMs: 30 }
    );

    expect(result.settled).toBe(true);
    expect(result.waitedMs).toBeGreaterThanOrEqual(30);
    expect(result.waitedMs).toBeLessThan(2000);
    expect(result.polls).toBeGreaterThan(1);
  });

  it("does not settle while the screen stays blank (times out)", async () => {
    const tool = createAwaitScreenIdleTool(iosRegistry(makeSequencedAXService([axResponse([])])));

    const result = await tool.execute(
      {},
      { udid: IOS_UDID, timeoutMs: 60, pollIntervalMs: 10, minStableMs: 30 }
    );

    expect(result.settled).toBe(false);
    expect(result.waitedMs).toBeGreaterThanOrEqual(60);
  });

  it("does not settle while content keeps changing (times out)", async () => {
    // a different label every poll never holds for minStableMs
    const changing = Array.from({ length: 30 }, (_, i) =>
      axResponse([{ label: `item-${i}`, frame: FRAME, traits: ["button"] }])
    );
    const tool = createAwaitScreenIdleTool(iosRegistry(makeSequencedAXService(changing)));

    const result = await tool.execute(
      {},
      { udid: IOS_UDID, timeoutMs: 80, pollIntervalMs: 5, minStableMs: 40 }
    );

    expect(result.settled).toBe(false);
    expect(result.waitedMs).toBeGreaterThanOrEqual(80);
  });

  describe("schema validation", () => {
    const schema = createAwaitScreenIdleTool(iosRegistry({} as AXServiceApi)).zodSchema!;

    it.each(["minStableMS", "min_stable_ms", "frobnicate"])(
      "rejects the top-level key %s instead of silently applying the default",
      (key) => {
        const result = schema.safeParse({ udid: IOS_UDID, [key]: 1000 });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues).toContainEqual(
            expect.objectContaining({ code: "unrecognized_keys", keys: [key] })
          );
        }
      }
    );

    it("accepts the declared fields", () => {
      expect(
        schema.safeParse({
          udid: IOS_UDID,
          timeoutMs: 3000,
          pollIntervalMs: 200,
          minStableMs: 250,
        }).success
      ).toBe(true);
    });
  });

  it("settles on the first non-empty read when minStableMs is 0", async () => {
    const tool = createAwaitScreenIdleTool(iosRegistry(makeSequencedAXService([content()])));

    const result = await tool.execute(
      {},
      { udid: IOS_UDID, timeoutMs: 2000, pollIntervalMs: 50, minStableMs: 0 }
    );

    expect(result.settled).toBe(true);
    expect(result.polls).toBe(1);
  });

  // ── ios-remote (a cloud sim reached through sim-remote) ──────────────────
  // The AX service is the same one the local branch resolves; the blueprint
  // puts it on a TCP transport across the tunnel. These pin that a remote udid
  // actually EXECUTES, not merely that the capability gate lets it through.

  it("settles on ios-remote through the same AX path as a local sim", async () => {
    const tool = createAwaitScreenIdleTool(
      iosRegistry(makeSequencedAXService([axResponse([]), content()]))
    );

    const result = await tool.execute(
      {},
      { udid: `remote:${IOS_UDID}`, timeoutMs: 2000, pollIntervalMs: 10, minStableMs: 20 }
    );

    expect(result.settled).toBe(true);
    expect(result.polls).toBeGreaterThan(1);
  });

  it("does not settle on ios-remote while the screen keeps changing", async () => {
    // a different label every poll never holds for minStableMs
    const changing = Array.from({ length: 30 }, (_, i) =>
      axResponse([{ label: `item-${i}`, frame: FRAME, traits: ["button"] }])
    );
    const tool = createAwaitScreenIdleTool(iosRegistry(makeSequencedAXService(changing)));

    const result = await tool.execute(
      {},
      { udid: `remote:${IOS_UDID}`, timeoutMs: 80, pollIntervalMs: 5, minStableMs: 40 }
    );

    expect(result.settled).toBe(false);
    expect(result.waitedMs).toBeGreaterThanOrEqual(80);
  });

  it("settles when only a looping animation keeps moving (ambient motion)", async () => {
    // A coach-mark hand bobbing between two positions forever next to static
    // content: the full tree never repeats for long, but nothing else moves.
    const bob = (y: number) =>
      axResponse([
        { label: "Settings", frame: FRAME, traits: ["button"] },
        { label: "hand", frame: { x: 0.4, y, width: 0.18, height: 0.08 }, traits: ["image"] },
      ]);
    const looping = Array.from({ length: 60 }, (_, i) => bob(i % 2 ? 0.218 : 0.238));
    const tool = createAwaitScreenIdleTool(iosRegistry(makeSequencedAXService(looping)));

    const result = await tool.execute(
      {},
      { udid: IOS_UDID, timeoutMs: 1000, pollIntervalMs: 10, minStableMs: 30 }
    );

    expect(result.settled).toBe(true);
    expect(result.ambientMotion).toBe(true);
    expect(result.waitedMs).toBeLessThan(1000);
  });

  it("keeps waiting while an element slides without repeating a position", async () => {
    const slide = Array.from({ length: 200 }, (_, i) =>
      axResponse([
        { label: "Settings", frame: FRAME, traits: ["button"] },
        { label: "sheet", frame: { x: 0, y: 1 - i * 0.004, width: 1, height: 0.5 }, traits: [] },
      ])
    );
    const tool = createAwaitScreenIdleTool(iosRegistry(makeSequencedAXService(slide)));

    const result = await tool.execute(
      {},
      { udid: IOS_UDID, timeoutMs: 150, pollIntervalMs: 10, minStableMs: 30 }
    );

    expect(result.settled).toBe(false);
  });

  describe("ambient motion rules", () => {
    type Box = { label: string; x?: number; y: number; width?: number; height?: number };
    const screen = (...boxes: Box[]) =>
      axResponse([
        { label: "Settings", frame: FRAME, traits: ["button"] },
        ...boxes.map((b) => ({
          label: b.label,
          frame: { x: b.x ?? 0.4, y: b.y, width: b.width ?? 0.18, height: b.height ?? 0.08 },
          traits: ["image"],
        })),
      ]);
    const run = (
      frames: AXDescribeResponse[],
      opts: { timeoutMs?: number; minStableMs?: number } = {}
    ) =>
      createAwaitScreenIdleTool(iosRegistry(makeSequencedAXService(frames))).execute(
        {},
        {
          udid: IOS_UDID,
          timeoutMs: opts.timeoutMs ?? 300,
          pollIntervalMs: 10,
          minStableMs: opts.minStableMs ?? 30,
        }
      );
    const bobY = (i: number) => (i % 2 ? 0.218 : 0.238);

    it("keeps waiting when an entrance overshoots once and keeps moving", async () => {
      // Slides up, overshoots, then creeps back down without reversing again.
      const ys = [
        ...Array.from({ length: 10 }, (_, i) => 0.9 - i * 0.04),
        ...Array.from({ length: 200 }, (_, i) => 0.5 + i * 0.012),
      ];
      const result = await run(ys.map((y) => screen({ label: "snackbar", y })));

      expect(result.settled).toBe(false);
    });

    it("does not count an axis coming to rest as a reversal", async () => {
      // A slow diagonal: x moves on every other rounded poll, y on every poll.
      const result = await run(
        Array.from({ length: 200 }, (_, i) =>
          screen({ label: "toast", x: 0.5 - i * 0.005, y: 0.9 - i * 0.012 })
        )
      );

      expect(result.settled).toBe(false);
    });

    it("settles once a one-time slide has stopped and only a loop keeps moving", async () => {
      const result = await run(
        Array.from({ length: 200 }, (_, i) =>
          screen({ label: "panel", y: 0.9 - Math.min(i, 10) * 0.04 }, { label: "hand", y: bobY(i) })
        ),
        { timeoutMs: 1000 }
      );

      expect(result.settled).toBe(true);
      expect(result.ambientMotion).toBe(true);
    });

    it("counts nodes that move together as one animation", async () => {
      // A coach mark: container, arrow, text and button bob as one.
      const result = await run(
        Array.from({ length: 200 }, (_, i) =>
          screen(
            { label: "coach", y: bobY(i), height: 0.2 },
            { label: "arrow", y: bobY(i) + 0.01 },
            { label: "tip", y: bobY(i) + 0.05 },
            { label: "Got it", y: bobY(i) + 0.1 }
          )
        ),
        { timeoutMs: 1000 }
      );

      expect(result.settled).toBe(true);
      expect(result.ambientMotion).toBe(true);
    });

    it("keeps waiting when more than three separate loops move", async () => {
      const result = await run(
        Array.from({ length: 200 }, (_, i) =>
          screen(
            ...[0.02, 0.03, 0.04, 0.05].map((amp, k) => ({
              label: `dot-${k}`,
              y: 0.3 + k * 0.1 + (i % 2) * amp,
            }))
          )
        )
      );

      expect(result.settled).toBe(false);
    });

    it("holds the structure for minStableMs before taking the ambient path", async () => {
      const result = await run(
        Array.from({ length: 400 }, (_, i) => screen({ label: "hand", y: bobY(i) })),
        { timeoutMs: 2000, minStableMs: 300 }
      );

      expect(result.settled).toBe(true);
      expect(result.waitedMs).toBeGreaterThanOrEqual(300);
    });

    it("forgets loop evidence when the structure changes", async () => {
      // The hand bobs, then a toast appears and the hand slides away for good.
      const result = await run(
        [
          ...Array.from({ length: 6 }, (_, i) => screen({ label: "hand", y: bobY(i) })),
          ...Array.from({ length: 200 }, (_, i) =>
            screen({ label: "hand", y: 0.24 + i * 0.012 }, { label: "toast", y: 0.8 })
          ),
        ],
        { timeoutMs: 600, minStableMs: 200 }
      );

      expect(result.settled).toBe(false);
    });

    it("forgets loop evidence across a blank read", async () => {
      // The sheet slides, the screen blanks, then the slide replays from the top.
      const result = await run([
        screen({ label: "sheet", y: 0.9 }),
        screen({ label: "sheet", y: 0.7 }),
        axResponse([]),
        ...Array.from({ length: 200 }, (_, i) => screen({ label: "sheet", y: 0.9 - i * 0.012 })),
      ]);

      expect(result.settled).toBe(false);
    });
  });
});
