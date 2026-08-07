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
vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn(async (): Promise<DescribeTreeData> => {
    if (treeDelayMs > 0) await new Promise((r) => setTimeout(r, treeDelayMs));
    return {
      tree: currentTree(),
      source: "native-devtools",
      screen: { width: 390, height: 844 },
    };
  }),
}));

// Stub only the capture; the real `comparePixels` decides whether two frames
// moved, so the comparison the check depends on is the one under test.
let currentFrame: () => PixelFrame | undefined;
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
        return Date.now() >= deadline ? undefined : currentFrame();
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
  - await: { idle: true, minStableMs: 0 }
`
    );
    const r = await run("ready");
    expect(r.ok).toBe(true);
    expect(r.steps.at(-1)).toMatchObject({ kind: "idle", status: "pass" });
    // Both signals were available, so nothing about this pass is weakened.
    expect(r.steps.at(-1)!.warning).toBeUndefined();
  });

  // Stillness is a property of an interval, and one interval can alias (see
  // the reversing-animation case below), so `minStableMs: 0` still means "the
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
  - await: { idle: true, minStableMs: 0 }
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

  // `minStableMs` is a clock, not a label: a screen that is still from the
  // first read must still be held for it before the step returns. Without that
  // the option means nothing, since three reads take about 400ms whatever it
  // is set to.
  it("holds a still screen for the whole requested hold before passing", async () => {
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 2500, minStableMs: 800 }
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

  it("warns, and does not fail, when the tree never stops changing", async () => {
    let tick = 0;
    currentTree = () => screenWith(`frame ${tick++}`);
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 900, minStableMs: 300 }
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
  - await: { idle: true, timeout: 900, minStableMs: 300 }
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
  - await: { idle: true, timeout: 600, minStableMs: 0 }
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
  - await: { idle: true, minStableMs: 0 }
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
  - await: { idle: true, minStableMs: 0 }
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
  - await: { idle: true, minStableMs: 0 }
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
  - await: { idle: true, timeout: 2000, minStableMs: 0 }
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
  - await: { idle: true, timeout: 1500, minStableMs: 0 }
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
  - await: { idle: true, timeout: 800, minStableMs: 0 }
`
    );
    const started = Date.now();
    const r = await run("ready");
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(3_000);
    const step = r.steps.at(-1)!;
    expect(step.status).toBe("error");
    expect(step.reason).toContain("never answered within the step's 800ms");
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
  - await: { idle: true, timeout: 2500, minStableMs: 0 }
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
  - await: { idle: true, timeout: 1200, minStableMs: 0 }
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
  - await: { idle: true, timeout: 900, minStableMs: 0 }
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
  // runs with `minStableMs: 0`, where the hold term is vacuous — drop it and
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
  - await: { idle: true, timeout: 1400, minStableMs: 800 }
`
    );
    const step = (await run("ready")).steps.at(-1)!;
    expect(step.status).toBe("pass");
    expect(step.warning).not.toContain("UI tree alone");
    expect(step.warning).toContain("never held still for 800ms");
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
  - await: { idle: true, minStableMs: 0 }
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
  - await: { idle: true, minStableMs: 0 }
`
    );
    const step = (await run("ready")).steps.at(-1)!;
    expect(step.status).toBe("pass");
    // 1,2 hold; 3 is missing; 4 and 5 hold across the gap and settle. Six would
    // mean round 4 was blinded by round 3's absence.
    expect(captures).toBe(5);
    // And one missed capture out of five is not "no screenshot could be read".
    expect(step.warning).toBeUndefined();
  });

  // A capture that goes missing is the ABSENCE of visual evidence. Treating it
  // as evidence of stillness is how a moving screen used to pass: the round
  // that outran the deadline skipped its capture, and the skip stood in for
  // "the pixels held".
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
      "never held still for 250ms within 900ms"
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
  - await: { idle: true, timeout: 900, minStableMs: 0 }
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
  - await: { idle: true, minStableMs: 0 }
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
  - await: { idle: true, timeout: 900, minStableMs: 0 }
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
  - await: { idle: true, timeout: 900, minStableMs: 0 }
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
  - await: { idle: true, minStableMs: 0 }
`
    );
    const step = (await run("ready")).steps.at(-1)!;
    expect(step.status).toBe("pass");
    expect(step.warning).toBeUndefined();
    expect(reads).toBe(5);
  });

  // Cancelling a run is not a verdict about the screen. The check has to stop
  // promptly and report a skip, never a pass, a warning or an error.
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
  - await: { idle: true, timeout: 700, minStableMs: 0 }
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
  - await: { idle: true, timeout: 2500, minStableMs: 0 }
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
  - await: { idle: true, timeout: 2500, minStableMs: 0 }
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
  - await: { idle: true, timeout: 2000, minStableMs: 0 }
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
  - await: { idle: true, timeout: 1600, minStableMs: 900 }
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
