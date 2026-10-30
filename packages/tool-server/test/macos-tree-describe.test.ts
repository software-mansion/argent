import { describe, expect, it } from "vitest";
import type { DescribeNode } from "../src/tools/describe/contract";
import {
  MACOS_UNREACHABLE_REREAD_MS,
  projectMacosDescribeTree,
  readMacosTree,
} from "../src/tools/describe/platforms/macos";
import { adaptMacosTreeForFlows } from "../src/tools/flows/flow-macos-tree";
import { formatDescribeTree } from "../src/tools/describe/format-tree";
import { createDescribeTool } from "../src/tools/describe";
import { findAll } from "../src/utils/ui-tree-match";
import { renderFlagGated } from "../src/utils/flag-gated-text";
import { createRegistry } from "../src/utils/setup-registry";
import { advertisedSchema, definitionsById } from "./helpers/catalog";
import { useMacosAppsFlag } from "./helpers/macos-apps-flag";
import {
  MACOS_DEVICE_ID,
  axNode,
  fakeMacosLibrary,
  isUnitFrame,
  macosRegistry,
  probeTree,
  rect,
  windowRoot,
} from "./helpers/macos-tree-fixture";

useMacosAppsFlag();

function walk(node: DescribeNode, out: DescribeNode[] = []): DescribeNode[] {
  out.push(node);
  for (const c of node.children) walk(c, out);
  return out;
}

function byId(tree: DescribeNode, id: string): DescribeNode | undefined {
  return walk(tree).find((n) => n.identifier === id);
}

function byText(tree: DescribeNode, text: string): DescribeNode | undefined {
  return walk(tree).find((n) => n.label === text || n.value === text);
}

async function describeFixture(trees: Array<Record<string, unknown> | Error> = [probeTree()]) {
  const lib = fakeMacosLibrary({ trees });
  const read = await readMacosTree(lib.api);
  const data = projectMacosDescribeTree(read);
  return {
    data,
    lib,
    flow: adaptMacosTreeForFlows(read),
    text: formatDescribeTree(data.tree, { source: data.source }),
  };
}

describe("macOS describe adapter: projection of the probe app", () => {
  it("returns a nested tree under the app, every frame finite and inside 0-1", async () => {
    const { data } = await describeFixture();
    expect(data.source).toBe("macos-devtools");
    expect(data.tree.role).toBe("AXApplication");
    const nodes = walk(data.tree);
    expect(nodes.length).toBeGreaterThan(40);
    for (const n of nodes) {
      expect(isUnitFrame(n.frame), JSON.stringify(n)).toBe(true);
      expect(n.frame.x + n.frame.width).toBeLessThanOrEqual(1 + 1e-9);
      expect(n.frame.y + n.frame.height).toBeLessThanOrEqual(1 + 1e-9);
    }
    expect(data.tree.children[0]).toMatchObject({ role: "AXWindow", label: "Probe" });
    // Nested: the rows sit under the table under the scroll area.
    const scroll = byId(data.tree, "appkit.scroll")!;
    expect(byId(scroll, "appkit.table")).toBeDefined();
    expect(walk(scroll).some((n) => n.value === "row 1")).toBe(true);
  });

  it("keeps AX roles and maps the AX attributes onto the describe flags", async () => {
    const { data } = await describeFixture();
    const t = data.tree;
    expect(byId(t, "appkit.button")).toMatchObject({
      role: "AXButton",
      label: "Tap me",
      clickable: true,
    });
    // `description` is the label when there is no title (a SwiftUI control).
    expect(byId(t, "swift.toggle")).toMatchObject({
      role: "AXCheckBox",
      label: "SwiftUI toggle",
      value: "1",
      checkable: true,
      checked: true,
    });
    expect(byId(t, "appkit.checkbox")).toMatchObject({ checkable: true, value: "0" });
    expect(byId(t, "appkit.checkbox")!.checked).toBeUndefined();
    expect(byText(t, "Disabled")).toMatchObject({ role: "AXButton", disabled: true });
    expect(byId(t, "appkit.scroll")).toMatchObject({ role: "AXScrollArea", scrollable: true });
    expect(byId(t, "appkit.field")).toMatchObject({ value: "hello", focused: true });
    // A focused window covers every target; the flag is dropped on it.
    expect(t.children[0]!.focused).toBeUndefined();
  });

  it("merges the web view's items under its node, in the AX role vocabulary", async () => {
    const { data, lib } = await describeFixture();
    expect(lib.calls.filter((c) => c.method === "Web.tree")).toEqual([
      expect.objectContaining({ params: { webView: 0, maxItems: 3000 } }),
    ]);
    const webView = walk(data.tree).find((n) =>
      n.children.some((c) => c.identifier === "web-button")
    )!;
    expect(webView.role).toBe("AXGroup");
    expect(byId(webView, "web-button")).toMatchObject({ role: "AXButton", label: "Web button" });
    // The placeholder labels an empty field.
    expect(byId(webView, "web-input")).toMatchObject({ role: "AXTextField", label: "Type here" });
    expect(byId(webView, "web-input")!.value).toBeUndefined();
    expect(byId(webView, "web-check")).toMatchObject({ role: "AXCheckBox", checked: true });
    expect(byId(webView, "web-link")).toMatchObject({ role: "AXLink", label: "Docs" });
    expect(byText(webView, "Close banner")).toMatchObject({ role: "AXButton", clickable: true });
    // A select's text is all its options; only the value is kept.
    expect(byId(webView, "web-select")).toMatchObject({ role: "AXPopUpButton", value: "b" });
    expect(byId(webView, "web-select")!.label).toBeUndefined();
  });

  it("renders the macOS header in nested mode", async () => {
    const { text } = await describeFixture();
    expect(text).toContain("Source: macos-devtools");
    expect(text).toContain("Mode: nested");
    expect(text).toContain("fractions of the app window, title bar included, grown to hold");
    expect(text).toContain("gesture-tap / gesture-drag / gesture-scroll");
    expect(text).not.toContain("gesture-pinch");
    // Nested: a row's text is indented under its row.
    const rowLine = text.split("\n").find((l) => l.includes('value="row 1"'))!;
    const scrollLine = text.split("\n").find((l) => l.includes('id="appkit.scroll"'))!;
    expect(rowLine.search(/\S/)).toBeGreaterThan(scrollLine.search(/\S/));
  });

  it("takes a context menu root (kind menu) as a floating menu", async () => {
    const tree = probeTree();
    const copy = axNode("AXMenuItem", rect(0.222, 0.396, 0.133, 0.035), { title: "Copy" });
    (tree.windows as unknown[]).push({
      kind: "menu",
      root: axNode("AXMenu", rect(0.222, 0.396, 0.133, 0.07), {}, [copy]),
    });
    const { data } = await describeFixture([tree]);
    const menus = data.tree.children.filter((n) => n.role === "AXMenu");
    expect(menus.map((m) => m.children.map((c) => c.label))).toContainEqual(["Copy"]);
  });

  it("keeps the controls of a sheet that hangs below its window", async () => {
    const tree = probeTree();
    const root = windowRoot(tree);
    root.normalizedFrame = rect(0, 0, 1, 0.6);
    const save = axNode("AXButton", rect(0.6, 0.9, 0.1, 0.04), { title: "Save" });
    (root.children as unknown[]).push(axNode("AXSheet", rect(0.2, 0.05, 0.6, 0.9), {}, [save]));
    const { data } = await describeFixture([tree]);
    const frame = byText(data.tree, "Save")!.frame;
    expect(frame.y).toBe(0.9);
    expect(frame.height).toBeCloseTo(0.04);
  });

  it("drops a node whose frame is not finite, keeping its children", async () => {
    const tree = probeTree();
    const children = windowRoot(tree).children as Array<Record<string, unknown>>;
    children.find((c) => c.identifier === "appkit.scroll")!.normalizedFrame = {
      x: NaN,
      y: 0,
      width: 1,
      height: 1,
    };
    const { data } = await describeFixture([tree]);
    // The scroll area lost its frame and with it its clip; its rows are now
    // clipped by the window only, and the area spans what survived.
    const area = byId(data.tree, "appkit.scroll")!;
    expect(isUnitFrame(area.frame)).toBe(true);
    expect(byText(area, "row 1")).toBeDefined();
  });
});

describe("macOS describe adapter: reads", () => {
  it("reads once more 150 ms later when elements did not answer, and uses the second read", async () => {
    const { data, flow, lib } = await describeFixture([probeTree({ dead: true }), probeTree()]);
    const reads = lib.calls.filter((c) => c.method === "Accessibility.getTree");
    expect(reads).toHaveLength(2);
    expect(reads[1]!.at - reads[0]!.at).toBeGreaterThanOrEqual(MACOS_UNREACHABLE_REREAD_MS - 5);
    for (const tree of [data.tree, flow]) {
      expect(findAll(tree, { identifier: "swift.dead" })).toEqual([
        expect.objectContaining({ label: "Dead button" }),
      ]);
    }
    expect(data.hint ?? "").not.toMatch(/did not answer/);
  });

  it("skips an element that still does not answer, in both trees, and says so", async () => {
    const { data, flow, lib } = await describeFixture([probeTree({ dead: true })]);
    expect(lib.calls.filter((c) => c.method === "Accessibility.getTree")).toHaveLength(2);
    for (const tree of [data.tree, flow]) {
      expect(findAll(tree, { identifier: "swift.dead" })).toEqual([]);
    }
    expect(data.hint).toMatch(/1 element\(s\) did not answer/);
  });

  it("keeps the first read when the re-read fails", async () => {
    const { data, lib } = await describeFixture([
      probeTree({ dead: true }),
      new Error("timed out"),
    ]);
    expect(lib.calls.filter((c) => c.method === "Accessibility.getTree")).toHaveLength(2);
    expect(byId(data.tree, "appkit.button")).toBeDefined();
    expect(byId(data.tree, "swift.dead")).toBeUndefined();
    expect(data.hint).toMatch(/1 element\(s\) did not answer/);
  });

  it("does not re-read a tree that answered in full", async () => {
    const { lib } = await describeFixture();
    expect(lib.calls.filter((c) => c.method === "Accessibility.getTree")).toHaveLength(1);
  });

  it.each([
    ["the first read fails", new Error("No window"), "No window"],
    ["a tree result has no windows", {}, /returned no windows/],
  ])("rejects when %s", async (_name, tree, error) => {
    const lib = fakeMacosLibrary({ trees: [tree] });
    await expect(readMacosTree(lib.api)).rejects.toThrow(error);
  });
});

describe("describe tool on a Mac app", () => {
  it("reads the tree from the in-app library through the registry", async () => {
    const lib = fakeMacosLibrary();
    const registry = macosRegistry(lib.api);
    const tool = createDescribeTool(registry);
    expect(tool.capability?.macos).toEqual({ app: true });
    const result = await tool.execute({}, { udid: MACOS_DEVICE_ID });
    expect(result.source).toBe("macos-devtools");
    expect(result.description).toContain('AXButton "Tap me" id="appkit.button"');
    expect(registry.resolveService).toHaveBeenCalledTimes(1);
    expect(lib.calls.map((c) => c.method)).toEqual(["Accessibility.getTree", "Web.tree"]);
  });
});

it.each([
  "describe",
  "await-ui-element",
  "await-screen-idle",
  "native-describe-screen",
  "native-find-views",
  "native-full-hierarchy",
  "native-view-at-point",
  "native-user-interactable-view-at-point",
  "native-network-logs",
])("%s mentions Mac apps only while the macos-apps flag is on", (id) => {
  const def = definitionsById(createRegistry()).get(id)!;
  const text = (on: boolean) =>
    JSON.stringify(
      renderFlagGated([def.description, advertisedSchema(def), def.searchHint], () => on)
    );
  expect(text(false)).not.toMatch(/Mac app|macos|AppKit|NSView/i);
  expect(text(true)).toMatch(/Mac app/);
});
