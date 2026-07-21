import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

// Serve the flow tree directly: flows resolve selectors against the platform's
// full-hierarchy source and hard-fail rather than degrade to the AX tree, so
// these unit tests stub the tree fetch itself. `currentScreen` feeds the
// optional pixel dimensions the rotate directive's physical-circle math reads.
let currentTree: () => DescribeNode;
let currentScreen: () => { width: number; height: number } | undefined;
vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn(async (): Promise<DescribeTreeData> => {
    const screen = currentScreen();
    return { tree: currentTree(), source: "native-devtools", ...(screen ? { screen } : {}) };
  }),
}));

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow, parseFlow } from "../../src/tools/flows/flow-utils";

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
const SCREEN_W = 1080;
const SCREEN_H = 2400;
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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-rotate-"));
  currentTree = () => screen([]);
  currentScreen = () => ({ width: SCREEN_W, height: SCREEN_H });
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("rotate: parse/serialize", () => {
  it("round-trips the by-only and on+by spellings", () => {
    const flow = {
      executionPrerequisite: "",
      steps: [
        { kind: "rotate" as const, by: 90 },
        { kind: "rotate" as const, selector: { text: "Map", loose: true }, by: -30 },
        { kind: "rotate" as const, selector: { identifier: "map" }, by: 720 },
      ],
    };
    const reparsed = parseFlow(serializeFlow(flow)).steps;
    expect(reparsed).toEqual(flow.steps);
  });

  it("emits `on`, then `by`", () => {
    const yaml = serializeFlow({
      executionPrerequisite: "",
      steps: [
        { kind: "rotate", selector: { text: "Map", loose: true }, by: 90 },
        { kind: "rotate", by: -45 },
      ],
    });
    expect(yaml).toMatch(/rotate:\n\s+on: Map\n\s+by: 90\n/);
    expect(yaml).toMatch(/rotate:\n\s+by: -45\n/);
  });

  it("parses the options map with the usual selector sugar", () => {
    const steps = parseFlow(
      "steps:\n" +
        '  - rotate: { on: "Map", by: 90 }\n' +
        "  - rotate: { on: { id: map }, by: -30 }\n" +
        "  - rotate: { by: 720 }\n"
    ).steps;
    expect(steps).toEqual([
      { kind: "rotate", selector: { text: "Map", loose: true }, by: 90 },
      { kind: "rotate", selector: { identifier: "map" }, by: -30 },
      { kind: "rotate", by: 720 },
    ]);
  });

  it("rejects a non-map body with the options-map hint, not a by type error", () => {
    for (const bad of ["90", '"Map"', "null"]) {
      let message = "";
      try {
        parseFlow(`steps:\n  - rotate: ${bad}\n`);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toMatch(/rotate takes an options map/);
      expect(message).not.toMatch(/by must be/);
    }
  });

  it("rejects top-level selector fields with the nested-selector hint", () => {
    expect(() => parseFlow('steps:\n  - rotate: { text: "Map", by: 90 }\n')).toThrow(
      /takes a nested selector/i
    );
    expect(() => parseFlow("steps:\n  - rotate: { id: map, by: 90 }\n")).toThrow(
      /takes a nested selector/i
    );
  });

  it("rejects unknown keys with a typo suggestion", () => {
    expect(() => parseFlow("steps:\n  - rotate: { on: Map, by: 90, angle: 45 }\n")).toThrow(
      /unknown key `angle`.*allowed keys: on, by/i
    );
    expect(() => parseFlow("steps:\n  - rotate: { on: Map, byy: 90 }\n")).toThrow(
      /did you mean `by`/i
    );
  });

  it("rejects `duration` as an unknown key — the pace is fixed", () => {
    expect(() => parseFlow("steps:\n  - rotate: { by: 90, duration: 1200 }\n")).toThrow(
      /unknown key `duration`.*allowed keys: on, by/i
    );
  });

  it("rejects invalid angles", () => {
    for (const bad of ["0", ".inf", '"90"']) {
      expect(() => parseFlow(`steps:\n  - rotate: { on: Map, by: ${bad} }\n`)).toThrow(
        /rotate\.by must be a finite non-zero number of degrees \(\+CW, −CCW\)/
      );
    }
    expect(() => parseFlow("steps:\n  - rotate: { on: Map }\n")).toThrow(
      /rotate\.by must be a finite non-zero number/
    );
  });

  it("accepts angles up to ±3000° and rejects anything beyond, naming the limit", () => {
    for (const ok of ["3000", "-3000"]) {
      expect(() => parseFlow(`steps:\n  - rotate: { by: ${ok} }\n`)).not.toThrow();
    }
    for (const bad of ["3000.001", "-3001"]) {
      expect(() => parseFlow(`steps:\n  - rotate: { by: ${bad} }\n`)).toThrow(
        /rotate\.by must be within ±3000°/
      );
    }
  });
});

describe("rotate: execution", () => {
  it("dispatches one physically circular gesture at the element center with the derived duration", async () => {
    currentTree = () =>
      screen([n({ label: "Map", frame: { x: 0.1, y: 0.3, width: 0.8, height: 0.4 } })]);
    await writeFlow("rotate-map", {
      executionPrerequisite: "",
      steps: [{ kind: "rotate", selector: { text: "Map", loose: true }, by: 90 }],
    });

    const result = await run("rotate-map");

    expect(result.ok).toBe(true);
    expect(result.calls).toHaveLength(1);
    const { tool, args } = result.calls[0]!;
    expect(tool).toBe("gesture-rotate");
    expect(args.udid).toBe(DEVICE);
    expect(args.centerX).toBeCloseTo(0.5, 9);
    expect(args.centerY).toBeCloseTo(0.5, 9);
    // Physical circle: one radius spelled in both normalizations, no ellipse.
    expect((args.radiusX as number) * SCREEN_W).toBeCloseTo((args.radiusY as number) * SCREEN_H, 9);
    expect(args).not.toHaveProperty("radius");
    // +by = clockwise: endAngle − startAngle is exactly the requested delta.
    expect((args.endAngle as number) - (args.startAngle as number)).toBe(90);
    expect(args.durationMs).toBe(300); // ~90°/300ms
  });

  it("defaults to the screen center when no selector is given", async () => {
    await writeFlow("rotate-center", {
      executionPrerequisite: "",
      steps: [{ kind: "rotate", by: -90 }],
    });

    const result = await run("rotate-center");

    expect(result.ok).toBe(true);
    const args = result.calls[0]!.args;
    expect(args.centerX).toBeCloseTo(0.5, 9);
    expect(args.centerY).toBeCloseTo(0.5, 9);
    // Portrait phone: horizontal Down points would ride the side guards, so
    // the fingers start on the vertical axis.
    expect(args.startAngle).toBe(90);
    expect((args.endAngle as number) - (args.startAngle as number)).toBe(-90);
    expect((args.radiusX as number) * SCREEN_W).toBeCloseTo((args.radiusY as number) * SCREEN_H, 9);
  });

  it("derives every duration from the angle at the fixed pace", async () => {
    await writeFlow("rotate-durations", {
      executionPrerequisite: "",
      steps: [
        { kind: "rotate", by: 720 },
        { kind: "rotate", by: -720 },
        { kind: "rotate", by: 3000 },
      ],
    });

    const result = await run("rotate-durations");

    expect(result.ok).toBe(true);
    expect(result.calls.map((c) => c.args.durationMs)).toEqual([2400, 2400, 10000]);
  });

  it("falls back to the legacy single-radius ellipse when the source reports no dimensions", async () => {
    currentScreen = () => undefined;
    await writeFlow("rotate-no-dims", {
      executionPrerequisite: "",
      steps: [{ kind: "rotate", by: 90 }],
    });

    const result = await run("rotate-no-dims");

    expect(result.ok).toBe(true);
    const args = result.calls[0]!.args;
    expect(args.radius).toBeGreaterThan(0);
    expect(args).not.toHaveProperty("radiusX");
    expect(args).not.toHaveProperty("radiusY");
  });

  it("still rotates (ellipse fallback) when the tree is unreadable and no selector is given", async () => {
    currentTree = () => {
      throw new Error("native devtools is unavailable");
    };
    await writeFlow("rotate-blind", {
      executionPrerequisite: "",
      steps: [{ kind: "rotate", by: 45 }],
    });

    const result = await run("rotate-blind");

    expect(result.ok).toBe(true);
    const args = result.calls[0]!.args;
    expect(args.radius).toBeGreaterThan(0);
    expect(args.durationMs).toBe(300); // max(1, 45/90) floors at one 90° unit
  });

  it("fails only when no on-screen orbit radius exists — and never blames target size", async () => {
    // Target centered inside the 2% screen inset: no circle fits around it.
    currentTree = () =>
      screen([n({ label: "Edge", frame: { x: 0, y: 0.4, width: 0.02, height: 0.2 } })]);
    await writeFlow("rotate-no-room", {
      executionPrerequisite: "",
      steps: [{ kind: "rotate", selector: { text: "Edge", loose: true }, by: 90 }],
    });

    const result = await run("rotate-no-room");

    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({ kind: "rotate", status: "fail" });
    expect(result.steps[0].reason).toMatch(/no on-screen orbit radius/);
    expect(result.steps[0].reason).not.toMatch(/small|tiny/i);
    expect(result.calls).toHaveLength(0);
  });

  it("fails with the scroll-to hint when the target never appears", async () => {
    currentTree = () => screen([]);
    await writeFlow("rotate-missing", {
      executionPrerequisite: "",
      steps: [{ kind: "rotate", selector: { text: "Map", loose: true }, by: 90 }],
    });

    const result = await run("rotate-missing");

    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({ kind: "rotate", status: "fail" });
    expect(result.steps[0].reason).toMatch(/add a scroll-to step/i);
    expect(result.calls).toHaveLength(0);
  }, 15000);
});

describe("rotate: gating", () => {
  it("rejects rotate on vega with the touch-directive message shape", async () => {
    await writeFlow("rotate-vega", {
      executionPrerequisite: "",
      steps: [{ kind: "rotate", by: 90 }],
    });

    const result = await run("rotate-vega", "amazon-4a27df03c9777152");

    expect(result.steps[0]).toMatchObject({ kind: "rotate", status: "fail" });
    expect(result.steps[0].reason).toMatch(
      /rotate is a touch directive and Vega is remote-driven — move focus with `tool: tv-remote`/
    );
    expect(result.calls).toHaveLength(0);
  });

  it("rejects rotate on chromium for the missing rotate idiom, not a missing backend", async () => {
    await writeFlow("rotate-chromium", {
      executionPrerequisite: "",
      steps: [{ kind: "rotate", by: 90 }],
    });

    const result = await run("rotate-chromium", "chromium-cdp-9222");

    expect(result.steps[0]).toMatchObject({ kind: "rotate", status: "fail" });
    expect(result.steps[0].reason).toMatch(/no rotate-gesture idiom/);
    expect(result.steps[0].reason).toMatch(/tap\/keyboard/);
    expect(result.steps[0].reason).not.toMatch(/no backend/i);
    expect(result.calls).toHaveLength(0);
  });
});

describe("rotate: abort", () => {
  it("aborts before dispatch: aborted outcome, no gesture", async () => {
    const controller = new AbortController();
    // Cancel the run during the aspect read — after the step has started but
    // before the gesture dispatch, which must then be suppressed.
    currentTree = () => {
      controller.abort();
      return screen([]);
    };
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];

    await writeFlow("rotate-abort", {
      executionPrerequisite: "",
      steps: [{ kind: "rotate", by: 720 }],
    });

    const result = asRun(
      await createRunFlowTool(mockRegistry(calls)).execute(
        {},
        { name: "rotate-abort", project_root: tmpDir, device: DEVICE },
        { signal: controller.signal } as never
      )
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["rotate:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
    expect(calls).toHaveLength(0);
  });

  it("maps a mid-gesture abort rejection to the aborted skip, not a failure", async () => {
    const controller = new AbortController();
    // The tool now rejects when cancelled mid-gesture: abort, then reject, from
    // inside the dispatch — the flow must read the signal, not the message.
    const registry = {
      invokeTool: vi.fn(async (id: string) => {
        if (id === "list-devices") return { devices: [] };
        if (id === "gesture-rotate") {
          controller.abort();
          throw new Error("gesture-rotate aborted — cancelled mid-gesture after 3 of 31 frames");
        }
        return { ok: true };
      }),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    } as unknown as Registry;

    await writeFlow("rotate-mid-abort", {
      executionPrerequisite: "",
      steps: [{ kind: "rotate", by: 90 }],
    });

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "rotate-mid-abort", project_root: tmpDir, device: DEVICE },
        { signal: controller.signal } as never
      )
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["rotate:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
  });

  it("propagates a dispatch rejection as a real error when the run is not aborted", async () => {
    const registry = {
      invokeTool: vi.fn(async (id: string) => {
        if (id === "list-devices") return { devices: [] };
        if (id === "gesture-rotate") throw new Error("simulator-server unreachable");
        return { ok: true };
      }),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    } as unknown as Registry;

    await writeFlow("rotate-dispatch-error", {
      executionPrerequisite: "",
      steps: [{ kind: "rotate", by: 90 }],
    });

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "rotate-dispatch-error", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.steps[0]).toMatchObject({ kind: "rotate", status: "error" });
    expect(result.steps[0].reason).toMatch(/simulator-server unreachable/);
  });
});
