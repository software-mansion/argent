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
import { MIN_VIABLE_TRAVEL } from "../../src/tools/flows/flow-pinch-geometry";
import { serializeFlow, parseFlow } from "../../src/tools/flows/flow-utils";

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
let tmpDir: string;

function n(partial: Partial<DescribeNode> & { frame: DescribeNode["frame"] }): DescribeNode {
  return { role: "AXOther", children: [], ...partial };
}

function screen(children: DescribeNode[]): DescribeNode {
  return n({ role: "AXWindow", frame: { x: 0, y: 0, width: 1, height: 1 }, children });
}

/** Registry that records every gesture tool invocation's args. */
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

function asRun(r: FlowRunResult | { notice: string }): FlowRunResult {
  if (!("steps" in r)) throw new Error(`expected a run result, got notice: ${r.notice}`);
  return r;
}

async function run(
  name: string,
  device = DEVICE
): Promise<FlowRunResult & { calls: Array<{ tool: string; args: Record<string, unknown> }> }> {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const tool = createRunFlowTool(mockRegistry(calls));
  const result = asRun(await tool.execute({}, { name, project_root: tmpDir, device }));
  return Object.assign(result, { calls });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-pinch-"));
  currentTree = () => screen([]);
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("pinch: parse/serialize", () => {
  it("round-trips the scale-only and on+scale spellings", () => {
    const flow = {
      executionPrerequisite: "",
      steps: [
        { kind: "pinch" as const, scale: 2 },
        { kind: "pinch" as const, scale: 0.5 },
        { kind: "pinch" as const, selector: { text: "Map", loose: true }, scale: 3 },
        { kind: "pinch" as const, selector: { identifier: "map" }, scale: 20 },
      ],
    };
    expect(parseFlow(serializeFlow(flow)).steps).toEqual(flow.steps);
  });

  it("emits `on` before `scale`", () => {
    const yaml = serializeFlow({
      executionPrerequisite: "",
      steps: [{ kind: "pinch", selector: { text: "Map", loose: true }, scale: 3 }],
    });
    expect(yaml).toMatch(/pinch:\n\s+on: Map\n\s+scale: 3/);
  });

  it("parses the options map with the usual selector sugar", () => {
    const steps = parseFlow(
      "steps:\n" +
        '  - pinch: { on: "Map", scale: 3 }\n' +
        "  - pinch: { on: { id: map }, scale: 0.5 }\n" +
        "  - pinch: { scale: 2 }\n"
    ).steps;
    expect(steps).toEqual([
      { kind: "pinch", selector: { text: "Map", loose: true }, scale: 3 },
      { kind: "pinch", selector: { identifier: "map" }, scale: 0.5 },
      { kind: "pinch", scale: 2 },
    ]);
  });

  it("rejects a non-map body with the options-map hint, not a scale type error", () => {
    for (const bad of ['"Map"', "2", "null"]) {
      let message = "";
      try {
        parseFlow(`steps:\n  - pinch: ${bad}\n`);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toMatch(/pinch takes an options map/);
      expect(message).not.toMatch(/scale must be/);
    }
  });

  it("rejects top-level selector fields with the nested-selector hint", () => {
    expect(() => parseFlow('steps:\n  - pinch: { text: "Map", scale: 2 }\n')).toThrow(
      /takes a nested selector/i
    );
    expect(() => parseFlow("steps:\n  - pinch: { id: map, scale: 2 }\n")).toThrow(
      /takes a nested selector/i
    );
  });

  it("rejects unknown keys with a typo suggestion", () => {
    expect(() => parseFlow("steps:\n  - pinch: { on: Map, scale: 2, angle: 45 }\n")).toThrow(
      /unknown key `angle`.*allowed keys: on, scale/i
    );
    expect(() => parseFlow("steps:\n  - pinch: { on: Map, scal: 2 }\n")).toThrow(
      /did you mean `scale`/i
    );
  });

  it("rejects invalid scales (validity only — no magnitude cap)", () => {
    for (const bad of ["0", "1", "-1", ".inf", '"2"']) {
      expect(() => parseFlow(`steps:\n  - pinch: { on: Map, scale: ${bad} }\n`)).toThrow(
        /pinch\.scale must be a finite number > 0 and ≠ 1/
      );
    }
    expect(() => parseFlow("steps:\n  - pinch: { on: Map }\n")).toThrow(
      /pinch\.scale must be a finite number/
    );
    // No policy cap: an extreme scale parses fine.
    expect(parseFlow("steps:\n  - pinch: { scale: 1000000 }\n").steps).toEqual([
      { kind: "pinch", scale: 1000000 },
    ]);
  });
});

describe("pinch: execution", () => {
  it("dispatches gesture-pinch at the element center with the full requested ratio", async () => {
    currentTree = () =>
      screen([n({ label: "Map", frame: { x: 0.1, y: 0.3, width: 0.8, height: 0.4 } })]);
    await writeFlow("pinch-map", {
      executionPrerequisite: "",
      steps: [{ kind: "pinch", selector: { text: "Map", loose: true }, scale: 4 }],
    });

    const result = await run("pinch-map");

    expect(result.ok).toBe(true);
    expect(result.calls).toHaveLength(1);
    const { tool, args } = result.calls[0]!;
    expect(tool).toBe("gesture-pinch");
    expect(args.udid).toBe(DEVICE);
    expect(args.centerX).toBeCloseTo(0.5, 9);
    expect(args.centerY).toBeCloseTo(0.5, 9);
    expect(args.angle).toBe(0);
    expect((args.endDistance as number) / (args.startDistance as number)).toBeCloseTo(4, 9);
    // Centered target: the centroid never needs to drift.
    expect(args).not.toHaveProperty("endCenterX");
    expect(args).not.toHaveProperty("endCenterY");
  });

  it("defaults to the screen center when no selector is given (no tree read)", async () => {
    currentTree = () => {
      throw new Error("must not read the tree for a selector-less pinch");
    };
    await writeFlow("pinch-center", {
      executionPrerequisite: "",
      steps: [{ kind: "pinch", scale: 0.5 }],
    });

    const result = await run("pinch-center");

    expect(result.ok).toBe(true);
    const args = result.calls[0]!.args;
    expect(args.centerX).toBeCloseTo(0.5, 9);
    expect(args.centerY).toBeCloseTo(0.5, 9);
    // Zoom out: fingers travel together from the edge-safe start span.
    expect(args.startDistance).toBeCloseTo(0.84, 9);
    expect(args.endDistance).toBeCloseTo(0.42, 9);
  });

  it("chains scale 20 into 3 equal-ratio gestures separated by settle delays", async () => {
    await writeFlow("pinch-20", {
      executionPrerequisite: "",
      steps: [{ kind: "pinch", scale: 20 }],
    });

    const t0 = Date.now();
    const result = await run("pinch-20");
    const elapsed = Date.now() - t0;

    expect(result.ok).toBe(true);
    expect(result.calls.map((c) => c.tool)).toEqual([
      "gesture-pinch",
      "gesture-pinch",
      "gesture-pinch",
    ]);
    for (const { args } of result.calls) {
      expect((args.endDistance as number) / (args.startDistance as number)).toBeCloseTo(
        20 ** (1 / 3),
        9
      );
    }
    // Two inter-gesture recognizer resets of 250ms each.
    expect(elapsed).toBeGreaterThanOrEqual(450);
  });

  it("never lets target size alter the gesture count", async () => {
    currentTree = () =>
      screen([n({ label: "Tiny", frame: { x: 0.49, y: 0.49, width: 0.02, height: 0.01 } })]);
    await writeFlow("pinch-tiny-20", {
      executionPrerequisite: "",
      steps: [{ kind: "pinch", selector: { text: "Tiny", loose: true }, scale: 20 }],
    });

    const result = await run("pinch-tiny-20");

    expect(result.ok).toBe(true);
    expect(result.calls.filter((c) => c.tool === "gesture-pinch")).toHaveLength(3);
  });

  it("forwards the drifted end centroid on the moving axis only, for a corner target", async () => {
    currentTree = () =>
      screen([n({ label: "Corner", frame: { x: 0, y: 0.86, width: 0.3, height: 0.14 } })]);
    await writeFlow("pinch-corner", {
      executionPrerequisite: "",
      steps: [{ kind: "pinch", selector: { text: "Corner", loose: true }, scale: 4 }],
    });

    const result = await run("pinch-corner");

    expect(result.ok).toBe(true);
    const args = result.calls[0]!.args;
    expect(args.angle).toBe(0); // parallel to the violated bottom edge
    expect(args.centerX).toBeCloseTo(0.15, 9);
    expect(args.centerY).toBeCloseTo(0.93, 9);
    expect((args.endDistance as number) / (args.startDistance as number)).toBeCloseTo(4, 9);
    expect(args.endCenterX).toBeCloseTo(0.3, 9); // drifted inward off the corner
    expect(args).not.toHaveProperty("endCenterY"); // fixed perpendicular axis
    // Final pointers stay inside the screen inset.
    const half = (args.endDistance as number) / 2;
    expect((args.endCenterX as number) - half).toBeGreaterThanOrEqual(0.02 - 1e-9);
    expect((args.endCenterX as number) + half).toBeLessThanOrEqual(0.98 + 1e-9);
  });

  it("forwards vertical centroid drift for a tall target near the bottom edge", async () => {
    currentTree = () =>
      screen([n({ label: "Portrait", frame: { x: 0.475, y: 0.55, width: 0.05, height: 0.45 } })]);
    await writeFlow("pinch-portrait", {
      executionPrerequisite: "",
      steps: [{ kind: "pinch", selector: { text: "Portrait", loose: true }, scale: 4 }],
    });

    const result = await run("pinch-portrait");

    expect(result.ok).toBe(true);
    const args = result.calls[0]!.args;
    expect(args.angle).toBe(90);
    expect(args.centerX).toBeCloseTo(0.5, 9);
    expect(args.centerY).toBeCloseTo(0.775, 9);
    expect(args.startDistance).toBeCloseTo(0.24, 9);
    expect(args.endDistance).toBeCloseTo(0.96, 9);
    expect(args.endCenterY).toBeCloseTo(0.5, 9);
    expect(args).not.toHaveProperty("endCenterX");
  });

  it("picks the platform's guards: same edge target pinches horizontally on iOS, vertically on Android", async () => {
    currentTree = () =>
      screen([n({ label: "Edge", frame: { x: 0, y: 0.45, width: 0.3, height: 0.1 } })]);
    await writeFlow("pinch-edge", {
      executionPrerequisite: "",
      steps: [{ kind: "pinch", selector: { text: "Edge", loose: true }, scale: 4 }],
    });

    const ios = await run("pinch-edge");
    expect(ios.calls[0]!.args.angle).toBe(0);

    const android = await run("pinch-edge", "emulator-5554");
    expect(android.calls[0]!.args.angle).toBe(90);
  });

  it("prefers a perceptible edge-risky gesture over a sub-floor safe one", async () => {
    // Wide thin target centered inside Android's 0.13 left guard: the vertical
    // candidate is axis-safe but its travel is a recognizer no-op, so the
    // substantial horizontal candidate must win despite the guard violation.
    currentTree = () =>
      screen([n({ label: "Strip", frame: { x: 0, y: 0.4975, width: 0.2, height: 0.005 } })]);
    await writeFlow("pinch-strip", {
      executionPrerequisite: "",
      steps: [{ kind: "pinch", selector: { text: "Strip", loose: true }, scale: 4 }],
    });

    const result = await run("pinch-strip", "emulator-5554");

    expect(result.ok).toBe(true);
    const args = result.calls[0]!.args;
    expect(args.angle).toBe(0);
    expect(args.startDistance).toBeCloseTo(0.16, 9);
    expect(args.endDistance).toBeCloseTo(0.64, 9);
    expect((args.endDistance as number) - (args.startDistance as number)).toBeGreaterThanOrEqual(
      MIN_VIABLE_TRAVEL
    );
  });

  it("falls back to safety-rank ordering when every candidate is sub-floor", async () => {
    // Tiny target inside the iOS left guard: neither axis clears the travel
    // floor, so the vertical (axis-safe) candidate wins on safety rank and the
    // gesture is still dispatched, never rejected.
    currentTree = () =>
      screen([n({ label: "Dot", frame: { x: 0.045, y: 0.4975, width: 0.01, height: 0.005 } })]);
    await writeFlow("pinch-dot", {
      executionPrerequisite: "",
      steps: [{ kind: "pinch", selector: { text: "Dot", loose: true }, scale: 4 }],
    });

    const result = await run("pinch-dot");

    expect(result.ok).toBe(true);
    expect(result.calls).toHaveLength(1);
    const args = result.calls[0]!.args;
    expect(args.angle).toBe(90);
    expect((args.endDistance as number) / (args.startDistance as number)).toBeCloseTo(4, 9);
    expect((args.endDistance as number) - (args.startDistance as number)).toBeLessThan(
      MIN_VIABLE_TRAVEL
    );
  });

  it("fails with the scroll-to hint when the target never appears", async () => {
    currentTree = () => screen([]);
    await writeFlow("pinch-missing", {
      executionPrerequisite: "",
      steps: [{ kind: "pinch", selector: { text: "Map", loose: true }, scale: 2 }],
    });

    const result = await run("pinch-missing");

    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({ kind: "pinch", status: "fail" });
    expect(result.steps[0].reason).toMatch(/add a scroll-to step/i);
    expect(result.calls).toHaveLength(0);
  }, 15000);
});

describe("pinch: gating", () => {
  it("rejects pinch on vega with the touch-directive message shape", async () => {
    await writeFlow("pinch-vega", {
      executionPrerequisite: "",
      steps: [{ kind: "pinch", scale: 2 }],
    });

    const result = await run("pinch-vega", "amazon-4a27df03c9777152");

    expect(result.steps[0]).toMatchObject({ kind: "pinch", status: "fail" });
    expect(result.steps[0].reason).toMatch(
      /pinch is a touch directive and Vega is remote-driven — move focus with `tool: tv-remote`/
    );
    expect(result.calls).toHaveLength(0);
  });

  it("rejects pinch on chromium for the missing pinch mapping, not a missing backend", async () => {
    await writeFlow("pinch-chromium", {
      executionPrerequisite: "",
      steps: [{ kind: "pinch", scale: 2 }],
    });

    const result = await run("pinch-chromium", "chromium-cdp-9222");

    expect(result.steps[0]).toMatchObject({ kind: "pinch", status: "fail" });
    expect(result.steps[0].reason).toMatch(/no uniform pinch-zoom mapping/);
    expect(result.steps[0].reason).toMatch(/ctrl\+wheel/);
    expect(result.steps[0].reason).not.toMatch(/no backend/i);
    expect(result.calls).toHaveLength(0);
  });

  it("leaves tap on chromium untouched", async () => {
    currentTree = () =>
      screen([n({ label: "Zoom in", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.1 } })]);
    await writeFlow("tap-chromium", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", selector: { text: "Zoom in", loose: true } }],
    });

    const result = await run("tap-chromium", "chromium-cdp-9222");

    expect(result.ok).toBe(true);
    expect(result.calls.map((c) => c.tool)).toEqual(["gesture-tap"]);
  });
});

describe("pinch: abort", () => {
  it("stops the chain mid-decomposition: aborted outcome, no further gestures", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const registry = {
      invokeTool: vi.fn(async (id: string) => {
        calls.push(id);
        if (id === "list-devices") return { devices: [] };
        // Cancel the run during the FIRST sub-gesture: the inter-gesture gap
        // must then swallow the remaining two.
        if (id === "gesture-pinch") controller.abort();
        return { ok: true };
      }),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    } as unknown as Registry;

    await writeFlow("pinch-abort", {
      executionPrerequisite: "",
      steps: [{ kind: "pinch", scale: 20 }],
    });

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "pinch-abort", project_root: tmpDir, device: DEVICE },
        { signal: controller.signal } as never
      )
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["pinch:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
    expect(calls.filter((c) => c === "gesture-pinch")).toHaveLength(1);
  });
});
