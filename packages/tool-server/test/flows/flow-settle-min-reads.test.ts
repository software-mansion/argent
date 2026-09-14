import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type {
  DescribeFrame,
  DescribeNode,
  DescribeTreeData,
} from "../../src/tools/describe/contract";

// Reads are driven per attempt, so a test can make the FIRST one answer slowly —
// the shape that matters here. A tree RPC allows itself ~5s, more than the 3s
// settle window, so one such read used to be the only read a settle ever took:
// the "every read failed" throw fired on a single transient blip, and a read
// that came back was returned having been compared against nothing.
let reads = 0;
let onRead: (attempt: number) => Promise<DescribeTreeData>;
vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn(async (): Promise<DescribeTreeData> => {
    reads += 1;
    return onRead(reads);
  }),
}));

import { SETTLE_TIMEOUT_MS } from "../../src/tools/flows/flow-actions";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
// Outlasts the settle window on its own, the way a tree RPC's own timeout does.
// Derived rather than copied: a window raised past a pinned number would move
// these cases onto the ordinary poll path, where the scroll-to round cost still
// comes out at four reads and stops pricing the floor.
const SLOW_READ_MS = SETTLE_TIMEOUT_MS + 200;
const BUTTON_FRAME: DescribeFrame = { x: 0.2, y: 0.4, width: 0.6, height: 0.1 };
// The same button a scroll further down, i.e. a screen still in motion.
const MOVED_BUTTON_FRAME: DescribeFrame = { ...BUTTON_FRAME, y: 0.7 };
let tmpDir: string;

function screenWith(label: string, frame: DescribeFrame = BUTTON_FRAME): DescribeNode {
  return {
    role: "AXWindow",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children: [{ role: "AXButton", label, frame, children: [] }],
  };
}

function tree(label = "Continue", frame?: DescribeFrame): DescribeTreeData {
  return { tree: screenWith(label, frame), source: "native-devtools" };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Set when a scroll increment goes out, so a fixture can reveal the target the
// way a real scroll does rather than on a read count it is there to measure.
let swiped = false;

function mockRegistry(calls: Array<{ tool: string; args: Record<string, unknown> }>): Registry {
  return {
    invokeTool: vi.fn(async (id: string, args: Record<string, unknown>) => {
      if (id === "list-devices") return { devices: [] };
      if (id === "gesture-swipe") swiped = true;
      calls.push({ tool: id, args });
      return { ok: true };
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
  } as unknown as Registry;
}

async function writeFlow(name: string, yaml: Parameters<typeof serializeFlow>[0]): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.yaml`), serializeFlow(yaml), "utf8");
}

async function run(
  name: string,
  signal?: AbortSignal
): Promise<FlowRunResult & { calls: Array<{ tool: string; args: Record<string, unknown> }> }> {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const ctx = signal ? ({ signal } as never) : undefined;
  const r = await createRunFlowTool(mockRegistry(calls)).execute(
    {},
    { name, project_root: tmpDir, device: DEVICE },
    ctx
  );
  if (!("steps" in r)) throw new Error(`expected a run result, got notice: ${r.notice}`);
  return Object.assign(r, { calls });
}

async function writeTap(name: string): Promise<void> {
  await writeFlow(name, {
    executionPrerequisite: "",
    steps: [{ kind: "tap", selector: { text: "Continue", loose: true } }],
  });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-settle-reads-"));
  reads = 0;
  swiped = false;
  onRead = async () => tree();
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("settleTree takes at least two read attempts", () => {
  it("retries past the window when the only read so far failed slowly", async () => {
    onRead = async (attempt) => {
      if (attempt === 1) {
        await sleep(SLOW_READ_MS);
        throw new Error("ui tree RPC timed out");
      }
      return tree("Continue", MOVED_BUTTON_FRAME);
    };
    await writeTap("tap-slow-blip");

    const result = await run("tap-slow-blip");

    // One slow blip is not an outage: the retry read the screen, so the tap
    // resolved and went out instead of erroring the step.
    expect(result.ok).toBe(true);
    // The slow failure buys one retry, not an open-ended wait for a good read.
    expect(reads).toBe(2);
    // Centre of the MOVED frame, a point only the retry's tree can produce.
    expect(result.calls).toEqual([
      { tool: "gesture-tap", args: { udid: DEVICE, x: 0.5, y: 0.75 } },
    ]);
  }, 20_000);

  it("settles against the retry when the only read so far succeeded slowly", async () => {
    // The button moves between the two reads, so the dispatched point tells us
    // which read the gesture actually acted on.
    onRead = async (attempt) => {
      if (attempt === 1) {
        await sleep(SLOW_READ_MS);
        return tree();
      }
      return tree("Continue", MOVED_BUTTON_FRAME);
    };
    await writeTap("tap-slow-settle");

    const result = await run("tap-slow-settle");

    expect(result.ok).toBe(true);
    // A lone read has been compared against nothing and is no settle at all, so
    // the window being spent does not excuse skipping the retry.
    expect(reads).toBe(2);
    // Centre of the MOVED frame (0.45 would be the first read's): the tap lands
    // where the second read saw the button, not on the stale pre-deadline one.
    expect(result.calls).toEqual([
      { tool: "gesture-tap", args: { udid: DEVICE, x: 0.5, y: 0.75 } },
    ]);
  }, 20_000);

  it("settles against the slow first read when the retry then fails", async () => {
    onRead = async (attempt) => {
      if (attempt === 1) {
        await sleep(SLOW_READ_MS);
        return tree();
      }
      throw new Error("ui tree RPC timed out");
    };
    await writeTap("tap-slow-then-blip");

    const result = await run("tap-slow-then-blip");

    // A read did come back, so this is no outage: the step passes, and the
    // branch that would mint the outage memo is the one that throws.
    expect(result.ok).toBe(true);
    // The floor buys one retry; its failure is not grounds for a third read.
    expect(reads).toBe(2);
    // The first read's frame, handed back a read later than the bare deadline
    // would have returned it rather than discarded over one blip.
    expect(result.calls).toEqual([
      { tool: "gesture-tap", args: { udid: DEVICE, x: 0.5, y: 0.45 } },
    ]);
  }, 20_000);

  it("still calls a sustained outage an outage, on the read after the slow one", async () => {
    onRead = async (attempt) => {
      if (attempt === 1) await sleep(SLOW_READ_MS);
      throw new Error("native devtools is unavailable");
    };
    await writeTap("tap-outage");

    const result = await run("tap-outage");

    expect(result.ok).toBe(false);
    expect(result.steps[0].reason).toMatch(/native devtools is unavailable/);
    // The floor is a floor, not an open-ended retry: the second failure settles it.
    expect(reads).toBe(2);
    expect(result.calls).toHaveLength(0);
  }, 20_000);

  it("leaves a fast-failing outage on its existing budget", async () => {
    onRead = async () => {
      throw new Error("native devtools is unavailable");
    };
    await writeTap("tap-dead");

    const result = await run("tap-dead");

    expect(result.ok).toBe(false);
    expect(result.steps[0].reason).toMatch(/native devtools is unavailable/);
    // Reads that fail fast still fill the window, so the floor changes nothing.
    expect(reads).toBeGreaterThan(2);
  }, 20_000);

  it("adds no third read when the first two reads matched inside the window", async () => {
    await writeTap("tap-healthy");

    const result = await run("tap-healthy");

    expect(result.ok).toBe(true);
    // Two reads are what a settle has always cost a healthy run.
    expect(reads).toBe(2);
  });

  it("ends a run cancelled while the floor's retry is in flight", async () => {
    // The floor's read is the one cancelled here, not the first: read 1 answers
    // past the window, so the deadline closes on a lone read and the retry goes
    // out back-to-back with no poll sleep between them. Read 2 then never
    // answers, and carries no budget of its own - the read keeps its own RPC
    // tier so a slow cold start is ridden out - so the signal is all that ends
    // the wait.
    let retryStarted!: () => void;
    const retryInFlight = new Promise<void>((resolve) => {
      retryStarted = resolve;
    });
    onRead = async (attempt) => {
      if (attempt === 1) {
        await sleep(SLOW_READ_MS);
        return tree();
      }
      retryStarted();
      return new Promise<never>(() => {});
    };
    await writeTap("tap-cancelled-retry");

    const controller = new AbortController();
    const running = run("tap-cancelled-retry", controller.signal);
    // Racing the run itself: a settle that never issued the retry fails on the
    // assertions below rather than hanging here until this test's own timeout.
    await Promise.race([retryInFlight, running]);
    const abortedAt = Date.now();
    controller.abort();
    const result = await running;

    // Nothing but the signal could have ended a read that never answers.
    expect(Date.now() - abortedAt).toBeLessThan(2_000);
    // The cancelled settle hands back no tree at all, not the pre-deadline one
    // it already holds: that best-effort return would resolve a frame and land
    // a tap after cancellation, reported as a pass rather than this skip.
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["tap:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
    expect(result.calls).toHaveLength(0);
    // And the retry really was in flight: an abort on read 1 is a different
    // moment, already covered by flow-gesture-settle.test.ts, which hangs the
    // first read instead.
    expect(reads).toBe(2);
  }, 20_000);
});

describe("the settle floor is paid on every `scroll-to` round", () => {
  it("spends two reads a round against a source slower than the window", async () => {
    // Every read outlasts the window, so every round's settle closes it on the
    // first read and pays the floor's retry. The button drifts between reads so
    // no settle exits early on two matching fingerprints, which would cost two
    // reads whatever the floor is set to.
    onRead = async (attempt) => {
      await sleep(SLOW_READ_MS);
      const frame = attempt % 2 === 0 ? MOVED_BUTTON_FRAME : BUTTON_FRAME;
      return tree(swiped ? "Order #1234" : "Top", frame);
    };
    await writeFlow("scroll-slow", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Order #1234" }, direction: "down" }],
    });

    const result = await run("scroll-slow");

    expect(result.ok).toBe(true);
    // One increment, so the pass took exactly two rounds.
    expect(result.calls.map((c) => c.tool)).toEqual(["gesture-swipe"]);
    // Two per round where the pre-floor cost was one. The loop is bounded by
    // MAX_SCROLL_ITERATIONS rather than a clock, so two pinned rounds stand in
    // for the 25 it can run.
    expect(reads).toBe(4);
  }, 30_000);
});
