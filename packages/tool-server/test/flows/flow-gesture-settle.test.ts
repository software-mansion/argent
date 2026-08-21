import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

// One ordered log of tree reads and tool invocations, so a test can assert not
// just THAT the screen was settled but that it was settled before the gesture
// went out. `currentTree` throwing stands in for a tree-source outage.
type Event = { kind: "read" } | { kind: "invoke"; tool: string; args: Record<string, unknown> };
let events: Event[];
let currentTree: () => DescribeNode;
/** A source that never answers, for the tests that need a read still in flight. */
let hangReads: boolean;
/** How long a read takes to answer, for the tests that need one slower than a settle window. */
let readDelayMs: number;
/** Pixel dimensions the source serves, for the tests whose dispatched geometry reads them. */
let currentScreen: { width: number; height: number } | undefined;

// `idle` masks the status bar before comparing captures, which asks the iOS
// runtime whether this UDID is a tvOS simulator. DEVICE is fabricated, so a
// real probe would shell out to `xcrun simctl list` on every poll and never
// memoize the answer - pin it to the mobile one every case here is written
// against. Nothing else in this file reaches an iOS runtime path.
vi.mock("../../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/ios-devices")>()),
  isTvOsSimulator: vi.fn(async () => false),
}));

vi.mock("../../src/tools/flows/flow-tree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/tools/flows/flow-tree")>()),
  fetchFlowTree: vi.fn(async (): Promise<DescribeTreeData> => {
    events.push({ kind: "read" });
    if (hangReads) return new Promise<never>(() => {});
    if (readDelayMs > 0) await new Promise((r) => setTimeout(r, readDelayMs));
    return {
      tree: currentTree(),
      source: "native-devtools",
      ...(currentScreen ? { screen: currentScreen } : {}),
    };
  }),
}));

import { settleTree, type ActionEnv } from "../../src/tools/flows/flow-actions";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
/** The same simulator addressed through sim-remote — platform `ios-remote`, which has no flow tree. */
const REMOTE_DEVICE = `remote:${DEVICE}`;
let tmpDir: string;

const BUTTON = { x: 0.2, y: 0.4, width: 0.6, height: 0.1 };

function screen(children: DescribeNode[] = []): DescribeNode {
  return { role: "AXWindow", frame: { x: 0, y: 0, width: 1, height: 1 }, children };
}

const outage = (): DescribeNode => {
  throw new Error("native devtools is unavailable");
};

/** Dead until the named tool runs, healthy after: the gesture behind it can read again. */
const deadUntilTool = (tool: string) => (): DescribeNode => {
  if (!events.some((e) => e.kind === "invoke" && e.tool === tool)) {
    throw new Error("native devtools is unavailable");
  }
  return screen();
};

function mockRegistry(): Registry {
  return {
    invokeTool: vi.fn(async (id: string, args: Record<string, unknown>) => {
      if (id === "list-devices") return { devices: [] };
      events.push({ kind: "invoke", tool: id, args });
      return { ok: true };
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    // A `launch` gates on the native-devtools connection before it can pass.
    resolveService: vi.fn(async () => ({ isConnected: () => true })),
  } as unknown as Registry;
}

async function writeFlow(name: string, yaml: Parameters<typeof serializeFlow>[0]): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.yaml`), serializeFlow(yaml), "utf8");
}

async function run(
  name: string,
  signal?: AbortSignal,
  device: string = DEVICE
): Promise<FlowRunResult> {
  const tool = createRunFlowTool(mockRegistry());
  const ctx = signal ? ({ signal } as never) : undefined;
  const r = await tool.execute({}, { name, project_root: tmpDir, device }, ctx);
  if (!("steps" in r)) throw new Error(`expected a run result, got notice: ${r.notice}`);
  return r;
}

/** Tree reads that landed before the first dispatched gesture. */
function readsBeforeFirstGesture(): number {
  const at = events.findIndex((e) => e.kind === "invoke");
  return (at === -1 ? events : events.slice(0, at)).filter((e) => e.kind === "read").length;
}

/** Tree reads between two positions in the log, `to` exclusive. */
function readsBetween(from: number, to: number): number {
  return events.slice(from, to).filter((e) => e.kind === "read").length;
}

/** Index of the nth dispatched gesture in the event log. */
function gestureAt(n: number): number {
  return events.reduce<number[]>((acc, e, i) => (e.kind === "invoke" ? [...acc, i] : acc), [])[n]!;
}

function gestures(): Array<{ tool: string; args: Record<string, unknown> }> {
  return events.flatMap((e) => (e.kind === "invoke" ? [{ tool: e.tool, args: e.args }] : []));
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-gesture-settle-"));
  events = [];
  currentTree = screen;
  hangReads = false;
  readDelayMs = 0;
  currentScreen = undefined;
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// A selector target settles inside `waitForFrame`; a target that resolves
// nothing used to skip the settle entirely and dispatch into whatever motion
// was in flight. Every input directive settles first, however it is addressed.
describe("gestures without a selector settle before dispatching", () => {
  it("settles a coordinate tap", async () => {
    await writeFlow("tap-xy", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", x: 0.4, y: 0.6 }],
    });

    const result = await run("tap-xy");

    expect(result.ok).toBe(true);
    // Two identical reads are what "settled" means — the gesture waits for both.
    expect(readsBeforeFirstGesture()).toBeGreaterThanOrEqual(2);
    expect(gestures()[0]).toMatchObject({ tool: "gesture-tap", args: { x: 0.4, y: 0.6 } });
  });

  it("settles a coordinate long-press", async () => {
    await writeFlow("press-xy", {
      executionPrerequisite: "",
      steps: [{ kind: "long-press", x: 0.2, y: 0.3 }],
    });

    const result = await run("press-xy");

    expect(result.ok).toBe(true);
    expect(readsBeforeFirstGesture()).toBeGreaterThanOrEqual(2);
    expect(gestures()[0]?.tool).toBe("gesture-custom");
  });

  it("settles a centre-anchored pinch", async () => {
    await writeFlow("pinch-center", {
      executionPrerequisite: "",
      steps: [{ kind: "pinch", scale: 0.5 }],
    });

    const result = await run("pinch-center");

    expect(result.ok).toBe(true);
    expect(readsBeforeFirstGesture()).toBeGreaterThanOrEqual(2);
    expect(gestures()[0]?.tool).toBe("gesture-pinch");
  });

  it("settles a centre-anchored rotate", async () => {
    await writeFlow("rotate-center", {
      executionPrerequisite: "",
      steps: [{ kind: "rotate", by: 90 }],
    });

    const result = await run("rotate-center");

    expect(result.ok).toBe(true);
    expect(readsBeforeFirstGesture()).toBeGreaterThanOrEqual(2);
    expect(gestures()[0]?.tool).toBe("gesture-rotate");
  });

  it("waits for the screen to stop before a coordinate tap, not just for one read", async () => {
    // Three distinct trees, then a repeat: the settle cannot converge until the
    // fourth read matches the third.
    let reads = 0;
    currentTree = () => {
      reads += 1;
      const frame = { x: 0, y: Math.min(reads, 3) / 100, width: 1, height: 1 };
      return { role: "AXWindow", frame, children: [] };
    };
    await writeFlow("tap-moving", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", x: 0.5, y: 0.5 }],
    });

    const result = await run("tap-moving");

    expect(result.ok).toBe(true);
    expect(readsBeforeFirstGesture()).toBe(4);
  });
});

// Best-effort, unlike the selector path: these gestures read no frame out of
// the tree, so an outage must not turn a working coordinate gesture — the
// escape hatch for elements the tree cannot see — into a failed step.
describe("a tree-source outage never fails a selector-less gesture", () => {
  it("still dispatches a coordinate tap", async () => {
    currentTree = outage;
    await writeFlow("tap-blind", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", x: 0.4, y: 0.6 }],
    });

    const result = await run("tap-blind");

    expect(result.ok).toBe(true);
    expect(gestures()[0]).toMatchObject({ tool: "gesture-tap", args: { x: 0.4, y: 0.6 } });
  }, 15_000);

  it("still dispatches a centre-anchored pinch", async () => {
    currentTree = outage;
    await writeFlow("pinch-blind", {
      executionPrerequisite: "",
      steps: [{ kind: "pinch", scale: 2 }],
    });

    const result = await run("pinch-blind");

    expect(result.ok).toBe(true);
    expect(gestures()[0]?.tool).toBe("gesture-pinch");
  }, 15_000);

  it("charges one outage window for a run of gestures, not one per gesture", async () => {
    // The shape this matters for: a source that serves no tree at all
    // (`ios-remote`, an app the instrumentation cannot load) against a flow
    // made of coordinate gestures, which is the only kind such a run can have.
    // Consecutive ones, at that: a foreground-changing `tool:` step between two
    // gestures re-arms the window for the second, which the arms below pin.
    currentTree = outage;
    await writeFlow("taps-blind", {
      executionPrerequisite: "",
      steps: [
        { kind: "tap", x: 0.1, y: 0.1 },
        { kind: "tap", x: 0.2, y: 0.2 },
        { kind: "tap", x: 0.3, y: 0.3 },
      ],
    });

    const result = await run("taps-blind");

    expect(result.ok).toBe(true);
    expect(gestures()).toHaveLength(3);
    // Every read belongs to the first tap's window; taps 2 and 3 rethrow what
    // it proved. Without the memo each fills a window of its own, which is ~12
    // reads and 3s per gesture on a source that fails instantly.
    expect(readsBetween(gestureAt(0), events.length)).toBe(0);
    expect(readsBeforeFirstGesture()).toBeGreaterThan(2);
  }, 20_000);

  it("charges a centre-anchored rotate its aspect read, but no settle window", async () => {
    // `rotate` reads the screen aspect on top of its settle, and only the
    // settle is the memo's to spare: the aspect decides where the fingers go
    // down, so it is re-asked every time. One failed read per rotate is what
    // that costs against a source that is genuinely dead - unbudgeted, so on a
    // stalled iOS source it outlasts the window the memo saved.
    currentTree = outage;
    await writeFlow("tap-rotate-rotate", {
      executionPrerequisite: "",
      steps: [
        { kind: "tap", x: 0.1, y: 0.1 },
        { kind: "rotate", by: 90 },
        { kind: "rotate", by: -45 },
      ],
    });

    const result = await run("tap-rotate-rotate");

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "tap:pass",
      "rotate:pass",
      "rotate:pass",
    ]);
    // Every other read belongs to the tap's window: neither rotate settles, and
    // each asks for the aspect exactly once. A rotate that settled too would
    // make this a dozen-odd.
    expect(readsBetween(gestureAt(0), events.length)).toBe(2);
    expect(gestures().map((g) => g.tool)).toEqual([
      "gesture-tap",
      "gesture-rotate",
      "gesture-rotate",
    ]);
    // The read failed, so the geometry degrades to the legacy normalized-space
    // orbit - `radius`, the aspect-unknown spelling, on the horizontal axis.
    expect(gestures()[1]?.args).toMatchObject({ radius: 0.48, startAngle: 0 });
  }, 20_000);

  it("reads the aspect for a centre-anchored rotate though the verdict still stands", async () => {
    // The verdict is a prediction about a settle, not about the source: here it
    // is already stale when the rotate runs. Skipping the aspect read on it
    // would not just cost the step a wait, it would move both Down points -
    // and the placement it would move them to is the worse one.
    currentTree = deadUntilTool("gesture-tap");
    currentScreen = { width: 390, height: 844 };
    await writeFlow("tap-rotate-phone", {
      executionPrerequisite: "",
      steps: [
        { kind: "tap", x: 0.1, y: 0.1 },
        { kind: "rotate", by: 90 },
      ],
    });

    const result = await run("tap-rotate-phone");

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["tap:pass", "rotate:pass"]);
    // The settle is still skipped - one read between the gestures, the aspect's.
    expect(readsBetween(gestureAt(0), gestureAt(1))).toBe(1);
    // And the step says which half it lost: the wait, never the geometry.
    expect(result.steps[1].warning).toContain("without settling the screen");
    // radiusX = 0.5 - SCREEN_EDGE_INSET = 0.48, radiusY = 0.48 · 390/844, so the
    // vertical candidate's Down points are y = 0.278 / 0.722, clear of the 0.08
    // iOS top/bottom guard - the only fullyEdgeSafe candidate, hence selected.
    // At aspect 1 both tie unsafe at radius 0.48 and the horizontal one wins,
    // putting the fingers at x = 0.02 / 0.98, inside the back-gesture zone.
    expect(gestures()[1]).toMatchObject({
      tool: "gesture-rotate",
      args: {
        centerX: 0.5,
        centerY: 0.5,
        radiusX: 0.48,
        radiusY: 0.22180094786729856,
        startAngle: 90,
        endAngle: 180,
        durationMs: 300,
      },
    });
    // `radius` is the aspect-unknown spelling; its absence is the read landing.
    expect(gestures()[1]?.args).not.toHaveProperty("radius");
  }, 20_000);

  it("proves no outage from a window that read the tree but never settled", async () => {
    // A screen in perpetual motion (a spinner, a video) that also blips once:
    // the window expires having both read the tree and seen an error. It holds
    // still from the first tap onwards, so the second tap's reads are exact.
    let reads = 0;
    currentTree = () => {
      if (events.some((e) => e.kind === "invoke")) return screen();
      reads += 1;
      if (reads === 2) throw new Error("transient describe failure");
      const frame = { x: 0, y: reads / 100, width: 1, height: 1 };
      return { role: "AXWindow", frame, children: [] };
    };
    await writeFlow("tap-restless-tap", {
      executionPrerequisite: "",
      steps: [
        { kind: "tap", x: 0.1, y: 0.1 },
        { kind: "tap", x: 0.2, y: 0.2 },
      ],
    });

    const result = await run("tap-restless-tap");

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["tap:pass", "tap:pass"]);
    // A window that read the tree proves no outage, however restless the screen
    // it described: the second tap settles on its own two identical reads. A
    // verdict minted off the first window would leave it rethrowing with zero.
    expect(readsBetween(gestureAt(0), gestureAt(1))).toBe(2);
  }, 20_000);

  // Dispatching anyway is the right call; doing it silently is not. Nothing else
  // in a run's report separates a gesture that waited from one that went out
  // against whatever motion was in flight, so the swallowed outage says so here.
  describe("but the run is told the gesture went out unsettled", () => {
    /** The one thing every unsettled-gesture warning must carry: the source's own words. */
    const OUTAGE_REASON = "native devtools is unavailable";

    it("warns every gesture the outage touched, on the memo as well as on the proof", async () => {
      // One run, both producers: tap 1 proves the outage inside its own window,
      // and the three behind it spend the memo without reading. Being told only
      // once would understate a run that was blind throughout.
      currentTree = outage;
      await writeFlow("taps-blind-warned", {
        executionPrerequisite: "",
        steps: [
          { kind: "tap", x: 0.1, y: 0.1 },
          { kind: "tap", x: 0.2, y: 0.2 },
          { kind: "long-press", x: 0.3, y: 0.3 },
          { kind: "rotate", by: 90 },
        ],
      });

      const result = await run("taps-blind-warned");

      // The status stays green - the gesture is the escape hatch, not a failure.
      expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
        "tap:pass",
        "tap:pass",
        "long-press:pass",
        "rotate:pass",
      ]);
      for (const step of result.steps) {
        expect(step.warning).toContain("without settling the screen");
        expect(step.warning).toContain(OUTAGE_REASON);
      }
      // And only the first step paid a window for what all four report - the
      // one read behind it is the rotate's aspect, which no verdict spares.
      expect(readsBetween(gestureAt(0), events.length)).toBe(1);
    }, 20_000);

    it("warns a centre-anchored pinch too", async () => {
      currentTree = outage;
      await writeFlow("pinch-blind-warned", {
        executionPrerequisite: "",
        steps: [{ kind: "pinch", scale: 2 }],
      });

      const result = await run("pinch-blind-warned");

      expect(result.steps[0].status).toBe("pass");
      expect(result.steps[0].warning).toContain(OUTAGE_REASON);
    }, 15_000);

    it("says nothing when the source is healthy", async () => {
      // What keeps the warning worth reading. A settle that ran carries none,
      // whichever gesture asked for it.
      await writeFlow("gestures-settled", {
        executionPrerequisite: "",
        steps: [
          { kind: "tap", x: 0.1, y: 0.1 },
          { kind: "long-press", x: 0.2, y: 0.2 },
          { kind: "pinch", scale: 2 },
          { kind: "rotate", by: 90 },
        ],
      });

      const result = await run("gestures-settled");

      expect(result.ok).toBe(true);
      expect(result.steps.map((s) => s.warning)).toEqual([
        undefined,
        undefined,
        undefined,
        undefined,
      ]);
      // Silent because each gesture settled, not because none did: a still
      // screen converges on the 2 identical reads a settle returns on, and
      // every gesture pays for its own pair.
      expect(readsBeforeFirstGesture()).toBe(2);
      expect(readsBetween(gestureAt(0), gestureAt(1))).toBe(2);
      expect(readsBetween(gestureAt(1), gestureAt(2))).toBe(2);
      // 3 for the rotate: the same pair plus the aspect read it makes on top of
      // its settle, which no settle produces.
      expect(readsBetween(gestureAt(2), gestureAt(3))).toBe(3);
    });

    it("says nothing about a screen that read fine and never stopped moving", async () => {
      // The window expired without converging: that settle DID run and waited
      // out its whole budget, so the gesture is as settled as one can be. Only
      // the outage path warns.
      let reads = 0;
      currentTree = () => {
        reads += 1;
        return {
          role: "AXWindow",
          frame: { x: 0, y: reads / 100, width: 1, height: 1 },
          children: [],
        };
      };
      await writeFlow("tap-restless-warned", {
        executionPrerequisite: "",
        steps: [{ kind: "tap", x: 0.4, y: 0.6 }],
      });

      const startedAt = Date.now();
      const result = await run("tap-restless-warned");
      const elapsed = Date.now() - startedAt;

      expect(result.steps[0].status).toBe("pass");
      expect(result.steps[0].warning).toBeUndefined();
      // And the budget was spent whole: no two reads ever match, so the tap
      // waited the full 3000ms window at the 250ms poll - at most 13 reads (12
      // intervals plus the first), and never the 2 a converging settle returns
      // on. Only the ceiling is fixed; slower polls on a loaded machine cost
      // reads, not window, which is what the elapsed time pins instead.
      expect(readsBeforeFirstGesture()).toBeGreaterThan(2);
      expect(readsBeforeFirstGesture()).toBeLessThanOrEqual(13);
      expect(elapsed).toBeGreaterThanOrEqual(3_000);
    }, 15_000);
  });

  it("rides out a transient read failure rather than treating it as the outage", async () => {
    // Fails once, then serves a still screen: the settle must still converge on
    // the two identical reads that follow instead of quitting on the blip.
    let reads = 0;
    currentTree = () => {
      reads += 1;
      if (reads === 1) throw new Error("transient describe failure");
      return screen();
    };
    await writeFlow("tap-blip", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", x: 0.4, y: 0.6 }],
    });

    const result = await run("tap-blip");

    expect(result.ok).toBe(true);
    expect(readsBeforeFirstGesture()).toBe(3);
    expect(gestures()[0]).toMatchObject({ tool: "gesture-tap", args: { x: 0.4, y: 0.6 } });
  });

  // The source is dead until the run's first gesture goes out, which is exactly
  // when the memo has been written — so phase two starts on a known event
  // rather than on a clock, and every read count below is exact.
  const deadUntilFirstGesture = (): DescribeNode => {
    if (!events.some((e) => e.kind === "invoke")) {
      throw new Error("native devtools is unavailable");
    }
    return screen([{ role: "AXButton", label: "Continue", frame: BUTTON, children: [] }]);
  };

  it("keeps skipping after the source recovers, when nothing reads in between", async () => {
    // The memo's documented cost, pinned as the trade it is rather than left to
    // be rediscovered as a bug. Nothing re-tests the verdict, so a source that
    // comes back the moment its window closes buys the gestures behind it
    // nothing - and a flow of only coordinate gestures reaches neither escape
    // (a directive read below, a relaunch further down).
    currentTree = deadUntilFirstGesture;
    await writeFlow("tap-recovers-tap", {
      executionPrerequisite: "",
      steps: [
        { kind: "tap", x: 0.1, y: 0.1 },
        { kind: "tap", x: 0.2, y: 0.2 },
      ],
    });

    const result = await run("tap-recovers-tap");

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["tap:pass", "tap:pass"]);
    // Tap 1 paid the whole window: a dozen-odd failed reads at the poll
    // interval, never the 2 identical ones a settle converges on.
    expect(readsBeforeFirstGesture()).toBeGreaterThan(2);
    // And tap 2 spends the verdict without a read, though the source recovered
    // the moment tap 1 went out and would have answered one.
    expect(readsBetween(gestureAt(0), events.length)).toBe(0);
    expect(() => currentTree()).not.toThrow();
    // The compensation is the report: the skip is wrong here, and says so.
    expect(result.steps[1].warning).toContain("without settling the screen");
    expect(result.steps[1].warning).toContain("native devtools is unavailable");
  }, 20_000);

  it("stops skipping as soon as any read comes back, settle or not", async () => {
    // The `await` is the point: it never settles, it just reads. A memo only a
    // settle could clear would survive it and leave the tap after it unsettled.
    currentTree = deadUntilFirstGesture;
    await writeFlow("tap-await-tap", {
      executionPrerequisite: "",
      steps: [
        { kind: "tap", x: 0.1, y: 0.1 },
        { kind: "await", condition: "exists", selector: { text: "Continue", loose: true } },
        { kind: "tap", x: 0.2, y: 0.2 },
      ],
    });

    const result = await run("tap-await-tap");

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "tap:pass",
      "await:pass",
      "tap:pass",
    ]);
    // One read for the await, then two for the second tap's own settle. A memo
    // that outlived the await would leave the tap with none of its own.
    expect(readsBetween(gestureAt(0), gestureAt(1))).toBe(3);
  }, 20_000);

  it("stops skipping as soon as an `idle` step reads, though it settles nothing either", async () => {
    // The other directive whose read no settle produces, and the one the
    // `await` above cannot stand in for: `idle` polls the tree for stillness
    // beside the pixels and gives up at its own deadline, so unless the read
    // itself retires the verdict, nothing the step does retires it.
    currentTree = deadUntilFirstGesture;
    // A read slower than what its window has left afterwards keeps the idle to
    // one answered poll, so the count below is the tap's own settle plus a
    // known read rather than however many polls happened to fit.
    readDelayMs = 400;
    await writeFlow("tap-idle-tap", {
      executionPrerequisite: "",
      steps: [
        { kind: "tap", x: 0.1, y: 0.1 },
        // The parser's floor for the default hold. Nothing here can settle
        // early anyway - see the capture note below - so the window is spent
        // whole and this is the cheapest one that spends it.
        { kind: "idle", timeout: 600 },
        { kind: "tap", x: 0.2, y: 0.2 },
      ],
    });

    const result = await run("tap-idle-tap");

    // The idle passes warned rather than green, and could not have settled: one
    // answered read measures no interval, and this file stubs no capture
    // backend, so the pixel half of the check never gets a pair either. Which
    // is the point - what is under test is the read, not the verdict.
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "tap:pass",
      "idle:pass",
      "tap:pass",
    ]);
    // The idle's own poll, then the two identical reads the second tap's settle
    // converges on. A memo that outlived the idle would leave the tap with none
    // of its own.
    expect(readsBetween(gestureAt(0), gestureAt(1))).toBeGreaterThanOrEqual(3);
    // And it would say so: every gesture that spends the memo is warned it went
    // out unsettled, so this tap having nothing to report is the same claim
    // read off the run's own output.
    expect(result.steps[2].warning).toBeUndefined();
  }, 20_000);

  it("never lets a selector step inherit the skip", async () => {
    // Only the best-effort caller may consume the memo. `waitForFrame` must
    // still auto-wait the source back, or a proven outage would turn every
    // later selector step into an instant failure it could have polled through.
    currentTree = deadUntilFirstGesture;
    await writeFlow("tap-then-selector", {
      executionPrerequisite: "",
      steps: [
        { kind: "tap", x: 0.1, y: 0.1 },
        { kind: "tap", selector: { text: "Continue", loose: true } },
        { kind: "tap", x: 0.2, y: 0.2 },
      ],
    });

    const result = await run("tap-then-selector");

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "tap:pass",
      "tap:pass",
      "tap:pass",
    ]);
    expect(gestures()).toHaveLength(3);
    // And the selector step's reads cleared the memo for the tap behind it.
    expect(readsBetween(gestureAt(1), gestureAt(2))).toBe(2);
  }, 20_000);
});

// The other half of that best effort: a source that is ABSENT is not a source
// that is down. `fetchFlowTree` serves no tree on `ios-remote`, so every
// selector directive already fails there and a coordinate flow is the only kind
// such a run can have - charging each of its gestures a window, and then telling
// every one of them to restore a source that never existed, warns a fully green
// run about a degradation that never happened.
describe("a platform with no tree source settles nothing and warns nothing", () => {
  /** What a read gets on such a platform - `fetchTree`'s own refusal, verbatim. */
  const unsupported = (): DescribeNode => {
    throw new Error('ui-tree matching is not supported on platform "ios-remote"');
  };

  it("dispatches a coordinate tap without reading the tree at all", async () => {
    currentTree = unsupported;
    await writeFlow("tap-remote", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", x: 0.4, y: 0.6 }],
    });

    const result = await run("tap-remote", undefined, REMOTE_DEVICE);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["tap:pass"]);
    // Not one read, let alone the whole window an outage is proven over.
    expect(readsBeforeFirstGesture()).toBe(0);
    expect(gestures()[0]).toMatchObject({ tool: "gesture-tap", args: { x: 0.4, y: 0.6 } });
    // And the run prints clean: no `⚠` on the step, no warning count on the summary.
    expect(result.steps[0].warning).toBeUndefined();
  });

  it("still fails a selector step there, exactly as before", async () => {
    // Only the best-effort caller may skip. A selector needs a frame out of the
    // tree, so a platform that serves none must keep failing the step outright
    // rather than inheriting the pass this file's other case pins.
    currentTree = unsupported;
    await writeFlow("tap-remote-selector", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", selector: { text: "Continue", loose: true } }],
    });

    const result = await run("tap-remote-selector", undefined, REMOTE_DEVICE);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["tap:error"]);
    expect(result.steps[0].reason).toContain("not supported on platform");
    expect(gestures()).toEqual([]);
  }, 20_000);
});

// A relaunch is the repair the tree source names when it refuses an app that
// loaded no instrumentation, so a `launch` spends the verdict proven before it
// - no read falls between it and the next gesture to clear it instead.
describe("a launch clears a proven outage", () => {
  it("makes the gesture after it pay for a settle of its own", async () => {
    currentTree = outage;
    await writeFlow("tap-launch-tap", {
      executionPrerequisite: "",
      steps: [
        { kind: "tap", x: 0.1, y: 0.1 },
        { kind: "launch", app: "com.acme.app" },
        { kind: "tap", x: 0.2, y: 0.2 },
      ],
    });

    const result = await run("tap-launch-tap");

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "tap:pass",
      "launch:pass",
      "tap:pass",
    ]);
    // Invocation 1 is the launch's own `restart-app`; the tap behind it settles
    // from scratch. A memo that outlived the launch would leave it zero reads.
    expect(readsBetween(gestureAt(1), gestureAt(2))).toBeGreaterThan(2);
  }, 20_000);
});

// The same device operation written as a raw `tool:` step. It is the shape a
// recorded flow actually carries - `launch-app` is never rewritten into a
// `launch:` directive, and the docs tell authors to start an app that cannot
// load the instrumentation with a bare `tool: restart-app` - so it must spend
// the verdict too, or the gesture behind the most animation-heavy moment a flow
// has would be the one dispatched with no settle at all. The set is
// deliberately coarse - `button` and most `open-url` targets repair nothing -
// because over-clearing only costs a later gesture a window it would have
// skipped, while missing a repair leaves it dispatching blind.
describe("a raw `tool:` relaunch clears a proven outage", () => {
  // Every entry of `FOREGROUND_CHANGING_TOOLS`, with the args its own schema
  // asks for: the clear is unkeyed, so each spelling has to be pinned.
  it.each([
    { tool: "launch-app", args: { bundleId: "com.acme.app" } },
    { tool: "restart-app", args: { bundleId: "com.acme.app" } },
    { tool: "reinstall-app", args: { bundleId: "com.acme.app", appPath: "./build/Acme.app" } },
    { tool: "open-url", args: { url: "https://example.com" } },
    { tool: "button", args: { button: "home" } },
  ])(
    "makes the gesture after `tool: $tool` pay for a settle of its own",
    async ({ tool, args }) => {
      currentTree = deadUntilTool(tool);
      await writeFlow(`tap-${tool}-tap`, {
        executionPrerequisite: "",
        steps: [
          { kind: "tap", x: 0.1, y: 0.1 },
          { kind: "tool", name: tool, args },
          { kind: "tap", x: 0.2, y: 0.2 },
        ],
      });

      const result = await run(`tap-${tool}-tap`);

      expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
        "tap:pass",
        "tool:pass",
        "tap:pass",
      ]);
      // Exactly the two identical reads a settle converges on. A verdict only
      // `launch:` spent would leave the second tap with zero.
      expect(readsBetween(gestureAt(1), gestureAt(2))).toBe(2);
    },
    20_000
  );
});

// A nested `run:` shares this run's ExecState and so its memo, but a `tool:`
// orchestrator runs outside this holder entirely - whatever it reads or
// relaunches retires nothing here. So the step spends the verdict on the way
// in, or an authored composition (the shape `flow-add-step` records for a
// nested run) leaves every gesture behind it skipping its settle on evidence a
// whole sub-run may have disproved.
describe("a nested orchestrator step clears a proven outage", () => {
  it.each([
    { tool: "flow-execute", args: { name: "inner", project_root: "/repo" } },
    { tool: "run-sequence", args: { steps: [{ tool: "gesture-tap", args: { x: 0.5, y: 0.5 } }] } },
  ])(
    "makes the gesture after `tool: $tool` pay for a settle of its own",
    async ({ tool, args }) => {
      currentTree = deadUntilTool(tool);
      await writeFlow(`tap-${tool}-tap`, {
        executionPrerequisite: "",
        steps: [
          { kind: "tap", x: 0.1, y: 0.1 },
          { kind: "tool", name: tool, args },
          { kind: "tap", x: 0.2, y: 0.2 },
        ],
      });

      const result = await run(`tap-${tool}-tap`);

      expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
        "tap:pass",
        "tool:pass",
        "tap:pass",
      ]);
      // Exactly the two identical reads a settle converges on. A verdict the
      // nested step left standing would leave the second tap with zero.
      expect(readsBetween(gestureAt(1), gestureAt(2))).toBe(2);
    },
    20_000
  );
});

// The memo is keyed to the device it was proven against: a dead source on the
// device a run has left says nothing about the one it moved onto (a chromium
// `launch` boots its own). `runLaunch` clears the verdict before the only
// mid-run move, so a real run only ever compares equal - these hand-built envs
// are the only place the mismatch is exercised.
describe("a proven outage is spent only on the device that proved it", () => {
  const proven = (deviceId: string): ActionEnv["treeOutage"] => ({
    proven: { deviceId, error: new Error("native devtools is unavailable") },
  });

  function envFor(treeOutage: ActionEnv["treeOutage"]): ActionEnv {
    return {
      registry: mockRegistry(),
      device: { id: DEVICE, platform: "ios" } as ActionEnv["device"],
      treeOutage,
    };
  }

  it("rethrows without reading when the same device proved it", async () => {
    await expect(settleTree(envFor(proven(DEVICE)), { skipProvenOutage: true })).rejects.toThrow(
      "native devtools is unavailable"
    );
    expect(events).toEqual([]);
  });

  it("reads anyway when another device proved it", async () => {
    const tree = await settleTree(envFor(proven("some-other-device")), {
      skipProvenOutage: true,
    });

    expect(tree).toBeDefined();
    expect(events.filter((e) => e.kind === "read").length).toBeGreaterThanOrEqual(2);
  });
});

// The settle's deadline is tested only after a read RETURNS, so the window
// bounds how many reads it issues - never how long it waits on one, and never
// below the SETTLE_MIN_READS floor. That is deliberate: budgeting the read to
// what is left of the window would put a 3s cap on
// `ViewHierarchy.getFullHierarchy`, which #778 raised to a 15s RPC tier
// precisely so an iOS cold-start stall is ridden out instead of failed. The
// abort in the block below is the one thing that does cut such a read short.
describe("the settle window bounds its retries, not the read in flight", () => {
  // One whole window (3000ms) plus the least margin that still tells "waited it
  // out" from "cut it off at the deadline". The window cannot be made cheaper,
  // so the margin is the only part of this test's cost there is to keep down.
  const SLOW_READ_MS = 3_500;

  it("waits out every read slower than the whole window", async () => {
    readDelayMs = SLOW_READ_MS;
    await writeFlow("tap-slow-read", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", x: 0.4, y: 0.6 }],
    });

    const startedAt = Date.now();
    const result = await run("tap-slow-read");
    const elapsed = Date.now() - startedAt;

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["tap:pass"]);
    // Two reads, neither cut short: the first answered past the deadline, and
    // the floor owes a second even though the window is spent. Reads cut off at
    // the deadline would leave that count identical - the elapsed time is what
    // separates the two, and it covers BOTH reads.
    expect(readsBeforeFirstGesture()).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(2 * SLOW_READ_MS);
    // The floor read is what the settle converges on here, and a read did come
    // back, so this is no outage and the step is not warned about one.
    expect(gestures()[0]).toMatchObject({ tool: "gesture-tap", args: { x: 0.4, y: 0.6 } });
    expect(result.steps[0].warning).toBeUndefined();
  }, 15_000);
});

// The settle is the only abort checkpoint `tap`/`long-press` have: nothing
// between it and the dispatch looks at the signal again, unlike `pinch`/`rotate`,
// which re-check before their own dispatch. flow-abort.test.ts pins this same
// moment on the selector path.
describe("a run cancelled inside the settle dispatches no coordinate gesture", () => {
  /** Trip the abort inside read 2, the read that would complete the settle. */
  function abortOnSettlingRead(controller: AbortController): void {
    let reads = 0;
    currentTree = () => {
      reads += 1;
      if (reads >= 2) controller.abort();
      return screen();
    };
  }

  it("skips a coordinate tap", async () => {
    const controller = new AbortController();
    abortOnSettlingRead(controller);
    await writeFlow("tap-cancelled", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", x: 0.4, y: 0.6 }],
    });

    const result = await run("tap-cancelled", controller.signal);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["tap:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
    expect(gestures()).toEqual([]);
  });

  it("skips a coordinate long-press", async () => {
    const controller = new AbortController();
    abortOnSettlingRead(controller);
    await writeFlow("press-cancelled", {
      executionPrerequisite: "",
      steps: [{ kind: "long-press", x: 0.2, y: 0.3 }],
    });

    const result = await run("press-cancelled", controller.signal);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["long-press:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
    expect(gestures()).toEqual([]);
  });

  // The outcome is what this pins, not a branch: `runPinch`'s own abort return
  // after the settle is not separable from the signal check its dispatch opens with.
  it("skips a centre-anchored pinch", async () => {
    const controller = new AbortController();
    abortOnSettlingRead(controller);
    await writeFlow("pinch-cancelled", {
      executionPrerequisite: "",
      steps: [{ kind: "pinch", scale: 0.5 }],
    });

    const result = await run("pinch-cancelled", controller.signal);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["pinch:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
    expect(gestures()).toEqual([]);
  });

  it("skips a coordinate tap while the settle's read is still in flight", async () => {
    // The read carries no budget of its own - deliberately, so a slow iOS cold
    // start is ridden out rather than failed - so the signal is the only thing
    // that ends this wait. A settle that waited for the source first would hold
    // the cancelled run for as long as the source takes to answer: on iOS the
    // 5s state probe plus the 15s hierarchy read, and here forever.
    hangReads = true;
    const controller = new AbortController();
    await writeFlow("tap-hung-read", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", x: 0.4, y: 0.6 }],
    });

    const running = run("tap-hung-read", controller.signal);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    const abortedAt = Date.now();
    controller.abort();
    const result = await running;

    expect(Date.now() - abortedAt).toBeLessThan(2_000);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["tap:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
    expect(gestures()).toEqual([]);
    // And the abandoned read was never retried behind the abort.
    expect(events).toHaveLength(1);
  }, 10_000);
});
