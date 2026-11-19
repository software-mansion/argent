import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { DeviceInfo, Registry } from "@argent/registry";
import type { AXTreeResponse } from "../../src/blueprints/ax-service";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

// An app element must win against a key of the on-screen keyboard. The trees
// are real captures (see test/fixtures/keyboard/README.md) through the real
// adapters; the e2e runner reads them through a stubbed tree fetch.
let currentTreeData: () => DescribeTreeData;
vi.mock("../../src/tools/flows/flow-tree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/tools/flows/flow-tree")>()),
  fetchFlowTree: vi.fn(async (): Promise<DescribeTreeData> => currentTreeData()),
}));

import type { IosDeviceRunnerApi } from "../../src/blueprints/ios-device-runner";
import { describeIosDevice } from "../../src/tools/describe/platforms/ios-device";
import { adaptAxTree } from "../../src/tools/ui-tree/ios";
import {
  adaptIosUiTreeForFlows,
  queryIosDeviceFlowTree,
} from "../../src/tools/flows/flow-ios-tree";
import { adaptFullAndroidHierarchyToDescribeResult } from "../../src/tools/flows/flow-android-tree";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import {
  __resetRecordingsForTesting,
  parseFlow,
  serializeFlow,
} from "../../src/tools/flows/flow-utils";
import { setCurrentIosDeviceApp } from "../../src/utils/ios-device/app-session";
import type { RunnerSnapshotNode } from "../../src/utils/ios-device/runner-commands";
import {
  frameWithin,
  nodeAtPoint,
  keyboardDrawsAt,
  selectorToNode,
  underKeyboard,
  type Selector,
} from "../../src/utils/ui-tree-match";

const FIXTURES = path.join(__dirname, "..", "fixtures", "keyboard");
const IOS = "00000000-0000-0000-0000-0000000000ab";
const ANDROID = "emulator-5554";

function iosRaw(name: string): AXTreeResponse {
  return JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), "utf8")) as AXTreeResponse;
}

/** An iOS simulator capture as the e2e runner reads it. */
function iosTree(name: string): DescribeNode {
  return adaptIosUiTreeForFlows(adaptAxTree(iosRaw(name)));
}

function androidXml(name: string): string {
  return readFileSync(path.join(FIXTURES, `${name}.xml`), "utf8");
}

/** An Android capture (1080x2400) as the e2e runner reads it. */
function androidTree(name: string, xml = androidXml(name)): DescribeNode {
  return adaptFullAndroidHierarchyToDescribeResult(xml, 1080, 2400);
}

type Match = Partial<Pick<DescribeNode, "role" | "label" | "identifier" | "value">> & {
  keyboard?: boolean;
};

/** The one leaf with exactly these fields; fails on none or several. */
function leaf(tree: DescribeNode, want: Match): DescribeNode {
  const hits = tree.children.filter(
    (n) =>
      (want.role === undefined || n.role === want.role) &&
      (want.label === undefined || n.label === want.label) &&
      (want.identifier === undefined || n.identifier === want.identifier) &&
      (want.value === undefined || n.value === want.value) &&
      (want.keyboard === undefined || (n.keyboard === true) === want.keyboard)
  );
  if (hits.length !== 1) throw new Error(`${hits.length} leaves match ${JSON.stringify(want)}`);
  return hits[0]!;
}

const keys = (tree: DescribeNode) => tree.children.filter((n) => n.keyboard === true);
const centre = (n: DescribeNode) => ({
  x: n.frame.x + n.frame.width / 2,
  y: n.frame.y + n.frame.height / 2,
});
const reversed = (tree: DescribeNode): DescribeNode => ({
  ...tree,
  children: [...tree.children].reverse(),
});

describe("keyboard flag: iOS simulator (ax-service tree)", () => {
  it("marks every leaf of the keyboard window and none of the app or its input view", () => {
    const tree = iosTree("ios-27-iphone-name");
    for (const k of [
      { label: "done", identifier: "Done" },
      { label: "delete", identifier: "delete" },
      { label: "Q" },
      { label: "shift" },
      { label: "Emoji" },
      { label: "The" }, // a prediction
      { identifier: "SystemInputAssistantView" },
    ]) {
      expect(leaf(tree, k).keyboard, JSON.stringify(k)).toBe(true);
    }
    for (const app of [
      { role: "AXButton", label: "Done" },
      { identifier: "name" },
      { identifier: "status" },
      { role: "AXStaticText", label: "Delete" },
      { identifier: "inputView" }, // the window with the input and accessory views
    ]) {
      expect(leaf(tree, app).keyboard, JSON.stringify(app)).toBeUndefined();
    }
    // Every key lies on the keyboard: nothing above the prediction bar is marked.
    expect(keys(tree).length).toBeGreaterThan(30);
    for (const k of keys(tree)) expect(k.frame.y).toBeGreaterThanOrEqual(0.62);
  });

  it("leaves the input accessory toolbar and the edit menu to the app", () => {
    const pad = iosTree("ios-27-iphone-decimal-pad-covered-delete");
    expect(leaf(pad, { label: "Delete", keyboard: true }).role).toBe("AXGroup");
    // The accessory toolbar's "Done" sits above the keys.
    const accessory = pad.children.filter((n) => n.label === "Done" && n.frame.y > 0.5);
    expect(accessory).toHaveLength(1);
    expect(accessory[0]!.keyboard).toBeUndefined();
    expect(leaf(pad, { identifier: "Toolbar" }).keyboard).toBeUndefined();

    const menu = iosTree("ios-27-iphone-edit-menu");
    for (const item of ["Copy", "Replace…", "Next Page"]) {
      for (const n of menu.children.filter((c) => c.label === item)) {
        expect(n.keyboard, item).toBeUndefined();
      }
    }
    expect(leaf(menu, { label: "Part" }).keyboard).toBe(true); // a prediction
  });

  it("keeps the key ids in English under another keyboard language", () => {
    // Polish keyboard: the labels are translated, the ids are not.
    const tree = iosTree("ios-27-iphone-name-pl");
    expect(leaf(tree, { identifier: "Done" })).toMatchObject({ label: "gotowe", keyboard: true });
    expect(leaf(tree, { identifier: "delete" })).toMatchObject({ label: "usuń", keyboard: true });
  });

  it("marks the same window on iOS 26.5", () => {
    const tree = iosTree("ios-26.5-iphone-name");
    expect(leaf(tree, { identifier: "Done" }).keyboard).toBe(true);
    expect(leaf(tree, { role: "AXButton", label: "Done" }).keyboard).toBeUndefined();
  });

  it("marks the iPad's undo/redo/Paste bar, Hide keyboard and the emoji search field", () => {
    const tree = iosTree("ios-27-ipad-name");
    for (const id of [
      "assistantUndo",
      "assistantRedo",
      "assistantPaste:forEvent:",
      "tab",
      "Done",
    ]) {
      expect(leaf(tree, { identifier: id }).keyboard, id).toBe(true);
    }
    expect(leaf(tree, { label: "Hide keyboard" }).keyboard).toBe(true);
    expect(leaf(tree, { role: "AXButton", label: "Done" }).keyboard).toBeUndefined();

    const emoji = iosTree("ios-27-ipad-emoji-search");
    expect(leaf(emoji, { role: "AXTextField", value: "Search Emoji" }).keyboard).toBe(true);
  });

  it("marks nothing without a keyboard", () => {
    expect(keys(iosTree("ios-27-iphone-no-keyboard"))).toEqual([]);
  });

  it("marks a Keyboard element that is itself a child of the app root", () => {
    const frame = (y: number) => ({ x: 0, y, width: 1, height: 0.05 });
    const tree = adaptIosUiTreeForFlows(
      adaptAxTree({
        ...iosRaw("ios-27-iphone-no-keyboard"),
        nodes: [
          { index: 0, label: "App", bundleId: "com.example.kbrank", frame: frame(0) },
          { index: 1, parentIndex: 0, elementType: 9, label: "Done", frame: frame(0.1) },
          {
            index: 2,
            parentIndex: 0,
            elementType: 19,
            frame: { x: 0, y: 0.6, width: 1, height: 0.4 },
          },
          { index: 3, parentIndex: 2, elementType: 20, label: "done", frame: frame(0.9) },
        ],
      } as AXTreeResponse)
    );
    expect(leaf(tree, { label: "done" }).keyboard).toBe(true);
    expect(leaf(tree, { label: "Done" }).keyboard).toBeUndefined();
  });
});

describe("keyboard flag: Android (window-type 2)", () => {
  it("marks every leaf of the input method's window and none of the app's", () => {
    const tree = androidTree("android-36-settings-search");
    expect(leaf(tree, { identifier: "android:id/input_method_nav_back" }).keyboard).toBe(true);
    expect(
      leaf(tree, { identifier: "com.google.android.inputmethod.latin:id/key_pos_del" }).keyboard
    ).toBe(true);
    expect(leaf(tree, { identifier: "android:id/parentPanel" }).keyboard).toBe(true);
    expect(leaf(tree, { role: "Button", label: "Back" }).keyboard).toBeUndefined();
    expect(leaf(tree, { role: "TextField", label: "Search settings" }).keyboard).toBeUndefined();
    // The status bar and navigation bar windows are not the keyboard either.
    for (const k of keys(tree)) expect(k.identifier ?? "").not.toMatch(/systemui/);
  });

  it("marks nothing when the dump has no window-type", () => {
    const xml = androidXml("android-36-settings-search");
    expect(xml).toMatch(/window-type="2"/);
    expect(keys(androidTree("", xml.replace(/ window-type="\d+"/g, "")))).toEqual([]);
  });
});

describe("keyboard flag: physical iPhone (XCUITest runner snapshot)", () => {
  const UDID = "00008110-000978540290401E";
  const device = { id: UDID, platform: "ios", kind: "device" } as unknown as DeviceInfo;
  // Captured from the runner on an iOS 27 simulator with the keyboard up.
  const snapshot = JSON.parse(
    readFileSync(path.join(FIXTURES, "ios-27-runner-snapshot-name.json"), "utf8")
  ) as { data: { nodes: RunnerSnapshotNode[] } };
  const registry = {
    resolveService: async () =>
      ({
        udid: UDID,
        run: vi.fn(async () => ({ nodes: snapshot.data.nodes, quality: null })),
      }) as unknown as IosDeviceRunnerApi,
  } as unknown as Registry;
  setCurrentIosDeviceApp(UDID, "com.example.kbrank");

  it("carries the runner's mark into the e2e tree", async () => {
    const { tree } = await queryIosDeviceFlowTree(registry, device);
    expect(leaf(tree, { identifier: "Done" }).keyboard).toBe(true);
    expect(leaf(tree, { label: "Next keyboard" }).keyboard).toBe(true);
    expect(leaf(tree, { role: "AXButton", label: "Done" }).keyboard).toBeUndefined();
    expect(leaf(tree, { identifier: "inputView" }).keyboard).toBeUndefined();
    expect(selectorToNode(tree, { text: "Done" })).toBe(
      leaf(tree, { role: "AXButton", label: "Done" })
    );
    // The keyboard covers the same app elements as on the simulator.
    const covered = tree.children.filter((n) => underKeyboard(tree, n));
    expect(covered.map((n) => n.identifier ?? n.label)).toEqual(["Delete", "inputView"]);
  });

  it("leaves the describe tool's tree unmarked", async () => {
    const { tree } = await describeIosDevice(registry, device);
    expect(JSON.stringify(tree)).not.toContain('"keyboard"');
  });
});

describe("target ranking with keys", () => {
  it("takes an app element over a key that matches as exactly, in either tree order", () => {
    const ios = iosTree("ios-27-iphone-name");
    const app = leaf(ios, { role: "AXButton", label: "Done" });
    // The bug: the key is the smaller frame.
    const key = leaf(ios, { identifier: "Done" });
    expect(key.frame.width * key.frame.height).toBeLessThan(app.frame.width * app.frame.height);
    expect(selectorToNode(ios, { text: "Done" })).toBe(app);
    expect(selectorToNode(reversed(ios), { text: "Done" })).toBe(app);

    const android = androidTree("android-36-settings-search");
    const back = leaf(android, { role: "Button", label: "Back" });
    expect(selectorToNode(android, { text: "Back" })).toBe(back);
    expect(selectorToNode(reversed(android), { text: "Back" })).toBe(back);
  });

  it("takes the key when it matches more exactly: the return key Go over a row Google", () => {
    const tree = iosTree("ios-27-iphone-url");
    expect(selectorToNode(tree, { text: "Go" })).toBe(leaf(tree, { identifier: "Go" }));
  });

  it("takes a key when only keys match", () => {
    const tree = iosTree("ios-27-iphone-name");
    expect(selectorToNode(tree, { text: "shift" })).toBe(leaf(tree, { identifier: "shift" }));
    expect(selectorToNode(tree, { identifier: "delete" })).toBe(
      leaf(tree, { identifier: "delete" })
    );
  });

  it("still takes the smallest of several app elements", () => {
    const tree = iosTree("ios-27-iphone-name-two-done");
    const done = tree.children.filter((n) => n.label === "Done" && n.keyboard !== true);
    expect(done).toHaveLength(2);
    const smaller = done.reduce((a, b) =>
      a.frame.width * a.frame.height < b.frame.width * b.frame.height ? a : b
    );
    expect(selectorToNode(tree, { text: "Done" })).toBe(smaller);
  });

  it("takes an app element before a key for `any: true` too", () => {
    // The input view's region holds the decimal pad's keys and, under them, the
    // app's button. Reading order alone would pick the key "1".
    const tree = iosTree("ios-27-iphone-decimal-pad-covered-delete");
    const sel = { within: { identifier: "inputView" } } as Selector;
    expect(selectorToNode(tree, sel)).toBe(leaf(tree, { role: "AXButton", label: "Delete" }));
  });
});

describe("the recorder's point lookup", () => {
  it("takes the key under a tap on the keyboard, not the app element behind it", () => {
    const tree = androidTree("android-36-settings-results");
    const icon = leaf(tree, { identifier: "android:id/icon" });
    const point = { x: 0.087, y: 0.81 };
    const keyA = leaf(tree, { role: "FrameLayout", label: "a" });
    const hit = nodeAtPoint(tree, point);
    expect(hit?.keyboard).toBe(true);
    // The smallest key element there: Gboard's view inside the key "a".
    expect(frameWithin(hit!.frame, keyA.frame)).toBe(true);
    // The icon is smaller and under the point, which used to make it the hit.
    expect(icon.frame.width * icon.frame.height).toBeLessThan(hit!.frame.width * hit!.frame.height);
  });

  it("passes a tap above the keys to the app through the input method's tall containers", () => {
    const tree = androidTree("android-36-settings-search");
    const back = leaf(tree, { role: "Button", label: "Back" });
    expect(nodeAtPoint(tree, centre(back))).toBe(back);
  });
});

describe("an app element under the keyboard", () => {
  it("is covered when the keyboard draws at the centre of its frame", () => {
    const pad = iosTree("ios-27-iphone-decimal-pad-covered-delete");
    const covered = leaf(pad, { role: "AXButton", label: "Delete" });
    expect(underKeyboard(pad, covered)).toBe(true);
    // The ranking takes it over the decimal pad's delete key, "Delete" too.
    expect(selectorToNode(pad, { text: "Delete" })).toBe(covered);
    // Above the keys: the field and the input accessory toolbar.
    expect(underKeyboard(pad, leaf(pad, { identifier: "amount" }))).toBe(false);
    expect(underKeyboard(pad, leaf(pad, { identifier: "Toolbar" }))).toBe(false);
    // A key is never covered.
    expect(underKeyboard(pad, leaf(pad, { label: "Delete", keyboard: true }))).toBe(false);
    // Without the keyboard nothing is.
    const none = iosTree("ios-27-iphone-no-keyboard");
    expect(none.children.some((n) => underKeyboard(none, n))).toBe(false);
  });

  it("takes in the gaps between the keys, which have no element of their own", () => {
    // The bottom row of the iPhone keyboard: Emoji, a free strip, Dictate.
    const tree = iosTree("ios-27-iphone-name");
    const strip = { x: 0.5, y: 0.96 };
    expect(
      tree.children.some(
        (n) => n.keyboard === true && frameWithin({ ...strip, width: 0, height: 0 }, n.frame)
      )
    ).toBe(false);
    expect(keyboardDrawsAt(tree, strip)).toBe(true);
    // A tab bar item centred there is covered.
    const tab: DescribeNode = {
      role: "AXButton",
      label: "Home",
      frame: { x: 0.4, y: 0.94, width: 0.2, height: 0.04 },
      children: [],
    } as unknown as DescribeNode;
    const withTab = { ...tree, children: [...tree.children, tab] };
    expect(underKeyboard(withTab, tab)).toBe(true);
    // A tap there is on the keyboard: the app's input view behind it is not the hit.
    expect(nodeAtPoint(tree, strip)).toBeUndefined();
    // The decimal pad: below the keys, left of Dictate.
    const pad = iosTree("ios-27-iphone-decimal-pad-covered-delete");
    const below = { x: 0.3, y: 0.96 };
    expect(
      pad.children.some(
        (n) => n.keyboard === true && frameWithin({ ...below, width: 0, height: 0 }, n.frame)
      )
    ).toBe(false);
    expect(keyboardDrawsAt(pad, below)).toBe(true);
  });

  it("lets a tip above the keys cover only its own width", () => {
    // Gboard's "See more features" tip sits above the toolbar, at the left.
    const tree = androidTree("android-36-settings-search");
    const tip = leaf(tree, { role: "StaticText", label: "See more features" });
    expect(tip.keyboard).toBe(true);
    const beside = { x: 0.7, y: centre(tip).y };
    expect(keyboardDrawsAt(tree, beside)).toBe(false);
    // The recorder's lookup there finds the app, not a tall container of Gboard.
    expect(nodeAtPoint(tree, beside)?.keyboard).toBeUndefined();
    expect(keyboardDrawsAt(tree, centre(tip))).toBe(true);
    expect(nodeAtPoint(tree, centre(tip))).toBe(tip);
  });

  it("finds nothing in a gap between the keys, not a tall container of Gboard", () => {
    // Drop Gboard's elements at one point, short of the window-tall containers.
    const tree = androidTree("android-36-settings-search");
    const gap = { x: 0.5, y: 0.8 };
    const holds = (n: DescribeNode) =>
      n.frame.x <= gap.x &&
      gap.x <= n.frame.x + n.frame.width &&
      n.frame.y <= gap.y &&
      gap.y <= n.frame.y + n.frame.height;
    const tall = (n: DescribeNode) => n.frame.y < 0.1 && n.frame.height > 0.9;
    const holed = {
      ...tree,
      children: tree.children.filter((n) => !(n.keyboard === true && holds(n) && !tall(n))),
    };
    expect(holed.children.some((n) => n.keyboard === true && holds(n))).toBe(true);
    expect(keyboardDrawsAt(holed, gap)).toBe(true);
    expect(nodeAtPoint(holed, gap)).toBeUndefined();
  });

  it("measures the keyboard's top in the UI's orientation", () => {
    // The trees turned into the frames of a device held landscape right: the
    // keyboard is at the bottom of the UI, at a side of the frames.
    const toNative = (f: DescribeNode["frame"]) => ({
      x: 1 - f.y - f.height,
      y: f.x,
      width: f.height,
      height: f.width,
    });
    const turn = (tree: DescribeNode): DescribeNode => ({
      ...tree,
      children: tree.children.map((n) => ({ ...n, frame: toNative(n.frame) })),
    });
    const at = (p: { x: number; y: number }) => toNative({ ...p, width: 0, height: 0 });
    // Beside Gboard's tip, and the decimal pad's free strip below the keys.
    const search = androidTree("android-36-settings-search");
    const tip = leaf(search, { role: "StaticText", label: "See more features" });
    const beside = { x: 0.7, y: centre(tip).y };
    const pad = iosTree("ios-27-iphone-decimal-pad-covered-delete");
    const below = { x: 0.3, y: 0.96 };
    expect(keyboardDrawsAt(turn(search), at(beside), "landscapeRight")).toBe(false);
    expect(keyboardDrawsAt(turn(search), at(centre(tip)), "landscapeRight")).toBe(true);
    expect(keyboardDrawsAt(turn(pad), at(below), "landscapeRight")).toBe(true);
    // The app elements under the keys are the same as upright.
    const name = turn(iosTree("ios-27-iphone-name"));
    const covered = name.children.filter((n) => underKeyboard(name, n, "landscapeRight"));
    expect(covered.map((n) => n.identifier ?? n.label)).toEqual(["Delete", "inputView"]);
    // Read in the frames' own orientation, both come out wrong.
    expect(keyboardDrawsAt(turn(search), at(beside))).toBe(true);
    expect(keyboardDrawsAt(turn(pad), at(below))).toBe(false);
  });

  it("is judged by the keys on Android, not the input method's tall containers", () => {
    const results = androidTree("android-36-settings-results");
    expect(underKeyboard(results, leaf(results, { label: "Hearing devices" }))).toBe(true);
    const above = leaf(results, { label: "Default notification sound" });
    expect(underKeyboard(results, above)).toBe(false);
    const search = androidTree("android-36-settings-search");
    expect(underKeyboard(search, leaf(search, { role: "Button", label: "Back" }))).toBe(false);
  });
});

// ── The e2e runner ──────────────────────────────────────────────────────────

interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

let tmpDir: string;
// The tool calls of the run in progress, for a tree that changes after a gesture.
let liveCalls: ToolCall[] = [];
// The raw ax-service reply behind the served iOS tree: the stale-id reason
// reads the accessibility tree again, hidden nodes included.
let currentRaw: AXTreeResponse | undefined;

function mockRegistry(calls: ToolCall[]): Registry {
  return {
    resolveService: vi.fn(async () => {
      if (!currentRaw) throw new Error("no accessibility service in this test");
      return { degraded: false, tree: async () => currentRaw };
    }),
    invokeTool: vi.fn(async (id: string, args: Record<string, unknown>) => {
      if (id === "list-devices") return { devices: [] };
      if (id === "screenshot") return {};
      calls.push({ tool: id, args });
      if (id === "gesture-tap") return { tapped: true };
      if (id === "gesture-swipe") return { swiped: true };
      return { ok: true };
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
  } as unknown as Registry;
}

function serve(tree: DescribeNode, source: DescribeTreeData["source"] = "ax-service"): void {
  currentTreeData = () => ({ tree, source });
  currentRaw = undefined;
}

function serveIos(name: string): DescribeNode {
  const tree = iosTree(name);
  serve(tree);
  currentRaw = iosRaw(name);
  return tree;
}

async function run(
  steps: Parameters<typeof serializeFlow>[0]["steps"],
  device = IOS
): Promise<FlowRunResult & { calls: ToolCall[] }> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "kb.yaml"),
    serializeFlow({ executionPrerequisite: "", steps }),
    "utf8"
  );
  const calls: ToolCall[] = [];
  liveCalls = calls;
  const result = await createRunFlowTool(mockRegistry(calls)).execute(
    {},
    { name: "kb", project_root: tmpDir, device }
  );
  if (!("steps" in result)) throw new Error(`expected a run result, got notice: ${result.notice}`);
  return Object.assign(result, { calls });
}

function tapAt(calls: ToolCall[]): { x: number; y: number } {
  const taps = calls.filter((c) => c.tool === "gesture-tap");
  expect(taps).toHaveLength(1);
  return { x: taps[0]!.args.x as number, y: taps[0]!.args.y as number };
}

function expectTapOn(calls: ToolCall[], node: DescribeNode): void {
  const at = tapAt(calls);
  const want = centre(node);
  expect(at.x).toBeCloseTo(want.x, 5);
  expect(at.y).toBeCloseTo(want.y, 5);
}

describe("e2e runner: actions", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-keyboard-keys-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("taps the app's Done, not the return key", async () => {
    const tree = iosTree("ios-27-iphone-name");
    serve(tree);
    const result = await run([{ kind: "tap", selector: { text: "Done" } }]);
    expect(result.ok).toBe(true);
    expectTapOn(result.calls, leaf(tree, { role: "AXButton", label: "Done" }));
  });

  it("taps the app's Back on Android, not the keyboard's navigation back", async () => {
    const tree = androidTree("android-36-settings-search");
    serve(tree, "android-devtools");
    const result = await run([{ kind: "tap", selector: { text: "Back", loose: true } }], ANDROID);
    expect(result.ok).toBe(true);
    expectTapOn(result.calls, leaf(tree, { role: "Button", label: "Back" }));
  });

  it("goes on past an id lookup that finds only a key: bare `tap: Delete`", async () => {
    // The iOS delete key has the id "delete", which the bare string tries first.
    const tree = iosTree("ios-27-iphone-name");
    serve(tree);
    const result = await run([{ kind: "tap", selector: { text: "Delete", loose: true } }]);
    expect(result.ok).toBe(true);
    expectTapOn(result.calls, leaf(tree, { role: "AXStaticText", label: "Delete" }));
  });

  it("taps a key when only keys match", async () => {
    const tree = iosTree("ios-27-iphone-name-after-done");
    serve(tree);
    const result = await run([{ kind: "tap", selector: { text: "Done", loose: true } }]);
    expect(result.ok).toBe(true);
    expectTapOn(result.calls, leaf(tree, { identifier: "Done" }));
  });
});

describe("e2e runner: conditions and scroll-to ignore keys", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-keyboard-keys-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // After the app's Done hid itself, only the return key says "done".
  const afterDone = () => iosTree("ios-27-iphone-name-after-done");

  it("assert hidden passes when only a key has the text", async () => {
    serve(afterDone());
    const result = await run([
      { kind: "assert", condition: "hidden", selector: { text: "Done" } },
      { kind: "assert", condition: "visible", selector: { text: "saved" } },
    ]);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "assert:pass",
      "assert:pass",
    ]);
  });

  it("await visible does not settle on a key, and its message cites no key", async () => {
    serve(afterDone());
    const result = await run([
      { kind: "await", condition: "visible", selector: { text: "Done" }, timeout: 300 },
    ]);
    expect(result.steps[0]!.status).toBe("fail");
    expect(result.steps[0]!.reason).toBe('no element matched selector text="Done"');
  });

  it("a condition on an id only a key carries fails without citing the key", async () => {
    // Only the delete key has the id "delete", and its role is AXGroup: the
    // reason must not say the element with this id has that role.
    serveIos("ios-27-iphone-name");
    const result = await run([
      {
        kind: "assert",
        condition: "visible",
        selector: { identifier: "delete", role: "AXButton" },
      },
    ]);
    expect(result.steps[0]!.status).toBe("fail");
    expect(result.steps[0]!.reason).toBe('no element matched selector id="delete" role="AXButton"');
  });

  it("a bare-string condition goes on past a key's id to the app element", async () => {
    // Without keys the id lookup "delete" finds nothing, so the text lookup runs.
    serve(iosTree("ios-27-iphone-name"));
    const result = await run([
      {
        kind: "assert",
        condition: "text",
        selector: { text: "Delete", loose: true },
        expectedText: "Delete",
        textMatch: "equals",
      },
    ]);
    expect(result.ok).toBe(true);
  });

  it("when: skips its block when only a key matches", async () => {
    serve(afterDone());
    const result = await run([
      {
        kind: "when",
        condition: { kind: "ui", condition: "visible", selector: { text: "Done", loose: true } },
        steps: [{ kind: "echo", message: "app Done shown" }],
      },
    ]);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["when:skip", "echo:skip"]);
  });

  it("scroll-to does not stop on a key", async () => {
    // Gboard's delete key says "Delete"; the app has no such element.
    serve(androidTree("android-36-settings-search"), "android-devtools");
    const result = await run(
      [{ kind: "scroll-to", target: { text: "Delete" }, direction: "down" }],
      ANDROID
    );
    expect(result.steps[0]!.status).toBe("fail");
    expect(result.calls.some((c) => c.tool === "gesture-swipe")).toBe(true);
  });
});

describe("e2e runner: an action does not press an element under the keyboard", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-keyboard-keys-"));
    // Only Date is faked, and every tree read moves it on, so an action's
    // wait for a covered element runs out in a few reads.
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** Serve the tree `next` gives for each read, two seconds apart. */
  function serveReads(
    next: () => DescribeNode,
    source: DescribeTreeData["source"] = "ax-service"
  ): void {
    currentRaw = undefined;
    currentTreeData = () => {
      vi.setSystemTime(Date.now() + 2000);
      return { tree: next(), source };
    };
  }
  const withoutKeys = (tree: DescribeNode): DescribeNode => ({
    ...tree,
    children: tree.children.filter((n) => n.keyboard !== true),
  });
  const covered = (selector: string) =>
    `the element matching ${selector} is under the on-screen keyboard, so pressing it would ` +
    `press a key. Close the keyboard before this step, or bring the element above it with a ` +
    `scroll-to step`;
  const gestures = (calls: ToolCall[]) => calls.filter((c) => c.tool.startsWith("gesture-"));

  it("fails a tap on the app's Delete under the decimal pad and taps nothing", async () => {
    // The base build tapped the delete key here, and the first ranking change
    // the key "0" over the app's Delete.
    const pad = iosTree("ios-27-iphone-decimal-pad-covered-delete");
    serveReads(() => pad);
    const result = await run([{ kind: "tap", selector: { text: "Delete" } }]);
    expect(result.steps[0]!.status).toBe("fail");
    expect(result.steps[0]!.reason).toBe(covered('text="Delete"'));
    expect(gestures(result.calls)).toEqual([]);
  });

  it("taps the element once the keyboard has gone", async () => {
    const pad = iosTree("ios-27-iphone-decimal-pad-covered-delete");
    let reads = 0;
    serveReads(() => {
      const tree = reads++ < 3 ? pad : withoutKeys(pad);
      // Log the read among the tool calls, to see what the tap followed.
      liveCalls.push({ tool: "read", args: { keys: keys(tree).length } });
      return tree;
    });
    const result = await run([{ kind: "tap", selector: { text: "Delete" } }]);
    expect(result.ok).toBe(true);
    expectTapOn(result.calls, leaf(pad, { role: "AXButton", label: "Delete" }));
    const tap = result.calls.findIndex((c) => c.tool === "gesture-tap");
    const readsBefore = result.calls.slice(0, tap).filter((c) => c.tool === "read");
    expect(readsBefore[0]!.args.keys).toBeGreaterThan(0);
    expect(readsBefore.at(-1)!.args.keys).toBe(0);
  });

  const hearing = { text: "Hearing devices" };
  it.each<[string, Parameters<typeof serializeFlow>[0]["steps"][number]]>([
    ["tap", { kind: "tap", selector: hearing }],
    ["long-press", { kind: "long-press", selector: hearing }],
    ["type", { kind: "type", into: hearing, text: "x" }],
    ["pinch", { kind: "pinch", selector: hearing, scale: 2 }],
    ["rotate", { kind: "rotate", selector: hearing, by: 90 }],
    ["swipe from", { kind: "swipe", from: { selector: hearing }, direction: "up" }],
  ])("fails %s on a search result under Gboard, with no gesture", async (_name, step) => {
    serveReads(() => androidTree("android-36-settings-results"), "android-devtools");
    const result = await run([step], ANDROID);
    expect(result.steps[0]!.status).toBe("fail");
    expect(result.steps[0]!.reason).toBe(covered('text="Hearing devices"'));
    expect(gestures(result.calls)).toEqual([]);
    expect(result.calls.some((c) => c.tool === "keyboard")).toBe(false);
  });

  it("lets a swipe end on an element under the keyboard", async () => {
    serveReads(() => androidTree("android-36-settings-results"), "android-devtools");
    const result = await run(
      [
        {
          kind: "swipe",
          from: { selector: { text: "Default notification sound" } },
          to: { selector: hearing },
        },
      ],
      ANDROID
    );
    expect(result.ok).toBe(true);
    expect(gestures(result.calls).map((c) => c.tool)).toEqual(["gesture-swipe"]);
  });

  it("leaves the conditions alone: a covered element is visible", async () => {
    serveReads(() => androidTree("android-36-settings-results"), "android-devtools");
    const result = await run(
      [{ kind: "assert", condition: "visible", selector: hearing }],
      ANDROID
    );
    expect(result.ok).toBe(true);
  });

  it("scroll-to says when the scroll moved a covered target away", async () => {
    // Scrolling up moves the rows down, off the screen under the keyboard.
    const before = androidTree("android-36-settings-results");
    const after: DescribeNode = {
      ...before,
      children: before.children.filter((n) => n.label !== "Hearing devices"),
    };
    serveReads(
      () => (liveCalls.some((c) => c.tool === "gesture-swipe") ? after : before),
      "android-devtools"
    );
    const result = await run([{ kind: "scroll-to", target: hearing, direction: "up" }], ANDROID);
    expect(result.steps[0]!.status).toBe("fail");
    expect(result.steps[0]!.reason).toBe(
      'the element matching text="Hearing devices" was under the on-screen keyboard, and ' +
        "scrolling up did not bring it above the keyboard. Close the keyboard before this step"
    );
  });

  it("scroll-to does not swipe where the keyboard covers the centre of its container", async () => {
    // The app's input view spans the keyboard: its centre is on the keys.
    serveReads(() => iosTree("ios-27-iphone-name"));
    const result = await run([
      {
        kind: "scroll-to",
        target: { text: "Terms" },
        direction: "down",
        within: { identifier: "inputView" },
      },
    ]);
    expect(result.steps[0]!.status).toBe("fail");
    expect(result.steps[0]!.reason).toBe(
      'scroll-to swipes at the centre of id="inputView", which the on-screen keyboard covers, ' +
        "so the swipe would land on the keyboard. Close the keyboard before this step, or name " +
        "in within: a scroll container whose centre is above the keyboard"
    );
    expect(gestures(result.calls)).toEqual([]);
  });

  it("scroll-to checks the point it swipes at, also for a container centred off the screen", async () => {
    // A sheet that runs past the bottom edge: the swipe goes down at y = 1.
    const tree = iosTree("ios-27-iphone-name");
    const sheet = {
      role: "AXScrollView",
      identifier: "sheet",
      frame: { x: 0, y: 0.9, width: 1, height: 0.3 },
      children: [],
    } as unknown as DescribeNode;
    serveReads(() => ({ ...tree, children: [...tree.children, sheet] }));
    const result = await run([
      {
        kind: "scroll-to",
        target: { text: "Terms" },
        direction: "down",
        within: { identifier: "sheet" },
      },
    ]);
    expect(result.steps[0]!.reason).toMatch(/^scroll-to swipes at the centre of id="sheet"/);
    expect(gestures(result.calls)).toEqual([]);
  });

  it("scroll-to goes on while the keyboard covers its target, then the tap lands", async () => {
    // The results list scrolls the rows up; the first tree has the target on
    // screen, under the keys.
    const before = androidTree("android-36-settings-results");
    const row = (n: DescribeNode) =>
      n.keyboard !== true &&
      [
        "android:id/title",
        "android:id/icon",
        "com.google.android.settings.intelligence:id/breadcrumb",
      ].includes(n.identifier ?? "");
    const after: DescribeNode = {
      ...before,
      children: before.children.map((n) =>
        row(n) ? { ...n, frame: { ...n.frame, y: n.frame.y - 0.4 } } : n
      ),
    };
    serveReads(
      () => (liveCalls.some((c) => c.tool === "gesture-swipe") ? after : before),
      "android-devtools"
    );
    const result = await run(
      [
        { kind: "scroll-to", target: hearing, direction: "down" },
        { kind: "tap", selector: hearing },
      ],
      ANDROID
    );
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "scroll-to:pass",
      "tap:pass",
    ]);
    expect(gestures(result.calls).map((c) => c.tool)).toEqual(["gesture-swipe", "gesture-tap"]);
    expectTapOn(result.calls, leaf(after, { label: "Hearing devices" }));
    expect(underKeyboard(after, leaf(after, { label: "Hearing devices" }))).toBe(false);
  });
});

describe("e2e recorder: a recorded tap replays on the tapped element", () => {
  const FLOW = "rec";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-keyboard-rec-"));
    __resetRecordingsForTesting();
    await flowStartRecordingTool.execute(
      {},
      { name: FLOW, project_root: tmpDir, executionPrerequisite: "Keyboard up" }
    );
  });
  afterEach(async () => {
    __resetRecordingsForTesting();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function recordTap(
    tree: DescribeNode,
    point: { x: number; y: number },
    device = IOS,
    source: DescribeTreeData["source"] = "ax-service"
  ) {
    serve(tree, source);
    const registry = {
      invokeTool: vi.fn(async (id: string) => {
        if (id === "gesture-tap") return { tapped: true };
        throw new Error(`Tool "${id}" not found`);
      }),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    } as unknown as Registry;
    await createFlowAddStepTool(registry).execute(
      {},
      {
        name: FLOW,
        project_root: tmpDir,
        command: "gesture-tap",
        args: JSON.stringify({ udid: device, ...point }),
      }
    );
    const yaml = await fs.readFile(path.join(tmpDir, ".argent", "e2e", `${FLOW}.yaml`), "utf8");
    return parseFlow(yaml).steps.at(-1)!;
  }

  /** Replay `step` on `tree` through the e2e runner: the centre it taps. */
  async function replay(tree: DescribeNode, step: Awaited<ReturnType<typeof recordTap>>) {
    serve(tree);
    const result = await run([step]);
    expect(result.ok).toBe(true);
    return tapAt(result.calls);
  }

  it("records the app's Done as `{ text: Done }`, which replays on it", async () => {
    const tree = iosTree("ios-27-iphone-name");
    const app = leaf(tree, { role: "AXButton", label: "Done" });
    const step = await recordTap(tree, centre(app));
    expect(step).toEqual({ kind: "tap", selector: { text: "Done" } });
    const at = await replay(tree, step);
    expect(at.x).toBeCloseTo(centre(app).x, 5);
    expect(at.y).toBeCloseTo(centre(app).y, 5);
  });

  it("records a key whose text an app element behind it shares so it replays on the key", async () => {
    // The decimal pad's delete key has no id; the app's "Delete" lies under
    // it and wins `{ text: Delete }`, so the recorder scopes the key.
    const tree = iosTree("ios-27-iphone-decimal-pad-covered-delete");
    const key = leaf(tree, { label: "Delete", keyboard: true });
    const step = await recordTap(tree, centre(key));
    expect(step).not.toEqual({ kind: "tap", selector: { text: "Delete" } });
    const at = await replay(tree, step);
    expect(at.x).toBeCloseTo(centre(key).x, 5);
    expect(at.y).toBeCloseTo(centre(key).y, 5);
  });
  it("keeps coordinates for a tap on the part of a row above the keys", async () => {
    // The row's title shows above Gboard, but its centre is under the keys:
    // replay of a selector would not press it.
    const tree = androidTree("android-36-settings-results");
    const title = leaf(tree, { label: "Hear outgoing message sounds" });
    expect(underKeyboard(tree, title)).toBe(true);
    const point = { x: 0.3, y: 0.625 };
    expect(nodeAtPoint(tree, point)).toBe(title);
    const step = await recordTap(tree, point, ANDROID, "android-devtools");
    expect(step).toEqual({ kind: "tap", ...point });
  });

  it("keeps coordinates for a tap between keys, where replay would press another key", async () => {
    // The margin of a key row holds only the container of the keys, and the
    // centre of the container is the key G.
    const tree = iosTree("ios-27-iphone-name");
    const point = { x: 0.03, y: 0.77 };
    const container = leaf(tree, { identifier: "UIKeyboardLayoutStar Preview" });
    expect(nodeAtPoint(tree, point)).toBe(container);
    expect(nodeAtPoint(tree, centre(container))).toBe(leaf(tree, { label: "G", keyboard: true }));
    const step = await recordTap(tree, point);
    expect(step).toEqual({ kind: "tap", ...point });
  });

  it("records a key tapped beside its label, which replays on the key", async () => {
    // Gboard's key "a" holds its label inside a frame, `host`. A tap left of
    // them finds the key, and replay taps the label at the centre of the key,
    // which is the key. Two app elements behind the key change nothing.
    const captured = androidTree("android-36-settings-search");
    const key = leaf(captured, { role: "FrameLayout", label: "a" });
    const behind = (x: number): DescribeNode => ({
      role: "Image",
      frame: { x, y: key.frame.y + 0.002, width: 0.02, height: 0.02 },
      children: [],
    });
    const tree = {
      ...captured,
      children: [...captured.children, behind(key.frame.x + 0.01), behind(key.frame.x + 0.12)],
    };
    const point = { x: key.frame.x + key.frame.width * 0.15, y: centre(key).y };
    expect(nodeAtPoint(tree, point)).toBe(key);
    expect(nodeAtPoint(tree, centre(key))).toBe(leaf(tree, { role: "StaticText", label: "a" }));
    const step = await recordTap(tree, point, ANDROID, "android-devtools");
    expect(step).toEqual({ kind: "tap", selector: { identifier: key.identifier } });
  });

  it("records a suggestion that holds the dividers beside it, which replays on it", async () => {
    // The frame of Gboard's suggestion "found" holds the dividers at its edges,
    // but the centre of the suggestion is the suggestion.
    const tree = androidTree("android-36-settings-results");
    const word = leaf(tree, { role: "StaticText", label: "found" });
    expect(nodeAtPoint(tree, centre(word))).toBe(word);
    const step = await recordTap(tree, centre(word), ANDROID, "android-devtools");
    expect(step).toEqual({ kind: "tap", selector: { text: "found" } });
  });

  it("records the return key by its id, which replays on the key", async () => {
    const tree = iosTree("ios-27-iphone-name");
    const key = leaf(tree, { identifier: "Done" });
    const step = await recordTap(tree, centre(key));
    expect(step).toEqual({ kind: "tap", selector: { identifier: "Done" } });
    const at = await replay(tree, step);
    expect(at.x).toBeCloseTo(centre(key).x, 5);
    expect(at.y).toBeCloseTo(centre(key).y, 5);
  });

  it("says why a wait recorded on a key does not hold as a condition", async () => {
    // The live wait sees the keyboard; the runner's conditions do not.
    serve(iosTree("ios-27-iphone-name"));
    const registry = {
      invokeTool: vi.fn(async (id: string) => {
        if (id === "await-ui-element") return { success: true, elapsed: 120 };
        throw new Error(`Tool "${id}" not found`);
      }),
      getTool: vi.fn(() => undefined),
    } as unknown as Registry;
    const result = await createFlowAddStepTool(registry).execute(
      {},
      {
        name: FLOW,
        project_root: tmpDir,
        command: "await-ui-element",
        args: JSON.stringify({ udid: IOS, condition: "visible", selector: { text: "shift" } }),
      }
    );
    expect(result.message).toContain("does NOT hold against the tree the runner resolves");
    expect(result.message).toContain(
      "The runner's conditions do not see the on-screen keyboard: a wait on a key holds only " +
        "as the raw `tool:` step."
    );
  });
});
