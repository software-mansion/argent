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
import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import { summarizeStep } from "../../src/tools/flows/flow-finish-recording";
import { __resetRecordingsForTesting, parseFlow } from "../../src/tools/flows/flow-utils";
import { NATIVE_READY_TIMEOUT_MS } from "../../src/tools/flows/flow-run";

const DEVICE = "00000000-0000-0000-0000-0000000000AB"; // iOS UDID shape
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

function mockRegistry(): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "gesture-tap") return { tapped: true };
      throw new Error(`Tool "${id}" not found`);
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
  } as unknown as Registry;
}

async function recordTap(point: { x: number; y: number }) {
  const tool = createFlowAddStepTool(mockRegistry());
  return tool.execute(
    {},
    {
      name: FLOW,
      project_root: tmpDir,
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, ...point }),
    }
  );
}

async function recordedSteps() {
  const content = await fs.readFile(path.join(tmpDir, ".argent", "flows", `${FLOW}.yaml`), "utf8");
  return parseFlow(content).steps;
}

// The recorder re-reads the flow file from disk before each append, so the
// readiness gate is only reached once real I/O has settled — and a fake clock
// does not drive I/O. `useReadinessTimers` therefore leaves setImmediate real,
// and `flushIo` yields to the event loop so the gate's timer is registered
// before the test advances the clock past it.
async function flushIo(turns = 50) {
  for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r));
}

function useReadinessTimers() {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
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
  vi.useRealTimers();
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

    expect(vi.mocked(fetchFlowTree).mock.calls[0]![2]).toBe(BUNDLE);
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

    expect(result.message).toContain("also matches another element");
    expect(result.message).toContain("kept coordinates");
    // The warning names only what narrowing actually tries — the node's own
    // role. Identifier-narrowing does not exist (deriveSelector already uses any
    // stable id as the base), so the message must not claim it was attempted.
    expect(result.message).toContain("narrowing by the tapped element's own role");
    expect(result.message).not.toContain("or identifier");
    // Ambiguity gets its own remedy — re-discovering a selector the recorder
    // already derived is not the fix.
    expect(result.message).toContain("Disambiguate it");
    expect(result.message).not.toContain("Find the real target");
    expect(await recordedSteps()).toEqual([{ kind: "tap", x: 0.2, y: 0.52 }]);
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

  it("records the selector with a caveat when captured from the fallback tree source", async () => {
    setTree(
      [n({ label: "Settings", frame: { x: 0.3, y: 0.5, width: 0.4, height: 0.06 } })],
      "ax-service"
    );

    const result = await recordTap({ x: 0.5, y: 0.52 });

    expect(result.message).toContain("fallback ax-service tree");
    expect(await recordedSteps()).toEqual([{ kind: "tap", selector: { text: "Settings" } }]);
  });

  it("reports both caveats when a role-only selector comes off the fallback tree", async () => {
    // The two warnings are independent and can fire on one capture. A
    // fallback-source read is the most likely to return an unlabeled node. Other
    // tests cover each warning alone, so only this test holds the pair.
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
      "ax-service"
    );

    const result = await recordTap({ x: 0.5, y: 0.5 });

    expect(result.message).toContain("matches by role alone");
    expect(result.message).toContain("fallback ax-service tree");
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

  it("does not persist a raw point that replay would reject", async () => {
    setTree([]);

    await expect(recordTap({ x: 1.5, y: 0.52 })).rejects.toThrow(/normalized 0–1 fractions/i);
    expect(await recordedSteps()).toEqual([]);
  });

  // An ambiguous selector is not an absent one. Refusing it, and offering
  // coordinates as the only way forward, made the recorder unable to record
  // two of the hottest targets in a real app — the search field and a list
  // row — even though the runner resolves the narrower form perfectly.
  it("narrows an ambiguous text selector by role rather than refusing", async () => {
    setTree([
      n({ role: "Button", label: "Search", frame: { x: 0.2, y: 0.9, width: 0.2, height: 0.05 } }),
      n({
        role: "TextField",
        label: "Search",
        frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.06 },
      }),
    ]);

    const result = await recordTap({ x: 0.5, y: 0.13 });

    expect(result.message).toContain("Step added");
    expect(await recordedSteps()).toEqual([
      { kind: "tap", selector: { text: "Search", role: "TextField" } },
    ]);
  });

  it("keeps coordinates when the tapped element cannot be told apart by its own attributes", async () => {
    // A `within` scope is deliberately NOT derived: the flow tree is
    // flattened, so a container can only be found geometrically, and geometry
    // is z-order blind — with a modal open, the foreground's container is a
    // perfectly good "ancestor" of a background element.
    setTree([
      n({
        identifier: "row-1",
        frame: { x: 0, y: 0.1, width: 1, height: 0.1 },
        children: [
          n({
            role: "Button",
            label: "Reply",
            frame: { x: 0.1, y: 0.12, width: 0.2, height: 0.05 },
          }),
        ],
      }),
      n({
        identifier: "row-2",
        frame: { x: 0, y: 0.4, width: 1, height: 0.1 },
        children: [
          n({
            role: "Button",
            label: "Reply",
            frame: { x: 0.1, y: 0.42, width: 0.2, height: 0.05 },
          }),
        ],
      }),
    ]);

    const result = await recordTap({ x: 0.2, y: 0.44 });

    expect(result.message).toContain("also matches another element");
    expect(await recordedSteps()).toEqual([{ kind: "tap", x: 0.2, y: 0.44 }]);
  });

  // Regression: no derived form may carry a POSITIONAL id that deriveSelector
  // refused. The Bluesky edit-profile modal — a tap resolves against a
  // background pager tab whose ambiguous text ("Media") retargets, its role is
  // generic (so nothing narrows), and its only other anchor is
  // `profilePager-selector-2`. deriveSelector refuses that slot id, and
  // narrowing is role-only, so no path can reintroduce it: the recorder keeps
  // coordinates with the ambiguity warning instead.
  it("does not re-inject a positional id when narrowing an ambiguous selector", async () => {
    setTree([
      // A smaller, non-containing "Media" out-ranks the tapped node for a bare
      // { text: "Media" }, so the base selector retargets.
      n({ role: "view", label: "Media", frame: { x: 0.0, y: 0.9, width: 0.1, height: 0.03 } }),
      // The tapped node: generic role (no role narrowing) and only a positional
      // id to fall back on.
      n({
        identifier: "profilePager-selector-2",
        role: "view",
        label: "Media",
        frame: { x: 0.4, y: 0.15, width: 0.2, height: 0.1 },
      }),
    ]);

    const result = await recordTap({ x: 0.5, y: 0.2 });

    expect(result.message).toContain("also matches another element");
    expect(result.message).toContain("Disambiguate it");
    // Critically: the positional id was NOT smuggled back into a recorded step.
    expect(result.message).not.toContain("profilePager-selector-2");
    expect(await recordedSteps()).toEqual([{ kind: "tap", x: 0.5, y: 0.2 }]);
  });

  // A tap on empty space resolves to whatever container spans that spot, and
  // on some trees every screen root is addressable — so the derived selector
  // looked perfect and `frameContains` passed trivially. Observed on Bluesky
  // web: a tap on a profile page's empty left margin recorded
  // `tap: { id: profileView }`, which on replay fired at the screen centre and
  // activated a tab 45% of the screen away.
  it("keeps coordinates for a tap that lands on a container rather than a control", async () => {
    setTree([
      n({ identifier: "profileView", frame: { x: 0, y: 0, width: 1, height: 1 } }),
      n({ role: "Button", label: "Follow", frame: { x: 0.45, y: 0.45, width: 0.1, height: 0.06 } }),
    ]);

    const result = await recordTap({ x: 0.05, y: 0.5 });

    expect(result.message).toContain("covers most of the screen");
    expect(result.message).toContain("a container is indistinguishable from a control");
    expect(result.message).toContain("not the full-screen container it sits in");
    // The point reproduces the tap; the container selector would not. Keeping
    // it beats recording a step that fires 45% of the screen away.
    expect(await recordedSteps()).toEqual([{ kind: "tap", x: 0.05, y: 0.5 }]);
  });

  it("still records a normal control on a screen that has a full-screen root", async () => {
    setTree([
      n({ identifier: "profileView", frame: { x: 0, y: 0, width: 1, height: 1 } }),
      n({ role: "Button", label: "Follow", frame: { x: 0.45, y: 0.45, width: 0.1, height: 0.06 } }),
    ]);

    const result = await recordTap({ x: 0.5, y: 0.48 });

    expect(result.message).toContain("Step added");
    expect(await recordedSteps()).toEqual([{ kind: "tap", selector: { text: "Follow" } }]);
  });

  // MAX_TAP_TARGET_AREA (0.6) is the line between a recordable control and a
  // refused container; pin BOTH sides so the constant cannot silently drift and
  // start recording containers (or refusing ordinary large controls) unnoticed.
  it("records a control whose area sits just under the container threshold", async () => {
    setTree([n({ label: "Banner", frame: { x: 0, y: 0.2, width: 1, height: 0.59 } })]);

    const result = await recordTap({ x: 0.5, y: 0.49 });

    expect(result.message).toContain("Step added");
    expect(result.message).not.toContain("covers most of the screen");
    expect(await recordedSteps()).toEqual([{ kind: "tap", selector: { text: "Banner" } }]);
  });

  it("keeps coordinates for a target whose area sits just over the container threshold", async () => {
    setTree([n({ label: "Banner", frame: { x: 0, y: 0.2, width: 1, height: 0.61 } })]);

    const result = await recordTap({ x: 0.5, y: 0.5 });

    expect(result.message).toContain("covers most of the screen");
    expect(await recordedSteps()).toEqual([{ kind: "tap", x: 0.5, y: 0.5 }]);
  });

  // Neither ambiguous nor container: the tapped node has a generic role and no
  // id or label, so deriveSelector returns null. The remedy must point at the
  // tree reader (not "disambiguate", there is no selector; not "find a smaller
  // control", it is not a container) and only CONDITIONALLY suggest the element
  // itself is worth fixing — the failure may be that no node was addressable.
  it("sends the author to find a real target when the tapped element is unaddressable", async () => {
    setTree([n({ role: "AXGroup", frame: { x: 0.3, y: 0.5, width: 0.2, height: 0.05 } })]);

    const result = await recordTap({ x: 0.4, y: 0.52 });

    expect(result.message).toContain("tapped element has no stable text/id");
    expect(result.message).toContain("Find the real target");
    expect(result.message).toContain("If the element genuinely has no id or label");
    expect(result.message).not.toContain("Disambiguate it");
    expect(result.message).not.toContain("covers most of the screen");
    expect(await recordedSteps()).toEqual([{ kind: "tap", x: 0.4, y: 0.52 }]);
  });

  // The flow tree is FLATTENED, so a control's own label is a SIBLING rect
  // sitting on the control's centre. Requiring the centre to resolve back to
  // the same node refused a like button, a search field, a full-width row and
  // every grid cell — all of which replay perfectly, because the touch is
  // still inside the control. Two reviewers reproduced this independently.
  it("records a control whose own label sits on its centre", async () => {
    setTree([
      n({
        identifier: "likeBtn",
        label: "Like (393 likes)",
        frame: { x: 0.522, y: 0.647, width: 0.14, height: 0.032 },
      }),
      n({
        identifier: "likeCount",
        label: "393",
        frame: { x: 0.59, y: 0.653, width: 0.061, height: 0.02 },
      }),
    ]);

    // Off-centre, on the glyph rather than the count — exactly how an agent
    // taps a like button.
    const result = await recordTap({ x: 0.556, y: 0.6625 });

    expect(result.message).toContain("Step added");
    expect(await recordedSteps()).toEqual([{ kind: "tap", selector: { identifier: "likeBtn" } }]);
  });

  it("records a full-width row tapped off-centre, past its centred content", async () => {
    setTree([
      n({ label: "Edit interests", frame: { x: 0.04, y: 0.281, width: 0.92, height: 0.038 } }),
      // A centred chevron/icon leaf sitting on the row's centre — addressable,
      // but not what the tap was aimed at.
      n({ role: "AXImage", frame: { x: 0.47, y: 0.29, width: 0.06, height: 0.02 } }),
    ]);

    const result = await recordTap({ x: 0.113, y: 0.2996 });

    expect(result.message).toContain("Step added");
    expect(await recordedSteps()).toEqual([{ kind: "tap", selector: { text: "Edit interests" } }]);
  });

  it.each(["emulator-5554", "chromium-cdp-9222"])(
    "does not consult native devtools while recording a tap on %s",
    async (udid) => {
      setTree([n({ label: "Continue", frame: { x: 0.3, y: 0.5, width: 0.4, height: 0.06 } })]);
      const resolveService = vi.fn(async () => {
        throw new Error("must not be consulted");
      });
      const registry = {
        invokeTool: vi.fn(async () => ({ tapped: true })),
        getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
        resolveService,
      } as unknown as Registry;
      const tool = createFlowAddStepTool(registry);

      await tool.execute(
        {},
        {
          name: FLOW,
          project_root: tmpDir,
          command: "gesture-tap",
          args: JSON.stringify({ udid, x: 0.5, y: 0.52 }),
        }
      );

      expect(resolveService).not.toHaveBeenCalled();
    }
  );

  it("rides out the post-launch devtools connect window before reading the tree", async () => {
    // The injected dylib dials back asynchronously after a live restart-app —
    // capture must poll for a targetable connected app (mirroring replay's
    // launch gate) instead of downgrading the first post-launch tap to
    // coordinates on a transient "no connected app" read.
    let connected = false;
    currentTreeData = () => {
      if (!connected) throw new Error("no connected app yet");
      return {
        tree: screen([n({ label: "Home", frame: { x: 0.3, y: 0.5, width: 0.4, height: 0.06 } })]),
        source: "native-devtools",
      };
    };
    setTimeout(() => {
      connected = true;
    }, 300);

    const api = {
      listConnectedBundleIds: () => (connected ? ["com.example.app"] : []),
      getAppState: async (bundleId: string) => ({
        bundleId,
        applicationState: "active",
        foregroundActiveSceneCount: 1,
        foregroundInactiveSceneCount: 0,
        backgroundSceneCount: 0,
        unattachedSceneCount: 0,
        isFrontmostCandidate: true,
      }),
    };
    const registry = {
      invokeTool: vi.fn(async () => ({ tapped: true })),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
      resolveService: vi.fn(async () => api),
    } as unknown as Registry;

    const tool = createFlowAddStepTool(registry);
    const result = await tool.execute(
      {},
      {
        name: FLOW,
        project_root: tmpDir,
        command: "gesture-tap",
        args: JSON.stringify({ udid: DEVICE, x: 0.5, y: 0.52 }),
      }
    );

    expect(result.message).not.toContain("kept coordinates");
    expect(await recordedSteps()).toEqual([{ kind: "tap", selector: { text: "Home" } }]);
  });

  it("falls through immediately when the native-devtools service is unavailable", async () => {
    setTree([n({ label: "Home", frame: { x: 0.3, y: 0.5, width: 0.4, height: 0.06 } })]);
    const resolveService = vi.fn(async () => {
      throw new Error("native-devtools service unavailable");
    });
    const registry = {
      invokeTool: vi.fn(async () => ({ tapped: true })),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
      resolveService,
    } as unknown as Registry;

    const result = await createFlowAddStepTool(registry).execute(
      {},
      {
        name: FLOW,
        project_root: tmpDir,
        command: "gesture-tap",
        args: JSON.stringify({ udid: DEVICE, x: 0.5, y: 0.52 }),
      }
    );

    expect(resolveService).toHaveBeenCalledOnce();
    expect(result.message).not.toContain("kept coordinates");
  });

  it("pays an expired iOS readiness budget only once per recording session", async () => {
    useReadinessTimers();
    currentTreeData = () => {
      throw new Error("no connected app");
    };
    const listConnectedBundleIds = vi.fn(() => [] as string[]);
    const registry = {
      invokeTool: vi.fn(async () => ({ tapped: true })),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
      resolveService: vi.fn(async () => ({
        listConnectedBundleIds,
        getAppState: vi.fn(),
      })),
    } as unknown as Registry;
    const tool = createFlowAddStepTool(registry);

    const first = tool.execute(
      {},
      {
        name: FLOW,
        project_root: tmpDir,
        command: "gesture-tap",
        args: JSON.stringify({ udid: DEVICE, x: 0.5, y: 0.52 }),
      }
    );
    await flushIo();
    await vi.advanceTimersByTimeAsync(NATIVE_READY_TIMEOUT_MS);
    const firstResult = await first;
    expect(firstResult.message).toContain("kept coordinates");
    const readinessCalls = listConnectedBundleIds.mock.calls.length;
    expect(readinessCalls).toBeGreaterThan(1);

    // The failed tree read leaves the miss cached. The next tap performs one
    // direct capture attempt and returns without another readiness poll.
    const secondResult = await tool.execute(
      {},
      {
        name: FLOW,
        project_root: tmpDir,
        command: "gesture-tap",
        args: JSON.stringify({ udid: DEVICE, x: 0.4, y: 0.42 }),
      }
    );
    expect(secondResult.message).toContain("kept coordinates");
    expect(listConnectedBundleIds).toHaveBeenCalledTimes(readinessCalls);
  });

  it("invalidates a cached timed-out readiness miss after a successful restart-app", async () => {
    useReadinessTimers();
    let connected = false;
    currentTreeData = () => {
      if (!connected) throw new Error("no connected app");
      return {
        tree: screen([
          n({ label: "Recovered", frame: { x: 0.3, y: 0.5, width: 0.4, height: 0.06 } }),
        ]),
        source: "native-devtools",
      };
    };
    const listConnectedBundleIds = vi.fn(() =>
      connected ? ["com.example.app"] : ([] as string[])
    );
    const resolveService = vi.fn(async () => ({
      listConnectedBundleIds,
      getAppState: async (bundleId: string) => ({
        bundleId,
        applicationState: "active",
        foregroundActiveSceneCount: 1,
        foregroundInactiveSceneCount: 0,
        backgroundSceneCount: 0,
        unattachedSceneCount: 0,
        isFrontmostCandidate: true,
      }),
    }));
    const registry = {
      invokeTool: vi.fn(async (id: string) => {
        if (id === "restart-app") {
          setTimeout(() => {
            connected = true;
          }, 300);
          return { restarted: true, bundleId: "com.example.app" };
        }
        return { tapped: true };
      }),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
      resolveService,
    } as unknown as Registry;
    const tool = createFlowAddStepTool(registry);

    const missedPending = tool.execute(
      {},
      {
        name: FLOW,
        project_root: tmpDir,
        command: "gesture-tap",
        args: JSON.stringify({ udid: DEVICE, x: 0.5, y: 0.52 }),
      }
    );
    await flushIo();
    await vi.advanceTimersByTimeAsync(NATIVE_READY_TIMEOUT_MS);
    const missed = await missedPending;
    expect(missed.message).toContain("kept coordinates");
    const callsAtTimeout = listConnectedBundleIds.mock.calls.length;
    expect(callsAtTimeout).toBeGreaterThan(1);

    // Keep this as a raw restart in the prerequisite-bearing fragment; the
    // live successful restart must invalidate the per-device timed-out miss.
    await tool.execute(
      {},
      {
        name: FLOW,
        project_root: tmpDir,
        command: "restart-app",
        args: JSON.stringify({ udid: DEVICE, bundleId: "com.example.app" }),
        delayMs: 1,
      }
    );
    const recoveredPending = tool.execute(
      {},
      {
        name: FLOW,
        project_root: tmpDir,
        command: "gesture-tap",
        args: JSON.stringify({ udid: DEVICE, x: 0.5, y: 0.52 }),
      }
    );
    await flushIo();
    await vi.advanceTimersByTimeAsync(500);
    const recovered = await recoveredPending;

    expect(resolveService).toHaveBeenCalledTimes(2);
    expect(listConnectedBundleIds.mock.calls.length).toBeGreaterThan(callsAtTimeout);
    expect(recovered.message).not.toContain("kept coordinates");
    expect((await recordedSteps()).at(-1)).toEqual({
      kind: "tap",
      selector: { text: "Recovered" },
    });
  });

  it("invalidates a cached timed-out readiness miss after a successful launch-app", async () => {
    // launch-app foregrounds an already-running process without recording a
    // launch step, so the recovered tap auto-targets. Its `launched: true` must
    // clear the per-device miss just like restart-app's `restarted: true`.
    useReadinessTimers();
    let connected = false;
    currentTreeData = () => {
      if (!connected) throw new Error("no connected app");
      return {
        tree: screen([
          n({ label: "Foregrounded", frame: { x: 0.3, y: 0.5, width: 0.4, height: 0.06 } }),
        ]),
        source: "native-devtools",
      };
    };
    const listConnectedBundleIds = vi.fn(() =>
      connected ? ["com.example.app"] : ([] as string[])
    );
    const resolveService = vi.fn(async () => ({
      listConnectedBundleIds,
      getAppState: async (bundleId: string) => ({
        bundleId,
        applicationState: "active",
        foregroundActiveSceneCount: 1,
        foregroundInactiveSceneCount: 0,
        backgroundSceneCount: 0,
        unattachedSceneCount: 0,
        isFrontmostCandidate: true,
      }),
    }));
    const registry = {
      invokeTool: vi.fn(async (id: string) => {
        if (id === "launch-app") {
          setTimeout(() => {
            connected = true;
          }, 300);
          return { launched: true, bundleId: "com.example.app" };
        }
        return { tapped: true };
      }),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
      resolveService,
    } as unknown as Registry;
    const tool = createFlowAddStepTool(registry);

    const missedPending = tool.execute(
      {},
      {
        name: FLOW,
        project_root: tmpDir,
        command: "gesture-tap",
        args: JSON.stringify({ udid: DEVICE, x: 0.5, y: 0.52 }),
      }
    );
    await flushIo();
    await vi.advanceTimersByTimeAsync(NATIVE_READY_TIMEOUT_MS);
    const missed = await missedPending;
    expect(missed.message).toContain("kept coordinates");
    const callsAtTimeout = listConnectedBundleIds.mock.calls.length;
    expect(callsAtTimeout).toBeGreaterThan(1);

    await tool.execute(
      {},
      {
        name: FLOW,
        project_root: tmpDir,
        command: "launch-app",
        args: JSON.stringify({ udid: DEVICE, bundleId: "com.example.app" }),
      }
    );
    const recoveredPending = tool.execute(
      {},
      {
        name: FLOW,
        project_root: tmpDir,
        command: "gesture-tap",
        args: JSON.stringify({ udid: DEVICE, x: 0.5, y: 0.52 }),
      }
    );
    await flushIo();
    await vi.advanceTimersByTimeAsync(500);
    const recovered = await recoveredPending;

    // The successful launch-app cleared the miss, so the second tap re-probes
    // (more readiness calls) and captures once the app connects.
    expect(listConnectedBundleIds.mock.calls.length).toBeGreaterThan(callsAtTimeout);
    expect(recovered.message).not.toContain("kept coordinates");
    expect((await recordedSteps()).at(-1)).toEqual({
      kind: "tap",
      selector: { text: "Foregrounded" },
    });
  });

  it("hard-caps readiness when a connected app-state RPC wedges", async () => {
    useReadinessTimers();
    currentTreeData = () => {
      throw new Error("no connected app");
    };
    const getAppState = vi.fn(() => new Promise<never>(() => {}));
    const registry = {
      invokeTool: vi.fn(async () => ({ tapped: true })),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
      resolveService: vi.fn(async () => ({
        listConnectedBundleIds: () => ["com.example.wedged"],
        getAppState,
      })),
    } as unknown as Registry;
    const tool = createFlowAddStepTool(registry);
    const startedAt = Date.now();

    const pending = tool.execute(
      {},
      {
        name: FLOW,
        project_root: tmpDir,
        command: "gesture-tap",
        args: JSON.stringify({ udid: DEVICE, x: 0.5, y: 0.52 }),
      }
    );
    await flushIo();
    await vi.advanceTimersByTimeAsync(NATIVE_READY_TIMEOUT_MS);
    const result = await pending;

    expect(Date.now() - startedAt).toBe(NATIVE_READY_TIMEOUT_MS);
    expect(getAppState).toHaveBeenCalledOnce();
    expect(result.message).toContain("kept coordinates");
    // The budget bounds the wait, it does not cancel the step: the gesture
    // still runs, so the recording keeps describing the walkthrough it made.
    expect(registry.invokeTool).toHaveBeenCalledWith(
      "gesture-tap",
      expect.objectContaining({ x: 0.5, y: 0.52 })
    );
  });

  it("keeps polling to the budget when a connected app-state RPC rejects", async () => {
    // Distinct from the wedge case: here getAppState REJECTS rather than hanging,
    // so settleWithin resolves to { type: "error" }. The auto-target branch only
    // matches aborted/timeout/value, so an error must fall through as not-ready
    // and keep polling to the budget — not abort early, not spin, not hang.
    useReadinessTimers();
    currentTreeData = () => {
      throw new Error("no connected app");
    };
    const getAppState = vi.fn(async () => {
      throw new Error("app-state RPC failed");
    });
    const registry = {
      invokeTool: vi.fn(async () => ({ tapped: true })),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
      resolveService: vi.fn(async () => ({
        listConnectedBundleIds: () => ["com.example.err"],
        getAppState,
      })),
    } as unknown as Registry;
    const tool = createFlowAddStepTool(registry);
    const startedAt = Date.now();

    const pending = tool.execute(
      {},
      {
        name: FLOW,
        project_root: tmpDir,
        command: "gesture-tap",
        args: JSON.stringify({ udid: DEVICE, x: 0.5, y: 0.52 }),
      }
    );
    await flushIo();
    await vi.advanceTimersByTimeAsync(NATIVE_READY_TIMEOUT_MS);
    const result = await pending;

    expect(Date.now() - startedAt).toBe(NATIVE_READY_TIMEOUT_MS);
    // Retried each poll (treated as not-ready) rather than giving up on the first
    // rejection — proof the error result keeps the loop alive to the deadline.
    expect(getAppState.mock.calls.length).toBeGreaterThan(1);
    expect(result.message).toContain("kept coordinates");
  });

  it("does not treat a connected background app as ready", async () => {
    useReadinessTimers();
    currentTreeData = () => {
      throw new Error("no frontmost connected app");
    };
    const listConnectedBundleIds = vi.fn(() => ["com.example.background"]);
    const registry = {
      invokeTool: vi.fn(async () => ({ tapped: true })),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
      resolveService: vi.fn(async () => ({
        listConnectedBundleIds,
        getAppState: vi.fn(async (bundleId: string) => ({
          bundleId,
          applicationState: "background",
          foregroundActiveSceneCount: 0,
          foregroundInactiveSceneCount: 0,
          backgroundSceneCount: 1,
          unattachedSceneCount: 0,
          isFrontmostCandidate: false,
        })),
      })),
    } as unknown as Registry;
    const tool = createFlowAddStepTool(registry);

    const pending = tool.execute(
      {},
      {
        name: FLOW,
        project_root: tmpDir,
        command: "gesture-tap",
        args: JSON.stringify({ udid: DEVICE, x: 0.5, y: 0.52 }),
      }
    );
    await flushIo();
    await vi.advanceTimersByTimeAsync(NATIVE_READY_TIMEOUT_MS);
    const result = await pending;

    expect(listConnectedBundleIds.mock.calls.length).toBeGreaterThan(1);
    expect(result.message).toContain("kept coordinates");
  });

  it("skips readiness polling for non-injectable bundle ids case-insensitively", async () => {
    await flowStartRecordingTool.execute({}, { name: FLOW, project_root: tmpDir });
    setTree([n({ label: "Settings", frame: { x: 0.3, y: 0.5, width: 0.4, height: 0.06 } })]);
    const resolveService = vi.fn(async () => {
      throw new Error("must not be consulted");
    });
    const registry = {
      invokeTool: vi.fn(async (id: string) =>
        id === "restart-app" ? { restarted: true } : { tapped: true }
      ),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
      resolveService,
    } as unknown as Registry;
    const tool = createFlowAddStepTool(registry);
    await tool.execute(
      {},
      {
        name: FLOW,
        project_root: tmpDir,
        command: "restart-app",
        args: JSON.stringify({ udid: DEVICE, bundleId: "COM.APPLE.Preferences" }),
      }
    );

    const result = await tool.execute(
      {},
      {
        name: FLOW,
        project_root: tmpDir,
        command: "gesture-tap",
        args: JSON.stringify({ udid: DEVICE, x: 0.5, y: 0.52 }),
      }
    );

    expect(resolveService).not.toHaveBeenCalled();
    expect(result.message).not.toContain("kept coordinates");
  });

  it("aborts during readiness without executing or recording the tap", async () => {
    const controller = new AbortController();
    const registry = {
      invokeTool: vi.fn(async () => ({ tapped: true })),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
      resolveService: vi.fn(async () => ({
        listConnectedBundleIds: () => [] as string[],
        getAppState: vi.fn(),
      })),
    } as unknown as Registry;
    const tool = createFlowAddStepTool(registry);

    const pending = tool.execute(
      {},
      {
        name: FLOW,
        project_root: tmpDir,
        command: "gesture-tap",
        args: JSON.stringify({ udid: DEVICE, x: 0.5, y: 0.52 }),
      },
      { signal: controller.signal } as never
    );
    await Promise.resolve();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(await recordedSteps()).toEqual([]);
  });

  it("polls the leading launch's exact bundle and captures once it connects", async () => {
    // The PR's headline path: an injectable leading launch drives the gate's
    // exact-bundle `isConnected` poll (mirroring replay's waitForNativeDevtools),
    // not the auto-target branch. The dylib dials back only after a delay, so the
    // gate must ride that window out and still capture a selector.
    await flowStartRecordingTool.execute({}, { name: FLOW, project_root: tmpDir });
    let connected = false;
    // Gate the tree read on the connection too. With an unconditional setTree the
    // ride-out is not falsifiable: a gate that skipped the wait would read the
    // (already present) tree and capture a selector anyway, so the assertions
    // below would pass even with the gate removed. Throwing until connected
    // mirrors the real fetchFlowTree, which fails per-read while native-devtools
    // is disconnected — so a premature read now degrades to coordinates and the
    // `not.toContain("kept coordinates")` assertion catches it.
    currentTreeData = () => {
      if (!connected) throw new Error("no connected app yet");
      return {
        tree: screen([n({ label: "Home", frame: { x: 0.3, y: 0.5, width: 0.4, height: 0.06 } })]),
        source: "native-devtools",
      };
    };
    const isConnected = vi.fn((bundleId: string) => bundleId === "com.example.app" && connected);
    setTimeout(() => {
      connected = true;
    }, 300);
    const registry = {
      invokeTool: vi.fn(async (id: string) =>
        id === "restart-app" ? { restarted: true, bundleId: "com.example.app" } : { tapped: true }
      ),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
      resolveService: vi.fn(async () => ({
        isConnected,
        listConnectedBundleIds: () => (connected ? ["com.example.app"] : []),
        getAppState: vi.fn(),
      })),
    } as unknown as Registry;
    const tool = createFlowAddStepTool(registry);
    await tool.execute(
      {},
      {
        name: FLOW,
        project_root: tmpDir,
        command: "restart-app",
        args: JSON.stringify({ udid: DEVICE, bundleId: "com.example.app" }),
      }
    );

    const result = await tool.execute(
      {},
      {
        name: FLOW,
        project_root: tmpDir,
        command: "gesture-tap",
        args: JSON.stringify({ udid: DEVICE, x: 0.5, y: 0.52 }),
      }
    );

    // The exact-bundle bit was polled (not the auto-target path), and the gate
    // rode the connect window out rather than downgrading to coordinates.
    expect(isConnected).toHaveBeenCalledWith("com.example.app");
    expect(result.message).not.toContain("kept coordinates");
    expect((await recordedSteps()).at(-1)).toEqual({ kind: "tap", selector: { text: "Home" } });
  });

  it("gates on the most recent launch, riding out a mid-flow app switch", async () => {
    // restart A … restart B … tap. A stays connected (restart-app B never
    // touched it); B connects only after a delay. The gate must wait for B — the
    // most recent launch — not confirm A and read B's tree before it connected.
    await flowStartRecordingTool.execute({}, { name: FLOW, project_root: tmpDir });
    let bConnected = false;
    // As above: gate the tree read on B's connection so "wait for the most recent
    // launch" is falsifiable. Keying on A (already connected) would read here
    // while B is still disconnected and downgrade to coordinates — which the
    // `not.toContain("kept coordinates")` assertion below would then catch.
    currentTreeData = () => {
      if (!bConnected) throw new Error("B not connected yet");
      return {
        tree: screen([n({ label: "B Home", frame: { x: 0.3, y: 0.5, width: 0.4, height: 0.06 } })]),
        source: "native-devtools",
      };
    };
    const isConnected = vi.fn(
      (bundleId: string) =>
        bundleId === "com.example.a" || (bundleId === "com.example.b" && bConnected)
    );
    setTimeout(() => {
      bConnected = true;
    }, 300);
    const registry = {
      invokeTool: vi.fn(async (id: string) =>
        id === "restart-app" ? { restarted: true } : { tapped: true }
      ),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
      resolveService: vi.fn(async () => ({
        isConnected,
        listConnectedBundleIds: () => [],
        getAppState: vi.fn(),
      })),
    } as unknown as Registry;
    const tool = createFlowAddStepTool(registry);
    for (const bundleId of ["com.example.a", "com.example.b"]) {
      await tool.execute(
        {},
        {
          name: FLOW,
          project_root: tmpDir,
          command: "restart-app",
          args: JSON.stringify({ udid: DEVICE, bundleId }),
        }
      );
    }

    const result = await tool.execute(
      {},
      {
        name: FLOW,
        project_root: tmpDir,
        command: "gesture-tap",
        args: JSON.stringify({ udid: DEVICE, x: 0.5, y: 0.52 }),
      }
    );

    // Falsifiable against the old leading-launch keying, which would poll A
    // (already connected) and never wait for — or even query — B.
    expect(isConnected).toHaveBeenCalledWith("com.example.b");
    expect(isConnected).not.toHaveBeenCalledWith("com.example.a");
    expect(result.message).not.toContain("kept coordinates");
    expect((await recordedSteps()).at(-1)).toEqual({ kind: "tap", selector: { text: "B Home" } });
  });
});
