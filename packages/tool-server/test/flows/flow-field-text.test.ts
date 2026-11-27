import { describe, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { AXTreeNode, AXTreeResponse } from "../../src/blueprints/ax-service";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";

// The text a filled field holds on an iOS simulator, through the REAL runner and
// the real simulator tree read: only the ax-service is stubbed.

const APP = "com.example.app";
const FIELD_FRAME = { x: 0.05, y: 0.12, width: 0.9, height: 0.04 };
const ROW_FRAME = { x: 0.05, y: 0.25, width: 0.9, height: 0.064 };

interface Screen {
  /** Cut the walk short, as the daemon does on a heavy screen. */
  truncated?: boolean;
}

/** A search field (id `search`) holding `typed` (its placeholder when undefined), and the result rows. */
function axTree(typed: string | undefined, rows: string[], opts: Screen = {}): AXTreeResponse {
  return {
    alertVisible: false,
    screenFrame: { width: 402, height: 874 },
    nodes: [
      { index: 0, label: APP, bundleId: APP },
      {
        index: 1,
        parentIndex: 0,
        placeholder: "Search",
        identifier: "search",
        traits: typed === undefined ? ["textEntry"] : ["textEntry", "isEditing"],
        frame: FIELD_FRAME,
        ...(typed === undefined ? { value: "Search", hintShowing: true } : { value: typed }),
      },
      ...rows.map((label, i): AXTreeNode => ({
        index: 2 + i,
        parentIndex: 0,
        label,
        traits: ["button"],
        frame: { ...ROW_FRAME, y: ROW_FRAME.y + i * 0.08 },
      })),
    ],
    truncated: opts.truncated === true,
    foregroundApp: APP,
    interfaceOrientation: "portrait",
    treeVersion: 3,
  };
}

interface Sim {
  registry: Registry;
  /** Points of the taps the run sent. */
  taps: { x: number; y: number }[];
}

function device(typed: string | undefined, rows: string[], opts: Screen = {}): Sim {
  const sim: Sim = { taps: [], registry: undefined as unknown as Registry };
  const ax = { degraded: false, tree: async () => axTree(typed, rows, opts) };
  sim.registry = {
    resolveService: async () => ax,
    invokeTool: async (id: string, args: { x: number; y: number }) => {
      if (id === "list-devices") return { devices: [] };
      if (id === "gesture-tap") sim.taps.push({ x: args.x, y: args.y });
      return { ok: true };
    },
    getTool: () => ({ inputSchema: { properties: { udid: {} } } }),
  } as unknown as Registry;
  return sim;
}

type Step = Parameters<typeof serializeFlow>[0]["steps"][number];

async function run(sim: Sim, deviceId: string, steps: Step[]): Promise<FlowRunResult> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "flow-field-text-"));
  try {
    const dir = path.join(root, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "flow.yaml"),
      serializeFlow({ executionPrerequisite: "", steps }),
      "utf8"
    );
    const r = await createRunFlowTool(sim.registry).execute(
      {},
      { name: "flow", project_root: root, device: deviceId }
    );
    if (!("steps" in r)) throw new Error(`expected a run result, got notice: ${r.notice}`);
    return r;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

const centreY = (f: { y: number; height: number }) => f.y + f.height / 2;
const text = (t: string) => ({ text: t });

describe.concurrent("the text a filled field holds on an iOS simulator", () => {
  it("does not make the field a tap target: the row with the same text gets the tap", async ({
    expect,
  }) => {
    const sim = device("Paris", ["Berlin", "Paris"]);
    const result = await run(sim, "00000000-0000-0000-0000-0000000000d1", [
      { kind: "tap", selector: text("Paris") },
    ]);

    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(sim.taps).toHaveLength(1);
    expect(sim.taps[0].y).toBeCloseTo(centreY({ ...ROW_FRAME, y: ROW_FRAME.y + 0.08 }), 6);
  });

  it("still finds the field by that text for a type step's into", async ({ expect }) => {
    const sim = device("Paris", []);
    const result = await run(sim, "00000000-0000-0000-0000-0000000000d2", [
      { kind: "type", into: text("Paris"), text: " France", submit: false },
    ]);

    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(sim.taps[0].y).toBeCloseTo(centreY(FIELD_FRAME), 6);
  });

  it("still finds an empty field by its placeholder", async ({ expect }) => {
    const sim = device(undefined, ["Paris"]);
    const result = await run(sim, "00000000-0000-0000-0000-0000000000d3", [
      { kind: "type", into: text("Search"), text: "Paris", submit: false },
    ]);

    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(sim.taps[0].y).toBeCloseTo(centreY(FIELD_FRAME), 6);
  });

  it("still reads the text in a text check on the field", async ({ expect }) => {
    const sim = device("Paris", []);
    const result = await run(sim, "00000000-0000-0000-0000-0000000000d4", [
      {
        kind: "assert",
        condition: "text",
        selector: { role: "AXTextField" },
        expectedText: "Paris",
      },
    ]);

    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
  });

  it("does not satisfy a visible check, and the miss names the field", async ({ expect }) => {
    const sim = device("Paris", ["Berlin"]);
    const result = await run(sim, "00000000-0000-0000-0000-0000000000d5", [
      { kind: "assert", condition: "visible", selector: text("Paris") },
    ]);

    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toContain('no visible element matched selector text="Paris"');
    expect(result.steps[0].reason).toContain(
      "only a text field holds this text, and a selector does not match a text field by the text in it"
    );
  }, 20_000);

  it("names the field on a tap miss too", async ({ expect }) => {
    const sim = device("Paris", ["Berlin"]);
    const result = await run(sim, "00000000-0000-0000-0000-0000000000d6", [
      { kind: "tap", selector: text("Paris") },
    ]);

    expect(result.steps[0].status).toBe("fail");
    expect(sim.taps).toEqual([]);
    expect(result.steps[0].reason).toContain("only a text field holds this text");
  }, 20_000);

  it("passes a hidden check on that text while the field still holds it", async ({ expect }) => {
    const sim = device("Paris", ["Berlin"]);
    const result = await run(sim, "00000000-0000-0000-0000-0000000000d7", [
      { kind: "assert", condition: "hidden", selector: text("Paris") },
    ]);

    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
  });

  it("does not use the field as a next anchor", async ({ expect }) => {
    // The only "Paris" is the field's text, so the anchor resolves to nothing.
    const sim = device("Paris", ["Berlin"]);
    const result = await run(sim, "00000000-0000-0000-0000-0000000000d8", [
      { kind: "tap", selector: { text: "Berlin", next: text("Paris") } },
    ]);

    expect(result.steps[0].status).toBe("fail");
    expect(sim.taps).toEqual([]);
  }, 20_000);
  it("names the field when the selector has an id too", async ({ expect }) => {
    const sim = device("Paris", ["Berlin"]);
    const result = await run(sim, "00000000-0000-0000-0000-0000000000d9", [
      { kind: "assert", condition: "visible", selector: { identifier: "search", text: "Paris" } },
    ]);

    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toContain("only a text field holds this text");
    expect(result.steps[0].reason).toContain("use a `text` condition on the field");
  }, 20_000);

  it("does not name the field on a read the daemon cut short", async ({ expect }) => {
    // The element that shows the text can be past the cut.
    const sim = device("Paris", ["Berlin"], { truncated: true });
    const result = await run(sim, "00000000-0000-0000-0000-0000000000da", [
      { kind: "tap", selector: text("Paris") },
    ]);

    expect(result.steps[0].status).toBe("fail");
    expect(sim.taps).toEqual([]);
    expect(result.steps[0].reason).not.toContain("only a text field holds this text");
    expect(result.steps[0].reason).toBe(
      'no visible element matched selector text="Paris": the UI tree was cut at a size limit, ' +
        "and an element past the cut is not in the tree. Reduce what the screen shows before " +
        "this step (for example, close a long list or web page)."
    );
  }, 20_000);
});
