import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

let currentTreeData: () => DescribeTreeData;
vi.mock("../../src/tools/flows/flow-tree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/tools/flows/flow-tree")>()),
  fetchFlowTree: vi.fn(async (): Promise<DescribeTreeData> => currentTreeData()),
}));

import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import { __resetRecordingsForTesting, parseFlow } from "../../src/tools/flows/flow-utils";

const DEVICE = "00000000-0000-0000-0000-0000000000AB";
const FLOW = "rec";
const PREREQ = "App on home screen";

let tmpDir: string;

function n(partial: Partial<DescribeNode> & { frame: DescribeNode["frame"] }): DescribeNode {
  return { role: "AXOther", children: [], ...partial };
}

function setTree(children: DescribeNode[]) {
  currentTreeData = () => ({
    tree: n({ role: "AXGroup", frame: { x: 0, y: 0, width: 1, height: 1 }, children }),
    source: "native-devtools",
  });
}

function mockRegistry(): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "gesture-tap") return { tapped: true };
      if (id === "screenshot") return { path: "/tmp/x.png" };
      throw new Error(`Tool "${id}" not found`);
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
  } as unknown as Registry;
}

let registry: Registry;

async function record(params: Record<string, unknown>) {
  registry = mockRegistry();
  return createFlowAddStepTool(registry).execute({}, {
    name: FLOW,
    project_root: tmpDir,
    ...params,
  } as never);
}

async function recordedSteps() {
  const content = await fs.readFile(path.join(tmpDir, ".argent", "e2e", `${FLOW}.yaml`), "utf8");
  return parseFlow(content).steps;
}

// `deriveSelector` is identifier-first, so it picks the positional `row-3` over
// the stable text.
const POSITIONAL_ROW = [
  n({
    frame: { x: 0.1, y: 0.5, width: 0.4, height: 0.1 },
    label: "Settings",
    identifier: "row-3",
  }),
];
const ON_ROW = { x: 0.2, y: 0.55 };

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-explicit-sel-"));
  __resetRecordingsForTesting();
  setTree(POSITIONAL_ROW);
  await flowStartRecordingTool.execute(
    {},
    { name: FLOW, project_root: tmpDir, executionPrerequisite: PREREQ }
  );
});

afterEach(async () => {
  __resetRecordingsForTesting();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("flow-add-step records a caller-supplied tap selector", () => {
  it("records the supplied text instead of the identifier the recorder prefers", async () => {
    const res = (await record({
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, ...ON_ROW }),
      selector: { text: "Settings" },
    })) as { message: string };

    expect(await recordedSteps()).toEqual([{ kind: "tap", selector: { text: "Settings" } }]);
    expect(res.message).not.toMatch(/kept coordinates/);
  });

  it("differs from what the recorder derives on its own", async () => {
    await record({
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, ...ON_ROW }),
    });
    expect(await recordedSteps()).toEqual([{ kind: "tap", selector: { identifier: "row-3" } }]);
  });

  // Checked against the replay tree, which is not the describe tree the caller
  // read it from. A failed check must not tap: the tap may navigate away.
  it.each([
    [
      "matches nothing",
      { identifier: "no-such-id" },
      /`selector` \{"identifier":"no-such-id"\} matches no element in the tree a replay reads/,
    ],
    [
      "resolves away from the tapped point",
      { text: "Elsewhere" },
      /`selector` \{"text":"Elsewhere"\} resolves, in the tree a replay reads, to an element centred at \(0\.3, 0\.15\)/,
    ],
  ])("refuses a supplied selector that %s, running nothing", async (_, selector, reason) => {
    setTree([
      ...POSITIONAL_ROW,
      n({ frame: { x: 0.1, y: 0.1, width: 0.4, height: 0.1 }, label: "Elsewhere" }),
    ]);
    const res = (await record({
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, ...ON_ROW }),
      selector,
    })) as { message: string };

    expect(res.message).toMatch(reason);
    expect(res.message).toMatch(/Nothing was executed and no step was recorded/);
    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(await recordedSteps()).toHaveLength(0);
  });

  it("refuses a supplied selector when the replay tree cannot be read", async () => {
    currentTreeData = () => {
      throw new Error("helper down");
    };
    const res = (await record({
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, ...ON_ROW }),
      selector: { text: "Settings" },
    })) as { message: string };

    expect(res.message).toMatch(
      /`selector` could not be checked \(helper down\)\. Record the tap again once that tree can be read\./
    );
    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(await recordedSteps()).toHaveLength(0);
  });

  it("refuses a selector on a command that is not a tap, recording nothing", async () => {
    const res = (await record({
      command: "screenshot",
      args: JSON.stringify({ udid: DEVICE }),
      selector: { identifier: "save-final" },
    })) as { message: string; toolResult: unknown };

    expect(res.message).toMatch(/applies to a recorded `gesture-tap`/);
    expect(res.message).toMatch(/Nothing was executed and no step was recorded/);
    expect(res.toolResult).toBeUndefined();
    expect(await recordedSteps()).toHaveLength(0);
  });

  it("refuses a misplaced selector before parsing args", async () => {
    const res = (await record({
      command: "screenshot",
      args: "{not json",
      selector: { identifier: "save-final" },
    })) as { message: string };

    expect(res.message).toMatch(/applies to a recorded `gesture-tap`/);
    expect(await recordedSteps()).toHaveLength(0);
  });

  it("refuses a selector on a tap carrying delayMs, naming delayMs", async () => {
    const res = (await record({
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, ...ON_ROW }),
      selector: { identifier: "save-final" },
      delayMs: 300,
    })) as { message: string };

    expect(res.message).toMatch(/delayMs/);
    expect(await recordedSteps()).toHaveLength(0);
  });

  it("refuses a selector on a tap carrying delayMs: 0", async () => {
    const res = (await record({
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, ...ON_ROW }),
      selector: { text: "Settings" },
      delayMs: 0,
    })) as { message: string };

    expect(res.message).toMatch(/delayMs/);
    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(await recordedSteps()).toHaveLength(0);
  });

  // Replay taps the resolved frame's centre, which here is the Info button,
  // not the switch the tap hit.
  it("refuses a container selector whose centre is on another element", async () => {
    setTree([
      n({ frame: { x: 0, y: 0.4, width: 1, height: 0.1 }, identifier: "settings-card" }),
      n({ role: "AXButton", frame: { x: 0.4, y: 0.42, width: 0.2, height: 0.06 }, label: "Info" }),
      n({
        role: "AXSwitch",
        frame: { x: 0.8, y: 0.42, width: 0.12, height: 0.06 },
        identifier: "switch-3",
      }),
    ]);
    const res = (await record({
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, x: 0.86, y: 0.45 }),
      selector: { identifier: "settings-card" },
    })) as { message: string };

    expect(res.message).toMatch(
      /`selector` \{"identifier":"settings-card"\} resolves, in the tree a replay reads, to an element centred at \(0\.5, 0\.45\)/
    );
    // Info sits at that centre: only the device can say which of them takes a touch.
    expect(res.message).toMatch(
      /A smaller element sits at that centre and may take the touch\. If a tap there does what you want, record the tap at \(0\.5, 0\.45\)\./
    );
    expect(res.message).toMatch(/Otherwise pass a selector for the tapped element, or omit it\./);
    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(await recordedSteps()).toHaveLength(0);
  });

  // Nothing smaller sits at the row's centre, so a replay taps the row itself,
  // not the Delete button the tap hit.
  it("refuses a container selector when the tap hit a control inside it", async () => {
    setTree([
      n({ frame: { x: 0, y: 0.4, width: 1, height: 0.1 }, identifier: "row-1" }),
      n({
        role: "AXButton",
        frame: { x: 0.85, y: 0.42, width: 0.1, height: 0.06 },
        label: "Delete",
      }),
    ]);
    const res = (await record({
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, x: 0.9, y: 0.45 }),
      selector: { identifier: "row-1" },
    })) as { message: string };

    expect(res.message).toMatch(
      /`selector` \{"identifier":"row-1"\} resolves, in the tree a replay reads/
    );
    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(await recordedSteps()).toHaveLength(0);
  });

  // The text is its own leaf, narrower than the row (a raw iOS view tree, or an
  // Android TextView), so a tap at the row's centre misses it.
  it("names the replay point for a text leaf inside the tapped row, and records a tap there", async () => {
    setTree([
      n({ frame: { x: 0, y: 0.3, width: 1, height: 0.06 }, identifier: "row-3" }),
      n({ frame: { x: 0.05, y: 0.31, width: 0.2, height: 0.04 }, label: "Settings" }),
    ]);
    const refused = (await record({
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, x: 0.5, y: 0.33 }),
      selector: { text: "Settings" },
    })) as { message: string };
    expect(refused.message).toMatch(/To tap that element, record the tap at \(0\.15, 0\.33\)/);
    expect(refused.message).not.toMatch(/A smaller element/);
    expect(await recordedSteps()).toHaveLength(0);

    await record({
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, x: 0.15, y: 0.33 }),
      selector: { text: "Settings" },
    });
    expect(await recordedSteps()).toEqual([{ kind: "tap", selector: { text: "Settings" } }]);
  });

  // "Go" is centred at x 0.40265; the badge starts at 0.4027, so the centre
  // rounded to 0.403 would land on the badge and be refused again.
  it("names a centre that a re-recorded tap there passes", async () => {
    setTree([
      n({ frame: { x: 0.1, y: 0.5, width: 0.6053, height: 0.1 }, label: "Go" }),
      n({ frame: { x: 0.4027, y: 0.52, width: 0.05, height: 0.06 }, identifier: "badge" }),
    ]);
    const refused = (await record({
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, x: 0.42, y: 0.55 }),
      selector: { text: "Go" },
    })) as { message: string };
    const named = /record the tap at \(([\d.]+), ([\d.]+)\)/.exec(refused.message);
    if (!named) throw new Error(`no centre named: ${refused.message}`);

    await record({
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, x: Number(named[1]), y: Number(named[2]) }),
      selector: { text: "Go" },
    });
    expect(await recordedSteps()).toEqual([{ kind: "tap", selector: { text: "Go" } }]);
  });

  // Appending the step refuses this marker, which would be after the tap ran.
  it("refuses a selector holding an output reference, running nothing", async () => {
    setTree([n({ frame: { x: 0.1, y: 0.5, width: 0.4, height: 0.1 }, label: "Pay {{output:x}}" })]);
    const res = (await record({
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, ...ON_ROW }),
      selector: { text: "{{output:x}}" },
    })) as { message: string };

    expect(res.message).toMatch(/uses unsupported template syntax/);
    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(await recordedSteps()).toHaveLength(0);
  });

  it("blames the tap point, not the selector, when no element is under it", async () => {
    const res = (await record({
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, x: 200, y: 0.55 }),
      selector: { text: "Settings" },
    })) as { message: string };

    expect(res.message).toMatch(/No element in that tree is at this tap's point \(200, 0\.55\)/);
    expect(res.message).toMatch(
      /record the tap at \(0\.3, 0\.55\)\. Otherwise correct the point, then omit the selector if no element is there\./
    );
    expect(res.message).not.toMatch(/not at this tap's point/);
    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(await recordedSteps()).toHaveLength(0);
  });

  // With no selector the recorder derives `card-1` here and retargets silently,
  // so the refusal must not send the caller there.
  it("offers no omission when the match is the tapped element but not at its centre", async () => {
    setTree([
      n({ frame: { x: 0, y: 0.4, width: 1, height: 0.1 }, identifier: "card-1" }),
      n({ role: "AXButton", frame: { x: 0.4, y: 0.42, width: 0.2, height: 0.06 }, label: "Play" }),
    ]);
    const res = (await record({
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, x: 0.1, y: 0.42 }),
      selector: { identifier: "card-1" },
    })) as { message: string };

    expect(res.message).toMatch(
      /record the tap at \(0\.5, 0\.45\)\. Otherwise record a tap on another element\./
    );
    expect(res.message).not.toMatch(/omit/);
    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(await recordedSteps()).toHaveLength(0);
  });

  // Equal frames tie on reading order: the upper one on the frame space, the
  // other in the UI of this landscape screen, which is the one a replay taps.
  it("checks a supplied selector in the reading order of a landscape UI", async () => {
    currentTreeData = () => ({
      tree: n({
        role: "AXGroup",
        frame: { x: 0, y: 0, width: 1, height: 1 },
        children: [
          n({ frame: { x: 0.6, y: 0.1, width: 0.2, height: 0.1 }, label: "Dup" }),
          n({ frame: { x: 0.1, y: 0.6, width: 0.2, height: 0.1 }, label: "Dup" }),
        ],
      }),
      source: "native-devtools",
      uiOrientation: "landscapeLeft",
    });
    await record({
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, x: 0.2, y: 0.65 }),
      selector: { text: "Dup" },
    });
    expect(await recordedSteps()).toEqual([{ kind: "tap", selector: { text: "Dup" } }]);
  });

  it("refuses a selector inside the args JSON, running nothing", async () => {
    const res = (await record({
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, ...ON_ROW, selector: { text: "Settings" } }),
    })) as { message: string; recorded?: string };

    expect(res.message).toMatch(/`selector` goes beside `args`/);
    expect(res.recorded).toBeUndefined();
    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(await recordedSteps()).toHaveLength(0);
  });

  it("dispatches the caller's coordinates and clickCount, and reports the supplied selector", async () => {
    const res = (await record({
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, ...ON_ROW, clickCount: 2 }),
      selector: { text: "Settings" },
    })) as { recorded?: string };

    expect(registry.invokeTool).toHaveBeenCalledTimes(1);
    expect(vi.mocked(registry.invokeTool).mock.calls[0]?.slice(0, 2)).toEqual([
      "gesture-tap",
      { udid: DEVICE, ...ON_ROW, clickCount: 2 },
    ]);
    expect(res.recorded).toContain('1. tap: {"text":"Settings"}');
    expect(await recordedSteps()).toEqual([
      { kind: "tap", selector: { text: "Settings" }, times: 2 },
    ]);
  });

  // The tapped card edge is what is covered, not the match, and a derived `card-1`
  // would replay on Play. Applies to a selector that matches nothing as well.
  it.each([
    ["resolves elsewhere", { text: "Elsewhere" }],
    ["matches nothing", { text: "Nope" }],
  ])(
    "offers no omission when the tapped element is covered and the selector %s",
    async (_, selector) => {
      setTree([
        n({ frame: { x: 0, y: 0.4, width: 1, height: 0.1 }, identifier: "card-1" }),
        n({
          role: "AXButton",
          frame: { x: 0.4, y: 0.42, width: 0.2, height: 0.06 },
          label: "Play",
        }),
        n({ frame: { x: 0.1, y: 0.1, width: 0.4, height: 0.1 }, label: "Elsewhere" }),
      ]);
      const res = (await record({
        command: "gesture-tap",
        args: JSON.stringify({ udid: DEVICE, x: 0.1, y: 0.42 }),
        selector,
      })) as { message: string };

      expect(res.message).toMatch(/Otherwise record a tap on another element\./);
      expect(res.message).not.toMatch(/omit/);
      expect(registry.invokeTool).not.toHaveBeenCalled();
    }
  );

  it("leaves a selector inside the args of another command to that command", async () => {
    const res = (await record({
      command: "screenshot",
      args: JSON.stringify({ udid: DEVICE, selector: { text: "Settings" } }),
    })) as { recorded?: string };

    expect(registry.invokeTool).toHaveBeenCalledTimes(1);
    expect(res.recorded).toBeDefined();
  });

  it("does not blame selector when the args JSON is null", async () => {
    const message = await record({ command: "gesture-tap", args: "null", delayMs: 10 }).then(
      () => "",
      (err: Error) => err.message
    );
    expect(message).not.toMatch(/reading 'selector'/);
  });

  it.each([
    ["ends in a no-break space", { text: "Save\u00a0" }],
    ["is blank", { identifier: "\u00a0" }],
    ["holds a one-space line when folded", { text: `${"x".repeat(78)}\n \nb` }],
  ])("refuses a value that %s, which the file does not keep", async (_, selector) => {
    const res = (await record({
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, ...ON_ROW }),
      selector,
    })) as { message: string };

    expect(res.message).toMatch(/changes when an e2e test file is written and read back/);
    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(await recordedSteps()).toHaveLength(0);
  });

  it("records a value with ordinary whitespace at its end, which the file keeps", async () => {
    setTree([n({ frame: { x: 0.1, y: 0.5, width: 0.4, height: 0.1 }, identifier: "row-3 " })]);
    await record({
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, ...ON_ROW }),
      selector: { identifier: "row-3 " },
    });
    expect(await recordedSteps()).toEqual([{ kind: "tap", selector: { identifier: "row-3 " } }]);
  });

  it("says no element is at the point when neither the selector nor the point finds one", async () => {
    const res = (await record({
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, x: 0.9, y: 0.02 }),
      selector: { text: "Nope" },
    })) as { message: string };

    expect(res.message).toMatch(/No element in that tree is at this tap's point \(0\.9, 0\.02\)/);
    expect(res.message).toMatch(/omit the selector if no element is there/);
  });

  it("offers a retry for a selector that matches nothing, since the screen may be moving", async () => {
    const res = (await record({
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, ...ON_ROW }),
      selector: { text: "Nope" },
    })) as { message: string };

    expect(res.message).toMatch(/If the screen was still changing, record the tap again\./);
  });

  it("names the centre to three decimals", async () => {
    setTree([
      ...POSITIONAL_ROW,
      n({ frame: { x: 0.1, y: 0.1, width: 0.05, height: 0.1 }, label: "Tiny" }),
    ]);
    const res = (await record({
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, ...ON_ROW }),
      selector: { text: "Tiny" },
    })) as { message: string };

    expect(res.message).toMatch(/record the tap at \(0\.125, 0\.15\)/);
  });

  // Each overlapping frame differs from the match in one field, and is walked
  // first so that it wins the tie where its area is equal.
  it.each([
    ["x", { x: 0.25, y: 0.4, width: 0.4, height: 0.2 }],
    ["y", { x: 0.2, y: 0.45, width: 0.4, height: 0.2 }],
    ["width", { x: 0.2, y: 0.4, width: 0.3, height: 0.2 }],
    ["height", { x: 0.2, y: 0.4, width: 0.4, height: 0.15 }],
  ])("tells a frame differing only in %s from the match", async (_, frame) => {
    setTree([
      n({ frame, identifier: "over" }),
      n({ frame: { x: 0.2, y: 0.4, width: 0.4, height: 0.2 }, label: "Go" }),
      n({ frame: { x: 0.85, y: 0.85, width: 0.1, height: 0.1 }, identifier: "other" }),
    ]);
    const res = (await record({
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, x: 0.9, y: 0.9 }),
      selector: { text: "Go" },
    })) as { message: string };

    expect(res.message).toMatch(/A smaller element sits at that centre/);
  });

  it("refuses a selector on a platform with no runner tree, naming the platform", async () => {
    const res = (await record({
      command: "gesture-tap",
      args: JSON.stringify({ udid: "harmony-127.0.0.1:5555", ...ON_ROW }),
      selector: { text: "Settings" },
    })) as { message: string };

    expect(res.message).toMatch(/this platform's e2e runner has no UI tree/);
    expect(res.message).not.toMatch(/could not be checked/);
    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(await recordedSteps()).toHaveLength(0);
  });

  // The element here has an id and text, so the warning must not claim otherwise.
  it("warns on a supplied role-only selector without blaming the element", async () => {
    setTree([
      n({
        role: "AXButton",
        frame: { x: 0.1, y: 0.5, width: 0.4, height: 0.1 },
        label: "Settings",
        identifier: "row-3",
      }),
    ]);
    const res = (await record({
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, ...ON_ROW }),
      selector: { role: "AXButton" },
    })) as { message: string };

    expect(await recordedSteps()).toEqual([{ kind: "tap", selector: { role: "AXButton" } }]);
    expect(res.message).toContain("the selector you passed");
    expect(res.message).toContain("matches by role alone");
    expect(res.message).not.toContain("has no id or visible text");
  });

  it("still derives a selector when none is supplied", async () => {
    setTree([n({ frame: { x: 0.1, y: 0.1, width: 0.3, height: 0.2 }, label: "Continue" })]);
    await record({
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, x: 0.2, y: 0.15 }),
    });
    expect(await recordedSteps()).toEqual([{ kind: "tap", selector: { text: "Continue" } }]);
  });

  it("needs at least one of identifier, text or role", async () => {
    const schema = createFlowAddStepTool(mockRegistry()).zodSchema;
    if (!schema) throw new Error("flow-add-step declares no zodSchema");
    const base = { name: FLOW, project_root: tmpDir, command: "gesture-tap" };
    expect(schema.safeParse({ ...base, selector: {} }).success).toBe(false);
    expect(schema.safeParse({ ...base, selector: { role: "AXButton" } }).success).toBe(true);
  });
});
