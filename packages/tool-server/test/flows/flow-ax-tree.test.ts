import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { DeviceInfo, Registry } from "@argent/registry";
import {
  AX_SERVICE_NAMESPACE,
  type AXTreeNode,
  type AXTreeResponse,
} from "../../src/blueprints/ax-service";
import type { DescribeFrame, DescribeNode } from "../../src/tools/describe/contract";
import {
  deriveScopedSelector,
  queryAxFlowTree,
  queryIosSimulatorFlowTree,
  readSettledIosFlowTree,
} from "../../src/tools/flows/flow-ax-tree";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { parseFlow, serializeFlow } from "../../src/tools/flows/flow-utils";
import { evaluateCondition, findAll, selectorToFrame } from "../../src/utils/ui-tree-match";

// The iOS simulator flow tree: the accessibility daemon's `tree` (the source
// `describe` reads), projected into the flow contract - flat leaves under one
// root, hoisted `subtreeText` - and the recorder's selector derivation over it.
// Fixtures are `AXTreeResponse` objects as the daemon sends them: nodes in
// document order, nested by `parentIndex`, frames normalized 0-1, and
// `accessible: true` on the VoiceOver targets a finger lands on.

const UDID = "00000000-0000-0000-0000-0000000000ab";
const DEVICE: DeviceInfo = { id: UDID, platform: "ios", kind: "simulator" };
const FULL: DescribeFrame = { x: 0, y: 0, width: 1, height: 1 };
/** The app element every daemon tree starts with; its children are the screen. */
const APP: AXTreeNode = { index: 0, label: "MyApp", frame: FULL };

function reply(nodes: AXTreeNode[], extra: Partial<AXTreeResponse> = {}): AXTreeResponse {
  return {
    alertVisible: false,
    screenFrame: { width: 402, height: 874 },
    nodes: [APP, ...nodes],
    truncated: false,
    ...extra,
  };
}

/**
 * A registry whose ax-service answers `tree()` from `responses` in turn (the
 * last one repeats), recording the URN of every read in `reads`. The tool
 * surface answers the runner's launch and tool steps inertly.
 */
function registryServing(
  responses: AXTreeResponse | AXTreeResponse[],
  reads: string[] = [],
  toolCalls: Array<{ id: string; args: Record<string, unknown> }> = []
): Registry {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  return {
    resolveService: vi.fn(async (urn: string) => ({
      tree: async () => {
        reads.push(urn);
        return queue.length > 1 ? queue.shift()! : queue[0]!;
      },
    })),
    invokeTool: vi.fn(async (id: string, args: Record<string, unknown>) => {
      toolCalls.push({ id, args });
      return id === "list-devices" ? { devices: [] } : { ok: true };
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
  } as unknown as Registry;
}

async function project(nodes: AXTreeNode[], extra: Partial<AXTreeResponse> = {}) {
  return queryAxFlowTree(registryServing(reply(nodes, extra)), DEVICE);
}

const centre = (f: DescribeFrame) => ({ x: f.x + f.width / 2, y: f.y + f.height / 2 });
/** The flat leaves, named by id, else label, else role, in emission order. */
const leaves = (tree: DescribeNode) => tree.children.map((n) => n.identifier ?? n.label ?? n.role);
const one = (tree: DescribeNode, sel: Parameters<typeof findAll>[1]): DescribeNode => {
  const all = findAll(tree, sel);
  expect(all).toHaveLength(1);
  return all[0]!;
};
function expectFrame(actual: DescribeFrame | undefined, expected: DescribeFrame): void {
  expect(actual).toBeDefined();
  for (const k of ["x", "y", "width", "height"] as const)
    expect(actual![k]).toBeCloseTo(expected[k], 9);
}

describe("queryAxFlowTree projects the daemon tree into the flow contract", () => {
  it("keeps an id-only container as a leaf and emits none for a bare group or the app element", async () => {
    const { tree, source } = await project([
      // A layout group with nothing to name: no leaf, but its subtree is walked.
      { index: 1, parentIndex: 0, frame: { x: 0, y: 0.1, width: 1, height: 0.3 } },
      // A testID-only row: what `describe` trims and a `within` scope names.
      {
        index: 2,
        parentIndex: 1,
        identifier: "feedItem-by-alice",
        frame: { x: 0, y: 0.1, width: 1, height: 0.2 },
      },
      {
        index: 3,
        parentIndex: 2,
        label: "Alice",
        traits: ["staticText"],
        accessible: true,
        frame: { x: 0.05, y: 0.12, width: 0.5, height: 0.05 },
      },
      // Content with a role but no text is still a node: an unlabelled image.
      {
        index: 4,
        parentIndex: 0,
        traits: ["image"],
        accessible: true,
        frame: { x: 0.1, y: 0.5, width: 0.3, height: 0.2 },
      },
    ]);

    expect(source).toBe("ax-service");
    // Flat: every leaf sits directly under the synthetic root.
    expect(tree.children.every((n) => n.children.length === 0)).toBe(true);
    // Post-order, like every flow tree; neither the group nor "MyApp" is a leaf.
    expect(leaves(tree)).toEqual(["Alice", "feedItem-by-alice", "AXImage"]);
    expectFrame(selectorToFrame(tree, { identifier: "feedItem-by-alice" }), {
      x: 0,
      y: 0.1,
      width: 1,
      height: 0.2,
    });
  });

  it("drops what a presentation covers, and nodes off the screen", async () => {
    const { tree } = await project([
      // The screen under a sheet: on screen, not reachable.
      {
        index: 1,
        parentIndex: 0,
        identifier: "login-form",
        covered: true,
        frame: { x: 0, y: 0.1, width: 1, height: 0.5 },
      },
      {
        index: 2,
        parentIndex: 1,
        label: "Log in",
        traits: ["button"],
        accessible: true,
        frame: { x: 0.1, y: 0.4, width: 0.8, height: 0.1 },
      },
      {
        index: 3,
        parentIndex: 0,
        identifier: "confirm-sheet",
        frame: { x: 0, y: 0.6, width: 1, height: 0.4 },
      },
      {
        index: 4,
        parentIndex: 3,
        label: "Confirm",
        traits: ["button"],
        accessible: true,
        frame: { x: 0.1, y: 0.8, width: 0.8, height: 0.1 },
      },
      // Scrolled out, zero-area, frameless: no leaf, as the simulator projection always did.
      {
        index: 5,
        parentIndex: 0,
        label: "Below the fold",
        traits: ["staticText"],
        frame: { x: 0, y: 1.2, width: 1, height: 0.1 },
      },
      {
        index: 6,
        parentIndex: 0,
        label: "Zero",
        traits: ["staticText"],
        frame: { x: 0.5, y: 0.5, width: 0, height: 0.1 },
      },
      { index: 7, parentIndex: 0, label: "No frame", traits: ["staticText"] },
      // Partly off the right edge: kept, clamped to the screen.
      {
        index: 8,
        parentIndex: 0,
        label: "Edge",
        traits: ["staticText"],
        frame: { x: 0.9, y: 0.5, width: 0.3, height: 0.1 },
      },
    ]);

    expect(leaves(tree)).toEqual(["Confirm", "confirm-sheet", "Edge"]);
    // The covered subtree is gone whole, text included: a `hidden` check on the
    // sheet's underlay holds, and nothing hoists from under it.
    expect(JSON.stringify(tree)).not.toContain("Log in");
    expect(findAll(tree, { identifier: "login-form" })).toHaveLength(0);
    expectFrame(selectorToFrame(tree, { text: "Edge" }), {
      x: 0.9,
      y: 0.5,
      width: 0.1,
      height: 0.1,
    });
  });

  it("merges a child sharing its parent's frame, label and value, carrying id, focus and role up", async () => {
    const F = { x: 0.1, y: 0.5, width: 0.8, height: 0.1 };
    const G = { x: 0.1, y: 0.2, width: 0.8, height: 0.08 };
    const H = { x: 0.8, y: 0.7, width: 0.15, height: 0.06 };
    const { tree } = await project([
      // A UIButton over its title label: one element, not two "Save" matches.
      { index: 1, parentIndex: 0, label: "Save", traits: ["button"], accessible: true, frame: F },
      {
        index: 2,
        parentIndex: 1,
        label: "Save",
        identifier: "save-button",
        traits: ["staticText"],
        frame: F,
      },
      // A text field over its editing text: the focus carries up.
      {
        index: 3,
        parentIndex: 0,
        value: "a@b.c",
        traits: ["textEntry"],
        accessible: true,
        frame: G,
      },
      { index: 4, parentIndex: 3, value: "a@b.c", traits: ["isEditing"], frame: G },
      // A testID-only wrapper over the control it wraps: the wrapper takes the role.
      { index: 5, parentIndex: 0, identifier: "like", frame: H },
      { index: 6, parentIndex: 5, traits: ["button"], accessible: true, frame: H },
    ]);

    expect(tree.children).toHaveLength(3);
    expect(one(tree, { text: "Save" })).toMatchObject({
      identifier: "save-button",
      role: "AXButton",
      label: "Save",
    });
    expect(one(tree, { text: "a@b.c" })).toMatchObject({ role: "AXTextField", focused: true });
    expect(one(tree, { identifier: "like" })).toMatchObject({ role: "AXButton" });
  });

  it("carries focused, disabled, selected and checked onto the leaves", async () => {
    const row = (y: number) => ({ x: 0.1, y, width: 0.8, height: 0.06 });
    const { tree } = await project([
      {
        index: 1,
        parentIndex: 0,
        label: "Submit",
        traits: ["button", "notEnabled"],
        frame: row(0.1),
      },
      { index: 2, parentIndex: 0, label: "Home", traits: ["button", "selected"], frame: row(0.2) },
      {
        index: 3,
        parentIndex: 0,
        value: "hello",
        traits: ["textEntry", "isEditing"],
        frame: row(0.3),
      },
      {
        index: 4,
        parentIndex: 0,
        label: "Wi-Fi",
        traits: ["toggleButton"],
        value: "1",
        frame: row(0.4),
      },
      {
        index: 5,
        parentIndex: 0,
        label: "Bluetooth",
        traits: ["toggleButton"],
        value: "0",
        frame: row(0.5),
      },
    ]);

    expect(one(tree, { text: "Submit" })).toMatchObject({ disabled: true });
    expect(one(tree, { text: "Submit" }).selected).toBeUndefined();
    expect(one(tree, { text: "Home" })).toMatchObject({ selected: true });
    expect(one(tree, { text: "hello" })).toMatchObject({ focused: true });
    expect(one(tree, { text: "Wi-Fi" })).toMatchObject({ checked: true });
    expect(one(tree, { text: "Bluetooth" })).toMatchObject({ checked: false });
  });

  it("reports the screen size, and a hint only when the daemon cut the walk", async () => {
    const nodes: AXTreeNode[] = [
      {
        index: 1,
        parentIndex: 0,
        label: "Ready",
        traits: ["staticText"],
        frame: { x: 0, y: 0.1, width: 1, height: 0.1 },
      },
    ];

    const whole = await project(nodes);
    expect(whole.screen).toEqual({ width: 402, height: 874 });
    expect(whole.hint).toBeUndefined();

    const cut = await project(nodes, { truncated: true });
    expect(cut.hint).toMatch(/cut at the daemon's node or depth cap/);
    expect(leaves(cut.tree)).toEqual(["Ready"]);
  });

  it("walks a second root's children while an alert shows, never the app elements themselves", async () => {
    const { tree } = await queryAxFlowTree(
      registryServing({
        alertVisible: true,
        nodes: [
          APP,
          {
            index: 1,
            parentIndex: 0,
            label: "Log in",
            traits: ["button"],
            covered: true,
            frame: { x: 0.1, y: 0.4, width: 0.8, height: 0.1 },
          },
          { index: 2, label: "SpringBoard", frame: FULL },
          {
            index: 3,
            parentIndex: 2,
            label: "Allow",
            traits: ["button"],
            accessible: true,
            frame: { x: 0.3, y: 0.5, width: 0.4, height: 0.08 },
          },
        ],
        truncated: false,
      }),
      DEVICE
    );

    expect(leaves(tree)).toEqual(["Allow"]);
    expect(JSON.stringify(tree)).not.toMatch(/MyApp|SpringBoard/);
  });

  it("hoists descendant text onto an identified container, scoped to the nearest identified ancestor", async () => {
    const { tree } = await project([
      {
        index: 1,
        parentIndex: 0,
        identifier: "feed",
        frame: { x: 0, y: 0.1, width: 1, height: 0.8 },
      },
      {
        index: 2,
        parentIndex: 1,
        label: "Feed title",
        traits: ["header"],
        frame: { x: 0.05, y: 0.12, width: 0.9, height: 0.05 },
      },
      {
        index: 3,
        parentIndex: 1,
        identifier: "feedItem-by-alice",
        frame: { x: 0, y: 0.2, width: 1, height: 0.2 },
      },
      {
        index: 4,
        parentIndex: 3,
        label: "Alice",
        traits: ["staticText"],
        frame: { x: 0.05, y: 0.22, width: 0.3, height: 0.05 },
      },
      {
        index: 5,
        parentIndex: 3,
        label: "Hello there",
        traits: ["staticText"],
        frame: { x: 0.05, y: 0.3, width: 0.9, height: 0.05 },
      },
    ]);

    const card = one(tree, { identifier: "feedItem-by-alice" });
    expect(card.subtreeText).toBe("Alice Hello there");
    expect(evaluateCondition("text", "Alice Hello there", [card], "equals")).toBe(true);
    expect(evaluateCondition("text", "Hello", [card], "contains")).toBe(true);
    // The card shields its text: the outer container sees only its own child.
    expect(one(tree, { identifier: "feed" }).subtreeText).toBe("Feed title");
  });

  it("does not double a container's label its child renders, but keeps one a child only contains", async () => {
    const { tree } = await project([
      {
        index: 1,
        parentIndex: 0,
        label: "Submit",
        identifier: "submit",
        traits: ["button"],
        accessible: true,
        frame: { x: 0.1, y: 0.7, width: 0.8, height: 0.1 },
      },
      // A different frame, so the merge does not fold it: the hoist must dedupe.
      {
        index: 2,
        parentIndex: 1,
        label: "Submit",
        traits: ["staticText"],
        frame: { x: 0.4, y: 0.73, width: 0.2, height: 0.04 },
      },
      {
        index: 3,
        parentIndex: 0,
        label: "Save",
        identifier: "save",
        traits: ["button"],
        accessible: true,
        frame: { x: 0.1, y: 0.5, width: 0.8, height: 0.1 },
      },
      {
        index: 4,
        parentIndex: 3,
        label: "Saved successfully",
        traits: ["staticText"],
        frame: { x: 0.2, y: 0.52, width: 0.6, height: 0.05 },
      },
    ]);

    const submit = one(tree, { identifier: "submit" });
    expect(submit.subtreeText).toBeUndefined();
    expect(evaluateCondition("text", "Submit", [submit], "equals")).toBe(true);
    expect(one(tree, { identifier: "save" }).subtreeText).toBe("Save Saved successfully");
  });

  it("hoists no text from an off-screen descendant", async () => {
    const { tree } = await project([
      {
        index: 1,
        parentIndex: 0,
        identifier: "list",
        frame: { x: 0, y: 0.1, width: 1, height: 0.9 },
      },
      {
        index: 2,
        parentIndex: 1,
        label: "Visible row",
        traits: ["staticText"],
        frame: { x: 0, y: 0.2, width: 1, height: 0.1 },
      },
      {
        index: 3,
        parentIndex: 1,
        label: "Scrolled-out row",
        traits: ["staticText"],
        frame: { x: 0, y: 1.3, width: 1, height: 0.1 },
      },
    ]);

    expect(one(tree, { identifier: "list" }).subtreeText).toBe("Visible row");
    expect(findAll(tree, { text: "Scrolled-out row" })).toHaveLength(0);
  });
});

describe("queryIosSimulatorFlowTree: the daemon, or the explained outage", () => {
  const PIN = reply([
    {
      index: 1,
      parentIndex: 0,
      identifier: "pin-wawel",
      label: "Wawel Castle",
      accessible: true,
      frame: { x: 0.5, y: 0.4, width: 0.1, height: 0.05 },
    },
  ]);
  /** A registry whose daemon behaves as `ax` says: a tree, a thrown reason, or a blind read. */
  function registryWith(ax: AXTreeResponse | Error | "blind" | "blind-degraded"): Registry {
    return {
      resolveService: vi.fn(async (urn: string) => {
        if (!urn.startsWith(`${AX_SERVICE_NAMESPACE}:`)) throw new Error(`no service for ${urn}`);
        if (ax instanceof Error) throw ax;
        return {
          degraded: ax === "blind-degraded",
          tree: async () => (typeof ax === "string" ? { ...reply([]), nodes: [] } : ax),
        };
      }),
      invokeTool: vi.fn(async (id: string) =>
        id === "list-devices" ? { devices: [] } : { ok: true }
      ),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    } as unknown as Registry;
  }

  it("reads the daemon when it answers", async () => {
    const { tree, source } = await queryIosSimulatorFlowTree(registryWith(PIN), DEVICE);

    expect(source).toBe("ax-service");
    expect(leaves(tree)).toEqual(["pin-wawel"]);
  });

  it("fails with the reason and the fix when the daemon does not resolve", async () => {
    await expect(
      queryIosSimulatorFlowTree(
        registryWith(new Error("no ax-service binary for this simulator")),
        DEVICE
      )
    ).rejects.toThrow(
      /is not available for .* \(no ax-service binary for this simulator\)\. Flows on a simulator resolve selectors against its tree and have no other source\. To fix: check that the simulator is booted, then restart the daemon with `stop-all-simulator-servers`/
    );
  });

  it("tells a daemon build without `tree` to update argent", async () => {
    await expect(
      queryIosSimulatorFlowTree(
        registryWith(new Error("ax-service predates `tree`; update argent")),
        DEVICE
      )
    ).rejects.toThrow(
      /To fix: update argent so its accessibility daemon serves the `tree` command/
    );
  });

  it("names a blind read, and the boot remedy when the simulator was not booted through argent", async () => {
    await expect(queryIosSimulatorFlowTree(registryWith("blind"), DEVICE)).rejects.toThrow(
      /returned no elements for .*To fix: wait for the screen to settle and relaunch the app/
    );
    await expect(queryIosSimulatorFlowTree(registryWith("blind-degraded"), DEVICE)).rejects.toThrow(
      /not booted through argent.*To fix: boot the simulator through argent \(`boot-device` with `force: true`\)/
    );
  });

  it("surfaces the same error from the recorder's settled read", async () => {
    await expect(
      readSettledIosFlowTree(registryWith(new Error("ax-service not connected")), DEVICE, 300)
    ).rejects.toThrow(/is not available for .*ax-service not connected/);
  });

  it("fails the launch step with the explained outage, so the run stops before a selector", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-ax-outage-"));
    try {
      const dir = path.join(tmp, ".argent", "flows");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "out.yaml"),
        serializeFlow({
          executionPrerequisite: "",
          steps: [
            { kind: "launch", app: "com.example.app" },
            { kind: "assert", condition: "visible", selector: { identifier: "ok-btn" } },
          ],
        }),
        "utf8"
      );
      const result = await createRunFlowTool(
        registryWith(new Error("no ax-service binary for this simulator"))
      ).execute({}, { name: "out", project_root: tmp, device: UDID });
      if (!("steps" in result)) throw new Error(`notice: ${result.notice}`);
      const run = result as FlowRunResult;

      expect(run.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
        "launch:error",
        "assert:skip",
      ]);
      expect(run.steps[0].reason).toContain(
        "the accessibility daemon (ax-service) is not available for"
      );
      expect(run.steps[0].reason).toContain("To fix:");
      expect(run.ok).toBe(false);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("readSettledIosFlowTree", () => {
  const row = { x: 0, y: 0.1, width: 1, height: 0.1 };
  const LOADING = reply([
    { index: 1, parentIndex: 0, label: "Loading", traits: ["staticText"], frame: row },
  ]);
  const READY = reply([
    { index: 1, parentIndex: 0, label: "Ready", traits: ["staticText"], frame: row },
  ]);

  it("re-reads until two consecutive reads agree", async () => {
    const reads: string[] = [];

    const { tree } = await readSettledIosFlowTree(
      registryServing([LOADING, READY, READY], reads),
      DEVICE
    );

    expect(reads).toHaveLength(3);
    expect(leaves(tree)).toEqual(["Ready"]);
  });

  it("takes one slow read as it is instead of a second read past the budget", async () => {
    const reads: string[] = [];
    const registry = {
      resolveService: async () => ({
        tree: async () => {
          reads.push("r");
          await new Promise((r) => setTimeout(r, 120));
          return LOADING;
        },
      }),
    } as unknown as Registry;

    const { tree } = await readSettledIosFlowTree(registry, DEVICE, 100);

    expect(reads).toHaveLength(1);
    expect(leaves(tree)).toEqual(["Loading"]);
  });

  it("returns the last read when the screen never holds still within the budget", async () => {
    let served = 0;
    let last: AXTreeResponse = LOADING;
    const registry = {
      resolveService: async () => ({
        tree: async () => {
          served += 1;
          last = served % 2 ? LOADING : READY;
          return last;
        },
      }),
    } as unknown as Registry;

    const { tree } = await readSettledIosFlowTree(registry, DEVICE, 300);

    expect(served).toBeGreaterThanOrEqual(2);
    expect(served).toBeLessThanOrEqual(4);
    expect(leaves(tree)).toEqual([last.nodes[1]!.label]);
  });
});

describe("deriveScopedSelector", () => {
  const ROW = { x: 0.1, y: 0.5, width: 0.8, height: 0.1 };

  it("uses a unique stable id as it is", async () => {
    const { tree } = await project([
      {
        index: 1,
        parentIndex: 0,
        identifier: "login",
        label: "Log in",
        traits: ["button"],
        accessible: true,
        frame: ROW,
      },
    ]);

    expect(deriveScopedSelector(tree, centre(ROW))).toEqual({
      selector: { identifier: "login" },
      strategy: "id",
    });
  });

  it("scopes a repeated id by the nearest stable ancestor id", async () => {
    const like = (y: number) => ({ x: 0.8, y, width: 0.15, height: 0.05 });
    const { tree } = await project([
      {
        index: 1,
        parentIndex: 0,
        identifier: "feedItem-by-alice",
        frame: { x: 0, y: 0.1, width: 1, height: 0.2 },
      },
      {
        index: 2,
        parentIndex: 1,
        identifier: "like-button",
        label: "Like",
        traits: ["button"],
        accessible: true,
        frame: like(0.15),
      },
      {
        index: 3,
        parentIndex: 0,
        identifier: "feedItem-by-bob",
        frame: { x: 0, y: 0.3, width: 1, height: 0.2 },
      },
      {
        index: 4,
        parentIndex: 3,
        identifier: "like-button",
        label: "Like",
        traits: ["button"],
        accessible: true,
        frame: like(0.35),
      },
    ]);

    expect(deriveScopedSelector(tree, centre(like(0.35)))).toEqual({
      selector: { identifier: "like-button", within: { identifier: "feedItem-by-bob" } },
      strategy: "within",
      scope: "feedItem-by-bob",
    });
  });

  it("uses the text plus role when the element has no id", async () => {
    const { tree } = await project([
      {
        index: 1,
        parentIndex: 0,
        label: "Continue",
        traits: ["button"],
        accessible: true,
        frame: ROW,
      },
    ]);

    expect(deriveScopedSelector(tree, centre(ROW))).toEqual({
      selector: { text: "Continue", role: "AXButton" },
      strategy: "text",
    });
  });

  it("anchors on a unique preceding text with `next` when neither id nor container helps", async () => {
    const label = (y: number) => ({ x: 0.05, y, width: 0.4, height: 0.05 });
    const toggle = (y: number) => ({ x: 0.8, y, width: 0.15, height: 0.05 });
    const { tree } = await project([
      {
        index: 1,
        parentIndex: 0,
        label: "Wi-Fi",
        traits: ["staticText"],
        accessible: true,
        frame: label(0.2),
      },
      {
        index: 2,
        parentIndex: 0,
        label: "On",
        traits: ["button"],
        accessible: true,
        frame: toggle(0.2),
      },
      {
        index: 3,
        parentIndex: 0,
        label: "Bluetooth",
        traits: ["staticText"],
        accessible: true,
        frame: label(0.3),
      },
      {
        index: 4,
        parentIndex: 0,
        label: "On",
        traits: ["button"],
        accessible: true,
        frame: toggle(0.3),
      },
    ]);

    expect(deriveScopedSelector(tree, centre(toggle(0.3)))).toEqual({
      selector: { text: "On", role: "AXButton", next: { text: "Bluetooth" } },
      strategy: "next",
      scope: JSON.stringify({ text: "Bluetooth" }),
    });
  });

  it("replaces a positional own id by the text inside the non-positional ancestor", async () => {
    const { tree } = await project([
      // A toolbar search button shares the tab's text, so the text alone is ambiguous.
      {
        index: 1,
        parentIndex: 0,
        label: "Search",
        traits: ["button"],
        accessible: true,
        frame: { x: 0.85, y: 0.05, width: 0.1, height: 0.05 },
      },
      {
        index: 2,
        parentIndex: 0,
        identifier: "main-tabs",
        traits: ["tabBar"],
        frame: { x: 0, y: 0.9, width: 1, height: 0.1 },
      },
      {
        index: 3,
        parentIndex: 2,
        identifier: "tab-1",
        label: "Home",
        traits: ["button"],
        accessible: true,
        frame: { x: 0, y: 0.9, width: 0.5, height: 0.1 },
      },
      {
        index: 4,
        parentIndex: 2,
        identifier: "tab-2",
        label: "Search",
        traits: ["button"],
        accessible: true,
        frame: { x: 0.5, y: 0.9, width: 0.5, height: 0.1 },
      },
    ]);

    expect(deriveScopedSelector(tree, { x: 0.75, y: 0.95 })).toEqual({
      selector: { text: "Search", role: "AXButton", within: { identifier: "main-tabs" } },
      strategy: "within",
      scope: "main-tabs",
    });
  });

  it("does not count a longer text as a collision: Save is unique beside Save changes", async () => {
    const SAVE = { x: 0.1, y: 0.8, width: 0.35, height: 0.08 };
    const SAVE_CHANGES = { x: 0.55, y: 0.8, width: 0.4, height: 0.08 };
    const { tree } = await project([
      {
        index: 1,
        parentIndex: 0,
        label: "Save",
        traits: ["button"],
        accessible: true,
        frame: SAVE,
      },
      {
        index: 2,
        parentIndex: 0,
        label: "Save changes",
        traits: ["button"],
        accessible: true,
        frame: SAVE_CHANGES,
      },
    ]);

    expect(deriveScopedSelector(tree, centre(SAVE))).toEqual({
      selector: { text: "Save", role: "AXButton" },
      strategy: "text",
    });
    expect(deriveScopedSelector(tree, centre(SAVE_CHANGES))).toEqual({
      selector: { text: "Save changes", role: "AXButton" },
      strategy: "text",
    });
  });

  it("keeps an off-centre tap as fractions of the element's frame, and drops a centre one", async () => {
    const { tree } = await project([
      {
        index: 1,
        parentIndex: 0,
        identifier: "row-open",
        label: "Open",
        traits: ["button"],
        accessible: true,
        frame: ROW,
      },
    ]);

    expect(deriveScopedSelector(tree, { x: 0.8, y: 0.55 })).toEqual({
      selector: { identifier: "row-open" },
      strategy: "id",
      offset: { x: 0.88, y: 0.5 },
    });
    expect(deriveScopedSelector(tree, { x: 0.5, y: 0.52 })).toMatchObject({
      offset: { x: 0.5, y: 0.2 },
    });
    // Within 0.15 of the centre on both axes: the centre tap replay sends anyway.
    expect(deriveScopedSelector(tree, { x: 0.6, y: 0.56 })).toEqual({
      selector: { identifier: "row-open" },
      strategy: "id",
    });
  });

  it("notes an id that looks like data, in the selector or in its scope", async () => {
    const { tree } = await project([
      {
        index: 1,
        parentIndex: 0,
        identifier: "user@example.com",
        label: "Alice",
        traits: ["button"],
        accessible: true,
        frame: ROW,
      },
    ]);
    expect(deriveScopedSelector(tree, centre(ROW))).toEqual({
      selector: { identifier: "user@example.com" },
      strategy: "id",
      notes: "the id looks like data",
    });

    const like = (y: number) => ({ x: 0.8, y, width: 0.15, height: 0.05 });
    const scoped = async (alice: string, bob: string) => {
      const { tree } = await project([
        {
          index: 1,
          parentIndex: 0,
          identifier: alice,
          frame: { x: 0, y: 0.1, width: 1, height: 0.2 },
        },
        {
          index: 2,
          parentIndex: 1,
          identifier: "like",
          traits: ["button"],
          accessible: true,
          frame: like(0.15),
        },
        {
          index: 3,
          parentIndex: 0,
          identifier: bob,
          frame: { x: 0, y: 0.3, width: 1, height: 0.2 },
        },
        {
          index: 4,
          parentIndex: 3,
          identifier: "like",
          traits: ["button"],
          accessible: true,
          frame: like(0.35),
        },
      ]);
      return deriveScopedSelector(tree, centre(like(0.35)));
    };
    // No stable ancestor: the data-like one still scopes, with the caveat.
    expect(await scoped("item:alice@x", "item:bob@x")).toEqual({
      selector: { identifier: "like", within: { identifier: "item:bob@x" } },
      strategy: "within",
      scope: "item:bob@x",
      notes: "the scope id looks like data and may change with content",
    });
    expect(await scoped("row-1", "row-2")).toEqual({
      selector: { identifier: "like", within: { identifier: "row-2" } },
      strategy: "within",
      scope: "row-2",
      notes: "the scope id looks positional",
    });
  });

  it("lands on the VoiceOver target under the finger, not the smaller text inside it", async () => {
    const { tree } = await project([
      { index: 1, parentIndex: 0, label: "Buy", traits: ["button"], accessible: true, frame: ROW },
      {
        index: 2,
        parentIndex: 1,
        label: "$9.99",
        traits: ["staticText"],
        frame: { x: 0.6, y: 0.52, width: 0.2, height: 0.05 },
      },
    ]);

    expect(deriveScopedSelector(tree, { x: 0.7, y: 0.545 })).toMatchObject({
      selector: { text: "Buy", role: "AXButton" },
      strategy: "text",
      offset: { x: 0.75 },
    });
  });

  it("prefers the sheet's Done over the toolbar button under the sheet, even one with an id", async () => {
    // The daemon did not flag the toolbar as covered (seen in Calendar and
    // Reminders on iOS 27): the sheet comes later in document order and its
    // Done overlaps the Add button, so Done is what the finger reaches.
    const { tree } = await project([
      { index: 1, parentIndex: 0, frame: FULL },
      {
        index: 2,
        parentIndex: 1,
        label: "Add",
        identifier: "add-plus-button",
        traits: ["button"],
        accessible: true,
        frame: { x: 0.857, y: 0.076, width: 0.093, height: 0.041 },
      },
      { index: 3, parentIndex: 0, frame: { x: 0, y: 0.07, width: 1, height: 0.93 } },
      {
        index: 4,
        parentIndex: 3,
        label: "Done",
        traits: ["button"],
        accessible: true,
        frame: { x: 0.861, y: 0.094, width: 0.09, height: 0.041 },
      },
    ]);

    expect(deriveScopedSelector(tree, { x: 0.906, y: 0.1145 })).toMatchObject({
      selector: { text: "Done", role: "AXButton" },
      strategy: "text",
    });
  });

  it("prefers the search result drawn over the list row it covers", async () => {
    const { tree } = await project([
      { index: 1, parentIndex: 0, identifier: "ContactsListView", frame: FULL },
      {
        index: 2,
        parentIndex: 1,
        label: "John Appleseed",
        accessible: true,
        frame: { x: 0, y: 0.179, width: 1, height: 0.05 },
      },
      { index: 3, parentIndex: 0, label: "Search results", frame: FULL },
      {
        index: 4,
        parentIndex: 3,
        label: "Sweepy",
        accessible: true,
        frame: { x: 0, y: 0.193, width: 1, height: 0.052 },
      },
    ]);

    expect(deriveScopedSelector(tree, { x: 0.5, y: 0.219 })).toMatchObject({
      selector: { text: "Sweepy", role: "AXGroup" },
      strategy: "text",
    });
  });

  it("keeps a small button listed before the wide heading it sits on: the heading is background", async () => {
    // Maps lists the card's Close button before its header, yet the button is
    // drawn on the header: a later target that holds the earlier one whole
    // with room to spare does not cover it.
    const { tree } = await project([
      {
        index: 1,
        parentIndex: 0,
        identifier: "card",
        frame: { x: 0, y: 0.55, width: 1, height: 0.45 },
      },
      {
        index: 2,
        parentIndex: 1,
        label: "Close",
        traits: ["button"],
        accessible: true,
        frame: { x: 0.886, y: 0.568, width: 0.075, height: 0.034 },
      },
      {
        index: 3,
        parentIndex: 1,
        label: "Paris",
        identifier: "PlaceHeaderView",
        traits: ["header"],
        accessible: true,
        frame: { x: 0, y: 0.55, width: 1, height: 0.057 },
      },
    ]);

    expect(deriveScopedSelector(tree, { x: 0.9235, y: 0.585 })).toMatchObject({
      selector: { text: "Close", role: "AXButton" },
      strategy: "text",
    });
    expect(deriveScopedSelector(tree, { x: 0.3, y: 0.58 })).toMatchObject({
      selector: { identifier: "PlaceHeaderView" },
      strategy: "id",
    });
  });

  it("lists a view the daemon reports under two containers once, keeping the copy drawn last", async () => {
    // MapKit: each annotation view appears as a map accessibility element and
    // again as a subview of the annotation container, identical in every
    // field. One leaf, so `{id: pin-wawel}` is unique; the kept copy is the
    // later one, over the map's own labels in document order.
    const PIN = { x: 0.551, y: 0.443, width: 0.07, height: 0.032 };
    const { tree } = await project([
      { index: 1, parentIndex: 0, identifier: "map", frame: FULL },
      {
        index: 2,
        parentIndex: 1,
        label: "Wawel Castle, Castle",
        identifier: "pin-wawel",
        accessible: true,
        frame: PIN,
      },
      { index: 3, parentIndex: 1, label: "Map", frame: FULL },
      {
        index: 4,
        parentIndex: 3,
        label: "Wawel Castle, Wawel Castle, Castle",
        identifier: "VKPointFeature",
        accessible: true,
        frame: { x: 0.551, y: 0.46, width: 0.07, height: 0.032 },
      },
      { index: 5, parentIndex: 1, identifier: "AnnotationContainer", frame: FULL },
      {
        index: 6,
        parentIndex: 5,
        label: "Wawel Castle, Castle",
        identifier: "pin-wawel",
        accessible: true,
        frame: PIN,
      },
    ]);

    expect(findAll(tree, { identifier: "pin-wawel" })).toHaveLength(1);
    expect(deriveScopedSelector(tree, { x: 0.586, y: 0.465 })).toMatchObject({
      selector: { identifier: "pin-wawel" },
      strategy: "id",
    });
  });

  it("keeps a map cluster marker under the count text drawn on it, over its hidden members", async () => {
    // MapKit lists the clustered members at the cluster's frame, then the
    // cluster, then its count as a sibling text: the count decorates the
    // marker, and the marker covers the members it replaced.
    const AT = { x: 0.6, y: 0.35, width: 0.07, height: 0.03 };
    const { tree } = await project([
      { index: 1, parentIndex: 0, identifier: "map", frame: FULL },
      {
        index: 2,
        parentIndex: 1,
        label: "Cloth Hall, Market",
        identifier: "pin-cloth",
        accessible: true,
        frame: AT,
      },
      {
        index: 3,
        parentIndex: 1,
        label: "Main Square, Square",
        identifier: "pin-square",
        accessible: true,
        frame: AT,
      },
      {
        index: 4,
        parentIndex: 1,
        label: "3 places",
        identifier: "cluster",
        accessible: true,
        frame: AT,
      },
      {
        index: 5,
        parentIndex: 1,
        label: "3",
        traits: ["staticText"],
        accessible: true,
        frame: { x: 0.61, y: 0.355, width: 0.05, height: 0.02 },
      },
    ]);

    expect(deriveScopedSelector(tree, centre(AT))).toMatchObject({
      selector: { identifier: "cluster" },
      strategy: "id",
    });
  });

  it("prefers a later card's wide close button over the narrow Close of the card beneath", async () => {
    // Apple Maps: the directions card (later) draws its X over the place
    // card's Close; the X is a control, so holding the smaller button whole
    // does not make it background.
    const { tree } = await project([
      {
        index: 1,
        parentIndex: 0,
        identifier: "PlaceCard",
        frame: { x: 0, y: 0.55, width: 1, height: 0.45 },
      },
      {
        index: 2,
        parentIndex: 1,
        label: "Close",
        traits: ["button"],
        accessible: true,
        frame: { x: 0.886, y: 0.559, width: 0.075, height: 0.034 },
      },
      {
        index: 3,
        parentIndex: 1,
        label: "Share",
        traits: ["button"],
        accessible: true,
        frame: { x: 0.77, y: 0.559, width: 0.1, height: 0.034 },
      },
      {
        index: 4,
        parentIndex: 0,
        identifier: "DirectionsCard",
        frame: { x: 0, y: 0.54, width: 1, height: 0.46 },
      },
      {
        index: 5,
        parentIndex: 4,
        label: "close",
        identifier: "CardButtonActionButton",
        traits: ["button"],
        accessible: true,
        frame: { x: 0.846, y: 0.541, width: 0.154, height: 0.071 },
      },
    ]);

    expect(deriveScopedSelector(tree, { x: 0.923, y: 0.5765 })).toMatchObject({
      selector: { identifier: "CardButtonActionButton" },
      strategy: "id",
    });
  });

  it("keeps the Close button over the heading behind it when the button pokes out of the heading", async () => {
    // Apple Maps on iOS 27: the heading (later, non-control) holds most of
    // the Close button but not all of it; it is still background.
    const { tree } = await project([
      {
        index: 1,
        parentIndex: 0,
        identifier: "card",
        frame: { x: 0, y: 0.55, width: 1, height: 0.45 },
      },
      {
        index: 2,
        parentIndex: 1,
        label: "Close",
        identifier: "CardButtonTypeClose",
        traits: ["button"],
        accessible: true,
        frame: { x: 0.837, y: 0.577, width: 0.105, height: 0.048 },
      },
      {
        index: 3,
        parentIndex: 1,
        label: "Kraków",
        identifier: "PlaceHeaderView",
        traits: ["header"],
        accessible: true,
        frame: { x: 0.02, y: 0.559, width: 0.96, height: 0.055 },
      },
    ]);

    expect(deriveScopedSelector(tree, { x: 0.8895, y: 0.601 })).toMatchObject({
      selector: { identifier: "CardButtonTypeClose" },
      strategy: "id",
    });
  });

  it("picks the clear button inside a text field over the field's own id", async () => {
    const FIELD = { x: 0.04, y: 0.102, width: 0.761, height: 0.041 };
    const { tree } = await project([
      {
        index: 1,
        parentIndex: 0,
        label: "Apple Maps",
        value: "Paris",
        identifier: "MapsSearchTextField",
        traits: ["textEntry"],
        accessible: true,
        frame: FIELD,
      },
      {
        index: 2,
        parentIndex: 1,
        label: "Clear text",
        traits: ["button"],
        accessible: true,
        frame: { x: 0.738, y: 0.112, width: 0.049, height: 0.022 },
      },
    ]);

    expect(deriveScopedSelector(tree, { x: 0.7625, y: 0.123 })).toMatchObject({
      selector: { text: "Clear text", role: "AXButton" },
      strategy: "text",
    });
    expect(deriveScopedSelector(tree, { x: 0.3, y: 0.123 })).toMatchObject({
      selector: { identifier: "MapsSearchTextField" },
      strategy: "id",
    });
  });

  it("names a row whose label joins its children's labels by its title part", async () => {
    const ROW = { x: 0.04, y: 0.179, width: 0.92, height: 0.1 };
    const { tree } = await project([
      { index: 1, parentIndex: 0, label: "Berlin, Germany", accessible: true, frame: ROW },
      {
        index: 2,
        parentIndex: 1,
        label: "Berlin",
        identifier: "PlaceSummaryTitleLabel",
        traits: ["staticText"],
        frame: { x: 0.06, y: 0.19, width: 0.3, height: 0.03 },
      },
      {
        index: 3,
        parentIndex: 1,
        label: "Germany",
        traits: ["staticText"],
        frame: { x: 0.06, y: 0.23, width: 0.3, height: 0.03 },
      },
    ]);

    expect(deriveScopedSelector(tree, centre(ROW))).toMatchObject({
      selector: { text: "Berlin", role: "AXGroup" },
      strategy: "text",
      notes: expect.stringContaining("title part"),
    });
    // The title part matches the row as a substring after the label grows.
    const grown = (
      await project([
        {
          index: 1,
          parentIndex: 0,
          label: "Berlin, Recently Viewed · Germany",
          accessible: true,
          frame: ROW,
        },
      ])
    ).tree;
    expect(findAll(grown, { text: "Berlin", role: "AXGroup" })).toHaveLength(1);
  });

  it("keeps coordinates when nothing makes the element unique, or nothing is under the tap", async () => {
    const item = (y: number) => ({ x: 0.1, y, width: 0.8, height: 0.1 });
    const { tree } = await project([
      {
        index: 1,
        parentIndex: 0,
        label: "Item",
        traits: ["button"],
        accessible: true,
        frame: item(0.2),
      },
      {
        index: 2,
        parentIndex: 0,
        label: "Item",
        traits: ["button"],
        accessible: true,
        frame: item(0.4),
      },
      { index: 3, parentIndex: 0, traits: ["image"], accessible: true, frame: item(0.6) },
    ]);

    // The first "Item": no anchor precedes it, no id is anywhere near it.
    expect(deriveScopedSelector(tree, centre(item(0.2)))).toEqual({
      warning:
        "selector for the tapped element matches 2 elements and no scope makes it unique; kept coordinates (brittle)",
    });
    expect(deriveScopedSelector(tree, centre(item(0.6)))).toEqual({
      warning: "tapped element has no stable text/id; kept coordinates (brittle)",
    });
    expect(deriveScopedSelector(tree, { x: 0.5, y: 0.9 })).toEqual({
      warning: "no element found under the tap; kept coordinates (brittle)",
    });
  });
});

describe("tap x and y beside on", () => {
  it("parses and round-trips a tap positioned inside the resolved element", () => {
    const steps = parseFlow(
      "steps:\n" +
        "  - tap: { on: { id: photo }, x: 0.75, y: 0.5 }\n" +
        "  - tap: { on: { id: photo }, times: 2, x: 0, y: 1 }\n"
    ).steps;
    expect(steps).toEqual([
      { kind: "tap", selector: { identifier: "photo" }, x: 0.75, y: 0.5 },
      { kind: "tap", selector: { identifier: "photo" }, times: 2, x: 0, y: 1 },
    ]);

    const yaml = serializeFlow({ executionPrerequisite: "", steps });
    expect(yaml).toContain("on:");
    expect(yaml).toContain("x: 0.75");
    expect(parseFlow(yaml).steps).toEqual(steps);
  });

  it("rejects out-of-range, malformed or lone fractions", () => {
    for (const bad of [
      "x: 1.5, y: 0.5",
      "x: 0.5, y: -0.1",
      "x: 0.5",
      "y: 0.5",
      'x: "0.5", y: 0.5',
    ]) {
      expect(() => parseFlow(`steps:\n  - tap: { on: { id: photo }, ${bad} }\n`)).toThrow(
        /0–1 fractions of the resolved element's frame/
      );
    }
  });

  it("rejects x and y beside a coordinate target, which is already a point", () => {
    expect(() =>
      parseFlow("steps:\n  - tap: { on: { x: 0.5, y: 0.5 }, x: 0.1, y: 0.1 }\n")
    ).toThrow(/a coordinate target is already a point/);
  });
});

// Ported from the retired tool-step tests: the runner keeps reading the daemon
// tree across the step forms that used to depend on the launch's tree target.
// Nothing on the tree path is mocked - the runner goes through the REAL
// fetchFlowTree -> queryAxFlowTree, and the ax-service is the only seam.
describe("the runner reads the daemon tree end to end", () => {
  const BUNDLE = "com.example.app";
  const READY = reply([
    {
      index: 1,
      parentIndex: 0,
      identifier: "ready",
      label: "Ready",
      traits: ["staticText"],
      accessible: true,
      frame: { x: 0, y: 0.1, width: 1, height: 0.1 },
    },
  ]);
  const ASSERT_READY = {
    kind: "assert",
    condition: "visible",
    selector: { identifier: "ready" },
  } as const;
  let tmpDir: string;

  async function writeFlow(name: string, yaml: Parameters<typeof serializeFlow>[0]): Promise<void> {
    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${name}.yaml`), serializeFlow(yaml), "utf8");
  }

  async function run(
    name: string,
    reads: string[],
    toolCalls: Array<{ id: string; args: Record<string, unknown> }> = []
  ) {
    const result = await createRunFlowTool(registryServing(READY, reads, toolCalls)).execute(
      {},
      { name, project_root: tmpDir, device: UDID }
    );
    if (!("steps" in result))
      throw new Error(`expected a run result, got notice: ${result.notice}`);
    return result as FlowRunResult;
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-ax-tree-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("keeps reading after a run: fragment that ends in a tool step", async () => {
    const reads: string[] = [];
    await writeFlow("dismiss", {
      executionPrerequisite: "",
      steps: [{ kind: "tool", name: "screenshot", args: {} }],
    });
    await writeFlow("fragment-tool", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: BUNDLE },
        ASSERT_READY,
        { kind: "run", flow: "dismiss.yaml" },
        ASSERT_READY,
      ],
    });

    const result = await run("fragment-tool", reads);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "launch:pass",
      "assert:pass",
      "run:pass",
      "tool:pass",
      "assert:pass",
    ]);
    expect(result.ok).toBe(true);
    // One read per assert, each against this device's daemon.
    // The launch gate's probe read, then one read per directive.
    expect(reads).toEqual([`AXService:${UDID}`, `AXService:${UDID}`, `AXService:${UDID}`]);
  });

  it("evaluates a when: guard after a tool step instead of stopping the run", async () => {
    const reads: string[] = [];
    await writeFlow("when-after-tool", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: BUNDLE },
        ASSERT_READY,
        { kind: "tool", name: "screenshot", args: {} },
        {
          kind: "when",
          condition: { kind: "ui", condition: "visible", selector: { identifier: "ready" } },
          steps: [{ kind: "echo", message: "guard met" }],
        },
        ASSERT_READY,
      ],
    });

    const result = await run("when-after-tool", reads);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "launch:pass",
      "assert:pass",
      "tool:pass",
      "when:pass",
      "echo:pass",
      "assert:pass",
    ]);
    expect(result.ok).toBe(true);
    // The assert, the guard's probe read, then the trailing assert.
    expect(reads).toHaveLength(4); // launch probe + 3
  });

  it("reads the screen aspect for a rotate after a tool step", async () => {
    // `fetchScreenAspect` swallows a failed read and degrades the orbit to the
    // legacy normalized ellipse with the step still green, so the geometry is
    // the proof: radiusX/radiusY differ only when the 402x874 screen was read.
    const reads: string[] = [];
    const toolCalls: Array<{ id: string; args: Record<string, unknown> }> = [];
    await writeFlow("rotate-after-tool", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: BUNDLE },
        ASSERT_READY,
        { kind: "tool", name: "screenshot", args: {} },
        { kind: "rotate", by: 90 },
      ],
    });

    const result = await run("rotate-after-tool", reads, toolCalls);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "launch:pass",
      "assert:pass",
      "tool:pass",
      "rotate:pass",
    ]);
    expect(result.steps[3]?.warning).toBeUndefined();
    // The assert, the rotate's two settle reads, then the aspect read.
    expect(reads).toHaveLength(5); // launch probe + 4
    const rotations = toolCalls.filter((c) => c.id === "gesture-rotate");
    expect(rotations).toHaveLength(1);
    expect(rotations[0]!.args.radius).toBeUndefined();
    expect(rotations[0]!.args.radiusX).toEqual(expect.any(Number));
    expect(rotations[0]!.args.radiusY).toEqual(expect.any(Number));
    expect(rotations[0]!.args.radiusX).not.toEqual(rotations[0]!.args.radiusY);
  });
});
