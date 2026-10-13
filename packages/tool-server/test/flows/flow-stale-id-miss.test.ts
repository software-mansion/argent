import { describe, vi, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { AXTreeNode, AXTreeResponse } from "../../src/blueprints/ax-service";
import { readIosSimulatorUiTree } from "../../src/tools/flows/flow-ios-tree";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow, type FlowSelector } from "../../src/tools/flows/flow-utils";

// The reason a selector miss reports, through the REAL runner and the real
// simulator tree read. The only seams are the services, and a pass-through spy
// on the miss path's extra read so a test can fail it or count it: the flow's
// own reads call the reader inside its module, past the spy.
vi.mock("../../src/tools/flows/flow-ios-tree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/flows/flow-ios-tree")>();
  return { ...actual, readIosSimulatorUiTree: vi.fn(actual.readIosSimulatorUiTree) };
});

const APP = "com.example.app";
const PLAIN =
  'no visible element matched selector id="house.fill" — if it is off-screen, add a scroll-to step before this one';
const STALE = "no element with this id is in the accessibility tree right now, on screen or off";

/** A tab bar whose Home button carries no id, plus whatever `extra` adds. */
function axTree(extra: AXTreeNode[]): AXTreeResponse {
  return {
    alertVisible: false,
    screenFrame: { width: 402, height: 874 },
    nodes: [
      { index: 0, label: APP, bundleId: APP },
      {
        index: 1,
        parentIndex: 0,
        label: "Home",
        traits: ["button", "selected"],
        frame: { x: 0, y: 0.92, width: 0.25, height: 0.06 },
      },
      ...extra,
    ],
    truncated: false,
    foregroundApp: APP,
    interfaceOrientation: "portrait",
    treeVersion: 3,
  };
}

const ANDROID_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="${APP}" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.Button" text="Home" clickable="true" package="${APP}" bounds="[0,1800][270,1920]" />
  </node>
</hierarchy>`;

interface Sim {
  registry: Registry;
  urns: string[];
  /** Tools the run dispatched, `list-devices` and the failure screenshot aside. */
  tools: string[];
}

function device(extra: AXTreeNode[] = []): Sim {
  const sim: Sim = { urns: [], tools: [], registry: undefined as unknown as Registry };
  const ax = { degraded: false, tree: async () => axTree(extra) };
  const android = {
    getHierarchy: async () => ({ xml: ANDROID_XML }),
    getScreenSize: async () => ({ width: 1080, height: 1920 }),
  };
  sim.registry = {
    resolveService: async (urn: string) => {
      sim.urns.push(urn);
      return urn.startsWith("AndroidDevtools") ? android : ax;
    },
    invokeTool: async (id: string) => {
      if (id === "list-devices") return { devices: [] };
      if (id !== "screenshot") sim.tools.push(id);
      return { ok: true };
    },
    getTool: () => ({ inputSchema: { properties: { udid: {} } } }),
  } as unknown as Registry;
  return sim;
}

type Step = Parameters<typeof serializeFlow>[0]["steps"][number];

/** Run one step that must fail without dispatching anything; returns its reason. */
async function stepFails(sim: Sim, deviceId: string, step: Step): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "flow-stale-id-"));
  try {
    const dir = path.join(root, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const flow = serializeFlow({ executionPrerequisite: "", steps: [step] });
    await fs.writeFile(path.join(dir, "flow.yaml"), flow, "utf8");
    const r = await createRunFlowTool(sim.registry).execute(
      {},
      { name: "flow", project_root: root, device: deviceId }
    );
    if (!("steps" in r)) throw new Error(`expected a run result, got notice: ${r.notice}`);
    const result: FlowRunResult = r;
    if (result.steps[0]?.status !== "fail" || sim.tools.length > 0) {
      throw new Error(
        `expected the step to fail undispatched: ${JSON.stringify([result.steps, sim.tools])}`
      );
    }
    return result.steps[0].reason ?? "";
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

/** The miss path's extra reads made against this registry. */
function extraReads(sim: Sim): number {
  return vi.mocked(readIosSimulatorUiTree).mock.calls.filter(([r]) => r === sim.registry).length;
}

const ID = { identifier: "house.fill" };
const tap = (selector: FlowSelector): Step => ({ kind: "tap", selector });

// Each case waits out the full auto-wait, so they run side by side; each owns
// its registry, device id and project root.
describe.concurrent("a selector miss on an id", () => {
  it("names a stale id when no node in the accessibility tree carries it", async ({ expect }) => {
    const sim = device();
    const reason = await stepFails(sim, "00000000-0000-0000-0000-0000000000a1", tap(ID));

    expect(reason).toContain('no visible element matched selector id="house.fill"');
    expect(reason).toContain(STALE);
    expect(reason).toContain("add an await or scroll-to step before this one");
    expect(reason).toContain("Argent 0.27.0 or earlier");
    expect(reason).toContain("re-record the step, or target the control `describe` shows there");
    expect(reason).not.toContain("if it is off-screen");
    expect(extraReads(sim)).toBe(1);
  }, 20_000);

  it.for<[string, string, Step]>([
    ["long-press", "b1", { kind: "long-press", selector: ID }],
    ["pinch", "b2", { kind: "pinch", selector: ID, scale: 2 }],
    ["rotate", "b3", { kind: "rotate", selector: ID, by: 90 }],
    ["swipe", "b4", { kind: "swipe", from: { selector: ID }, direction: "up" }],
    ["type", "b5", { kind: "type", into: ID, text: "hello" }],
    ["snapshot cropOn", "b6", { kind: "snapshot", name: "icon", cropOn: ID }],
  ])(
    "names a stale id on a %s step too",
    { timeout: 20_000 },
    async ([, suffix, step], { expect }) => {
      const sim = device();
      const reason = await stepFails(sim, `00000000-0000-0000-0000-0000000000${suffix}`, step);

      expect(reason).toContain(STALE);
      expect(extraReads(sim)).toBe(1);
    }
  );

  it("keeps the scroll-to hint when the id is on a node off the screen", async ({ expect }) => {
    const sim = device([
      {
        index: 2,
        parentIndex: 0,
        identifier: "house.fill",
        traits: ["image"],
        frame: { x: 0.1, y: 1.5, width: 0.1, height: 0.05 },
      },
    ]);
    const reason = await stepFails(sim, "00000000-0000-0000-0000-0000000000a2", tap(ID));

    expect(reason).toBe(PLAIN);
    expect(extraReads(sim)).toBe(1);
  }, 20_000);

  it("never reads the accessibility tree on Android", async ({ expect }) => {
    const sim = device();
    const reason = await stepFails(sim, "emulator-5554", tap(ID));

    expect(reason).toBe(PLAIN);
    expect(sim.urns.length).toBeGreaterThan(0);
    expect(sim.urns.filter((urn) => urn.startsWith("AXService"))).toEqual([]);
    expect(extraReads(sim)).toBe(0);
  }, 20_000);

  it("keeps the plain hint when the extra read fails", async ({ expect }) => {
    const sim = device();
    vi.mocked(readIosSimulatorUiTree).mockImplementation(async (registry, dev) => {
      if (registry === sim.registry) throw new Error("ax-service went away");
      const actual = await vi.importActual<typeof import("../../src/tools/flows/flow-ios-tree")>(
        "../../src/tools/flows/flow-ios-tree"
      );
      return actual.readIosSimulatorUiTree(registry, dev);
    });
    const reason = await stepFails(sim, "00000000-0000-0000-0000-0000000000a4", tap(ID));

    expect(reason).toBe(PLAIN);
    expect(extraReads(sim)).toBe(1);
  }, 20_000);

  it("keeps the plain hint for a bare string, which also tries its text", async ({ expect }) => {
    const sim = device();
    const reason = await stepFails(
      sim,
      "00000000-0000-0000-0000-0000000000a5",
      tap({ text: "house.fill", loose: true })
    );

    expect(reason).toBe(
      'no visible element matched selector text="house.fill" — if it is off-screen, add a scroll-to step before this one'
    );
    expect(extraReads(sim)).toBe(0);
  }, 20_000);
});
