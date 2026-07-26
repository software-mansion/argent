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

async function run(name: string): Promise<FlowRunResult & { taps: TapCall[] }> {
  const taps: TapCall[] = [];
  const tool = createRunFlowTool(mockRegistry(taps));
  const result = asRun(await tool.execute({}, { name, project_root: tmpDir, device: DEVICE }));
  return Object.assign(result, { taps });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-within-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// Two identical "Delete" buttons in different cards — the screen shape the
// `within` scope exists to disambiguate. FLAT leaves under the root, exactly
// the shape every flow adapter emits (flow-tree-flatten): the scope must
// resolve from frames, since ancestry does not survive flattening.
function twoCards(): DescribeNode {
  return screen([
    n({ identifier: "profile-card", frame: { x: 0, y: 0.1, width: 1, height: 0.3 } }),
    n({ role: "AXButton", label: "Delete", frame: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 } }),
    n({ identifier: "billing-card", frame: { x: 0, y: 0.5, width: 1, height: 0.3 } }),
    n({ role: "AXButton", label: "Delete", frame: { x: 0.1, y: 0.6, width: 0.3, height: 0.1 } }),
  ]);
}

describe("within (descendant) selector resolution", () => {
  it("tap resolves the button inside the named container, not the first one on screen", async () => {
    currentTree = twoCards;

    await writeFlow("scoped", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "tap",
          selector: { text: "Delete", within: { identifier: "billing-card" } },
        },
      ],
    });

    const result = await run("scoped");
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["tap:pass"]);
    // Centre of the billing-card button (y 0.6 + 0.1/2), not profile-card's.
    expect(result.taps).toHaveLength(1);
    expect(result.taps[0].y).toBeCloseTo(0.65, 6);
  });

  it("a bare-string within resolves identifier-first, like every loose selector", async () => {
    // The container is exposed ONLY via testID — a strict text scope would
    // never find it; the loose `within: billing-card` must.
    currentTree = twoCards;

    await writeFlow("loosescope", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "tap",
          selector: {
            text: "Delete",
            within: { text: "billing-card", loose: true },
          },
        },
      ],
    });

    const result = await run("loosescope");
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["tap:pass"]);
    expect(result.taps[0].y).toBeCloseTo(0.65, 6);
  });

  it("await passes only when the target is inside the container", async () => {
    currentTree = () =>
      screen([
        n({ identifier: "toast-area", frame: { x: 0, y: 0.8, width: 1, height: 0.2 } }),
        n({ label: "Saved", frame: { x: 0.3, y: 0.85, width: 0.4, height: 0.05 } }),
      ]);

    await writeFlow("scopedawait", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "await",
          condition: "visible",
          selector: { text: "Saved", within: { identifier: "toast-area" } },
        },
      ],
    });

    const result = await run("scopedawait");
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["await:pass"]);
  });

  it("assert hidden holds when the only match sits OUTSIDE the container", async () => {
    // "Saved" exists on screen, but not inside toast-area — the scoped
    // `hidden` must pass where an unscoped one would fail.
    currentTree = () =>
      screen([
        n({ identifier: "toast-area", frame: { x: 0, y: 0.8, width: 1, height: 0.2 } }),
        n({ label: "Saved", frame: { x: 0.3, y: 0.1, width: 0.4, height: 0.05 } }),
      ]);

    await writeFlow("scopedhidden", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "hidden",
          selector: { text: "Saved", within: { identifier: "toast-area" } },
        },
        { kind: "assert", condition: "visible", selector: { text: "Saved" } },
      ],
    });

    const result = await run("scopedhidden");
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "assert:pass",
      "assert:pass",
    ]);
  });

  it("the step report target renders the within scope so scoped steps aren't indistinguishable", async () => {
    // Two taps that differ ONLY by their `within` container must not collapse to
    // the same report `target` label — the report stringifier (`selectorLabel`)
    // has to render the scope, in lockstep with the reason stringifier
    // (`describeSelector`).
    currentTree = twoCards;

    await writeFlow("scopedlabel", {
      executionPrerequisite: "",
      steps: [
        { kind: "tap", selector: { text: "Delete", within: { identifier: "billing-card" } } },
        { kind: "tap", selector: { text: "Delete", within: { identifier: "profile-card" } } },
      ],
    });

    const result = await run("scopedlabel");
    expect(result.steps.map((s) => s.target)).toEqual([
      '"Delete" within (id=billing-card)',
      '"Delete" within (id=profile-card)',
    ]);
  });

  // An unresolved action intentionally consumes its 7.5s auto-wait budget.
  it("a failed scoped tap names the scope in its reason", async () => {
    currentTree = () =>
      screen([n({ label: "Delete", frame: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 } })]);

    await writeFlow("scopedmiss", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "tap",
          selector: { text: "Delete", within: { identifier: "billing-card" } },
        },
      ],
    });

    const result = await run("scopedmiss");
    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toContain('within (id="billing-card")');
    expect(result.taps).toHaveLength(0);
  }, 10_000);
});

// A settings list: three rows, each a label plus a switch to its right. The
// switches are taller than their labels, so each sits a hair HIGHER — the shape
// that makes a naive top-to-bottom reading order pick the wrong row's control.
function settingsRows(): DescribeNode {
  return screen(
    [
      ["Airplane Mode", 0.2],
      ["Wi-Fi", 0.35],
      ["Bluetooth", 0.5],
    ].flatMap(([label, y]) => [
      n({ label: label as string, frame: { x: 0.05, y: y as number, width: 0.4, height: 0.04 } }),
      n({
        role: "AXSwitch",
        frame: { x: 0.8, y: (y as number) - 0.005, width: 0.15, height: 0.05 },
      }),
    ])
  );
}

describe("after / next (sibling) selector resolution", () => {
  it("tap resolves the switch belonging to the named row, not the first on screen", async () => {
    currentTree = settingsRows;

    await writeFlow("nextrow", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", selector: { role: "AXSwitch", next: { text: "Wi-Fi" } } }],
    });

    const result = await run("nextrow");
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["tap:pass"]);
    // Centre of the Wi-Fi row's switch (y 0.345 + 0.05/2), not Airplane Mode's.
    expect(result.taps).toHaveLength(1);
    expect(result.taps[0].x).toBeCloseTo(0.875, 6);
    expect(result.taps[0].y).toBeCloseTo(0.37, 6);
  });

  it("a universal `any: true` selector taps the element right after the anchor", async () => {
    currentTree = settingsRows;

    await writeFlow("anynext", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", selector: { any: true, next: { text: "Bluetooth" } } }],
    });

    const result = await run("anynext");
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["tap:pass"]);
    expect(result.taps[0].y).toBeCloseTo(0.52, 6);
  });

  it("assert hidden holds when the only match sits BEFORE the anchor", async () => {
    // The Airplane Mode row is above the Wi-Fi one, so it follows nothing there
    // — while the very same target is plainly visible unscoped, and the rows
    // below Airplane Mode do follow it.
    currentTree = settingsRows;

    await writeFlow("afterhidden", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "hidden",
          selector: { text: "Airplane Mode", after: { text: "Wi-Fi" } },
        },
        { kind: "assert", condition: "visible", selector: { text: "Airplane Mode" } },
        {
          kind: "assert",
          condition: "visible",
          selector: { text: "Bluetooth", after: { text: "Wi-Fi" } },
        },
      ],
    });

    const result = await run("afterhidden");
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "assert:pass",
      "assert:pass",
      "assert:pass",
    ]);
  });

  it("a bare-string sibling scope resolves identifier-first, like every loose selector", async () => {
    // The anchor is exposed ONLY via testID — a strict text scope would never
    // find it, so the loose fallback has to reach the identifier pass at depth.
    currentTree = () =>
      screen([
        n({ identifier: "wifi-row", frame: { x: 0.05, y: 0.35, width: 0.4, height: 0.04 } }),
        n({ role: "AXSwitch", frame: { x: 0.8, y: 0.345, width: 0.15, height: 0.05 } }),
      ]);

    await writeFlow("loosenext", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "tap",
          selector: { role: "AXSwitch", next: { text: "wifi-row", loose: true } },
        },
      ],
    });

    const result = await run("loosenext");
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["tap:pass"]);
    expect(result.taps[0].y).toBeCloseTo(0.37, 6);
  });

  it("the step report target renders sibling scopes so scoped steps aren't indistinguishable", async () => {
    currentTree = settingsRows;

    await writeFlow("scopelabels", {
      executionPrerequisite: "",
      steps: [
        { kind: "tap", selector: { role: "AXSwitch", next: { text: "Wi-Fi" } } },
        { kind: "tap", selector: { any: true, next: { text: "Bluetooth" } } },
      ],
    });

    const result = await run("scopelabels");
    expect(result.steps.map((s) => s.target)).toEqual([
      'role=AXSwitch next ("Wi-Fi")',
      '* next ("Bluetooth")',
    ]);
  });

  // An unresolved action intentionally consumes its 7.5s auto-wait budget.
  it("a failed sibling-scoped tap names the scope in its reason", async () => {
    currentTree = () =>
      screen([n({ role: "AXSwitch", frame: { x: 0.8, y: 0.1, width: 0.15, height: 0.05 } })]);

    await writeFlow("nextmiss", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", selector: { role: "AXSwitch", next: { text: "Wi-Fi" } } }],
    });

    const result = await run("nextmiss");
    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toContain('next (text="Wi-Fi")');
    expect(result.taps).toHaveLength(0);
  }, 10_000);
});
