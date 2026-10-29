import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FAILURE_CODES, getFailureSignal, type Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../src/tools/describe/contract";

// The recorder on a Mac app: the locked-Mac caveat, the clauses that explain a
// recorder/runner disagreement, the capability gate, and the bare-string launch
// a recorded `restart-app` becomes. The runner's tree is served directly.
let currentTreeData: () => DescribeTreeData;
vi.mock("../src/tools/flows/flow-tree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tools/flows/flow-tree")>()),
  fetchFlowTree: vi.fn(async (): Promise<DescribeTreeData> => currentTreeData()),
}));

import { createFlowAddStepTool, directiveCommandHint } from "../src/tools/flows/flow-add-step";
import { flowStartRecordingTool } from "../src/tools/flows/flow-start-recording";
import { __resetRecordingsForTesting, parseFlow } from "../src/tools/flows/flow-utils";
import { MACOS_DESCRIBE_LIMITS, MACOS_JUDGING_LIMITS } from "../src/tools/describe/platforms/macos";
import { useMacosAppsFlag } from "./helpers/macos-apps-flag";

useMacosAppsFlag();

const MAC = "macos-app-com.argent.probe";
const BUNDLE = "com.argent.probe";
const FULL = { x: 0, y: 0, width: 1, height: 1 };

let tmpDir: string;

function n(partial: Partial<DescribeNode> & { frame: DescribeNode["frame"] }): DescribeNode {
  return { role: "AXGroup", children: [], ...partial };
}

function serve(children: DescribeNode[], source: DescribeTreeData["source"]): void {
  currentTreeData = () => ({ tree: n({ role: "Screen", frame: FULL, children }), source });
}

function registry(): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "gesture-tap") return { tapped: true };
      if (id === "restart-app") return { restarted: true };
      if (id === "await-ui-element") return { success: true, elapsed: 120 };
      throw new Error(`Tool "${id}" not found`);
    }),
    getTool: vi.fn((id: string) => ({
      inputSchema: { properties: { udid: {} } },
      // Not on a Mac, as gesture-swipe and the debugger tools declare.
      ...(id === "gesture-swipe" || id === "debugger-status"
        ? { capability: { apple: { simulator: true } } }
        : {}),
    })),
  } as unknown as Registry;
}

async function start(name: string, executionPrerequisite = "on the form"): Promise<void> {
  await flowStartRecordingTool.execute({}, { name, project_root: tmpDir, executionPrerequisite });
}

async function record(
  name: string,
  command: string,
  args: Record<string, unknown>,
  reg = registry()
) {
  return createFlowAddStepTool(reg).execute(
    {},
    { name, project_root: tmpDir, command, args: JSON.stringify({ udid: MAC, ...args }) }
  );
}

async function recordedSteps(name: string) {
  const yaml = await fs.readFile(path.join(tmpDir, ".argent", "e2e", `${name}.yaml`), "utf8");
  return parseFlow(yaml).steps;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "macos-flows-recording-"));
  __resetRecordingsForTesting();
});
afterEach(async () => {
  __resetRecordingsForTesting();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const BUTTON = n({
  role: "AXButton",
  label: "Save",
  frame: { x: 0.3, y: 0.5, width: 0.2, height: 0.06 },
});

describe("a tap recorded on a Mac app", () => {
  it("carries the locked-Mac caveat when the tree came from the fallback walk", async () => {
    serve([BUTTON], "macos-fallback");
    await start("locked");

    const result = await record("locked", "gesture-tap", { x: 0.4, y: 0.53 });

    expect(result.message).toContain(
      "selector captured while the Mac was locked (the macos-fallback tree, not macos-devtools)"
    );
    expect(result.message).not.toContain("full hierarchy");
    expect(await recordedSteps("locked")).toEqual([{ kind: "tap", selector: { text: "Save" } }]);
  });

  it("carries no caveat from the unlocked tree", async () => {
    serve([BUTTON], "macos-devtools");
    await start("unlocked");

    const result = await record("unlocked", "gesture-tap", { x: 0.4, y: 0.53 });

    expect(result.message).toBe('Step added to "unlocked" e2e test');
    expect(await recordedSteps("unlocked")).toEqual([{ kind: "tap", selector: { text: "Save" } }]);
  });

  it.each([
    [undefined, BUNDLE],
    [["-Flag", "1"], { macos: { app: BUNDLE, args: ["-Flag", "1"] } }],
  ])("records restart-app with the args the restarted app got (%j)", async (args, app) => {
    serve([], "macos-devtools");
    await start("e2e", "");
    const reg = registry();
    vi.mocked(reg.invokeTool).mockResolvedValueOnce({ restarted: true, args });

    await record("e2e", "restart-app", { bundleId: BUNDLE }, reg);

    expect(await recordedSteps("e2e")).toEqual([{ kind: "launch", app }]);
  });

  it("refuses a tool without macOS support before it runs, as the runner does", async () => {
    serve([], "macos-devtools");
    await start("swipe");
    const reg = registry();

    const err = await record(
      "swipe",
      "gesture-swipe",
      { fromX: 0.5, fromY: 0.7, toX: 0.5, toY: 0.3 },
      reg
    ).catch((e: unknown) => e);

    expect(String(err)).toMatch(/a Mac app takes mouse input: use gesture-drag/);
    expect(getFailureSignal(err)?.error_code).toBe(
      FAILURE_CODES.TOOL_CAPABILITY_UNSUPPORTED_OPERATION
    );
    expect(reg.invokeTool).not.toHaveBeenCalled();
    expect(await recordedSteps("swipe")).toEqual([]);
  });

  it("refuses a device_id tool the same way: the runner binds device_id too", async () => {
    serve([], "macos-devtools");
    await start("debugger");
    const reg = registry();

    const args = { udid: undefined, device_id: MAC };
    const err = await record("debugger", "debugger-status", args, reg).catch((e: unknown) => e);

    expect(String(err)).toMatch(/no macos support declared/);
    expect(reg.invokeTool).not.toHaveBeenCalled();
  });
});

describe("a tap recorded on the empty space of a Mac app container", () => {
  const CENTRE = { x: 0.75, y: 0.65, width: 0.1, height: 0.1 };
  const container = (attrs: Partial<DescribeNode>) =>
    n({ identifier: "box", frame: { x: 0.6, y: 0.5, width: 0.4, height: 0.4 }, ...attrs });

  it.each([
    [
      "keeps the coordinates when another element lies at the container's centre",
      container({ role: "AXStaticText" }),
      { kind: "tap", x: 0.65, y: 0.55 },
    ],
    [
      "keeps the selector of a control, which takes the click anywhere in it",
      container({ role: "AXButton", clickable: true }),
      { kind: "tap", selector: { identifier: "box" } },
    ],
  ])("%s", async (_label, box, step) => {
    serve(
      [box, n({ role: "AXButton", label: "Delete", clickable: true, frame: CENTRE })],
      "macos-devtools"
    );
    await start("box");

    await record("box", "gesture-tap", { x: 0.65, y: 0.55 });

    expect(await recordedSteps("box")).toEqual([step]);
  });
});

describe("a tap recorded at a point of a Mac app element", () => {
  const SEEK = { identifier: "seek", frame: { x: 0.1, y: 0.2, width: 0.6, height: 0.1 } };

  it.each([
    ["keeps the coordinates on a canvas, chart or seek bar", "AXGroup", 0.2, { x: 0.2, y: 0.25 }],
    ["keeps the coordinates on a slider", "AXSlider", 0.2, { x: 0.2, y: 0.25 }],
    [
      "keeps the selector of a click at the centre, give or take a rounded frame",
      "AXGroup",
      0.401,
      { selector: { identifier: "seek" } },
    ],
    [
      "keeps the selector of text, which takes the click anywhere in it",
      "AXStaticText",
      0.2,
      { selector: { identifier: "seek" } },
    ],
  ])("%s", async (_label, role, x, step) => {
    serve([n({ ...SEEK, role, clickable: role === "AXSlider" })], "macos-devtools");
    await start("seek");

    await record("seek", "gesture-tap", { x, y: 0.25 });

    expect(await recordedSteps("seek")).toEqual([{ kind: "tap", ...step }]);
  });
});

describe("a right tap recorded on a Mac app", () => {
  const BOX = n({
    identifier: "box.context",
    label: "box.context",
    frame: { x: 0.2, y: 0.4, width: 0.2, height: 0.1 },
  });

  it.each([
    [
      "keeps the right button on the captured selector",
      [BOX],
      { button: "right" },
      { kind: "tap", selector: { identifier: "box.context" }, button: "right" },
    ],
    [
      "keeps the right button and the click count on a coordinate tap",
      [],
      { button: "right", clickCount: 2 },
      { kind: "tap", x: 0.3, y: 0.45, times: 2, button: "right" },
    ],
    [
      "records an explicit left button as a plain tap",
      [BOX],
      { button: "left" },
      { kind: "tap", selector: { identifier: "box.context" } },
    ],
  ])("%s", async (_label, tree, extra, step) => {
    serve(tree, "macos-devtools");
    await start("ctx");

    const result = await record("ctx", "gesture-tap", { x: 0.3, y: 0.45, ...extra });

    expect(await recordedSteps("ctx")).toEqual([step]);
    if (extra.button === "right") expect(result.recorded).toMatch(/\(right button\)$/);
  });
});

/** The warning half of an e2e-add-step message. */
function warningOf(result: { message: string }, name: string): string {
  const prefix = `Step added to "${name}" e2e test`;
  expect(result.message.startsWith(prefix)).toBe(true);
  return result.message.slice(prefix.length).replace(/^ — /, "");
}

describe("a wait recorded on a Mac app that the runner's tree disagrees with", () => {
  const judging = MACOS_JUDGING_LIMITS.maxNodes;

  it.each([
    // The live wait passed; the runner's flat list holds nothing that matches.
    [
      "names the runner's projection when the recorder saw the element",
      "visible",
      [],
      [
        "it is the RUNNER's side to check",
        "never a window, scroll bar or value indicator",
        `stops at ${MACOS_DESCRIBE_LIMITS.maxNodes} elements where the runner reads ${judging}`,
        "only an `id`/`role` selector can match it",
      ],
    ],
    // The live wait passed on absence; the runner's tree still holds the element.
    [
      "inverts the story for a `hidden` wait: the recorder is the side that missed it",
      "hidden",
      [n({ role: "AXStaticText", value: "Loading", identifier: "field", frame: BUTTON.frame })],
      [
        "it is the RECORDER that never saw the element",
        `with the same limits (${judging} elements, ${MACOS_JUDGING_LIMITS.maxItems} items per web view)`,
        "both refuse an incomplete read",
        "matches only what you expect to leave",
      ],
    ],
  ])("%s", async (_label, condition, tree, clauses) => {
    serve(tree, "macos-devtools");
    await start("wait");

    const warning = warningOf(
      await record("wait", "await-ui-element", { condition, selector: { identifier: "field" } }),
      "wait"
    );

    expect(warning).toContain("does NOT hold against the tree the runner resolves");
    for (const clause of clauses) expect(warning).toContain(clause);
    // No other platform's walk limits or story apply.
    expect(warning).not.toMatch(/\b5000\b|Chromium|native-find-views|UNSUPPORTED/);
  });
});

it("names macOS beside chromium in the directive hints for the pointer tools", () => {
  expect(directiveCommandHint("swipe")).toContain("`gesture-drag` on chromium and macOS");
  expect(directiveCommandHint("scroll-to")).toContain("`gesture-scroll` on chromium and macOS");
});
