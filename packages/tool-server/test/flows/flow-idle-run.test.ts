import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry, ToolContext } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";
import type { PixelFrame } from "../../src/tools/flows/flow-pixels";

// The status-bar mask asks the iOS runtime whether this UDID is a tvOS
// simulator. These UDIDs are fabricated, so a real probe would shell out to
// `xcrun simctl list` on every step and answer "unknown" each time — pin it to
// the mobile answer the cases are written against.
vi.mock("../../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/ios-devices")>()),
  isTvOsSimulator: vi.fn(async () => false),
}));

// Serve the flow tree directly (see flow-when.test.ts) — `idle` polls it.
let currentTree: () => DescribeNode;
/** Simulates a tree source that is slow, or wedged when it exceeds the step. */
let treeDelayMs = 0;
/**
 * The degradation flags a reader attaches to a read it could not trust — an
 * unattached Vega toolkit, an iOS AX service that wants a relaunch. They ride
 * along with an EMPTY tree, which is what makes the read blind rather than an
 * observation that the screen drew nothing.
 */
let treeHint: string | undefined;
let treeShouldRestart: boolean | undefined;
vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn(async (): Promise<DescribeTreeData> => {
    // Pinned to the source this call started against, not to whatever the
    // module-level `currentTree` holds when the delay elapses. A read the
    // runner abandoned (`settleWithin` gives up; the underlying fetch does not)
    // resolves after its own step, and often after `beforeEach` has repointed
    // `currentTree` at the NEXT case — so an unpinned call reported an orphan
    // read into a case that never made it, moving where that case's blank read
    // landed and how many it saw.
    const source = currentTree;
    if (treeDelayMs > 0) await new Promise((r) => setTimeout(r, treeDelayMs));
    return {
      tree: source(),
      source: "native-devtools",
      screen: { width: 390, height: 844 },
      ...(treeHint === undefined ? {} : { hint: treeHint }),
      ...(treeShouldRestart === undefined ? {} : { should_restart: treeShouldRestart }),
    };
  }),
}));

// Stub only the capture; the real `comparePixels` decides whether two frames
// moved, so the comparison the check depends on is the one under test.
let currentFrame: () => PixelFrame | undefined;
/**
 * How long a capture takes to come back. A live backend is not instant, and a
 * round is `Promise.all([read, capture])` — so this, not the poll, is what a
 * round lasts once the capture is the slow half.
 */
let captureDelayMs = 0;
/** Every `firstCapture` flag the runner passed, in order. */
const captureFirstFlags: boolean[] = [];
vi.mock("../../src/tools/flows/flow-pixels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/flows/flow-pixels")>();
  return {
    ...actual,
    // Carries the same three inputs the real one has, so nothing the runner
    // hands it can go unexercised:
    //  - `deadline`, which it honours by returning undefined without capturing
    //    once the budget is gone. A stub that ignored it hid the case where the
    //    runner judges a screen on a round it had no time to observe, which is
    //    where a missing frame used to read as stillness.
    //  - the abort signal, which the real capture is abandoned on.
    //  - `firstCapture`, which buys a cold stream's first frame a wider bound
    //    and must be true exactly once per step.
    capturePixelsWithin: vi.fn(
      async (
        env: { signal?: AbortSignal },
        deadline: number,
        firstCapture: boolean
      ): Promise<PixelFrame | undefined> => {
        captureFirstFlags.push(firstCapture);
        if (env.signal?.aborted) return undefined;
        const budget = deadline - Date.now();
        if (budget <= 0) return undefined;
        if (captureDelayMs > 0) {
          // Bounded by what is left, the way `settleWithin` bounds the real
          // one, and abandoned rather than answered late if it outlasts that.
          await new Promise((r) => setTimeout(r, Math.min(captureDelayMs, budget)));
          if (captureDelayMs > budget || env.signal?.aborted) return undefined;
        }
        return currentFrame();
      }
    ),
  };
});

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
let tmpDir: string;

function n(partial: Partial<DescribeNode> & { frame: DescribeNode["frame"] }): DescribeNode {
  return { role: "AXOther", children: [], ...partial };
}

const FULL: DescribeNode["frame"] = { x: 0, y: 0, width: 1, height: 1 };

function screenWith(label: string): DescribeNode {
  return n({
    role: "AXWindow",
    frame: FULL,
    children: [n({ frame: { x: 0, y: 0, width: 1, height: 0.1 }, label })],
  });
}

/** A 10x10 frame filled with one grey level — a uniform "screen". */
function frameAt(level: number): PixelFrame {
  const data = Buffer.alloc(10 * 10 * 4, level);
  return { width: 10, height: 10, data };
}

/**
 * A capture-sized frame (180k pixels, the order a real one has at
 * CAPTURE_SCALE) that is still apart from `movingPixels` of it. Sized so a
 * spinner's share of a screen can be expressed at all: on the 10x10 frames
 * above, one pixel is already 1% of the screen.
 */
function frameWithMovingPixels(movingPixels: number, level: number): PixelFrame {
  const [width, height] = [300, 600];
  const data = Buffer.alloc(width * height * 4, 255);
  for (let i = 0; i < movingPixels; i++) {
    const o = (STATUS_BAR_ROWS * width + i) * 4;
    data[o] = level;
    data[o + 1] = level;
    data[o + 2] = level;
  }
  return { width, height, data };
}

/**
 * The first row of a 600-row frame the comparison actually looks at: the
 * comparator masks the top 6% on a device with a system status bar, so motion
 * a case means to be SEEN has to be placed below it. Frames that move
 * everywhere (frameAt) are unaffected, as is a 10-row one, where 6% floors to
 * no rows at all.
 */
const STATUS_BAR_ROWS = Math.floor(600 * 0.06);

function mockRegistry(): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "list-devices") return { devices: [] };
      if (id === "restart-app") return { restarted: true };
      return { ok: true };
    }),
    getTool: vi.fn(() => undefined),
    resolveService: vi.fn(async () => ({ isConnected: () => true })),
  } as unknown as Registry;
}

async function writeFlow(name: string, yaml: string): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.yaml`), yaml, "utf8");
}

async function run(name: string, signal?: AbortSignal): Promise<FlowRunResult> {
  const tool = createRunFlowTool(mockRegistry());
  const result = await tool.execute(
    {},
    { name, project_root: tmpDir, device: DEVICE },
    // Only the signal matters here; the runner does not touch the rest.
    signal ? ({ signal } as unknown as ToolContext) : undefined
  );
  if (!("steps" in result)) throw new Error("expected a run result");
  return result;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-idle-"));
  currentTree = () => screenWith("Home");
  currentFrame = () => frameAt(120);
  treeDelayMs = 0;
  treeHint = undefined;
  treeShouldRestart = undefined;
  captureDelayMs = 0;
  captureFirstFlags.length = 0;
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

// `await: { idle: true }` is the readiness check: it returns the moment the
// screen is still, so the next tap resolves against a screen that has stopped.
// It never fails a run — a screen that never settles passes with a warning,
// because readiness is not an acceptance criterion and a screen that keeps
// moving (a video, a shimmer, live-updating text on Android) is usually a
// property of the app. Only an unreadable window is a hard stop, as an error.
describe("await: { idle }", () => {
  it("passes once both the tree and the pixels hold still", async () => {
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, stableFor: 0 }
`
    );
    const r = await run("ready");
    expect(r.ok).toBe(true);
    expect(r.steps.at(-1)).toMatchObject({ kind: "idle", status: "pass" });
    // Both signals were available, so nothing about this pass is weakened.
    expect(r.steps.at(-1)!.warning).toBeUndefined();
  });

  // Stillness is a property of an interval, and one interval can alias (see
  // the reversing-animation case below), so `stableFor: 0` still means "the
  // first two agreeing intervals" — three reads — not "the first read".
  it("never settles on one read or one interval, even with no hold requested", async () => {
    let reads = 0;
    currentTree = () => {
      reads += 1;
      return screenWith("Home");
    };
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, stableFor: 0 }
`
    );
    expect((await run("ready")).ok).toBe(true);
    // Exactly three, pinned from both sides: two would settle on a single
    // agreeing pair (the aliasing case below), four would make every settle a
    // poll slower than it needs to be.
    expect(reads).toBe(3);
    // And only the first capture of the step may claim the cold-stream bound.
    expect(captureFirstFlags).toEqual([true, false, false]);
  });

  // `stableFor` is a clock, not a label: a screen that is still from the
  // first read must still be held for it before the step returns. Without that
  // the option means nothing, since three reads take about 400ms whatever it
  // is set to.
  it("holds a still screen for the whole requested hold before passing", async () => {
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 2500, stableFor: 800 }
`
    );
    const started = Date.now();
    const r = await run("ready");
    const elapsed = Date.now() - started;
    expect(r.steps.at(-1)).toMatchObject({ kind: "idle", status: "pass" });
    expect(r.steps.at(-1)!.warning).toBeUndefined();
    expect(elapsed).toBeGreaterThanOrEqual(750);
    expect(elapsed).toBeLessThan(2_400);
  });

  // The floor the parser enforces has to be one the runner can serve, or the
  // parser is rejecting steps that work. This is the smallest wait it allows
  // for an 800ms hold: the additive floor called it impossible and demanded
  // 1400ms, while the settle lands at ~820ms because the hold is counted
  // across the polls rather than after them.
  it("settles inside the smallest timeout the parser allows for the hold", async () => {
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 1000, stableFor: 800 }
  - echo: reached
`
    );
    const started = Date.now();
    const r = await run("ready");
    const elapsed = Date.now() - started;
    expect(r.ok).toBe(true);
    const step = r.steps.find((s) => s.kind === "idle")!;
    expect(step.status).toBe("pass");
    // A clean settle, not a step that ran out of budget and warned its way out.
    expect(step.warning).toBeUndefined();
    expect(elapsed).toBeGreaterThanOrEqual(750);
    expect(elapsed).toBeLessThan(1_000);
    expect(r.steps.at(-1)).toMatchObject({ kind: "echo", status: "pass" });
  });

  it("warns, and does not fail, when the tree never stops changing", async () => {
    let tick = 0;
    currentTree = () => screenWith(`frame ${tick++}`);
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 900, stableFor: 300 }
`
    );
    const r = await run("ready");
    expect(r.ok).toBe(true);
    const step = r.steps.at(-1)!;
    expect(step.status).toBe("pass");
    expect(step.warning).toContain("never held still");
    // The warning has to say what to do next, not merely that it gave up.
    expect(step.warning).toContain("stable element");
  });

  // The point of warning instead of failing: a screen that never stops moving
  // is usually the app working as built (a video, a shimmer, a carousel, or —
  // on Android, whose tree carries live text — a ticking timestamp). The run
  // has to reach the checks that actually carry its verdict.
  it("lets the rest of the flow run when the screen never settles", async () => {
    let tick = 0;
    currentTree = () => screenWith(`frame ${tick++}`);
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 900, stableFor: 300 }
  - echo: reached
`
    );
    const r = await run("ready");
    expect(r.ok).toBe(true);
    expect(r.failed).toBe(0);
    expect(r.errored).toBe(0);
    expect(r.steps.at(-1)).toMatchObject({ kind: "echo", status: "pass", message: "reached" });
  });

  // The reason this check reads pixels at all: an iOS push or modal dismissal
  // commits its hierarchy up front and then animates a layer for a few hundred
  // milliseconds. The tree is perfectly still the whole time.
  it("warns when the pixels keep moving under a motionless tree", async () => {
    let level = 0;
    currentFrame = () => frameAt((level += 60) % 240);
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 600, stableFor: 0 }
`
    );
    const r = await run("ready");
    expect(r.ok).toBe(true);
    const step = r.steps.at(-1)!;
    expect(step.status).toBe("pass");
    expect(step.warning).toContain("never held still");
  });

  // A spinner is the reason this warning exists. It is far too small to move
  // the screen (a stock one covers ~0.1% of a phone display) and it does not
  // move the tree either — it spins in a layer whose box never changes — so
  // both halves of the check call the screen settled while it is still
  // loading. The step still passes, because waiting out a caret or a spinner
  // that never stops is worse than saying so, but it must SAY so.
  it("warns when the screen settles with something small still moving on it", async () => {
    let tick = 0;
    // 40 of 180_000 pixels (0.022%) alternating: an order of magnitude under
    // the motion fraction, an order above the noise floor.
    currentFrame = () => frameWithMovingPixels(40, tick++ % 2 === 0 ? 0 : 40);
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, stableFor: 0 }
  - echo: reached
`
    );
    const r = await run("ready");
    expect(r.ok).toBe(true);
    const step = r.steps.at(-2)!;
    expect(step).toMatchObject({ kind: "idle", status: "pass" });
    expect(step.warning).toContain("small part of it was still changing");
    expect(step.warning).toContain("spinner");
    // The warning is about how the settle was reached, not a refusal to settle.
    expect(step.warning).not.toContain("never held still");
  });

  // The runner pins the status bar for the whole run, but the pin lands a few
  // hundred milliseconds AFTER the run starts and a nested `tool: flow-execute`
  // clears it for the rest of the outer run — so this step regularly compared a
  // real clock against a pinned one, or against a ticking one, and reported a
  // static screen as moving or as carrying a spinner. The band is masked.
  it("ignores the system status bar the run's own pin repaints", async () => {
    let tick = 0;
    // 400 pixels — over the motion budget for this frame — confined to the
    // masked band, which is where the measured clock repaint landed.
    currentFrame = () => {
      const level = tick++ % 2 === 0 ? 0 : 255;
      const [width, height] = [300, 600];
      const data = Buffer.alloc(width * height * 4, 255);
      for (let i = 0; i < 400; i++) {
        const o = (width + i) * 4; // row 1, inside the status bar
        data[o] = level;
        data[o + 1] = level;
        data[o + 2] = level;
      }
      return { width, height, data };
    };
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, stableFor: 0 }
`
    );
    const step = (await run("ready")).steps.at(-1)!;
    expect(step).toMatchObject({ kind: "idle", status: "pass" });
    expect(step.warning).toBeUndefined();
  });

  it("says nothing about small motion when the screen is genuinely still", async () => {
    currentFrame = () => frameWithMovingPixels(0, 0);
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, stableFor: 0 }
`
    );
    expect((await run("ready")).steps.at(-1)!.warning).toBeUndefined();
  });

  // Sub-threshold drift is encoder noise, not motion — treating it as motion
  // would make the check unsatisfiable on a screen that is genuinely at rest.
  it("tolerates capture noise below the motion threshold", async () => {
    let level = 120;
    currentFrame = () => frameAt((level += 1));
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 2000, stableFor: 0 }
`
    );
    const r = await run("ready");
    expect(r.ok).toBe(true);
    // `ok` alone would hold for every idle outcome but an unreadable tree, so
    // it says nothing about the threshold. What this case is about is that
    // +1 per channel settles CLEANLY: no motion warning, and none about a
    // spinner either — noise must not be reported as something small moving.
    const step = r.steps.at(-1)!;
    expect(step).toMatchObject({ kind: "idle", status: "pass" });
    expect(step.warning).toBeUndefined();
  });

  // A reversing animation — a cross-fade, a pulse, a bounce — has a turning
  // point, and two samples straddling it come back identical while the screen
  // is still moving. Measured on a live 3s cross-fade: a default-shaped step
  // passed on roughly one run in three until a second agreeing interval was
  // required. Here every other capture repeats its predecessor, so a
  // one-interval rule settles and a two-interval rule cannot.
  it("does not settle on a single agreeing pair of a reversing animation", async () => {
    let tick = 0;
    currentFrame = () => {
      // 0, 60, 60, 120, 120, 180, 180, … — one still interval, never two.
      const level = Math.floor((tick + 1) / 2) * 60;
      tick += 1;
      return frameAt(level % 240);
    };
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 1500, stableFor: 0 }
`
    );
    const r = await run("ready");
    expect(r.steps.at(-1)!.status).toBe("pass");
    expect(r.steps.at(-1)!.warning).toContain("never held still");
  });

  // `timeout:` is the author's answer to "how long may this take", so it has to
  // be the answer. No describe path takes an abort signal, so a wedged tree
  // source (a hung ViewInspector RPC, an adb that stopped answering) used to
  // run the round past the deadline — measured at 2.25s over an 8s budget on a
  // live simulator.
  it("honours its timeout even when the tree source stops answering", async () => {
    treeDelayMs = 5_000;
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 800, stableFor: 0 }
`
    );
    const started = Date.now();
    const r = await run("ready");
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(3_000);
    const step = r.steps.at(-1)!;
    expect(step.status).toBe("error");
    expect(step.reason).toContain("never answered within the step's 800ms");
    // Classified, or the assembler falls through to a post-hoc read against
    // the very source that just wedged — and hangs for as long as it likes.
    expect(step.failure).toMatchObject({
      code: "tree-source-unavailable",
      category: "environment",
      determinacy: "indeterminate",
    });
    expect(step.failure?.screen.state).toBe("unavailable");
  });

  // The sibling of the case above, and the one that used to slip through: a
  // source that FAILS is caught by the unreadable-tree error, but one that
  // HANGS is a different outcome internally, and after any earlier read had
  // succeeded it fell through to the motion warning — telling the author that
  // a screen frozen by a wedged renderer was a video or a carousel.
  it("reports a tree source that wedges mid-wait as indeterminate, not as motion", async () => {
    let reads = 0;
    currentTree = () => {
      reads += 1;
      // Answer the first read, then wedge for longer than the step can wait.
      treeDelayMs = 60_000;
      return screenWith("Home");
    };
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 2500, stableFor: 0 }
  - echo: reached
`
    );
    const r = await run("ready");
    expect(reads).toBe(1);
    expect(r.ok).toBe(false);
    const step = r.steps.find((s) => s.kind === "idle")!;
    expect(step.status).toBe("error");
    expect(step.reason).toContain("answered and then stopped");
    expect(step.reason).toContain("foreground");
    // And it must not be dressed up as a verdict about what was on screen.
    expect(step.reason).not.toContain("never held still");
    expect(step.failure).toMatchObject({
      code: "tree-source-unavailable",
      determinacy: "indeterminate",
    });
    // The screen slot is SUPPRESSED — the report must not chase a post-hoc
    // read of a source it has just declared wedged.
    expect(step.failure?.screen.state).toBe("unavailable");
  });

  // ...and the other side of that split. Every read here is abandoned at the
  // deadline, so how much budget one had is a fact about the step's arithmetic
  // rather than about the source: on its own it cannot tell a wedge from a
  // source that is merely slow. Taking it on its own hard-stopped a run on the
  // most settled screen there is — every read answering with the same tree —
  // whenever the closing round happened to start with 2s in hand.
  it("does not call a slow but answering source a wedged one", async () => {
    // 2300ms reads in a 4600ms wait: the first answers, the second is cut off
    // with 2100ms of budget — over the hung threshold, and under what this
    // source has already been seen to need.
    treeDelayMs = 2_300;
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 4600, stableFor: 0 }
  - echo: reached
`
    );
    const r = await run("ready");
    expect(r.ok).toBe(true);
    const step = r.steps.find((s) => s.kind === "idle")!;
    expect(step.status).toBe("pass");
    // Not the wedged-source verdict, in whichever field it would have landed.
    expect(`${step.reason ?? ""} ${step.warning ?? ""}`).not.toContain("answered and then stopped");
    // What it actually was: too few looks to judge the screen by.
    expect(step.warning).toContain("content on 1 read in 4600ms");
    expect(r.steps.at(-1)).toMatchObject({ kind: "echo", status: "pass" });
  });

  // A settle is three reads spanning two intervals. A step that got fewer has
  // no evidence either way, and both of the verdicts it used to reach for —
  // "the screen never stopped moving", "no screenshot could be read" — are
  // claims about an app nobody observed for long enough to make one.
  it("says it ran out of looks rather than judging a screen it barely read", async () => {
    treeDelayMs = 700; // two of these do not fit in the wait
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 1200 }
`
    );
    const step = (await run("ready")).steps.at(-1)!;
    expect(step.status).toBe("pass");
    expect(step.warning).toContain("content on 1 read in 1200ms");
    expect(step.warning).toContain("`timeout:`");
    // The screen was static the whole time; it must not be described as moving.
    expect(step.warning).not.toContain("never held still");
    expect(step.warning).not.toContain("no pair of screenshots");
  });

  // A blank read is an observation — it resets both holds — but it measures no
  // interval, so it is not one of the three a settle takes. Counting it let a
  // window blank for all but its last two reads slip past the guard above and
  // reach for the motion verdict instead, telling the author that "something on
  // it never stops" on the strength of one measured interval.
  it("does not count a blank read as a look at the screen", async () => {
    let reads = 0;
    // A 250ms read plus a 200ms poll fits three rounds in 1200ms; the first
    // comes back blank, so only one interval could ever be measured.
    treeDelayMs = 250;
    currentTree = () => (reads++ < 1 ? n({ role: "AXWindow", frame: FULL }) : screenWith("Home"));
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 1200, stableFor: 0 }
`
    );
    const step = (await run("ready")).steps.at(-1)!;
    expect(step.status).toBe("pass");
    expect(step.warning).toContain("content on 2 reads in 1200ms");
    expect(step.warning).not.toContain("never held still");
  });

  it("settles on the tree alone when no screenshot can be captured, and says so", async () => {
    currentFrame = () => undefined;
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 900, stableFor: 0 }
`
    );
    const r = await run("ready");
    expect(r.ok).toBe(true);
    const step = r.steps.at(-1)!;
    expect(step.status).toBe("pass");
    // The step has no target beyond the screen itself, and the renderer
    // already prints the kind — a target here would read "idle screen idle".
    expect(step.target).toBeUndefined();
    expect(step.warning).toContain("UI tree alone");
    // Attributed to the capture, not to the platform: on a device where
    // screenshots normally work this is a per-capture failure, not a property
    // of the OS.
    expect(step.warning).not.toContain("could not be captured on");
  });

  // The tree-only report is a claim that the HIERARCHY settled, so it owes the
  // same hold every other settle does. Every case that reaches it elsewhere
  // runs with `stableFor: 0`, where the hold term is vacuous — drop it and
  // the suite stays green while a tree that had only just stopped moving is
  // reported as having settled.
  it("does not report a tree-only settle when the hold was never served", async () => {
    currentFrame = () => undefined;
    // The tree keeps changing for the first 700ms, then holds. The last read
    // lands ~1200ms in, so the hierarchy has been still for well under the
    // 800ms hold, however many agreeing intervals it managed.
    const startedAt = Date.now();
    let churn = 0;
    currentTree = () => screenWith(Date.now() - startedAt < 700 ? `Loading ${churn++}` : "Settled");
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 1400, stableFor: 800 }
`
    );
    const step = (await run("ready")).steps.at(-1)!;
    expect(step.status).toBe("pass");
    expect(step.warning).not.toContain("UI tree alone");
    expect(step.warning).toContain(
      "never held still for 2 consecutive 200ms intervals spanning 800ms"
    );
  });

  // The localized flag describes the hold being REPORTED, so a hold that broke
  // has to clear it. Without the reset, a spinner that stopped — then a screen
  // that went still — still told the author something "kept changing the whole
  // time".
  it("forgets small motion that stopped before the settle that gets reported", async () => {
    // Round 1 has no predecessor; 2 moves a spinner's worth; 3 moves the whole
    // screen, breaking the hold; 4 and 5 are identical, which is the settle.
    const WHOLE_FRAME = 300 * 600;
    const frames = [
      frameWithMovingPixels(0, 0),
      frameWithMovingPixels(40, 0),
      frameWithMovingPixels(WHOLE_FRAME, 90),
      frameWithMovingPixels(WHOLE_FRAME, 90),
      frameWithMovingPixels(WHOLE_FRAME, 90),
    ];
    let i = 0;
    currentFrame = () => frames[Math.min(i++, frames.length - 1)];
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, stableFor: 0 }
`
    );
    const step = (await run("ready")).steps.at(-1)!;
    expect(step).toMatchObject({ kind: "idle", status: "pass" });
    expect(step.warning).toBeUndefined();
  });

  // A capture that goes missing used to cost the settle TWO intervals, not
  // one: the missing frame was also stored as the previous frame, so the next
  // round had nothing to compare against either. Holding the last good frame
  // asks the same question across the gap. The witness is the number of
  // captures the settle takes — rounds run in lockstep, so it is exact.
  it("loses only the interval a capture went missing in, not the one after it", async () => {
    let captures = 0;
    currentFrame = () => {
      captures += 1;
      return captures === 3 ? undefined : frameAt(120);
    };
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, stableFor: 0 }
`
    );
    const step = (await run("ready")).steps.at(-1)!;
    expect(step.status).toBe("pass");
    // 1,2 hold — one interval; 3 is missing, which measures no interval and
    // refutes none; 4 holds across the gap for the second, and settles. Five
    // would mean round 3's absence had cost the hold an interval it had
    // already measured, six that it had blinded round 4 as well.
    expect(captures).toBe(4);
    // And one missed capture out of four is not "no screenshot could be read".
    expect(step.warning).toBeUndefined();
  });

  // A missing frame is the absence of an observation, exactly as an abandoned
  // tree read is — and the loop says so about the read a few lines up. Letting
  // it DESTROY the combined hold instead meant a backend that merely drops a
  // frame now and then could serve no hold longer than the gap between drops:
  // the step burned its whole timeout on a screen that never moved, and then
  // reported that the screen "could not be screenshotted on enough polls to
  // compare a pair of them" on a run where two captures in three arrived and
  // every compared pair read still.
  it("rides over a dropped capture instead of restarting the hold", async () => {
    let captures = 0;
    currentFrame = () => (++captures % 3 === 0 ? undefined : frameAt(120));
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, stableFor: 900, timeout: 6000 }
`
    );
    const started = Date.now();
    const step = (await run("ready")).steps.at(-1)!;
    const elapsed = Date.now() - started;
    expect(step.status).toBe("pass");
    // Every pair that was compared read still, so nothing about this pass is
    // weakened — and it is a settle, not a step that ran out of budget.
    expect(step.warning).toBeUndefined();
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(3_000);
    // Captures did go missing; the point is that they cost only their own
    // interval.
    expect(captures).toBeGreaterThan(3);
    // Room for the pre-fix behaviour — burning the whole 6000ms wait — to be
    // reported as the failed assertion it is rather than as a harness timeout.
  }, 15_000);

  // The other half of that, and the reason a missing frame is never simply
  // waved through: it is the ABSENCE of visual evidence, and treating it as
  // evidence of stillness is how a moving screen used to pass — the round that
  // outran the deadline skipped its capture, and the skip stood in for "the
  // pixels held". Riding over one costs the hold nothing, but it can never
  // MEASURE an interval either.
  it("never lets a missing capture stand in for stillness while the pixels move", async () => {
    let level = 0;
    currentFrame = () => frameAt((level += 60) % 240);
    await writeFlow(
      "ready",
      // A default-shaped step, whose last poll round routinely starts with no
      // capture budget left.
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 1200 }
`
    );
    const r = await run("ready");
    // Passing is fine; claiming the screen SETTLED is not — the warning must
    // still report the motion, not the tree-only settle.
    expect(r.steps.at(-1)!.warning).toContain("never held still");
    expect(r.steps.at(-1)!.warning).not.toContain("UI tree alone");
  });

  // A settle needs an interval COUNT as well as a duration, and the count is
  // the term a short wait usually misses. Naming only the duration reported a
  // screen the run had watched go still as one that never held still — and at
  // `stableFor: 0` it read "never held still for 0ms", a hold nothing can fail
  // — then sent the author looking for a video or a carousel.
  it("names the interval it fell short of, not a hold the screen did serve", async () => {
    let reads = 0;
    // Moving for the first four reads, then identical: one still interval,
    // where a settle takes two. The 0ms hold is satisfied the instant that
    // pair agrees.
    currentTree = () => {
      reads += 1;
      return screenWith(reads <= 4 ? `frame ${reads}` : "Settled");
    };
    let frames = 0;
    currentFrame = () => {
      frames += 1;
      return frameAt(frames <= 4 ? frames * 40 : 200);
    };
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, stableFor: 0, timeout: 1100 }
`
    );
    const step = (await run("ready")).steps.at(-1)!;
    expect(step.status).toBe("pass");
    expect(step.warning).not.toContain("never held still");
    // What it did achieve, and the term it was short of.
    expect(step.warning).toContain("still for the last");
    expect(step.warning).toContain("1 200ms interval");
    expect(step.warning).toContain("2 consecutive ones");
    // The repair is the wait, not the app: nothing here is evidence of a video.
    expect(step.warning).toContain("`timeout:`");
    expect(step.warning).not.toContain("a video");
  });

  // The default hold is what nearly every step runs with, so it is worth
  // pinning somewhere the number is actually used rather than only in a parser
  // message.
  it("holds for 250ms by default", async () => {
    let tick = 0;
    currentTree = () => screenWith(`frame ${tick++}`);
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 900 }
`
    );
    expect((await run("ready")).steps.at(-1)!.warning).toContain(
      "never held still for 2 consecutive 200ms intervals spanning 250ms within 900ms"
    );
  });

  // A tree source that never answers at all: no read succeeded, so there is
  // nothing to reason from and the advice is about the window, not the app.
  // The existing mid-wait case lets the first read land, so this branch — the
  // one that produces the foreground advice from a standing start — was never
  // taken.
  it("reports a tree source that never answered as unreadable, naming the underlying error", async () => {
    currentTree = () => {
      throw new Error("native-devtools is not connected");
    };
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 900, stableFor: 0 }
  - echo: unreachable
`
    );
    const r = await run("ready");
    expect(r.ok).toBe(false);
    const step = r.steps.find((s) => s.kind === "idle")!;
    expect(step.status).toBe("error");
    expect(step.reason).toContain("could not read the UI tree");
    expect(step.reason).toContain("foreground");
    expect(step.reason).toContain("native-devtools is not connected");
    // The underlying error survives into the payload as `screen.detail`: it is
    // the ONLY statement of why the step failed, and the classified code is
    // what stops the assembler reading the source that just threw.
    expect(step.failure).toMatchObject({
      code: "tree-source-unavailable",
      category: "environment",
      determinacy: "indeterminate",
    });
    expect(step.failure?.screen).toMatchObject({
      state: "unavailable",
      detail: expect.stringContaining("native-devtools is not connected"),
    });
    // An indeterminate readiness check stops the run rather than recording a
    // regression the app never had.
    expect(r.steps.at(-1)!.status).toBe("skip");
  });

  // A blip mid-settle is expected — the hold restarts from the next good read
  // rather than the step giving up or carrying its pre-blip state across.
  it("restarts the hold after a failed read, and still settles", async () => {
    let reads = 0;
    currentTree = () => {
      reads += 1;
      if (reads === 2) throw new Error("transient describe failure");
      return screenWith("Home");
    };
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, stableFor: 0 }
`
    );
    const step = (await run("ready")).steps.at(-1)!;
    expect(step.status).toBe("pass");
    expect(step.warning).toBeUndefined();
    // 1 ok, 2 failed, 3 is a fresh start (nothing to compare against), 4 and 5
    // are the two agreeing intervals. Three would mean the blip was ignored.
    expect(reads).toBe(5);
  });

  // A blip on the read that ENDS the step is still a blip. Which poll it lands
  // on used to decide the whole verdict: one poll earlier it restarted the hold
  // and the step passed with a warning, on the last poll it stopped the run and
  // skipped every later step. So a screen this check is explicit about wanting
  // to pass — a video, a shimmer, a carousel, live-updating text — turned a run
  // red on timing luck alone.
  it("does not stop the run when only the read that ended the wait failed", async () => {
    let firstReadAt: number | undefined;
    let tick = 0;
    // Never settles, so the step always exits through the bottom of the loop
    // and its last read is the one that decides. Measured from the first read
    // rather than from the run, the threshold sits midway between the closing
    // two rounds of a 900ms step (600ms and 800ms in), so only the last throws.
    currentTree = () => {
      firstReadAt ??= Date.now();
      if (Date.now() - firstReadAt >= 700) throw new Error("transient describe failure");
      return screenWith(`frame ${tick++}`);
    };
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 900, stableFor: 0 }
  - echo: reached
`
    );
    const r = await run("ready");
    expect(r.ok).toBe(true);
    const step = r.steps.find((s) => s.kind === "idle")!;
    expect(step.status).toBe("pass");
    expect(step.warning).toContain("never held still");
    // Tolerated, not swallowed: the read that failed is still named.
    expect(step.warning).toContain("transient describe failure");
    // And the checks that actually carry the flow's verdict still run.
    expect(r.steps.at(-1)).toMatchObject({ kind: "echo", status: "pass" });
  });

  // ...and it stays a blip when the round runs longer than a poll. The tail
  // between the last read that answered and the end of the wait is
  // `sleep + max(read, capture)`, and nothing holds either half to a poll: a
  // capture gets seconds of its own. Measuring the tolerance in milliseconds
  // therefore expired it on any slow-but-working capture backend, which put the
  // verdict back on where the blip landed — the exact thing the tolerance
  // exists to remove. It is counted in rounds for that reason.
  it("does not stop the run when the closing read failed and captures are slow", async () => {
    captureDelayMs = 300; // > IDLE_POLL_MS, so the round outlasts the poll
    let firstReadAt: number | undefined;
    let tick = 0;
    // Never settles. With a 300ms capture the rounds start every ~500ms, so of
    // the five that fit in 2400ms only the last (t≈2000) is past the threshold.
    currentTree = () => {
      firstReadAt ??= Date.now();
      if (Date.now() - firstReadAt >= 1750) throw new Error("transient describe failure");
      return screenWith(`frame ${tick++}`);
    };
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 2400, stableFor: 0 }
  - echo: reached
`
    );
    const r = await run("ready");
    expect(r.ok).toBe(true);
    const step = r.steps.find((s) => s.kind === "idle")!;
    expect(step.status).toBe("pass");
    expect(step.warning).toContain("never held still");
    expect(step.warning).toContain("transient describe failure");
    expect(r.steps.at(-1)).toMatchObject({ kind: "echo", status: "pass" });
  });

  // The other side of that bound: a slow round does not buy a second failing
  // read the same tolerance. Two consecutive dark reads are the window this
  // step cannot describe, however long the rounds that carried them took.
  it("still errors when two consecutive reads failed, however slow the captures", async () => {
    captureDelayMs = 300;
    let firstReadAt: number | undefined;
    let tick = 0;
    // Threshold one round earlier than the case above, so the last two reads
    // (t≈1500 and t≈2000) both throw.
    currentTree = () => {
      firstReadAt ??= Date.now();
      if (Date.now() - firstReadAt >= 1250) throw new Error("native-devtools is not connected");
      return screenWith(`frame ${tick++}`);
    };
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 2400, stableFor: 0 }
  - echo: unreachable
`
    );
    const r = await run("ready");
    expect(r.ok).toBe(false);
    const step = r.steps.find((s) => s.kind === "idle")!;
    expect(step.status).toBe("error");
    expect(step.reason).toContain("could not read the UI tree");
    expect(r.steps.at(-1)!.status).toBe("skip");
  });

  // The dark tail is a CONSECUTIVE count, and that is what makes a blip a
  // blip: the run of unanswered rounds at the END of the wait is the window
  // the step cannot describe. Without the reset on a read that answers,
  // `darkReads` becomes a total for the whole step, so two blips that were
  // never consecutive — the case this design exists to ride out — sum past the
  // tolerance and turn a passing step into a run-stopping error.
  it("counts the dark tail from the last read that answered, not over the whole step", async () => {
    let reads = 0;
    currentTree = () => {
      reads += 1;
      // Fail on 2 and 4, answer on 1 and 3: two blips, never consecutive.
      if (reads % 2 === 0) throw new Error("transient describe failure");
      return screenWith("Home");
    };
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 700, stableFor: 0 }
  - echo: reached
`
    );
    const r = await run("ready");
    // Four rounds fit, so the wait ends on the second blip — the position that
    // makes the tail one read long and the step total two.
    expect(reads).toBe(4);
    expect(r.ok).toBe(true);
    const step = r.steps.find((s) => s.kind === "idle")!;
    expect(step.status).toBe("pass");
    // Tolerated, not swallowed.
    expect(step.warning).toContain("transient describe failure");
    expect(r.steps.at(-1)).toMatchObject({ kind: "echo", status: "pass" });
  });

  // What makes a window unreadable is the dark tail, not the flavour of the
  // last read in it. A closing round that simply ran out of budget ends as a
  // `timeout` however dead the source is, and keying the guard on `error`
  // discarded the whole tail with it — the dark rounds, the error, and the note
  // that names it — so a source that had stopped answering passed silently
  // whenever the deadline happened to land inside one read's latency.
  it.each([1500, 1700])(
    "errors on a dead source whichever way the closing round of a %sms wait ends",
    async (timeout) => {
      treeDelayMs = 150;
      let reads = 0;
      currentTree = () => {
        reads += 1;
        if (reads > 2) throw new Error("native-devtools is not connected");
        return screenWith("Home");
      };
      await writeFlow(
        "ready",
        `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: ${timeout}, stableFor: 0 }
  - echo: unreachable
`
      );
      const r = await run("ready");
      expect(r.ok).toBe(false);
      const step = r.steps.find((s) => s.kind === "idle")!;
      expect(step.status).toBe("error");
      // The failure is named either way, rather than dropped with the tail.
      expect(step.reason).toContain("native-devtools is not connected");
      expect(r.steps.at(-1)!.status).toBe("skip");
    }
  );

  // The same blip against the other window it used to redden: a screen that
  // read back empty throughout is an observation about the app, and a transient
  // on the closing read does not turn it into a window nobody could see.
  it("still reports an empty screen as empty when the closing read failed", async () => {
    let firstReadAt: number | undefined;
    currentTree = () => {
      firstReadAt ??= Date.now();
      if (Date.now() - firstReadAt >= 700) throw new Error("transient describe failure");
      return n({ role: "AXWindow", frame: FULL, children: [] });
    };
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 900, stableFor: 0 }
`
    );
    const step = (await run("ready")).steps.at(-1)!;
    expect(step.status).toBe("pass");
    expect(step.warning).toContain("never rendered content");
    expect(step.warning).toContain("transient describe failure");
  });

  // The same for a screen that goes blank in the middle: an observation that
  // resets both holds, not a gap and not a reason to give up.
  it("restarts the hold after the screen goes blank, and still settles", async () => {
    let reads = 0;
    currentTree = () => {
      reads += 1;
      return reads === 2 ? n({ role: "AXWindow", frame: FULL, children: [] }) : screenWith("Home");
    };
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, stableFor: 0 }
`
    );
    const step = (await run("ready")).steps.at(-1)!;
    expect(step.status).toBe("pass");
    expect(step.warning).toBeUndefined();
    expect(reads).toBe(5);
  });

  // Cancelling a run is not a verdict about the screen. The check has to stop
  // promptly and report a skip, never a pass, a warning or an error.
  // An empty tree that arrives with a relaunch hint is the reader saying it
  // could not see the app — not the app saying it drew nothing. Scoring it as
  // an observation produced a verdict about the author's screen ("this is
  // where it did not render content") from a window that was never readable,
  // and pointed them away from the toolkit that never attached. The selector
  // conditions have refused to read such a tree since they were written.
  it("does not draw a verdict about the screen from a degraded empty read", async () => {
    currentTree = () => n({ role: "AXWindow", frame: FULL, children: [] });
    treeHint = "the automation toolkit is not attached — relaunch the app so it can attach";
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 1200, stableFor: 0 }
  - echo: unreachable
`
    );
    const r = await run("ready");
    expect(r.ok).toBe(false);
    const step = r.steps.find((s) => s.kind === "idle")!;
    expect(step.status).toBe("error");
    // The window, named as the window — and the reader's own repair with it.
    expect(step.reason).toContain("empty and degraded");
    expect(step.reason).toContain("automation toolkit is not attached");
    expect(step.reason).not.toContain("never rendered content");
    // The reader's own repair reaches the structured payload too, and the
    // screen slot stays suppressed: an empty tree is not "the app was blank".
    expect(step.failure).toMatchObject({
      code: "tree-source-unavailable",
      category: "environment",
      determinacy: "indeterminate",
    });
    expect(step.failure?.hint).toContain("automation toolkit is not attached");
    expect(step.failure?.screen.state).toBe("unavailable");
    expect(r.steps.at(-1)!.status).toBe("skip");
  });

  // `should_restart` is the same claim without a sentence attached.
  it("treats a should_restart empty read as degraded too", async () => {
    currentTree = () => n({ role: "AXWindow", frame: FULL, children: [] });
    treeShouldRestart = true;
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 1200, stableFor: 0 }
`
    );
    const step = (await run("ready")).steps.at(-1)!;
    expect(step.status).toBe("error");
    expect(step.reason).toContain("empty and degraded");
  });

  // A degraded tail survives a closing round that merely ran out of budget,
  // for the same reason a failing one does: the round that ends the wait is
  // abandoned whenever the read outlasts the budget it was allowed to start
  // with, and that says nothing about the source. `should_restart` is the
  // spelling that arrives with no hint attached, so the tail cannot be
  // recognised from the message alone.
  it("keeps a degraded tail when the closing round runs out of budget", async () => {
    treeDelayMs = 150;
    // Set up front rather than from inside the source: a read the runner
    // abandons still resolves later, and mutating shared state from there
    // reports this case's degradation into the next one.  Harmless on the
    // reads that carry a tree — only an EMPTY one is blind.
    treeShouldRestart = true;
    let reads = 0;
    currentTree = () => {
      reads += 1;
      return reads > 2 ? n({ role: "AXWindow", frame: FULL, children: [] }) : screenWith("Home");
    };
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 1500, stableFor: 0 }
  - echo: unreachable
`
    );
    const r = await run("ready");
    expect(r.ok).toBe(false);
    const step = r.steps.find((s) => s.kind === "idle")!;
    expect(step.status).toBe("error");
    expect(step.reason).toContain("empty and degraded");
    expect(r.steps.at(-1)!.status).toBe("skip");
  });

  // ...and the guard must not swallow the ordinary blank screen it sits next
  // to. An empty tree with nothing attached to it IS an observation: the app
  // rendered no accessible content, which is a warning and not a stop.
  it("still reports an undegraded empty screen as an empty screen", async () => {
    currentTree = () => n({ role: "AXWindow", frame: FULL, children: [] });
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 1200, stableFor: 0 }
  - echo: reached
`
    );
    const r = await run("ready");
    expect(r.ok).toBe(true);
    const step = r.steps.find((s) => s.kind === "idle")!;
    expect(step.status).toBe("pass");
    expect(step.warning).toContain("the UI tree stayed empty");
    expect(r.steps.at(-1)).toMatchObject({ kind: "echo", status: "pass" });
  });

  it("stops on abort without judging the screen", async () => {
    let tick = 0;
    currentTree = () => screenWith(`frame ${tick++}`); // never settles
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 7500 }
  - echo: unreachable
`
    );
    const started = Date.now();
    const r = await run("ready", controller.signal);
    expect(Date.now() - started).toBeLessThan(3_000);
    const step = r.steps.find((s) => s.kind === "idle")!;
    expect(step.status).toBe("skip");
    expect(step.reason).toContain("aborted");
    expect(step.warning).toBeUndefined();
  });

  // One good read early does not license an app verdict drawn from a window
  // that went dark afterwards: a backgrounded app or a dropped instrumentation
  // session reads as "unknown", never as "still animating".
  it("reports a tree source that dies mid-wait as indeterminate, not as motion", async () => {
    let reads = 0;
    currentTree = () => {
      reads += 1;
      if (reads > 1) throw new Error("native-devtools is not connected");
      return screenWith("Home");
    };
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 700, stableFor: 0 }
`
    );
    const r = await run("ready");
    expect(r.ok).toBe(false);
    const step = r.steps.at(-1)!;
    // `indeterminate` is scored `error`, which is what stops a QA run rather
    // than recording a regression the app never had.
    expect(step.status).toBe("error");
    expect(step.reason).toContain("could not read the UI tree");
    expect(step.reason).toContain("foreground");
  });

  // H1: a screen that settles and then moves again has NOT settled. The
  // tree-only verdict used to be a write-once latch, so an early quiet stretch
  // licensed a pass drawn from a window that spent the rest of its time
  // churning — which is precisely the regression this step exists to catch.
  it("does not pass on a screen that settled early and then started moving again", async () => {
    currentFrame = () => undefined; // force the tree-only path
    let reads = 0;
    currentTree = () => {
      reads += 1;
      return reads <= 4 ? screenWith("Home") : screenWith(`churn ${reads}`);
    };
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 2500, stableFor: 0 }
`
    );
    const r = await run("ready");
    expect(r.steps.at(-1)!.warning).toContain("never held still");
  });

  // H2: the same latch let a screen that had gone BLANK by the deadline report
  // ready. A blank tree is an observation, not a gap — it clears the verdict.
  it("does not pass on a screen that settled early and then went blank", async () => {
    currentFrame = () => undefined;
    let reads = 0;
    currentTree = () => {
      reads += 1;
      return reads <= 4 ? screenWith("Home") : n({ role: "AXWindow", frame: FULL, children: [] });
    };
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 2500, stableFor: 0 }
`
    );
    expect((await run("ready")).steps.at(-1)!.warning).toContain("never held still");
  });

  // H3: bounding the tree read by the remaining budget made the LAST read
  // time out on every run, which turned every honest timeout into an
  // environment `error` — deleting the hard-fail that justifies this step over
  // the soft `await-screen-idle` tool. A round is not started without a budget
  // to observe it with, and a read that ran out of step budget is the step
  // ending, not the source failing.
  it("still warns, rather than erroring, when a slow tree source keeps changing", async () => {
    // 300ms per read against a 200ms tail budget: the LAST read runs out of
    // step budget, which is the step ending, not the source failing. Earlier
    // reads landed and saw a moving screen, so the verdict is theirs — and the
    // budget the last read was given is what separates this from a source that
    // wedged (see the case above).
    treeDelayMs = 300;
    let tick = 0;
    currentTree = () => screenWith(`frame ${tick++}`);
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 2000, stableFor: 0 }
`
    );
    const r = await run("ready");
    expect(r.steps.at(-1)!.status).toBe("pass");
    expect(r.steps.at(-1)!.warning).toContain("never held still");
  });

  // A step whose budget is spent mid-settle must not invent a verdict out of
  // what it did not manage to observe. It has three ways to do that — blaming
  // the capture, blaming motion, or claiming a settle — so this pins the
  // outcome exactly rather than ruling one wording out.
  it("reaches a real settle rather than a verdict about the budget that ran out", async () => {
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 1600, stableFor: 900 }
`
    );
    const r = await run("ready");
    const step = r.steps.at(-1)!;
    // A still screen and a working capture path: the only honest outcome is a
    // clean settle, reached before the hold could exhaust the wait.
    expect(step.status).toBe("pass");
    expect(step.warning).toBeUndefined();
  });

  // A tree that reads back fine and is empty is an observation about the app,
  // not a window that could not be read — so it warns like any other screen
  // that did not settle, and the flow goes on to the checks that carry its
  // verdict. Stopping there used to take every later step with it, including
  // the element check that would have named what was actually wrong.
  it("distinguishes a screen that never rendered from one that never settled", async () => {
    currentTree = () => n({ role: "AXWindow", frame: FULL, children: [] });
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 900 }
  - echo: reached
`
    );
    const r = await run("ready");
    expect(r.ok).toBe(true);
    expect(r.errored).toBe(0);
    const step = r.steps.find((s) => s.kind === "idle")!;
    expect(step.status).toBe("pass");
    expect(step.warning).toContain("never rendered content");
    expect(step.warning).not.toContain("never held still");
    expect(r.steps.at(-1)).toMatchObject({ kind: "echo", status: "pass" });
  });
});
