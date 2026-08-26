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
import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import { adaptFullAndroidHierarchyToDescribeResult } from "../../src/tools/flows/flow-android-tree";
import { adaptFullHierarchyToDescribeResult } from "../../src/tools/flows/flow-ios-tree";
import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import { summarizeStep } from "../../src/tools/flows/flow-finish-recording";
import { __resetRecordingsForTesting, parseFlow } from "../../src/tools/flows/flow-utils";

const DEVICE = "00000000-0000-0000-0000-0000000000AB"; // iOS UDID shape
const ANDROID_DEVICE = "emulator-5554"; // Android serial shape
const FLOW = "rec";
const PREREQ = "App on home screen";

let tmpDir: string;

function n(partial: Partial<DescribeNode> & { frame: DescribeNode["frame"] }): DescribeNode {
  return { role: "AXOther", children: [], ...partial };
}

function screen(children: DescribeNode[]): DescribeNode {
  return n({ role: "AXGroup", frame: { x: 0, y: 0, width: 1, height: 1 }, children });
}

function setTree(children: DescribeNode[], source: DescribeTreeData["source"] = "native-devtools") {
  currentTreeData = () => ({ tree: screen(children), source });
}

// Same stub, fed through the REAL iOS adapter: what the recorder can derive
// from an iOS screen depends on which views the adapter emits, so a hand-built
// DescribeNode would pin the recorder against a tree no device produces.
function setIosTree(raw: unknown) {
  currentTreeData = () => ({
    tree: adaptFullHierarchyToDescribeResult(raw),
    source: "native-devtools",
  });
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

async function recordTap(point: { x: number; y: number }, udid: string = DEVICE) {
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

    expect(vi.mocked(fetchFlowTree).mock.calls[0]![2]).toEqual({
      bundleId: BUNDLE,
      pinned: false,
      probeAnswered: false,
    });
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
    // derived selector must use the label alone and still pass the re-resolve
    // check instead of degrading to coordinates.
    setTree([
      n({ label: "Volume", value: "50%", frame: { x: 0.2, y: 0.4, width: 0.6, height: 0.08 } }),
    ]);

    const result = await recordTap({ x: 0.5, y: 0.44 });

    expect(result.message).not.toContain("resolves to a different element");
    expect(result.message).not.toContain("matches no element");
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

  it("keeps coordinates when the selector would retarget to another element", async () => {
    // Two "Add" labels: replay's selectorToFrame ranking (exact → smallest
    // frame) elects the smaller node at the top, not the tapped one — so the
    // selector must be rejected in favor of coordinates.
    setTree([
      n({ label: "Add", frame: { x: 0.1, y: 0.1, width: 0.1, height: 0.03 } }),
      n({ label: "Add", frame: { x: 0.1, y: 0.5, width: 0.3, height: 0.05 } }),
    ]);

    const result = await recordTap({ x: 0.2, y: 0.52 });

    expect(result.message).toContain("resolves to a different element");
    expect(await recordedSteps()).toEqual([{ kind: "tap", x: 0.2, y: 0.52 }]);
  });

  it("keeps coordinates for a tap on dead space over a scrollable layout container", async () => {
    // Driven through the real Android adapter, because the node under the tap
    // exists only by that adapter's keep-gate: an id-less, label-less
    // FrameLayout reaches the flow tree solely because it is framework-marked
    // scrollable (for the scroll-to nudge), so drop `scrollable` from the dump
    // and there is nothing under the tap at all. nodeAtPoint finds it under a
    // tap that hits no row, and its class-fallback role must NOT become the
    // selector: the containment guard accepts `{ role: "FrameLayout" }` (the
    // scroller does cover the point) and replay would tap the list centre
    // instead. The RecyclerView below is the control that keeps the refusal
    // scoped to scaffolding - its role is a real one, and derivation must
    // still reach the role branch for it.
    currentTreeData = () => ({
      tree: adaptFullAndroidHierarchyToDescribeResult(
        `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,2000]">
    <node index="0" class="android.widget.FrameLayout" scrollable="true" package="com.acme.app" bounds="[0,200][1080,1200]">
      <node index="0" class="android.widget.TextView" text="Row 1" package="com.acme.app" bounds="[20,240][1060,320]" />
    </node>
    <node index="1" class="androidx.recyclerview.widget.RecyclerView" package="com.acme.app" bounds="[0,1200][1080,2000]">
      <node index="0" class="android.widget.TextView" text="Comment 1" package="com.acme.app" bounds="[20,1240][1060,1320]" />
    </node>
  </node>
</hierarchy>`,
        1080,
        2000
      ),
      source: "android-devtools",
    });

    // y 0.4 -> 800px: inside the scrollable FrameLayout, below its only row.
    const scaffolding = await recordTap({ x: 0.5, y: 0.4 }, ANDROID_DEVICE);
    expect(scaffolding.message).toContain("no stable text/id");

    // y 0.8 -> 1600px: the same kind of dead space over the RecyclerView.
    const genuine = await recordTap({ x: 0.5, y: 0.8 }, ANDROID_DEVICE);
    expect(genuine.message).not.toContain("kept coordinates");

    expect(await recordedSteps()).toEqual([
      { kind: "tap", x: 0.5, y: 0.4 },
      { kind: "tap", selector: { role: "ScrollView" } },
    ]);
  });

  it("still records a scroller's id over the same dead space", async () => {
    // The other half of the scoping: an identified scroller keeps its id, so
    // the refusal above is about scaffolding with nothing to name it, not
    // about scrollers.
    setTree([
      n({
        role: "FrameLayout",
        identifier: "feed",
        frame: { x: 0, y: 0.1, width: 1, height: 0.8 },
      }),
    ]);

    await recordTap({ x: 0.5, y: 0.6 });

    expect(await recordedSteps()).toEqual([{ kind: "tap", selector: { identifier: "feed" } }]);
  });

  it("keeps coordinates for a tap on a UIKit row's dead space", async () => {
    // The iOS arm of the same refusal, driven through the real full-hierarchy
    // adapter because the bug lives in what that adapter emits. A stock
    // UITableViewCell carries no identifier and no label, so the row is only in
    // the tree at all by its cell role - and that role is scaffolding every row
    // on the screen shares, so the tap keeps its coordinates. Both halves are
    // load-bearing: drop the row from the tree and nodeAtPoint returns the list,
    // whose frame covers the whole screen, so the containment guard waves
    // `{ id: list }` through and replay taps the middle of the list; keep the
    // row but derive `{ role: "AXCell" }` and replay taps the first row.
    const SCREEN = { x: 0, y: 0, width: 400, height: 800 };
    setIosTree({
      windows: [
        {
          className: "UIWindow",
          frame: SCREEN,
          windowFrame: SCREEN,
          children: [
            {
              className: "UITableView",
              identifier: "list",
              windowFrame: SCREEN,
              children: [0, 1, 2, 3].map((row) => {
                const y = 100 + row * 100;
                return {
                  className: "UITableViewCell",
                  windowFrame: { x: 0, y, width: 400, height: 100 },
                  children: [
                    {
                      // The row's only nameable content, in its left third -
                      // the tap lands to the right of it.
                      className: "UILabel",
                      label: `Row ${row + 1}`,
                      windowFrame: { x: 16, y: y + 35, width: 110, height: 30 },
                      children: [],
                    },
                  ],
                };
              }),
            },
          ],
        },
      ],
    });

    // 0.306 * 800 = 244.8pt: dead space in the second row.
    const deadSpace = await recordTap({ x: 0.75, y: 0.306 });
    expect(deadSpace.message).toContain("no stable text/id");

    // Same row and same height, over its label: keeping coordinates above is
    // about what the tap hit, not about the row being unaddressable, so the
    // nameable half of the same row must still record a selector.
    const onLabel = await recordTap({ x: 0.2, y: 0.306 });
    expect(onLabel.message).not.toContain("kept coordinates");

    expect(await recordedSteps()).toEqual([
      { kind: "tap", x: 0.75, y: 0.306 },
      { kind: "tap", selector: { text: "Row 2" } },
    ]);
  });

  it("records the selector with a caveat when captured from the fallback tree source", async () => {
    setTree(
      [n({ label: "Settings", frame: { x: 0.3, y: 0.5, width: 0.4, height: 0.06 } })],
      "ax-service"
    );

    const result = await recordTap({ x: 0.5, y: 0.52 });

    expect(result.message).toContain("fallback ax-service tree");
    expect(await recordedSteps()).toEqual([{ kind: "tap", selector: { text: "Settings" } }]);
  });

  it("keeps coordinates with a warning when the tree fetch fails", async () => {
    currentTreeData = () => {
      throw new Error("devtools gone");
    };

    const result = await recordTap({ x: 0.5, y: 0.52 });

    expect(result.message).toContain("selector capture failed");
    expect(await recordedSteps()).toEqual([{ kind: "tap", x: 0.5, y: 0.52 }]);
  });

  it("does not persist a raw point that replay would reject", async () => {
    setTree([]);

    await expect(recordTap({ x: 1.5, y: 0.52 })).rejects.toThrow(/normalized 0–1 fractions/i);
    expect(await recordedSteps()).toEqual([]);
  });
});
