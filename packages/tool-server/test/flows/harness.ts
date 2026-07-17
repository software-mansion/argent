import { afterEach, beforeEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode } from "../../src/tools/describe/contract";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";

const IOS_DEVICE = "00000000-0000-0000-0000-0000000000ab";

interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export function n(partial: Partial<DescribeNode> & { frame: DescribeNode["frame"] }): DescribeNode {
  return { role: "AXOther", children: [], ...partial };
}

export function screen(children: DescribeNode[]): DescribeNode {
  return n({ role: "AXWindow", frame: { x: 0, y: 0, width: 1, height: 1 }, children });
}

export function label(text: string, extra: Partial<DescribeNode> = {}): DescribeNode {
  return n({
    role: "AXStaticText",
    label: text,
    frame: { x: 0.1, y: 0.1, width: 0.5, height: 0.05 },
    ...extra,
  });
}

function mockRegistry(calls?: ToolCall[]): Registry {
  return {
    invokeTool: vi.fn(async (id: string, args: Record<string, unknown>) => {
      if (id === "list-devices") return { devices: [] };
      calls?.push({ tool: id, args });
      return { ok: true };
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
  } as unknown as Registry;
}

function asRun(result: FlowRunResult | { notice: string }): FlowRunResult {
  if (!("steps" in result)) throw new Error(`expected a run result, got notice: ${result.notice}`);
  return result;
}

export function createFlowTestHarness(options: {
  tempDirectoryPrefix: string;
  reset?: () => void;
}) {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), options.tempDirectoryPrefix));
    options.reset?.();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeFlow(name: string, flow: Parameters<typeof serializeFlow>[0]): Promise<void> {
    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${name}.yaml`), serializeFlow(flow), "utf8");
  }

  async function execute(
    name: string,
    calls?: ToolCall[],
    device: string = IOS_DEVICE
  ): Promise<FlowRunResult> {
    const tool = createRunFlowTool(mockRegistry(calls));
    return asRun(await tool.execute({}, { name, project_root: tmpDir, device }));
  }

  const run = (name: string): Promise<FlowRunResult> => execute(name);
  const runWithCalls = async (
    name: string,
    device?: string
  ): Promise<FlowRunResult & { calls: ToolCall[] }> => {
    const calls: ToolCall[] = [];
    return Object.assign(await execute(name, calls, device), { calls });
  };

  return { writeFlow, run, runWithCalls };
}
