import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

// Reads are driven per attempt, so a test can make the FIRST one fail slowly —
// the shape that matters here. A tree RPC allows itself ~5s, more than the 3s
// settle window, so one such failure used to be the only read a settle ever
// took, and the "every read failed" throw fired on a single transient blip.
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
const SLOW_FAILURE_MS = 3200;
let tmpDir: string;

function screenWith(label: string): DescribeNode {
  return {
    role: "AXWindow",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children: [
      { role: "AXButton", label, frame: { x: 0.2, y: 0.4, width: 0.6, height: 0.1 }, children: [] },
    ],
  };
}

function tree(label = "Continue"): DescribeTreeData {
  return { tree: screenWith(label), source: "native-devtools" };
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
        await sleep(SLOW_FAILURE_MS);
        throw new Error("ui tree RPC timed out");
      }
      return tree();
    };
    await writeTap("tap-slow-blip");

    const result = await run("tap-slow-blip");

    // One slow blip is not an outage: the retry read the screen, so the tap
    // resolved and went out instead of erroring the step.
    expect(result.ok).toBe(true);
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(result.calls.map((c) => c.tool)).toEqual(["gesture-tap"]);
  }, 20_000);

  it("still calls a sustained outage an outage, on the read after the slow one", async () => {
    onRead = async (attempt) => {
      if (attempt === 1) await sleep(SLOW_FAILURE_MS);
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

  it("does not spend a second read when the first one settles the screen", async () => {
    await writeTap("tap-healthy");

    const result = await run("tap-healthy");

    expect(result.ok).toBe(true);
    // Two reads are what a settle costs a healthy run — the floor adds none.
    expect(reads).toBe(2);
  });
});
