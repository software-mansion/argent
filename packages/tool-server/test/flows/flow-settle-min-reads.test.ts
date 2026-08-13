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

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
// Comfortably past the 3000ms settle window, the way a tree RPC's own timeout is.
const SLOW_READ_MS = 3200;
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

function mockRegistry(calls: Array<{ tool: string; args: Record<string, unknown> }>): Registry {
  return {
    invokeTool: vi.fn(async (id: string, args: Record<string, unknown>) => {
      if (id === "list-devices") return { devices: [] };
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
  name: string
): Promise<FlowRunResult & { calls: Array<{ tool: string; args: Record<string, unknown> }> }> {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const r = await createRunFlowTool(mockRegistry(calls)).execute(
    {},
    { name, project_root: tmpDir, device: DEVICE }
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
});
