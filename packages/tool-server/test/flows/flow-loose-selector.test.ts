import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

// Drive resolution through the mocked iOS AX tree (flows fall back to it when
// native-devtools is unavailable, as in these unit tests).
let currentTree: () => DescribeNode;
vi.mock("../../src/tools/describe/platforms/ios", () => ({
  describeIos: vi.fn(async (): Promise<DescribeTreeData> => ({
    tree: currentTree(),
    source: "ax-service",
  })),
}));

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
let tmpDir: string;

function n(partial: Partial<DescribeNode> & { frame: DescribeNode["frame"] }): DescribeNode {
  return { role: "AXOther", children: [], ...partial };
}

function screen(children: DescribeNode[]): DescribeNode {
  return n({ role: "AXWindow", frame: { x: 0, y: 0, width: 1, height: 1 }, children });
}

interface TapCall {
  x: number;
  y: number;
}

function mockRegistry(taps: TapCall[]): Registry {
  return {
    invokeTool: vi.fn(async (id: string, args: Record<string, unknown>) => {
      if (id === "list-devices") return { devices: [] };
      if (id === "gesture-tap") {
        taps.push({ x: args.x as number, y: args.y as number });
        return { tapped: true };
      }
      return { ok: true };
    }),
    getTool: vi.fn((id: string) =>
      id === "gesture-tap" ? { inputSchema: { properties: { udid: {} } } } : undefined
    ),
    // iOS flows gate on a native-devtools connection: report connected so the
    // run proceeds, but expose no target app so the tree fetch falls back to
    // the mocked AX tree above.
    resolveService: vi.fn(async () => ({
      isConnected: () => true,
      listConnectedBundleIds: () => [],
    })),
  } as unknown as Registry;
}

async function writeFlow(name: string, yaml: Parameters<typeof serializeFlow>[0]): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.yaml`), serializeFlow(yaml), "utf8");
}

function asRun(r: FlowRunResult | { notice: string }): FlowRunResult {
  if (!("steps" in r)) throw new Error(`expected a run result, got notice: ${r.notice}`);
  return r;
}

async function run(name: string): Promise<FlowRunResult> {
  const taps: TapCall[] = [];
  const tool = createRunFlowTool(mockRegistry(taps));
  const result = asRun(await tool.execute({}, { name, project_root: tmpDir, device: DEVICE }));
  return Object.assign(result, { taps });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-loose-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("loose (bare-string) selector resolution", () => {
  it("resolves a bare string against an identifier (testID) when no text matches", async () => {
    // A blue box exposed only via testID — no visible label "tap-box".
    currentTree = () =>
      screen([
        n({ identifier: "tap-box", frame: { x: 0.1, y: 0.4, width: 0.8, height: 0.1 } }),
      ]);

    await writeFlow("idtap", {
      launch: "com.acme.app",
      executionPrerequisite: "",
      // `tap: tap-box` ⇒ loose; identifier-first finds the testID node.
      steps: [{ kind: "tap", selector: { text: "tap-box", loose: true } }],
    });

    const result = (await run("idtap")) as FlowRunResult & { taps: TapCall[] };
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["tap:pass"]);
    // Tapped the centre of the testID node.
    expect(result.taps).toEqual([{ x: 0.5, y: 0.45 }]);
  });

  it("falls back to text (label/value) when no identifier matches", async () => {
    currentTree = () =>
      screen([n({ label: "Login", frame: { x: 0.2, y: 0.6, width: 0.6, height: 0.1 } })]);

    await writeFlow("texttap", {
      launch: "com.acme.app",
      executionPrerequisite: "",
      steps: [{ kind: "tap", selector: { text: "Login", loose: true } }],
    });

    const result = (await run("texttap")) as FlowRunResult & { taps: TapCall[] };
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["tap:pass"]);
    expect(result.taps).toEqual([{ x: 0.5, y: 0.65 }]);
  });

  it("prefers the identifier match over a different text match", async () => {
    // Both an element whose identifier is "save" and a different element whose
    // visible text contains "save" are on screen; loose must pick the testID.
    currentTree = () =>
      screen([
        n({ label: "save your work first", frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.1 } }),
        n({ identifier: "save", frame: { x: 0.1, y: 0.8, width: 0.8, height: 0.1 } }),
      ]);

    await writeFlow("prefer", {
      launch: "com.acme.app",
      executionPrerequisite: "",
      steps: [{ kind: "tap", selector: { text: "save", loose: true } }],
    });

    const result = (await run("prefer")) as FlowRunResult & { taps: TapCall[] };
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["tap:pass"]);
    // Centre of the identifier node (y 0.8 + 0.1/2), not the text node at y≈0.25.
    expect(result.taps).toHaveLength(1);
    expect(result.taps[0].x).toBeCloseTo(0.5, 6);
    expect(result.taps[0].y).toBeCloseTo(0.85, 6);
  });

  it("an explicit { text } map stays strict and does NOT match a testID-only node", async () => {
    currentTree = () =>
      screen([
        n({ identifier: "tap-box", frame: { x: 0.1, y: 0.4, width: 0.8, height: 0.1 } }),
      ]);

    // Hand-authored map form (not via serializeFlow, which would collapse a
    // text-only selector back to a bare string ⇒ loose). parseFlow keeps the
    // map strict, so the text locator must NOT fall back to the testID.
    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "strict.yaml"),
      "launch: com.acme.app\nsteps:\n  - tap: { text: tap-box }\n",
      "utf8"
    );

    const result = (await run("strict")) as FlowRunResult & { taps: TapCall[] };
    expect(result.steps[0].status).toBe("fail");
    expect(result.taps).toHaveLength(0);
  }, 20000); // an unresolved tap auto-waits then auto-scrolls before failing
});
