import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";
import type { PixelFrame } from "../../src/tools/flows/flow-pixels";

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

// Stub only the capture; the real `pixelsDiffer` decides whether two frames
// moved, so the comparison the check depends on is the one under test.
let currentFrame: () => PixelFrame | undefined;
vi.mock("../../src/tools/flows/flow-pixels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/flows/flow-pixels")>();
  return {
    ...actual,
    // Honours `deadline` exactly as the real one does — it returns undefined
    // without capturing once the budget is gone. A stub that ignored it hid
    // the case where the runner judges a screen on a round it had no time to
    // observe, which is where a missing frame used to read as stillness.
    capturePixelsWithin: vi.fn(
      async (_env: unknown, deadline: number): Promise<PixelFrame | undefined> =>
        Date.now() >= deadline ? undefined : currentFrame()
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
    data[i * 4] = level;
    data[i * 4 + 1] = level;
    data[i * 4 + 2] = level;
  }
  return { width, height, data };
}

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

async function run(name: string): Promise<FlowRunResult> {
  const tool = createRunFlowTool(mockRegistry());
  const result = await tool.execute({}, { name, project_root: tmpDir, device: DEVICE }, undefined);
  if (!("steps" in result)) throw new Error("expected a run result");
  return result;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-idle-"));
  currentTree = () => screenWith("Home");
  currentFrame = () => frameAt(120);
  treeDelayMs = 0;
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
    expect(reads).toBeGreaterThanOrEqual(3);
  });

  it("warns, and does not fail, when the tree never stops changing", async () => {
    let tick = 0;
    currentTree = () => screenWith(`frame ${tick++}`);
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 600, minStableMs: 300 }
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
  - await: { idle: true, timeout: 600, minStableMs: 300 }
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
    expect(step.warning).toContain("small part of it kept changing");
    expect(step.warning).toContain("spinner");
    // The warning is about how the settle was reached, not a refusal to settle.
    expect(step.warning).not.toContain("never held still");
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
    expect((await run("ready")).ok).toBe(true);
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
    expect(step.warning).toContain("UI tree alone");
    // Attributed to the capture, not to the platform: on a device where
    // screenshots normally work this is a per-capture failure, not a property
    // of the OS.
    expect(step.warning).not.toContain("could not be captured on");
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
    // reads landed and saw a moving screen, so the verdict is theirs.
    treeDelayMs = 300;
    let tick = 0;
    currentTree = () => screenWith(`frame ${tick++}`);
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 1200, minStableMs: 0 }
`
    );
    const r = await run("ready");
    expect(r.steps.at(-1)!.status).toBe("pass");
    expect(r.steps.at(-1)!.warning).toContain("never held still");
  });

  // M1: the final round used to begin with no budget left, so its capture was
  // skipped — and that skip was recorded as "this device cannot be
  // screenshotted", warning about a capture path that had worked every round.
  it("does not blame the capture when only the step's budget ran out", async () => {
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 1000, minStableMs: 900 }
`
    );
    const r = await run("ready");
    const step = r.steps.at(-1)!;
    // Whatever the verdict, it must not claim the screen could not be captured.
    expect(step.warning ?? "").not.toContain("no screenshot");
  });

  it("distinguishes a screen that never rendered from one that never settled", async () => {
    currentTree = () => n({ role: "AXWindow", frame: FULL, children: [] });
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 500 }
`
    );
    const r = await run("ready");
    expect(r.steps.at(-1)!.status).toBe("error");
    expect(r.steps.at(-1)!.reason).toContain("never rendered content");
  });
});
