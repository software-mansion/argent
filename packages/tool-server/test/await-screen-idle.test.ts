import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AXServiceApi, AXDescribeResponse } from "../src/blueprints/ax-service";
import { createAwaitScreenIdleTool } from "../src/tools/await-screen-idle";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";
import type { DescribeNode } from "../src/tools/describe/contract";

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

  it("settles on a degraded simulator without a note", async () => {
    // A degraded tree is live; its boot hint does not qualify a settle.
    const ax = { ...makeSequencedAXService([content()]), degraded: true };
    const tool = createAwaitScreenIdleTool(iosRegistry(ax));

    const result = await tool.execute(
      {},
      { udid: IOS_UDID, timeoutMs: 2000, pollIntervalMs: 10, minStableMs: 0 }
    );

    expect(result.settled).toBe(true);
    expect(result.note).toBeUndefined();
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
        { label: "sheet", frame: { x: 0, y: 1 - i * 0.012, width: 1, height: 0.5 }, traits: [] },
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
    type Box = {
      label: string;
      value?: string;
      x?: number;
      y: number;
      width?: number;
      height?: number;
    };
    const screen = (...boxes: Box[]) =>
      axResponse([
        { label: "Settings", frame: FRAME, traits: ["button"] },
        ...boxes.map((b) => ({
          label: b.label,
          value: b.value,
          frame: { x: b.x ?? 0.4, y: b.y, width: b.width ?? 0.18, height: b.height ?? 0.08 },
          traits: ["image"],
        })),
      ]);
    const run = (
      frames: AXDescribeResponse[],
      opts: { timeoutMs?: number; minStableMs?: number; pollIntervalMs?: number } = {}
    ) =>
      createAwaitScreenIdleTool(iosRegistry(makeSequencedAXService(frames))).execute(
        {},
        {
          udid: IOS_UDID,
          timeoutMs: opts.timeoutMs ?? 300,
          pollIntervalMs: opts.pollIntervalMs ?? 10,
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

    it("waits out a spring entrance that swings with shrinking amplitude", async () => {
      const springY = (i: number) => 0.5 + 0.3 * 0.6 ** (i / 3) * Math.cos((Math.PI * i) / 3);
      const result = await run(
        [...Array.from({ length: 16 }, (_, i) => springY(i)), 0.5].map((y) =>
          screen({ label: "card", y })
        ),
        { timeoutMs: 1000 }
      );

      expect(result.settled).toBe(true);
      expect(result.ambientMotion).toBeUndefined();
    });

    it("waits out a one-time shake that swings at a constant amplitude", async () => {
      const ys = [0.5, 0.52, 0.5, 0.52, 0.5];
      const result = await run(ys.map((y) => screen({ label: "field", y })));

      expect(result.settled).toBe(true);
      expect(result.ambientMotion).toBeUndefined();
    });

    it("keeps waiting when a reload jumps a slide back and replays it", async () => {
      const ys = [0.9, 0.88, 0.86, ...Array.from({ length: 200 }, (_, i) => 0.9 - i * 0.012)];
      const result = await run(ys.map((y) => screen({ label: "sheet", y })));

      expect(result.settled).toBe(false);
    });

    it("keeps waiting when a loop stops looping and slides away", async () => {
      const result = await run(
        [
          ...Array.from({ length: 6 }, (_, i) => screen({ label: "hand", y: bobY(i) })),
          ...Array.from({ length: 200 }, (_, i) => screen({ label: "hand", y: 0.24 + i * 0.012 })),
        ],
        { timeoutMs: 600, minStableMs: 200 }
      );

      expect(result.settled).toBe(false);
    });

    it("keeps waiting while cells that share a label scroll past", async () => {
      // On-screen cells only: as a row leaves the top, the next one takes its place.
      const cells = (i: number) =>
        [0, 1, 2].map((k) => ({ label: "Photo", y: 0.2 + 0.1 * k - ((i * 0.03) % 0.1) }));
      const result = await run(
        Array.from({ length: 200 }, (_, i) => screen(...cells(i), { label: "hand", y: bobY(i) }))
      );

      expect(result.settled).toBe(false);
    });

    it("settles on a loop that the AX service sometimes lists twice", async () => {
      const result = await run(
        Array.from({ length: 200 }, (_, i) => {
          const hand = { label: "hand", y: bobY(i) };
          return i % 4 === 3 ? screen(hand, { ...hand, y: bobY(i + 1) }) : screen(hand);
        }),
        { timeoutMs: 1000 }
      );

      expect(result.settled).toBe(true);
      expect(result.ambientMotion).toBe(true);
    });

    it("keeps waiting on a slow diagonal slide whose x moves every other poll", async () => {
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

    it("counts a coach mark whose parts bob together as one animation", async () => {
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

    it("counts side-by-side nodes as one animation when snapping skews their moves", async () => {
      // AX frames snap to whole points, so nodes bobbing together report moves
      // that differ by about a point, and some reads show only some of them moving.
      const snap = (v: number) => Math.round(v * 956) / 956;
      const wave = (i: number) => 0.02 * Math.sin((Math.PI * i) / 4);
      const result = await run(
        Array.from({ length: 200 }, (_, i) =>
          screen(
            ...["arrow", "Tip", "Body", "Skip", "Next"].map((label, k) => ({
              label,
              x: 0.02 + k * 0.2,
              y: snap(0.3003 + k * 0.0004 + wave(i)),
              width: 0.15,
            }))
          )
        ),
        { timeoutMs: 1000 }
      );

      expect(result.settled).toBe(true);
      expect(result.ambientMotion).toBe(true);
    });

    it("counts a pulsing card and its children as one animation", async () => {
      const card = { x: 0.2, y: 0.3, width: 0.6, height: 0.3 };
      const children = [
        { x: 0.22, y: 0.32, width: 0.2, height: 0.05 },
        { x: 0.58, y: 0.32, width: 0.2, height: 0.05 },
        { x: 0.22, y: 0.53, width: 0.2, height: 0.05 },
        { x: 0.58, y: 0.53, width: 0.2, height: 0.05 },
      ];
      const scaled = (b: typeof card, s: number) => ({
        x: 0.5 + (b.x - 0.5) * s,
        y: 0.45 + (b.y - 0.45) * s,
        width: b.width * s,
        height: b.height * s,
      });
      const result = await run(
        Array.from({ length: 200 }, (_, i) => {
          const s = i % 2 ? 1.1 : 1;
          return screen(
            { label: "card", ...scaled(card, s) },
            ...children.map((c, k) => ({ label: `line-${k}`, ...scaled(c, s) }))
          );
        }),
        { timeoutMs: 1000 }
      );

      expect(result.settled).toBe(true);
      expect(result.ambientMotion).toBe(true);
    });

    it("settles on a badge that pulses in size without moving", async () => {
      const result = await run(
        Array.from({ length: 200 }, (_, i) =>
          screen({ label: "badge", y: 0.2, width: i % 2 ? 0.12 : 0.1, height: i % 2 ? 0.06 : 0.05 })
        ),
        { timeoutMs: 1000 }
      );

      expect(result.settled).toBe(true);
      expect(result.ambientMotion).toBe(true);
    });

    it("settles when exactly three separate loops move", async () => {
      const result = await run(
        Array.from({ length: 200 }, (_, i) =>
          screen(
            ...[0.02, 0.03, 0.04].map((amp, k) => ({
              label: "dot",
              value: `${k + 1} of 3`,
              y: 0.3 + k * 0.1 + (i % 2) * amp,
            }))
          )
        ),
        { timeoutMs: 1000 }
      );

      expect(result.settled).toBe(true);
      expect(result.ambientMotion).toBe(true);
    });

    it("keeps loops apart that make the same moves on different polls", async () => {
      // Each dot steps every other poll, a poll out of phase with the next one.
      const step = (i: number, k: number) => 0.03 * (Math.floor((i + k) / 2) % 2);
      const result = await run(
        Array.from({ length: 200 }, (_, i) =>
          screen(...[0, 1, 2, 3].map((k) => ({ label: `dot-${k}`, y: 0.3 + k * 0.1 + step(i, k) })))
        ),
        { timeoutMs: 600, minStableMs: 100 }
      );

      expect(result.settled).toBe(false);
    });

    it("keeps waiting while a loop moves next to a sheet that is still sliding", async () => {
      const result = await run(
        Array.from({ length: 200 }, (_, i) =>
          screen(
            { label: "hand", y: bobY(i) },
            { label: "sheet", x: 0, y: 0.9 - i * 0.012, width: 1, height: 0.05 }
          )
        )
      );

      expect(result.settled).toBe(false);
    });

    it("keeps waiting while a slow slide has moved within minStableMs", async () => {
      // The sheet steps every fifth poll: within minStableMs, but not within two polls.
      const result = await run(
        Array.from({ length: 200 }, (_, i) =>
          screen(
            { label: "hand", y: bobY(i) },
            { label: "sheet", x: 0, y: 0.9 - Math.floor(i / 5) * 0.02, width: 1, height: 0.05 }
          )
        ),
        { timeoutMs: 600, minStableMs: 200 }
      );

      expect(result.settled).toBe(false);
    });

    it("keeps waiting on a slide that moved one poll ago when minStableMs is shorter", async () => {
      const result = await run(
        Array.from({ length: 200 }, (_, i) =>
          screen(
            { label: "hand", y: bobY(i) },
            { label: "sheet", x: 0, y: 0.9 - Math.floor(i / 2) * 0.02, width: 1, height: 0.05 }
          )
        ),
        { timeoutMs: 1500, minStableMs: 20, pollIntervalMs: 50 }
      );

      expect(result.settled).toBe(false);
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

    it("needs fresh loop evidence after the structure changes", async () => {
      // The hand loops next to a sliding sheet; the sheet leaves, then the hand
      // swings a few more times and stops.
      const result = await run(
        [
          ...Array.from({ length: 20 }, (_, i) =>
            screen({ label: "hand", y: bobY(i) }, { label: "sheet", x: 0, y: 0.9 - i * 0.012 })
          ),
          ...Array.from({ length: 5 }, (_, i) => screen({ label: "hand", y: bobY(i) })),
          screen({ label: "hand", y: 0.238 }),
        ],
        { timeoutMs: 2000, minStableMs: 40, pollIntervalMs: 20 }
      );

      expect(result.settled).toBe(true);
      expect(result.ambientMotion).toBeUndefined();
    });

    it.each([
      ["a progress bar", ["progressbar"]],
      ["an activity indicator", ["ActivityIndicator"]],
      ["a progress bar inside a group", ["group", "progressbar"]],
    ])("keeps waiting while a looping spinner is %s", async (_, roles) => {
      const node = (role: string, label: string, y: number, children: DescribeNode[] = []) => ({
        role,
        label,
        frame: { x: 0.4, y, width: 0.1, height: 0.05 },
        children,
      });
      const spinner = (y: number) =>
        roles.reduceRight<DescribeNode[]>(
          (children, role) => [node(role, "Loading", y, children)],
          []
        );
      const tree = (i: number) => ({
        role: "html",
        frame: { x: 0, y: 0, width: 1, height: 1 },
        children: [node("h1", "Products", 0.1), ...spinner(bobY(i))],
      });
      let i = 0;
      const chromium = {
        refreshViewport: async () => {},
        cdp: {
          send: async () => ({ result: { value: JSON.stringify({ tree: tree(i++) }) } }),
        },
      };
      const tool = createAwaitScreenIdleTool(iosRegistry({} as AXServiceApi));

      const result = await tool.execute(
        { chromium },
        { udid: "chromium-cdp-9222", timeoutMs: 300, pollIntervalMs: 10, minStableMs: 30 }
      );

      expect(result.settled).toBe(false);
    });

    describe("on a simulated clock with default timing", () => {
      // Reads land exactly every 200 ms, so these pin the rules at their boundaries.
      beforeEach(() => {
        vi.useFakeTimers();
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      const runOnClock = async (frames: AXDescribeResponse[]) => {
        const pending = createAwaitScreenIdleTool(
          iosRegistry(makeSequencedAXService(frames))
        ).execute({}, { udid: IOS_UDID });
        await vi.runAllTimersAsync();
        return pending;
      };
      const shakeUntil = (lastMovingRead: number) =>
        Array.from({ length: lastMovingRead + 1 }, (_, i) =>
          screen({ label: "field", y: i % 2 ? 0.52 : 0.5 })
        );

      it("counts a shake as a loop once it has swung for seven poll intervals", async () => {
        const result = await runOnClock(shakeUntil(8));

        expect(result.settled).toBe(true);
        expect(result.ambientMotion).toBe(true);
      });

      it("waits out a shake that stops a poll before that", async () => {
        const result = await runOnClock(shakeUntil(7));

        expect(result.settled).toBe(true);
        expect(result.ambientMotion).toBeUndefined();
      });

      it("keeps waiting while a very bouncy spring rings", async () => {
        // Each swing repeats the one before within a quarter swing, but shrinks.
        const springY = (i: number) => 0.5 + 0.3 * 0.8 ** (i / 2) * Math.cos((Math.PI * i) / 2);
        const result = await runOnClock(
          Array.from({ length: 60 }, (_, i) => screen({ label: "card", y: springY(i) }))
        );

        expect(result.settled).toBe(false);
      });

      it("settles on a loop that the AX service lists twice on two reads in a row", async () => {
        // The second listing comes from a collection pass half a poll earlier.
        const waveY = (i: number) => 0.27 + 0.03 * Math.sin((2 * Math.PI * i) / 7);
        const result = await runOnClock(
          Array.from({ length: 40 }, (_, i) => {
            const hand = { label: "hand", y: waveY(i) };
            const listedTwice = i % 4 === 1 || i % 4 === 2;
            return listedTwice ? screen({ ...hand, y: waveY(i - 0.5) }, hand) : screen(hand);
          })
        );

        expect(result.settled).toBe(true);
        expect(result.ambientMotion).toBe(true);
      });

      it("forgets loop evidence on every blank read", async () => {
        const result = await runOnClock(
          Array.from({ length: 30 }, (_, i) =>
            i % 8 === 7 ? axResponse([]) : screen({ label: "hand", y: bobY(i) })
          )
        );

        expect(result.settled).toBe(false);
      });

      it("forgets loop evidence when copies of a node appear", async () => {
        const images = (count: number) =>
          Array.from({ length: count }, (_, k) => ({ label: "", x: 0.05 + k * 0.2, y: 0.7 }));
        const result = await runOnClock(
          Array.from({ length: 30 }, (_, i) =>
            screen({ label: "hand", y: bobY(i) }, ...images(i < 8 ? 1 : 4))
          )
        );

        expect(result.settled).toBe(false);
      });
    });

    it("settles on a small pulse whose turns jitter by one rounding step", async () => {
      const cycle = [0, 0.01, 0.02, 0.01, 0.02, 0.03, 0.02, 0.01];
      const result = await run(
        Array.from({ length: 200 }, (_, i) =>
          screen({ label: "badge", y: 0.2, width: 0.36 + cycle[i % cycle.length]! })
        ),
        { timeoutMs: 1000 }
      );

      expect(result.settled).toBe(true);
      expect(result.ambientMotion).toBe(true);
    });

    it("keeps waiting while a loop also drifts on another axis", async () => {
      const result = await run(
        Array.from({ length: 200 }, (_, i) =>
          screen({ label: "hand", x: 0.1 + i * 0.012, y: bobY(i) })
        )
      );

      expect(result.settled).toBe(false);
    });

    it("counts children that overhang a pulsing card by a rounding step as one animation", async () => {
      const card = { x: 0.2, y: 0.3, width: 0.6, height: 0.3 };
      const children = [0.32, 0.4, 0.48, 0.53].map((y) => ({
        x: 0.194,
        y,
        width: 0.2,
        height: 0.05,
      }));
      const scaled = (b: typeof card, s: number) => ({
        x: 0.5 + (b.x - 0.5) * s,
        y: 0.45 + (b.y - 0.45) * s,
        width: b.width * s,
        height: b.height * s,
      });
      const result = await run(
        Array.from({ length: 200 }, (_, i) => {
          const s = i % 2 ? 1.1 : 1;
          return screen(
            { label: "card", ...scaled(card, s) },
            ...children.map((c, k) => ({ label: `line-${k}`, ...scaled(c, s) }))
          );
        }),
        { timeoutMs: 1000 }
      );

      expect(result.settled).toBe(true);
      expect(result.ambientMotion).toBe(true);
    });

    it("does not report ambient motion when nothing moves", async () => {
      // A still node the AX service lists twice on every other read.
      const result = await run(
        Array.from({ length: 200 }, (_, i) => {
          const hand = { label: "hand", y: 0.3 };
          return i % 2 ? screen(hand, hand) : screen(hand);
        })
      );

      expect(result.ambientMotion).toBeUndefined();
    });

    it("settles on a loop whose container shares its role and label with another node", async () => {
      // Unlabeled containers share one identity; this one bobs around its children.
      const result = await run(
        Array.from({ length: 200 }, (_, i) =>
          screen(
            { label: "", y: 0.05, height: 0.05 },
            { label: "", y: bobY(i), height: 0.2 },
            { label: "arrow", y: bobY(i) + 0.01 },
            { label: "Got it", y: bobY(i) + 0.1 }
          )
        ),
        { timeoutMs: 1000 }
      );

      expect(result.settled).toBe(true);
      expect(result.ambientMotion).toBe(true);
    });

    it("settles on a loop that pauses at each end", async () => {
      const result = await run(
        Array.from({ length: 200 }, (_, i) =>
          screen({ label: "hand", y: bobY(Math.floor(i / 2)) })
        ),
        { timeoutMs: 1000 }
      );

      expect(result.settled).toBe(true);
      expect(result.ambientMotion).toBe(true);
    });

    it("settles on a loop that jumps to a narrower bob", async () => {
      const ys = Array.from({ length: 200 }, (_, i) =>
        i < 6 ? (i % 2 ? 0.2 : 0.26) : i % 2 ? 0.5 : 0.52
      );
      const result = await run(
        ys.map((y) => screen({ label: "hand", y })),
        { timeoutMs: 1000 }
      );

      expect(result.settled).toBe(true);
      expect(result.ambientMotion).toBe(true);
    });

    it("settles on a small loop whose swing shrinks by two rounding steps", async () => {
      const ys = [
        0.2,
        0.18,
        0.22,
        0.19,
        ...Array.from({ length: 200 }, (_, i) => (i % 2 ? 0.2 : 0.21)),
      ];
      const result = await run(
        ys.map((y) => screen({ label: "badge", y })),
        { timeoutMs: 1000 }
      );

      expect(result.settled).toBe(true);
      expect(result.ambientMotion).toBe(true);
    });

    describe("children of a card that pulses in height", () => {
      const card = { x: 0.1, y: 0.3, width: 0.6, height: 0.3 };
      const scaledY = (b: typeof card, s: number) => ({
        ...b,
        y: 0.45 + (b.y - 0.45) * s,
        height: b.height * s,
      });
      const pulse = (childX: number) =>
        Array.from({ length: 200 }, (_, i) => {
          const s = i % 2 ? 1.1 : 1;
          return screen(
            { label: "card", ...scaledY(card, s) },
            ...[0.32, 0.4, 0.48, 0.53].map((y, k) => ({
              label: `line-${k}`,
              ...scaledY({ x: childX, y, width: 0.2, height: 0.05 }, s),
            }))
          );
        });

      it("count as one animation when they overhang it by exactly one rounding step", async () => {
        const result = await run(pulse(0.09), { timeoutMs: 1000 });

        expect(result.settled).toBe(true);
        expect(result.ambientMotion).toBe(true);
      });

      it("count apart when they overhang it by two rounding steps", async () => {
        const result = await run(pulse(0.084));

        expect(result.settled).toBe(false);
      });
    });

    it("settles on unlabeled children that bob inside a coach mark", async () => {
      const result = await run(
        Array.from({ length: 200 }, (_, i) =>
          screen(
            { label: "coach", y: bobY(i), height: 0.2 },
            { label: "", y: bobY(i) + 0.03, height: 0.04 },
            { label: "", y: bobY(i) + 0.1, height: 0.04 }
          )
        ),
        { timeoutMs: 1000 }
      );

      expect(result.settled).toBe(true);
      expect(result.ambientMotion).toBe(true);
    });

    it("settles on unlabeled children that move one read after their coach mark", async () => {
      const result = await run(
        Array.from({ length: 200 }, (_, i) =>
          screen(
            { label: "coach", y: bobY(i), height: 0.2 },
            { label: "", y: bobY(i - 1) + 0.03, height: 0.04 },
            { label: "", y: bobY(i - 1) + 0.1, height: 0.04 }
          )
        ),
        { timeoutMs: 1000 }
      );

      expect(result.settled).toBe(true);
      expect(result.ambientMotion).toBe(true);
    });

    it("keeps waiting while unlabeled bars grow inside a pulsing card", async () => {
      const result = await run(
        Array.from({ length: 200 }, (_, i) => {
          const s = i % 2 ? 1.1 : 1;
          return screen(
            { label: "Offer", x: 0.2, y: 0.3, width: 0.6, height: 0.3 * s },
            ...[0.35, 0.45, 0.5].map((y) => ({
              label: "",
              x: 0.25,
              y,
              width: 0.1 + 0.01 * i,
              height: 0.03,
            }))
          );
        })
      );

      expect(result.settled).toBe(false);
    });

    it("settles once a cell that shares its label stops moving next to a loop", async () => {
      const result = await run(
        Array.from({ length: 200 }, (_, i) =>
          screen(
            { label: "hand", y: bobY(i) },
            { label: "Photo", x: 0.05, y: 0.6, width: 0.1 },
            { label: "Photo", x: 0.05, y: 0.8 - Math.min(i, 5) * 0.02, width: 0.1 }
          )
        ),
        { timeoutMs: 1000 }
      );

      expect(result.settled).toBe(true);
      expect(result.ambientMotion).toBe(true);
    });

    it("keeps waiting while a second copy of a still toast slides over it", async () => {
      const toast = { label: "Saved", x: 0.1, y: 0.8, width: 0.8 };
      const result = await run(
        Array.from({ length: 200 }, (_, i) =>
          i < 5
            ? screen({ label: "hand", y: bobY(i) }, toast)
            : screen({ label: "hand", y: bobY(i) }, toast, { ...toast, y: 0.86 - (i - 5) * 0.007 })
        )
      );

      expect(result.settled).toBe(false);
    });

    it.each([
      ["a sibling of another size over it", { height: 0.1 }],
      ["a sibling of its size beside it", { y: 0.6 }],
      ["two siblings of its size over it", { copies: 2 }],
    ])("keeps waiting while a looping node has %s that keeps sliding", async (_, sibling) => {
      const { copies = 1, ...shape } = sibling as { copies?: number; y?: number; height?: number };
      const result = await run(
        Array.from({ length: 200 }, (_, i) => {
          const hand = { label: "hand", y: bobY(i) };
          const siblings = Array.from({ length: copies }, (_, k) => ({
            ...hand,
            x: 0.25 + k * 0.01 + i * 0.01,
            ...shape,
          }));
          return screen(hand, ...(i < 3 ? [] : siblings));
        })
      );

      expect(result.settled).toBe(false);
    });

    it("keeps waiting while rows that share a label are removed one by one", async () => {
      const rows = (count: number) =>
        Array.from({ length: count }, (_, k) => ({
          label: "Photo",
          x: 0.05,
          y: 0.05 * k,
          width: 0.1,
        }));
      const result = await run(
        Array.from({ length: 200 }, (_, i) =>
          screen({ label: "hand", y: bobY(i) }, ...rows(Math.max(1, 10 - Math.floor(i / 5))))
        ),
        { timeoutMs: 400, minStableMs: 100 }
      );

      expect(result.settled).toBe(false);
    });

    it("keeps waiting while more than three letters bob in a staggered wave", async () => {
      const wave = (i: number, k: number) =>
        0.3 + 0.02 * Math.sin((2 * Math.PI * (i - k * 0.25)) / 8);
      const result = await run(
        Array.from({ length: 200 }, (_, i) =>
          screen(
            ..."Loading".split("").map((label, k) => ({
              label,
              x: 0.1 + k * 0.1,
              y: wave(i, k),
              width: 0.08,
              height: 0.05,
            }))
          )
        ),
        { timeoutMs: 600 }
      );

      expect(result.settled).toBe(false);
    });

    it("settles quickly on a panel that bobs around many rows", async () => {
      const result = await run(
        Array.from({ length: 200 }, (_, i) =>
          screen(
            { label: "panel", x: 0, y: bobY(i) - 0.2, width: 1, height: 0.99 },
            ...Array.from({ length: 700 }, (_, k) => ({
              label: `Row ${k}`,
              x: 0.1,
              y: bobY(i) - 0.19 + k * 0.001,
              width: 0.8,
              height: 0.001,
            }))
          )
        ),
        { timeoutMs: 2000 }
      );

      expect(result.settled).toBe(true);
      expect(result.ambientMotion).toBe(true);
      expect(result.waitedMs).toBeLessThan(1000);
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
