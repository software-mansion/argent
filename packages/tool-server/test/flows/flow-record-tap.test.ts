import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import {
  AX_SERVICE_NAMESPACE,
  type AXTreeNode,
  type AXTreeResponse,
} from "../../src/blueprints/ax-service";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

// The recorder must read the SAME tree source the runner resolves selectors
// against at replay. On an iOS SIMULATOR that is the accessibility daemon's
// `tree`, read through the registry's ax-service (`queryAxFlowTree`), so the
// simulator cases below serve a raw daemon reply and let the real projection
// and selector derivation run. Every other platform — Android, a physical
// iPhone — reads `fetchFlowTree`; mock it directly so those cases control
// exactly what capture sees.
let currentTreeData: () => DescribeTreeData;
vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn(async (): Promise<DescribeTreeData> => currentTreeData()),
}));

import { fetchFlowTree } from "../../src/tools/flows/flow-tree";
import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import { summarizeStep } from "../../src/tools/flows/flow-step-definitions";
import { __resetRecordingsForTesting, parseFlow } from "../../src/tools/flows/flow-utils";

const DEVICE = "00000000-0000-0000-0000-0000000000AB"; // iOS simulator UDID shape
const REMOTE = `remote:${DEVICE}`; // remote: prefix → classifies ios-remote, always a simulator
const PHONE = "00008120-000A44443333801E"; // physical-iPhone UDID shape → kind "device"
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

// ── Runner-tree fixtures for the platforms that read `fetchFlowTree` ──────

function n(partial: Partial<DescribeNode> & { frame: DescribeNode["frame"] }): DescribeNode {
  return { role: "AXOther", children: [], ...partial };
}

function screen(children: DescribeNode[]): DescribeNode {
  return n({ role: "AXGroup", frame: { x: 0, y: 0, width: 1, height: 1 }, children });
}

function setTree(children: DescribeNode[], source: DescribeTreeData["source"]) {
  currentTreeData = () => ({ tree: screen(children), source });
}

// ── Daemon-tree fixtures for the iOS simulator ────────────────────────────

type AxFrame = NonNullable<AXTreeNode["frame"]>;

/**
 * One `tree` reply: the app element at index 0 (the roots are the apps; their
 * children are the screen), every fixture node under it unless it names
 * another parent. Frames are normalized 0–1, as the daemon sends them.
 */
function axReply(nodes: AXTreeNode[]): AXTreeResponse {
  return {
    alertVisible: false,
    screenFrame: { width: 390, height: 844 },
    nodes: [{ index: 0, label: "Shop" }, ...nodes.map((node) => ({ parentIndex: 0, ...node }))],
    truncated: false,
  };
}

/** A VoiceOver target: what a finger lands on. */
function axLeaf(partial: Partial<AXTreeNode> & { index: number; frame: AxFrame }): AXTreeNode {
  return { accessible: true, ...partial };
}

/** A container that only groups targets — a list row, a card, a section. */
function axGroup(partial: Partial<AXTreeNode> & { index: number; frame: AxFrame }): AXTreeNode {
  return partial;
}

// What the daemon answers, per read. `readSettledAxFlowTree` reads until two
// consecutive reads agree, so a fixture that serves ONE reply settles on the
// second read; a sequence lets a case stage a screen still moving.
let axReads: () => AXTreeResponse;
let axReadCount: number;

function setAxTree(nodes: AXTreeNode[]) {
  const reply = axReply(nodes);
  axReads = () => reply;
}

function setAxReads(replies: AXTreeResponse[]) {
  axReads = () => replies[Math.min(axReadCount - 1, replies.length - 1)]!;
}

function mockRegistry(): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "gesture-tap") return { tapped: true };
      throw new Error(`Tool "${id}" not found`);
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    // The simulator tree source: `AXService:<udid>` resolved through the
    // registry, answering `tree` from the staged replies.
    resolveService: vi.fn(async (urn: string) => {
      if (!urn.startsWith(`${AX_SERVICE_NAMESPACE}:`)) throw new Error(`no service for ${urn}`);
      return {
        tree: async () => {
          axReadCount += 1;
          return axReads();
        },
      };
    }),
  } as unknown as Registry;
}

async function recordTapOn(
  udid: string,
  point: { x: number; y: number },
  extra: Record<string, unknown> = {}
) {
  const tool = createFlowAddStepTool(mockRegistry());
  return tool.execute(
    {},
    {
      name: FLOW,
      project_root: tmpDir,
      command: "gesture-tap",
      args: JSON.stringify({ udid, ...point, ...extra }),
    }
  );
}

async function recordTap(point: { x: number; y: number }, extra: Record<string, unknown> = {}) {
  return recordTapOn(DEVICE, point, extra);
}

async function recordedYaml() {
  return fs.readFile(path.join(tmpDir, ".argent", "flows", `${FLOW}.yaml`), "utf8");
}

async function recordedSteps() {
  return parseFlow(await recordedYaml()).steps;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-record-tap-"));
  __resetRecordingsForTesting();
  axReadCount = 0;
  setAxTree([]);
  currentTreeData = () => {
    throw new Error("fixture: this case does not serve a runner tree");
  };
  await flowStartRecordingTool.execute(
    {},
    { name: FLOW, project_root: tmpDir, executionPrerequisite: PREREQ }
  );
});

afterEach(async () => {
  __resetRecordingsForTesting();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("flow-add-step tap selector capture on an iOS simulator", () => {
  const ADD_TO_CART = { x: 0.3, y: 0.5, width: 0.4, height: 0.06 };
  // Its centre, so no `at` is recorded (see the off-centre cases below).
  const ADD_TO_CART_CENTRE = { x: 0.5, y: 0.53 };

  it("reads the daemon's tree through the registry, not fetchFlowTree", async () => {
    setAxTree([
      axLeaf({
        index: 1,
        identifier: "add-to-cart",
        label: "Add to cart",
        traits: ["button"],
        frame: ADD_TO_CART,
      }),
    ]);

    await recordTap(ADD_TO_CART_CENTRE);

    expect(vi.mocked(fetchFlowTree)).not.toHaveBeenCalled();
    // Settled: the read repeats until two consecutive reads agree.
    expect(axReadCount).toBeGreaterThanOrEqual(2);
    expect(await recordedSteps()).toEqual([
      { kind: "tap", selector: { identifier: "add-to-cart" } },
    ]);
  });

  it("captures an identifier selector with no warning", async () => {
    setAxTree([
      axLeaf({
        index: 1,
        identifier: "add-to-cart",
        label: "Add to cart",
        traits: ["button"],
        frame: ADD_TO_CART,
      }),
    ]);

    const result = await recordTap(ADD_TO_CART_CENTRE);

    expect(result.message).toBe(`Step added to "${FLOW}" flow`);
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
    setAxTree([
      axLeaf({
        index: 1,
        identifier: "add-to-cart",
        label: "Add to cart",
        traits: ["button"],
        frame: ADD_TO_CART,
      }),
    ]);

    const result = await recordTap(ADD_TO_CART_CENTRE);

    expect(result.recorded).toBe('1. tap: {"id":"add-to-cart"}');
    expect(result.recorded).toBe(summarizeStep((await recordedSteps())[0], 1));
    expect(result.stepCount).toBe(1);
  });

  it("reports the coordinate fallback in the `recorded` line", async () => {
    // The other half of the same signal: when no selector is derivable the
    // step stays a coordinate tap, and `recorded` has to say so — that is how
    // the author knows the brittle form was kept, alongside the warning.
    setAxTree([]);

    const result = await recordTap({ x: 0.5, y: 0.52 });

    expect(result.message).toContain("no element found under the tap; kept coordinates (brittle)");
    expect(result.recorded).toBe("1. tap: (0.5, 0.52)");
    expect(result.recorded).toBe(summarizeStep((await recordedSteps())[0], 1));
  });

  it("captures text plus role when the node has no identifier", async () => {
    // Text alone is the loose spelling; the role pins the kind of element the
    // author tapped, so a label repeated on a heading cannot take the match.
    setAxTree([axLeaf({ index: 1, label: "Add to cart", traits: ["button"], frame: ADD_TO_CART })]);

    const result = await recordTap(ADD_TO_CART_CENTRE);

    expect(result.message).toBe(`Step added to "${FLOW}" flow`);
    expect(await recordedSteps()).toEqual([
      { kind: "tap", selector: { text: "Add to cart", role: "AXButton" } },
    ]);
  });

  it("records the label alone for a control that also exposes a value", async () => {
    // The label+value join ("Volume 50%") exists on no single node — matchNode
    // compares a text selector against label and value individually — so the
    // derived selector must use the label alone and still resolve back to the
    // tapped element instead of degrading to coordinates.
    setAxTree([
      axLeaf({
        index: 1,
        label: "Volume",
        value: "50%",
        traits: ["adjustable"],
        frame: { x: 0.2, y: 0.4, width: 0.6, height: 0.08 },
      }),
    ]);

    const result = await recordTap({ x: 0.5, y: 0.44 });

    expect(result.message).not.toContain("kept coordinates");
    expect(await recordedSteps()).toEqual([
      { kind: "tap", selector: { text: "Volume", role: "AXAdjustable" } },
    ]);
  });

  it("carries a recorded clickCount into the tap step's times", async () => {
    // A recorded double-tap must not silently replay as a single tap.
    setAxTree([axLeaf({ index: 1, label: "Photo", traits: ["image"], frame: ADD_TO_CART })]);

    await recordTap(ADD_TO_CART_CENTRE, { clickCount: 2 });

    expect(await recordedSteps()).toEqual([
      { kind: "tap", selector: { text: "Photo", role: "AXImage" }, times: 2 },
    ]);
  });

  it("scopes a repeated id by the stable container it sits in", async () => {
    // Two "Remove" buttons with the same testID, one per section. The section
    // containers carry only an id — nodes `describe` never lists, which is why
    // the recorder reads the daemon's tree whole.
    setAxTree([
      axGroup({
        index: 1,
        identifier: "cart-section",
        frame: { x: 0, y: 0.1, width: 1, height: 0.3 },
      }),
      axLeaf({
        index: 2,
        parentIndex: 1,
        identifier: "remove",
        label: "Remove",
        traits: ["button"],
        frame: { x: 0.7, y: 0.2, width: 0.2, height: 0.05 },
      }),
      axGroup({
        index: 3,
        identifier: "wishlist-section",
        frame: { x: 0, y: 0.5, width: 1, height: 0.3 },
      }),
      axLeaf({
        index: 4,
        parentIndex: 3,
        identifier: "remove",
        label: "Remove",
        traits: ["button"],
        frame: { x: 0.7, y: 0.6, width: 0.2, height: 0.05 },
      }),
    ]);

    const result = await recordTap({ x: 0.8, y: 0.625 });

    // The scope is informational: the step replays, and the author should know
    // what pins it to this section.
    expect(result.message).toBe(`Step added to "${FLOW}" flow — scoped by within wishlist-section`);
    expect(result.recorded).toBe('1. tap: {"id":"remove","within":{"id":"wishlist-section"}}');
    expect(await recordedSteps()).toEqual([
      {
        kind: "tap",
        selector: { identifier: "remove", within: { identifier: "wishlist-section" } },
      },
    ]);
  });

  it("scopes a repeated label by the stable container when it has no id", async () => {
    setAxTree([
      axGroup({
        index: 1,
        identifier: "cart-section",
        frame: { x: 0, y: 0.1, width: 1, height: 0.3 },
      }),
      axLeaf({
        index: 2,
        parentIndex: 1,
        label: "Remove",
        traits: ["button"],
        frame: { x: 0.7, y: 0.2, width: 0.2, height: 0.05 },
      }),
      axGroup({
        index: 3,
        identifier: "wishlist-section",
        frame: { x: 0, y: 0.5, width: 1, height: 0.3 },
      }),
      axLeaf({
        index: 4,
        parentIndex: 3,
        label: "Remove",
        traits: ["button"],
        frame: { x: 0.7, y: 0.6, width: 0.2, height: 0.05 },
      }),
    ]);

    const result = await recordTap({ x: 0.8, y: 0.625 });

    expect(result.message).toContain("scoped by within wishlist-section");
    expect(await recordedSteps()).toEqual([
      {
        kind: "tap",
        selector: {
          text: "Remove",
          role: "AXButton",
          within: { identifier: "wishlist-section" },
        },
      },
    ]);
  });

  it("anchors a repeated label on the unique element before it when no container has an id", async () => {
    // A plain list: no container carries an id, so the row's own label is what
    // tells the two "Add" buttons apart.
    setAxTree([
      axLeaf({
        index: 1,
        label: "Milk",
        traits: ["staticText"],
        frame: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 },
      }),
      axLeaf({
        index: 2,
        label: "Add",
        traits: ["button"],
        frame: { x: 0.7, y: 0.2, width: 0.2, height: 0.05 },
      }),
      axLeaf({
        index: 3,
        label: "Eggs",
        traits: ["staticText"],
        frame: { x: 0.1, y: 0.3, width: 0.3, height: 0.05 },
      }),
      axLeaf({
        index: 4,
        label: "Add",
        traits: ["button"],
        frame: { x: 0.7, y: 0.3, width: 0.2, height: 0.05 },
      }),
    ]);

    const result = await recordTap({ x: 0.8, y: 0.325 });

    expect(result.message).toContain('scoped by next {"text":"Eggs"}');
    expect(await recordedSteps()).toEqual([
      { kind: "tap", selector: { text: "Add", role: "AXButton", next: { text: "Eggs" } } },
    ]);
  });

  it("keeps coordinates when no scope makes a repeated label unique", async () => {
    // Two bare "Add" buttons: no container with an id, and the only element
    // before the tapped one is its twin, which is no anchor.
    setAxTree([
      axLeaf({
        index: 1,
        label: "Add",
        traits: ["button"],
        frame: { x: 0.1, y: 0.1, width: 0.1, height: 0.03 },
      }),
      axLeaf({
        index: 2,
        label: "Add",
        traits: ["button"],
        frame: { x: 0.1, y: 0.5, width: 0.3, height: 0.05 },
      }),
    ]);

    const result = await recordTap({ x: 0.2, y: 0.52 });

    expect(result.message).toContain(
      "matches 2 elements and no scope makes it unique; kept coordinates (brittle)"
    );
    expect(await recordedSteps()).toEqual([{ kind: "tap", x: 0.2, y: 0.52 }]);
  });

  it("keeps coordinates for a target with no id and no text", async () => {
    // An unlabeled icon inside an identified card. The icon is the smallest
    // element under the tap, and nothing about it is stable enough to record.
    setAxTree([
      axGroup({
        index: 1,
        identifier: "product-card",
        frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
      }),
      axLeaf({
        index: 2,
        parentIndex: 1,
        traits: ["image"],
        frame: { x: 0.48, y: 0.48, width: 0.04, height: 0.04 },
      }),
    ]);

    const result = await recordTap({ x: 0.5, y: 0.5 });

    // Its role inside the card is unique, so that is recorded, flagged as weak.
    expect(result.message).toContain(
      "the element has no id and no text, so the selector is its role inside product-card"
    );
    expect(await recordedSteps()).toEqual([
      { kind: "tap", selector: { role: "AXImage", within: { identifier: "product-card" } } },
    ]);
  });

  it("keeps coordinates for a target with no id, no text and no identified ancestor", async () => {
    setAxTree([
      axGroup({ index: 1, frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 } }),
      axLeaf({
        index: 2,
        parentIndex: 1,
        traits: ["image"],
        frame: { x: 0.48, y: 0.48, width: 0.04, height: 0.04 },
      }),
    ]);

    const result = await recordTap({ x: 0.5, y: 0.5 });

    expect(result.message).toContain(
      "tapped element has no stable text/id; kept coordinates (brittle)"
    );
    expect(await recordedSteps()).toEqual([{ kind: "tap", x: 0.5, y: 0.5 }]);
  });

  it("prefers the VoiceOver target under the tap over a smaller non-target", async () => {
    // A labelled button over a decorative hairline that is not an accessibility
    // element. Smallest-frame alone would pick the hairline; a finger lands on
    // the button.
    setAxTree([
      axLeaf({
        index: 1,
        identifier: "checkout",
        label: "Checkout",
        traits: ["button"],
        frame: { x: 0.1, y: 0.8, width: 0.8, height: 0.08 },
      }),
      axGroup({
        index: 2,
        parentIndex: 1,
        label: "divider",
        frame: { x: 0.1, y: 0.84, width: 0.8, height: 0.002 },
      }),
    ]);

    await recordTap({ x: 0.5, y: 0.84 });

    expect(await recordedSteps()).toEqual([{ kind: "tap", selector: { identifier: "checkout" } }]);
  });

  it("keeps where in the element the tap landed when it was off-centre", async () => {
    // A merged row: tapping its right end means the control there, not the
    // row's centre, so replay must land in the same place.
    setAxTree([
      axLeaf({
        index: 1,
        identifier: "total-row",
        label: "Total $5.00",
        frame: { x: 0.1, y: 0.5, width: 0.8, height: 0.06 },
      }),
    ]);

    const result = await recordTap({ x: 0.85, y: 0.53 });

    expect(result.message).toBe(
      `Step added to "${FLOW}" flow — tap kept at 0.94,0.5 of the element's frame`
    );
    expect(await recordedSteps()).toEqual([
      { kind: "tap", selector: { identifier: "total-row" }, x: 0.94, y: 0.5 },
    ]);
  });

  it("round-trips an off-centre tap through the file as `tap: { on, x, y }`", async () => {
    setAxTree([
      axLeaf({
        index: 1,
        identifier: "total-row",
        label: "Total $5.00",
        frame: { x: 0.1, y: 0.5, width: 0.8, height: 0.06 },
      }),
    ]);

    await recordTap({ x: 0.85, y: 0.53 });

    const yaml = await recordedYaml();
    // The options form, with the target under `on` and the position beside it.
    expect(yaml).toMatch(/tap:\n\s+on:\n\s+id: total-row\n\s+x: 0\.94\n\s+y: 0\.5\n/);
    expect(parseFlow(yaml).steps).toEqual([
      { kind: "tap", selector: { identifier: "total-row" }, x: 0.94, y: 0.5 },
    ]);
  });

  it("records no x and y for a tap near the centre", async () => {
    setAxTree([
      axLeaf({
        index: 1,
        identifier: "total-row",
        frame: { x: 0.1, y: 0.5, width: 0.8, height: 0.06 },
      }),
    ]);

    // 0.6 of the width: inside the 0.15 tolerance around the centre.
    await recordTap({ x: 0.58, y: 0.53 });

    expect(await recordedSteps()).toEqual([{ kind: "tap", selector: { identifier: "total-row" } }]);
    expect(await recordedYaml()).not.toContain("at:");
  });

  it("notes an id that looks positional", async () => {
    // `row-2` replays on whichever row is second today. It is still the only
    // handle the element has, so it is recorded — with the note.
    setAxTree([
      axLeaf({
        index: 1,
        identifier: "row-2",
        traits: ["button"],
        frame: { x: 0.1, y: 0.5, width: 0.8, height: 0.06 },
      }),
    ]);

    const result = await recordTap({ x: 0.5, y: 0.53 });

    expect(result.message).toBe(`Step added to "${FLOW}" flow — the id looks positional`);
    expect(await recordedSteps()).toEqual([{ kind: "tap", selector: { identifier: "row-2" } }]);
  });

  it("notes a scope id that looks like data, and still scopes by it", async () => {
    // Feed rows keyed by content: `post/def` is the only ancestor that tells
    // the two "like" buttons apart, and it changes with the feed.
    setAxTree([
      axGroup({ index: 1, identifier: "post/abc", frame: { x: 0, y: 0.1, width: 1, height: 0.3 } }),
      axLeaf({
        index: 2,
        parentIndex: 1,
        identifier: "like",
        traits: ["button"],
        frame: { x: 0.1, y: 0.3, width: 0.1, height: 0.05 },
      }),
      axGroup({ index: 3, identifier: "post/def", frame: { x: 0, y: 0.5, width: 1, height: 0.3 } }),
      axLeaf({
        index: 4,
        parentIndex: 3,
        identifier: "like",
        traits: ["button"],
        frame: { x: 0.1, y: 0.7, width: 0.1, height: 0.05 },
      }),
    ]);

    const result = await recordTap({ x: 0.15, y: 0.725 });

    expect(result.message).toBe(
      `Step added to "${FLOW}" flow — scoped by within post/def; ` +
        "the scope id looks like data and may change with content"
    );
    expect(await recordedSteps()).toEqual([
      { kind: "tap", selector: { identifier: "like", within: { identifier: "post/def" } } },
    ]);
  });

  it("derives the selector from a settled read, not a mid-animation one", async () => {
    // The first read catches the button sliding in; it has not reached the
    // tapped point yet. Deriving from that read would keep coordinates.
    const sliding = axReply([
      axLeaf({
        index: 1,
        identifier: "continue",
        traits: ["button"],
        frame: { x: 0.3, y: 0.3, width: 0.4, height: 0.06 },
      }),
    ]);
    const settled = axReply([
      axLeaf({
        index: 1,
        identifier: "continue",
        traits: ["button"],
        frame: { x: 0.3, y: 0.5, width: 0.4, height: 0.06 },
      }),
    ]);
    setAxReads([sliding, settled, settled]);

    const result = await recordTap({ x: 0.5, y: 0.53 });

    expect(axReadCount).toBe(3);
    expect(result.message).not.toContain("kept coordinates");
    expect(await recordedSteps()).toEqual([{ kind: "tap", selector: { identifier: "continue" } }]);
  });

  it("reads the daemon on a remote simulator too", async () => {
    setAxTree([
      axLeaf({
        index: 1,
        identifier: "add-to-cart",
        label: "Add to cart",
        traits: ["button"],
        frame: ADD_TO_CART,
      }),
    ]);

    const result = await recordTapOn(REMOTE, ADD_TO_CART_CENTRE);

    expect(result.message).toBe(`Step added to "${FLOW}" flow`);
    expect(vi.mocked(fetchFlowTree)).not.toHaveBeenCalled();
    expect(await recordedSteps()).toEqual([
      { kind: "tap", selector: { identifier: "add-to-cart" } },
    ]);
  });

  it("drops what a presentation covers, so a covered twin cannot steal the match", async () => {
    // A sheet over the screen: the "Done" under it is on screen but not
    // reachable, and the daemon flags it `covered`. The sheet's own "Done" is
    // then unique without a scope.
    setAxTree([
      axLeaf({
        index: 1,
        label: "Done",
        traits: ["button"],
        covered: true,
        frame: { x: 0.1, y: 0.1, width: 0.2, height: 0.05 },
      }),
      axLeaf({
        index: 2,
        label: "Done",
        traits: ["button"],
        frame: { x: 0.7, y: 0.8, width: 0.2, height: 0.05 },
      }),
    ]);

    const result = await recordTap({ x: 0.8, y: 0.825 });

    expect(result.message).toBe(`Step added to "${FLOW}" flow`);
    expect(await recordedSteps()).toEqual([
      { kind: "tap", selector: { text: "Done", role: "AXButton" } },
    ]);
  });

  it("keeps coordinates with a warning when the daemon read fails", async () => {
    axReads = () => {
      throw new Error("ax-service not connected");
    };

    const result = await recordTap({ x: 0.5, y: 0.52 });

    // The daemon's reason, then coordinates.
    expect(result.message).toContain("selector capture failed (");
    expect(result.message).toContain("ax-service not connected");
    expect(result.message).toContain("kept coordinates");
    expect(await recordedSteps()).toEqual([{ kind: "tap", x: 0.5, y: 0.52 }]);
  });

  it("does not persist a raw point that replay would reject", async () => {
    setAxTree([]);

    await expect(recordTap({ x: 1.5, y: 0.52 })).rejects.toThrow(/normalized 0–1 fractions/i);
    expect(await recordedSteps()).toEqual([]);
  });
});

// A physical iPhone has no daemon: its runner tree is the XCUITest snapshot
// through `fetchFlowTree`, and capture keeps the nodeAtPoint + deriveSelector
// path with its re-resolve guard.
describe("flow-add-step tap selector capture on a physical iPhone", () => {
  it("reads the runner tree through fetchFlowTree, and derives text without a role", async () => {
    setTree(
      [
        n({
          role: "AXButton",
          label: "Add to cart",
          frame: { x: 0.3, y: 0.5, width: 0.4, height: 0.06 },
        }),
      ],
      "xcuitest-runner"
    );

    const tool = createFlowAddStepTool(mockRegistry());
    const result = await tool.execute(
      {},
      {
        name: FLOW,
        project_root: tmpDir,
        command: "gesture-tap",
        args: JSON.stringify({ udid: PHONE, x: 0.5, y: 0.52 }),
      }
    );

    expect(vi.mocked(fetchFlowTree)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchFlowTree).mock.calls[0]![1]).toMatchObject({
      platform: "ios",
      kind: "device",
    });
    expect(result.message).not.toContain("kept coordinates");
    expect(await recordedSteps()).toEqual([{ kind: "tap", selector: { text: "Add to cart" } }]);
  });

  it("keeps coordinates when the selector would retarget to another element", async () => {
    // Two "Add" labels: replay's selectorToFrame ranking (exact → smallest
    // frame) elects the smaller node at the top, not the tapped one — so the
    // selector must be rejected in favor of coordinates.
    setTree(
      [
        n({ label: "Add", frame: { x: 0.1, y: 0.1, width: 0.1, height: 0.03 } }),
        n({ label: "Add", frame: { x: 0.1, y: 0.5, width: 0.3, height: 0.05 } }),
      ],
      "xcuitest-runner"
    );

    const result = await recordTapOn(PHONE, { x: 0.2, y: 0.52 });

    expect(result.message).toContain("resolves to a different element");
    expect(await recordedSteps()).toEqual([{ kind: "tap", x: 0.2, y: 0.52 }]);
  });

  it("flags a role-only selector rather than recording the downgrade silently", async () => {
    // An unlabeled icon is the smallest frame under the tap, so `nodeAtPoint`
    // picks it and `deriveSelector` falls back to its role. Replay then depends
    // on that icon ranking first for the role.
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
      "xcuitest-runner"
    );

    const result = await recordTapOn(PHONE, { x: 0.5, y: 0.5 });

    expect(result.message).toContain("matches by role alone");
    expect(await recordedSteps()).toEqual([{ kind: "tap", selector: { role: "AXImage" } }]);
  });
});

describe("flow-add-step tap selector capture on Android", () => {
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
    setTree(
      [
        n({
          ...node,
          role: "android.widget.Button",
          frame: { x: 0.3, y: 0.5, width: 0.4, height: 0.06 },
        }),
      ],
      "android-devtools"
    );

    const result = await recordTapOn(ANDROID, { x: 0.5, y: 0.52 });

    // Assert the step too. A coordinate fallback also carries no role-only
    // warning, so the negative check alone proves nothing.
    expect(await recordedSteps()).toEqual([{ kind: "tap", selector }]);
    expect(result.message).not.toContain("matches by role alone");
  });

  it("records the selector with a caveat when captured from the fallback tree source", async () => {
    // Replay gates on the full-hierarchy source and refuses to degrade, so a
    // selector read off the trimmed uiautomator tree deserves the caveat even
    // when it derives cleanly.
    setTree(
      [n({ label: "Settings", frame: { x: 0.3, y: 0.5, width: 0.4, height: 0.06 } })],
      "uiautomator"
    );

    const result = await recordTapOn(ANDROID, { x: 0.5, y: 0.52 });

    expect(result.message).toContain("fallback uiautomator tree (android-devtools unavailable)");
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
            n({
              role: "android.widget.ImageView",
              frame: { x: 0.48, y: 0.48, width: 0.04, height: 0.04 },
            }),
          ],
        }),
      ],
      "uiautomator"
    );

    const result = await recordTapOn(ANDROID, { x: 0.5, y: 0.5 });

    expect(result.message).toContain("matches by role alone");
    expect(result.message).toContain("fallback uiautomator tree");
    expect(await recordedSteps()).toEqual([
      { kind: "tap", selector: { role: "android.widget.ImageView" } },
    ]);
  });
});
