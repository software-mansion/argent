import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

// Serve the flow tree directly, as flow-tap.test.ts does.
let currentTree: () => DescribeNode;
vi.mock("../../src/tools/flows/flow-tree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/tools/flows/flow-tree")>()),
  fetchFlowTree: vi.fn(
    async (): Promise<DescribeTreeData> => ({
      tree: currentTree(),
      source: "native-devtools",
    })
  ),
}));

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow, type FlowStep } from "../../src/tools/flows/flow-utils";

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
const WARNING =
  "The panel this foldable simulator renders to could not be resolved (the accessibility " +
  "service failed (no); CoreDevice failed (no)), so this touch went to screen 1 (cover panel).";
let tmpDir: string;

function n(partial: Partial<DescribeNode> & { frame: DescribeNode["frame"] }): DescribeNode {
  return { role: "AXOther", children: [], ...partial };
}

function screen(children: DescribeNode[]): DescribeNode {
  return n({ role: "AXWindow", frame: { x: 0, y: 0, width: 1, height: 1 }, children });
}

/**
 * A registry whose gesture tools answer like the real ones on a foldable whose
 * panel could not be resolved (`warning` on the result), or plainly.
 */
function mockRegistry(warn: boolean, calls: string[]): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "list-devices") return { devices: [] };
      calls.push(id);
      return warn ? { ok: true, warning: WARNING } : { ok: true };
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
  } as unknown as Registry;
}

async function writeFlow(name: string, steps: FlowStep[]): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${name}.yaml`),
    serializeFlow({ executionPrerequisite: "", steps }),
    "utf8"
  );
}

async function run(name: string, warn: boolean): Promise<FlowRunResult & { calls: string[] }> {
  const calls: string[] = [];
  const tool = createRunFlowTool(mockRegistry(warn, calls));
  const result = await tool.execute({}, { name, project_root: tmpDir, device: DEVICE });
  if (!("steps" in result)) throw new Error("expected a run result");
  return Object.assign(result, { calls });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-panel-warning-"));
  currentTree = () =>
    screen([n({ label: "Photo", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } })]);
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const GESTURES: FlowStep[] = [
  { kind: "tap", selector: { text: "Photo", loose: true } },
  { kind: "long-press", selector: { text: "Photo", loose: true }, duration: 50 },
  { kind: "swipe", direction: "down" },
  { kind: "swipe", from: { selector: { text: "Photo", loose: true } }, direction: "up" },
];

describe("a gesture tool's panel warning reaches the flow step report", () => {
  it("rides tap, long-press and swipe steps", async () => {
    await writeFlow("gestures", GESTURES);
    const warned = await run("gestures", true);
    expect(warned.ok).toBe(true);
    expect(warned.calls).toEqual([
      "gesture-tap",
      "gesture-custom",
      "gesture-swipe",
      "gesture-swipe",
    ]);
    for (const step of warned.steps) {
      expect(step.status).toBe("pass");
      expect(step.warning).toContain("could not be resolved");
    }
  });

  it("rides a scroll-to that scrolled without finding its target", async () => {
    await writeFlow("scroll", [
      { kind: "scroll-to", target: { text: "Missing" }, direction: "down" },
    ]);
    const warned = await run("scroll", true);
    expect(warned.ok).toBe(false);
    expect(warned.steps[0]!.status).toBe("fail");
    expect(warned.steps[0]!.reason).toContain("reached the end of the scroll");
    expect(warned.steps[0]!.warning).toContain("could not be resolved");
  });

  it("leaves a step without a warning when the tool had none", async () => {
    await writeFlow("plain", GESTURES);
    const plain = await run("plain", false);
    expect(plain.ok).toBe(true);
    for (const step of plain.steps) {
      expect(step.status).toBe("pass");
      expect(step).not.toHaveProperty("warning");
    }
  });
});
