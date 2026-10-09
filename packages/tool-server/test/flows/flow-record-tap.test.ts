import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

// The recorder must read the SAME tree source the runner resolves selectors
// against at replay (fetchFlowTree), not the trimmed agent-facing describe
// tree — mock it directly so each test controls exactly what capture sees.
let currentTreeData: () => DescribeTreeData;
vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn(async (): Promise<DescribeTreeData> => currentTreeData()),
}));

import { fetchFlowTree } from "../../src/tools/flows/flow-tree";
import type { AXTreeNode } from "../../src/blueprints/ax-service";
import { adaptAxTree } from "../../src/tools/ui-tree/ios";
import { adaptIosUiTreeForFlows } from "../../src/tools/flows/flow-ios-tree";
import { selectorToFrame, type Selector } from "../../src/utils/ui-tree-match";
import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import { summarizeStep } from "../../src/tools/flows/flow-step-definitions";
import { __resetRecordingsForTesting, parseFlow } from "../../src/tools/flows/flow-utils";

const DEVICE = "00000000-0000-0000-0000-0000000000AB"; // iOS UDID shape
const ANDROID = "emulator-5554";
// The real wrapped shape the Android tree source raises: the registry's service
// tag inside the tree source's own prefix, around the reason the author needs.
const HELPER_UNAVAILABLE =
  "the argent android helper is unavailable: [AndroidDevtools:emulator-5554] the argent android " +
  "helper could not start on emulator-5554 even after reinstalling it: am instrument exited " +
  "before becoming ready: INSTRUMENTATION_STATUS: Error=Unable to find instrumentation info for: " +
  "ComponentInfo{com.argent.androiddevtools/.SnapshotInstrumentation}";
const FLOW = "rec";
const PREREQ = "App on home screen";

let tmpDir: string;

function n(partial: Partial<DescribeNode> & { frame: DescribeNode["frame"] }): DescribeNode {
  return { role: "AXOther", children: [], ...partial };
}

function screen(children: DescribeNode[]): DescribeNode {
  return n({ role: "AXGroup", frame: { x: 0, y: 0, width: 1, height: 1 }, children });
}

function setTree(children: DescribeNode[], source: DescribeTreeData["source"] = "ax-service") {
  currentTreeData = () => ({ tree: screen(children), source });
}

function mockRegistry(): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "gesture-tap") return { tapped: true };
      throw new Error(`Tool "${id}" not found`);
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
  } as unknown as Registry;
}

async function recordTapOn(udid: string, point: { x: number; y: number }) {
  const tool = createFlowAddStepTool(mockRegistry());
  return tool.execute(
    {},
    {
      name: FLOW,
      project_root: tmpDir,
      command: "gesture-tap",
      args: JSON.stringify({ udid, ...point }),
    }
  );
}

async function recordTap(point: { x: number; y: number }) {
  return recordTapOn(DEVICE, point);
}

async function recordedSteps() {
  const content = await fs.readFile(path.join(tmpDir, ".argent", "flows", `${FLOW}.yaml`), "utf8");
  return parseFlow(content).steps;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-record-tap-"));
  __resetRecordingsForTesting();
  await flowStartRecordingTool.execute(
    {},
    { name: FLOW, project_root: tmpDir, executionPrerequisite: PREREQ }
  );
});

afterEach(async () => {
  __resetRecordingsForTesting();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// The tree source needs the launched bundle id to measure and explain a read it
// could not take; without one it raises auto-targeting's stock "Launch or
// restart the app first". The recorder is where that lands hardest: it relaunches
// the app AFTER this tool-server bound its listener, so the first tap reads
// during the connect window — the states whose measured message says NOT to
// restart the app. The runner threads the id from its `launch:` step; here the
// equivalent is the `launch` the recorder just captured.
describe("flow-add-step tap capture targets the recorded launch", () => {
  const BUNDLE = "com.example.app";
  // A leading `launch` and an executionPrerequisite are mutually exclusive, so
  // this block records into an e2e flow of its own rather than the fragment the
  // outer setup opens.
  const E2E_FLOW = "rec-e2e";

  beforeEach(async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: E2E_FLOW, project_root: tmpDir, executionPrerequisite: "" }
    );
  });

  function registryWithRestart(): Registry {
    return {
      invokeTool: vi.fn(async (id: string) => {
        if (id === "gesture-tap") return { tapped: true };
        if (id === "restart-app") return { restarted: true };
        throw new Error(`Tool "${id}" not found`);
      }),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    } as unknown as Registry;
  }

  async function recordRestart(): Promise<void> {
    await createFlowAddStepTool(registryWithRestart()).execute(
      {},
      {
        name: E2E_FLOW,
        project_root: tmpDir,
        command: "restart-app",
        args: JSON.stringify({ udid: DEVICE, bundleId: BUNDLE }),
      }
    );
  }

  it("passes the recorded launch's app to the tree read", async () => {
    setTree([]);
    await recordRestart();
    vi.mocked(fetchFlowTree).mockClear();

    await createFlowAddStepTool(registryWithRestart()).execute(
      {},
      {
        name: E2E_FLOW,
        project_root: tmpDir,
        command: "gesture-tap",
        args: JSON.stringify({ udid: DEVICE, x: 0.5, y: 0.5 }),
      }
    );

    expect(vi.mocked(fetchFlowTree).mock.calls[0]![2]).toEqual({ bundleId: BUNDLE, pinned: false });
  });

  it("passes nothing when the recording has captured no launch", async () => {
    setTree([]);
    vi.mocked(fetchFlowTree).mockClear();

    await recordTap({ x: 0.5, y: 0.5 });

    expect(vi.mocked(fetchFlowTree).mock.calls[0]![2]).toBeUndefined();
  });
});

describe("flow-add-step tap selector capture", () => {
  it("captures an identifier selector from the flow tree", async () => {
    setTree([
      n({
        identifier: "add-to-cart",
        label: "Add to cart",
        frame: { x: 0.3, y: 0.5, width: 0.4, height: 0.06 },
      }),
    ]);

    const result = await recordTap({ x: 0.5, y: 0.52 });

    expect(result.message).not.toContain("—");
    expect(await recordedSteps()).toEqual([
      { kind: "tap", selector: { identifier: "add-to-cart" } },
    ]);
  });

  it("reports the captured selector in the `recorded` line, in the file's spelling", async () => {
    // The coordinates the caller passed are NOT what gets stored, and the
    // recorder no longer returns the YAML per step — so `recorded` is the only
    // thing telling the author their tap became a portable selector. It must
    // also use the FILE's spelling: capture produces `identifier`, which
    // selectorToYaml maps to `id` on the way to disk, so a line quoting
    // `identifier` would not match the YAML the author goes on to hand-edit.
    setTree([
      n({
        identifier: "add-to-cart",
        label: "Add to cart",
        frame: { x: 0.3, y: 0.5, width: 0.4, height: 0.06 },
      }),
    ]);

    const result = await recordTap({ x: 0.5, y: 0.52 });

    expect(result.recorded).toBe('1. tap: {"id":"add-to-cart"}');
    expect(result.recorded).toBe(summarizeStep((await recordedSteps())[0], 1));
    expect(result.stepCount).toBe(1);
  });

  it("reports the coordinate fallback in the `recorded` line", async () => {
    // The other half of the same signal: when no stable selector is derivable
    // the step stays a coordinate tap, and `recorded` has to say so — that is
    // how the author knows the brittle form was kept, alongside the warning.
    setTree([]);

    const result = await recordTap({ x: 0.5, y: 0.52 });

    expect(result.recorded).toBe("1. tap: (0.5, 0.52)");
    expect(result.recorded).toBe(summarizeStep((await recordedSteps())[0], 1));
  });

  it("captures a strict text selector when the node has no identifier", async () => {
    setTree([n({ label: "Add to cart", frame: { x: 0.3, y: 0.5, width: 0.4, height: 0.06 } })]);

    await recordTap({ x: 0.5, y: 0.52 });

    expect(await recordedSteps()).toEqual([{ kind: "tap", selector: { text: "Add to cart" } }]);
  });

  it("records a text selector for a labelled control that also exposes a value", async () => {
    // The label+value join ("Volume 50%") exists on no single node — matchNode
    // compares a text selector against label and value individually — so the
    // derived selector must use the label alone instead of degrading to
    // coordinates.
    setTree([
      n({ label: "Volume", value: "50%", frame: { x: 0.2, y: 0.4, width: 0.6, height: 0.08 } }),
    ]);

    const result = await recordTap({ x: 0.5, y: 0.44 });

    expect(result.message).not.toContain("—");
    expect(await recordedSteps()).toEqual([{ kind: "tap", selector: { text: "Volume" } }]);
  });

  it("carries a recorded clickCount into the tap step's times", async () => {
    // A recorded double-tap must not silently replay as a single tap.
    setTree([n({ label: "Photo", frame: { x: 0.3, y: 0.5, width: 0.4, height: 0.06 } })]);

    const tool = createFlowAddStepTool(mockRegistry());
    await tool.execute(
      {},
      {
        name: FLOW,
        project_root: tmpDir,
        command: "gesture-tap",
        args: JSON.stringify({ udid: DEVICE, x: 0.5, y: 0.52, clickCount: 2 }),
      }
    );

    expect(await recordedSteps()).toEqual([{ kind: "tap", selector: { text: "Photo" }, times: 2 }]);
  });

  it("keeps coordinates when nothing on screen singles out a repeated label", async () => {
    // Two "Add" labels in two rows, with no container or unique neighbour to
    // scope by: replay could land on either, so coordinates are kept.
    setTree([
      n({ label: "Add", frame: { x: 0.1, y: 0.1, width: 0.1, height: 0.03 } }),
      n({ label: "Add", frame: { x: 0.1, y: 0.5, width: 0.3, height: 0.05 } }),
    ]);

    const result = await recordTap({ x: 0.2, y: 0.52 });

    expect(result.message).toContain(
      'selector text="Add" also matches other elements on this screen and no ' +
        "`within`/`next` scope singles out the tapped one; kept coordinates (brittle)"
    );
    expect(await recordedSteps()).toEqual([{ kind: "tap", x: 0.2, y: 0.52 }]);
  });

  it("scopes a repeated label within the row that holds it", async () => {
    setTree([
      n({ identifier: "row-1", frame: { x: 0, y: 0.1, width: 1, height: 0.1 } }),
      n({ role: "AXButton", label: "Add", frame: { x: 0.7, y: 0.12, width: 0.2, height: 0.05 } }),
      n({ identifier: "row-2", frame: { x: 0, y: 0.3, width: 1, height: 0.1 } }),
      n({ role: "AXButton", label: "Add", frame: { x: 0.7, y: 0.32, width: 0.2, height: 0.05 } }),
    ]);

    const result = await recordTap({ x: 0.8, y: 0.34 });

    expect(result.message).not.toContain("—");
    expect(await recordedSteps()).toEqual([
      { kind: "tap", selector: { text: "Add", within: { identifier: "row-2" } } },
    ]);
  });

  it("anchors a repeated label next to the nearest unique element before it", async () => {
    setTree([
      n({ label: "Wi-Fi", frame: { x: 0.05, y: 0.12, width: 0.3, height: 0.05 } }),
      n({ role: "AXButton", label: "On", frame: { x: 0.8, y: 0.12, width: 0.15, height: 0.05 } }),
      n({ label: "Bluetooth", frame: { x: 0.05, y: 0.22, width: 0.3, height: 0.05 } }),
      n({ role: "AXButton", label: "On", frame: { x: 0.8, y: 0.22, width: 0.15, height: 0.05 } }),
    ]);

    const result = await recordTap({ x: 0.85, y: 0.24 });

    expect(result.message).not.toContain("—");
    expect(await recordedSteps()).toEqual([
      { kind: "tap", selector: { text: "On", next: { text: "Bluetooth" } } },
    ]);
  });

  it("records a Settings switch by role within its row, and replays it after the flip", async () => {
    // Settings > General > Keyboards on iOS 27, as the accessibility service
    // serves it. The switch has no label and no id: its value is its state.
    const settings = (haptic: boolean) => {
      const nodes: AXTreeNode[] = [
        { index: 0, label: "Settings", bundleId: "com.apple.Preferences" },
        { index: 1, parentIndex: 0, elementType: 26, frame: { x: 0, y: 0, width: 1, height: 1 } },
      ];
      const row = (id: string, title: string, on: boolean, y: number) => {
        const i = nodes.length;
        const value = on ? "1" : "0";
        const band = (x: number, width: number) => ({ x, y: y + 0.014, width, height: 0.032 });
        nodes.push(
          {
            index: i,
            parentIndex: 1,
            identifier: id,
            elementType: 75,
            frame: { x: 0.05, y, width: 0.9, height: 0.061 },
          },
          {
            index: i + 1,
            parentIndex: i,
            label: title,
            value,
            identifier: id,
            traits: ["button", "staticText", "toggleButton"],
            elementType: 40,
            frame: band(0.09, 0.821),
          },
          {
            index: i + 2,
            parentIndex: i + 1,
            label: title,
            identifier: id,
            traits: ["button", "staticText"],
            elementType: 9,
            frame: band(0.09, 0.321),
          },
          {
            index: i + 3,
            parentIndex: i + 1,
            value,
            traits: ["button", "toggleButton"],
            elementType: 40,
            frame: band(0.759, 0.157),
          }
        );
      };
      row("KeyboardAllowPaddle", "Character Preview", true, 0.415);
      row("KeyboardVisceral", "Haptic Feedback", haptic, 0.476);
      nodes.push({
        index: nodes.length,
        parentIndex: 1,
        label: "Vertical scroll bar, 3 pages",
        value: "0%",
        traits: ["adjustable"],
        elementType: 0,
        frame: { x: 0.918, y: 0.133, width: 0.075, height: 0.796 },
      });
      return adaptIosUiTreeForFlows(
        adaptAxTree({
          alertVisible: false,
          nodes,
          truncated: false,
          foregroundApp: "com.apple.Preferences",
          interfaceOrientation: "portrait",
          treeVersion: 3,
        })
      );
    };
    currentTreeData = () => ({ tree: settings(false), source: "ax-service" });

    const result = await recordTap({ x: 0.8375, y: 0.506 });

    const selector: Selector = { role: "AXSwitch", within: { identifier: "KeyboardVisceral" } };
    expect(result.message).not.toContain("—");
    expect(await recordedSteps()).toEqual([{ kind: "tap", selector }]);
    // With the switch on, the selector still taps the same switch.
    expect(selectorToFrame(settings(true), selector)).toEqual({
      x: 0.759,
      y: 0.476 + 0.014,
      width: 0.157,
      height: 0.032,
    });
  });

  it("flags a role-only selector rather than recording the downgrade silently", async () => {
    // The raised iOS flow tree depth cap now keeps unlabeled icons. One is the
    // smallest frame under the tap, so `nodeAtPoint` picks it and
    // `deriveSelector` falls back to its role. Replay then depends on that icon
    // ranking first for the role.
    setTree([
      n({
        identifier: "product-card",
        frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
        children: [n({ role: "AXImage", frame: { x: 0.48, y: 0.48, width: 0.04, height: 0.04 } })],
      }),
    ]);

    const result = await recordTap({ x: 0.5, y: 0.5 });

    expect(result.message).toContain("matches by role alone");
    expect(await recordedSteps()).toEqual([{ kind: "tap", selector: { role: "AXImage" } }]);
  });

  // `roleOnlySelectorWarning` withholds the warning under separate guards for an
  // identifier and for visible text, so both need a case. Each node also carries
  // a role, so the withholding follows from the stable field, not a missing role.
  it.each([
    {
      carries: "an id",
      node: { identifier: "add-to-cart" },
      selector: { identifier: "add-to-cart" },
    },
    { carries: "text", node: { label: "Add to cart" }, selector: { text: "Add to cart" } },
  ])("does not flag a selector that carries $carries", async ({ node, selector }) => {
    setTree([
      n({ ...node, role: "AXButton", frame: { x: 0.3, y: 0.5, width: 0.4, height: 0.06 } }),
    ]);

    const result = await recordTap({ x: 0.5, y: 0.52 });

    // Assert the step too. A coordinate fallback also carries no role-only
    // warning, so the negative check alone proves nothing.
    expect(await recordedSteps()).toEqual([{ kind: "tap", selector }]);
    expect(result.message).not.toContain("matches by role alone");
  });

  it("adds no fallback-source caveat on iOS, whose flows read the ax-service tree only", async () => {
    setTree([n({ label: "Settings", frame: { x: 0.3, y: 0.5, width: 0.4, height: 0.06 } })]);

    const result = await recordTap({ x: 0.5, y: 0.52 });

    expect(result.message).not.toContain("fallback");
    expect(await recordedSteps()).toEqual([{ kind: "tap", selector: { text: "Settings" } }]);
  });

  it("reports both caveats when a role-only selector comes off Android's fallback tree", async () => {
    // The two warnings are independent and can fire on one capture. A
    // fallback-source read is the most likely to return an unlabeled node. Other
    // tests cover the role-only warning alone, so only this test holds the pair.
    setTree(
      [
        n({
          identifier: "product-card",
          frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
          children: [
            n({ role: "AXImage", frame: { x: 0.48, y: 0.48, width: 0.04, height: 0.04 } }),
          ],
        }),
      ],
      "uiautomator"
    );

    const result = await recordTapOn(ANDROID, { x: 0.5, y: 0.5 });

    expect(result.message).toContain("matches by role alone");
    expect(result.message).toContain(
      "selector captured from the fallback uiautomator tree (android-devtools unavailable)"
    );
    expect(await recordedSteps()).toEqual([{ kind: "tap", selector: { role: "AXImage" } }]);
  });

  it("keeps coordinates with a warning when the tree fetch fails", async () => {
    currentTreeData = () => {
      throw new Error("devtools gone");
    };

    const result = await recordTap({ x: 0.5, y: 0.52 });

    expect(result.message).toContain("selector capture failed");
    expect(await recordedSteps()).toEqual([{ kind: "tap", x: 0.5, y: 0.52 }]);
  });

  // The reason, and nothing wrapped around it: neither the service tag nor the
  // tree source's prefix tells the author anything the reason does not, and
  // every tap of a tree-less recording repeats whatever is said here.
  it("warns with the bare helper reason on an android tap", async () => {
    currentTreeData = () => {
      throw new Error(HELPER_UNAVAILABLE);
    };

    const result = await recordTapOn(ANDROID, { x: 0.5, y: 0.52 });

    // The tag and the tree-source prefix are gone; the device's own reason is not.
    expect(result.message).toContain(
      "selector capture failed (the argent android helper could not start on emulator-5554"
    );
    expect(result.message).toContain("Error=Unable to find instrumentation info");
    expect(result.message).toContain("); kept coordinates");
    expect(result.message).not.toContain("[AndroidDevtools:");
    expect(result.message).not.toContain("helper is unavailable");
    expect(await recordedSteps()).toEqual([{ kind: "tap", x: 0.5, y: 0.52 }]);
  });

  it("does not persist a raw point that replay would reject", async () => {
    setTree([]);

    await expect(recordTap({ x: 1.5, y: 0.52 })).rejects.toThrow(/normalized 0–1 fractions/i);
    expect(await recordedSteps()).toEqual([]);
  });
});
