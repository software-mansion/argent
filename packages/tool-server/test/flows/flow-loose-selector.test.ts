import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

// Serve the flow tree directly: flows resolve selectors against the platform's
// full-hierarchy source and hard-fail rather than degrade to the AX tree, so
// these unit tests stub the tree fetch itself.
let currentTree: () => DescribeNode;
vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn(
    async (): Promise<DescribeTreeData> => ({
      tree: currentTree(),
      source: "native-devtools",
    })
  ),
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
      screen([n({ identifier: "tap-box", frame: { x: 0.1, y: 0.4, width: 0.8, height: 0.1 } })]);

    await writeFlow("idtap", {
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
      screen([n({ identifier: "tap-box", frame: { x: 0.1, y: 0.4, width: 0.8, height: 0.1 } })]);

    // serializeFlow keeps a strict { text } in map form (only LOOSE text-only
    // selectors collapse to a bare string), so writing through it preserves
    // strictness — the text locator must NOT fall back to the testID.
    await writeFlow("strict", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", selector: { text: "tap-box" } }],
    });

    const result = (await run("strict")) as FlowRunResult & { taps: TapCall[] };
    expect(result.steps[0].status).toBe("fail");
    expect(result.taps).toHaveLength(0);
  }, 10000); // an unresolved tap auto-waits its full timeout before failing

  it("await resolves a bare string against an identifier (testID), like every other directive", async () => {
    // The element is exposed only via testID — a text-only await would time out.
    currentTree = () =>
      screen([n({ identifier: "tap-box", frame: { x: 0.1, y: 0.4, width: 0.8, height: 0.1 } })]);

    await writeFlow("idawait", {
      executionPrerequisite: "",
      // `await: { visible: tap-box }` ⇒ loose; identifier-first finds the testID.
      steps: [{ kind: "await", condition: "visible", selector: { text: "tap-box", loose: true } }],
    });

    const result = await run("idawait");
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["await:pass"]);
    expect(result.ok).toBe(true);
  });

  it("await `visible` falls through a zero-area identifier match to the visible text, like tap", async () => {
    // A dead (zero-area) node's testID exactly matches the bare string, while
    // the element the user means is exposed as visible text. `tap: Checkout`
    // skips the dead identifier match (selectorToFrame filters to visible), so
    // `await: { visible: Checkout }` must resolve the same element rather than
    // stalling on the identifier pass until timeout.
    currentTree = () =>
      screen([
        n({ identifier: "checkout", frame: { x: 0.5, y: 0.5, width: 0, height: 0 } }),
        n({ label: "Checkout", frame: { x: 0.2, y: 0.7, width: 0.6, height: 0.1 } }),
      ]);

    await writeFlow("zeroawait", {
      executionPrerequisite: "",
      steps: [{ kind: "await", condition: "visible", selector: { text: "Checkout", loose: true } }],
    });

    const result = await run("zeroawait");
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["await:pass"]);
  });

  it("`hidden` does not false-pass on a zero-area identifier match while the text is visible", async () => {
    // Same screen: the identifier pass alone would satisfy `hidden` (its only
    // match is zero-area), yet a tap of the same bare string would land on the
    // visible "Checkout" text — so the element is NOT hidden.
    currentTree = () =>
      screen([
        n({ identifier: "checkout", frame: { x: 0.5, y: 0.5, width: 0, height: 0 } }),
        n({ label: "Checkout", frame: { x: 0.2, y: 0.7, width: 0.6, height: 0.1 } }),
      ]);

    await writeFlow("zerohidden", {
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "hidden", selector: { text: "Checkout", loose: true } }],
    });

    const result = await run("zerohidden");
    expect(result.steps[0].status).toBe("fail");
  });

  it("`exists` still accepts a zero-area identifier match when nothing else matches", async () => {
    // `exists` deliberately counts zero-area nodes; the visible-first fallback
    // must keep the identifier pass's matches when no alternative has a visible
    // match.
    currentTree = () =>
      screen([n({ identifier: "checkout", frame: { x: 0.5, y: 0.5, width: 0, height: 0 } })]);

    await writeFlow("zeroexists", {
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "exists", selector: { text: "Checkout", loose: true } }],
    });

    const result = await run("zeroexists");
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["assert:pass"]);
  });

  it("assert `text` reads the element the loose selector resolved to", async () => {
    currentTree = () =>
      screen([
        n({
          identifier: "counter",
          label: "Taps: 3",
          frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.1 },
        }),
      ]);

    await writeFlow("idassert", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "text",
          selector: { text: "counter", loose: true },
          expectedText: "Taps: 3",
          textMatch: "equals",
        },
      ],
    });

    const result = await run("idassert");
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["assert:pass"]);
  });
});
