import { describe, expect, it } from "vitest";
import type { DescribeNode } from "../src/tools/describe/contract";
import {
  MACOS_FALLBACK_HINT,
  MACOS_JUDGING_LIMITS,
  MACOS_LOCKED_HINT,
  describeMacos,
  projectMacosDescribeTree,
  readMacosTree,
} from "../src/tools/describe/platforms/macos";
import { adaptMacosTreeForFlows, queryMacosTree } from "../src/tools/flows/flow-macos-tree";
import { fetchFlowTree } from "../src/tools/flows/flow-tree";
import { resolveDevice } from "../src/utils/device-info";
import {
  assertText,
  evaluateCondition,
  findAll,
  firstInReadingOrder,
  nodeAtPoint,
  selectorToFrame,
  type Selector,
} from "../src/utils/ui-tree-match";
import { useMacosAppsFlag } from "./helpers/macos-apps-flag";
import {
  MACOS_DEVICE_ID,
  axNode,
  fakeMacosLibrary,
  findWireNode,
  isUnitFrame,
  macosRegistry,
  probeTree,
  probeWeb,
  rect,
  webTree,
  windowRoot,
} from "./helpers/macos-tree-fixture";

useMacosAppsFlag();

type Json = Record<string, unknown>;
type LibraryOpts = Parameters<typeof fakeMacosLibrary>[0];

/** The `describe` tree and the flow tree of one read. */
async function bothTrees(opts: LibraryOpts = {}) {
  const read = await readMacosTree(fakeMacosLibrary(opts).api);
  // The flow tree first: building it must leave the describe tree unchanged.
  const flow = adaptMacosTreeForFlows(read);
  const described = projectMacosDescribeTree(read);
  return { read, described, describe: described.tree, flow };
}

async function flowTree(opts: LibraryOpts = {}): Promise<DescribeNode> {
  return (await bothTrees(opts)).flow;
}

function walk(node: DescribeNode, out: DescribeNode[] = []): DescribeNode[] {
  out.push(node);
  for (const c of node.children) walk(c, out);
  return out;
}

function leaf(tree: DescribeNode, pred: (n: DescribeNode) => boolean): DescribeNode | undefined {
  return tree.children.find(pred);
}

const byId = (id: string) => (n: DescribeNode) => n.identifier === id;
const byText = (text: string) => (n: DescribeNode) => n.label === text || n.value === text;
const byWireId = (id: string) => (n: Json) => n.identifier === id;
const ROWS_1_TO_8 = "row 1 row 2 row 3 row 4 row 5 row 6 row 7 row 8";

describe("macOS flow tree projection", () => {
  it("is a flat list of on-screen leaves under one Screen root", async () => {
    const tree = await flowTree();
    expect(tree.role).toBe("Screen");
    expect(tree.children.length).toBeGreaterThan(20);
    for (const n of tree.children) {
      expect(n.children).toEqual([]);
      expect(isUnitFrame(n.frame), JSON.stringify(n)).toBe(true);
      expect(n.frame.width * n.frame.height).toBeGreaterThan(0);
    }
  });

  it("keeps only addressable leaves, never a window, scroll bar or bare group", async () => {
    const tree = await flowTree();
    for (const n of tree.children) {
      expect(
        Boolean(n.identifier || n.label || n.value || n.clickable || n.focused),
        JSON.stringify(n)
      ).toBe(true);
      expect(["AXWindow", "AXScrollBar", "AXValueIndicator"]).not.toContain(n.role);
    }
    // The web view's group has no label: scaffolding, its items are the leaves.
    expect(leaf(tree, (n) => n.role === "AXGroup" && !n.identifier && !n.label)).toBeUndefined();
    expect(leaf(tree, byId("web-button"))).toMatchObject({ role: "AXButton" });
    // A scroll bar's position does not hoist into the scroll area's text.
    expect(leaf(tree, byId("appkit.scroll"))!.subtreeText).toBeUndefined();
  });

  it("never makes a leaf of a scroll bar's page and arrow buttons", async () => {
    const tree = await flowTree();
    // The window's close button is the only unlabelled, unidentified button.
    const bare = tree.children.filter((n) => n.role === "AXButton" && !n.label && !n.identifier);
    expect(bare).toHaveLength(1);
    expect(bare[0]!.frame.y).toBeLessThan(0.05);
  });

  it("keeps a visible child of a zero-area group, as describe does", async () => {
    const tree = probeTree();
    (windowRoot(tree).children as Json[]).push(
      axNode("AXGroup", rect(-0.5, -0.375, 0, 0), {}, [
        axNode("AXButton", rect(0.2, 0.2, 0.1, 0.1), { title: "Zero group OK" }),
      ])
    );
    const { describe, flow } = await bothTrees({ trees: [tree] });
    expect(leaf(flow, byText("Zero group OK"))).toBeDefined();
    expect(JSON.stringify(describe)).toContain("Zero group OK");
  });

  it("gives a web container and an RN View container the text below them, for text checks", async () => {
    const { describe, flow } = await bothTrees();
    // A container is not named by its children's text; `fullText` holds all
    // of it, past the 80 characters of the library's `text`.
    const summary = leaf(flow, byId("web-summary"))!;
    expect(summary.label).toBeUndefined();
    expect(assertText(summary)).toContain("TOTAL 42");
    expect(
      evaluateCondition("text", "TOTAL 42", findAll(flow, { identifier: "web-summary" }))
    ).toBe(true);
    // An RN View testID with no text of its own: its children's text.
    const box = leaf(flow, byId("rn.box"))!;
    expect(box.label).toBeUndefined();
    expect(assertText(box)).toBe("Box title Box body");
    // describe leaves subtreeText unset (contract.ts), also after the flow tree
    // was built from the same read.
    expect(JSON.stringify(describe)).not.toContain("subtreeText");
    // A plain leaf whose text is all it has gets no subtreeText of its own.
    expect(leaf(flow, byId("web-button"))!.subtreeText).toBeUndefined();
  });

  it("names a field by its placeholder, never by the start of its value", async () => {
    const swift = probeTree();
    const swiftField = findWireNode(windowRoot(swift), byWireId("swift.field"))!;
    delete swiftField.description;
    swiftField.placeholder = "Email";
    expect(leaf(await flowTree({ trees: [swift] }), byId("swift.field"))!.label).toBe("Email");
    const tree = await flowTree();
    const value = "A".repeat(50) + " " + "B".repeat(49);
    expect(leaf(tree, byId("web-notes"))).toMatchObject({
      role: "AXTextArea",
      label: "Notes",
      value,
    });
    const matches = findAll(tree, { identifier: "web-notes" });
    expect(evaluateCondition("text", `Notes ${value}`, matches, "equals")).toBe(true);
    expect(evaluateCondition("text", value, matches, "contains")).toBe(true);
    // An aria-label wins over the placeholder.
    const web = probeWeb();
    const notes = (web.items as Json[]).find((i) => i.testid === "web-notes")!;
    notes.label = "Order notes";
    expect(leaf(await flowTree({ web }), byId("web-notes"))!.label).toBe("Order notes");
    // With neither, the field has no label, and `equals` holds on its value.
    notes.label = "";
    notes.placeholder = "";
    const bare = await flowTree({ web });
    expect(leaf(bare, byId("web-notes"))!.label).toBeUndefined();
    expect(
      evaluateCondition("text", value, findAll(bare, { identifier: "web-notes" }), "equals")
    ).toBe(true);
  });

  it("reads collected text with whitespace runs as single spaces", async () => {
    const tree = await flowTree();
    const address = findAll(tree, { identifier: "web-address" });
    expect(assertText(address[0]!)).toBe("Line one Line two");
    expect(evaluateCondition("text", "one Line two", address, "contains")).toBe(true);
    const views = probeTree();
    (views.extraViews as Json[]).find((v) => v.identifier === "rn.box")!.subtreeText =
      "Box title\n  Box body";
    const flat = await flowTree({ trees: [views] });
    expect(
      evaluateCondition(
        "text",
        "title Box body",
        findAll(flat, { identifier: "rn.box" }),
        "contains"
      )
    ).toBe(true);
  });

  it("carries input focus for the type step, native and web, but never on the window", async () => {
    const focused = (tree: DescribeNode) =>
      tree.children.filter((n) => n.focused).map((n) => n.identifier);
    expect(focused(await flowTree())).toEqual(["appkit.field"]);
    // SwiftUI reports every List row and cell focused.
    const list = probeTree();
    for (const role of ["AXRow", "AXCell"]) {
      findWireNode(windowRoot(list), (n) => n.role === role)!.focused = true;
    }
    expect(focused(await flowTree({ trees: [list] }))).toEqual(["appkit.field"]);
    const web = probeWeb();
    (web.items as Json[]).find((i) => i.testid === "web-input")!.focused = true;
    expect(focused(await flowTree({ web }))).toEqual(["appkit.field", "web-input"]);
  });

  it("lists a container after its children, where describe lists it before them", async () => {
    // The order the recorder's `text` tie clause relies on (flow-add-step).
    const { describe, flow } = await bothTrees();
    const rowIndex = flow.children.findIndex(
      (n) => n.role === "AXRow" && n.subtreeText === "row 1"
    );
    const textIndex = flow.children.findIndex((n) => n.value === "row 1");
    expect(textIndex).toBeGreaterThanOrEqual(0);
    expect(rowIndex).toBeGreaterThan(textIndex);
    const nested = walk(describe);
    const dRow = nested.findIndex(
      (n) =>
        n.role === "AXRow" && n.children.some((c) => c.children.some((t) => t.value === "row 1"))
    );
    expect(dRow).toBeLessThan(nested.findIndex((n) => n.value === "row 1"));
  });

  describe("web items are named as a browser names them", () => {
    const item = (attrs: Json) => ({ normalizedFrame: rect(0.1, 0.6, 0.2, 0.05), ...attrs });
    const text = (tag: string, t: string) => item({ tag, text: t, ownText: t });
    // <li data-testid="row-1"><span>Title</span><button>Edit</button></li>
    const row = [
      item({ tag: "li", testid: "row-1", text: "Title Edit" }),
      text("span", "Title"),
      item({ tag: "button", type: "submit", value: "", text: "Edit", ownText: "Edit" }),
    ];
    // <div id="root"><span>Status: OK</span><p>Error log is empty</p></div>
    const page = [
      item({ id: "root", text: "Status: OK Error log is empty" }),
      text("span", "Status: OK"),
      text("p", "Error log is empty"),
    ];
    const save = [{ role: "AXButton", label: "Save" }];

    it.each<[string, Json[], Selector, Array<Partial<DescribeNode>>]>([
      [
        "a list row's child, not the row",
        row,
        { text: "Edit" },
        [{ role: "AXButton", label: "Edit" }],
      ],
      [
        "the row, a group with its children's text",
        row,
        { identifier: "row-1" },
        [{ role: "AXGroup", subtreeText: "Title Edit" }],
      ],
      [
        "a page root's child, not the root",
        page,
        { text: "Status" },
        [{ role: "AXStaticText", label: "Status: OK" }],
      ],
      [
        "<button><span>Save</span></button> by its content",
        [item({ tag: "button", type: "submit", value: "", text: "Save" }), text("span", "Save")],
        { role: "button", text: "Save" },
        save,
      ],
      [
        '<div role="button"><div>Save</div></div> (a react-native-web Pressable) by its content',
        [item({ role: "button", text: "Save" }), text("div", "Save")],
        { role: "button", text: "Save" },
        save,
      ],
      [
        "a heading with inline markup by its content",
        [item({ tag: "h2", text: "Billing details", ownText: "details" })],
        { text: "Billing details" },
        [{ role: "AXStaticText", label: "Billing details" }],
      ],
      [
        "a table cell by its content",
        [item({ tag: "td", text: "42 EUR" })],
        { text: "42 EUR" },
        [{ role: "AXStaticText", label: "42 EUR" }],
      ],
      [
        "a paragraph as static text",
        [text("p", "Paragraph text")],
        { text: "Paragraph" },
        [{ role: "AXStaticText", label: "Paragraph text" }],
      ],
      [
        "a span with an id as static text",
        [item({ tag: "span", id: "status", text: "Ready", ownText: "Ready" })],
        { role: "statictext", text: "Ready" },
        [{ role: "AXStaticText", label: "Ready" }],
      ],
      [
        "an element with only an id as a group",
        [item({ id: "anchor" })],
        { identifier: "anchor" },
        [{ role: "AXGroup" }],
      ],
    ])("matches %s", async (_name, items, selector, expected) => {
      const flow = await flowTree({ web: webTree(items) });
      const matches = findAll(flow, selector);
      expect(matches.map(({ role, label, subtreeText }) => ({ role, label, subtreeText }))).toEqual(
        expected
      );
    });
  });
});

describe("macOS describe and flow trees of one read", () => {
  it("drops rows the scroll view hides even where they still fall inside the window", async () => {
    const { describe, flow } = await bothTrees();
    for (const tree of [describe, flow]) {
      const shown = new Set(walk(tree).map((n) => n.value));
      for (let i = 1; i <= 30; i++) expect(shown.has(`row ${i}`), `row ${i}`).toBe(i <= 8);
      // A partly visible row resolves to its visible part, so a tap lands on it.
      const scroll = findAll(tree, { identifier: "appkit.scroll" })[0]!;
      const row8 = walk(tree).find((n) => n.value === "row 8")!;
      expect(row8.frame.y + row8.frame.height).toBeCloseTo(scroll.frame.y + scroll.frame.height, 6);
      // The web view clips its page the same way.
      expect(findAll(tree, { identifier: "web-row-hidden" })).toEqual([]);
    }
    expect(findAll(flow, { text: "Hidden row" })).toEqual([]);
    // describe counts what each scroller hides; the flow tree hoists what shows.
    expect(walk(describe).find(byId("appkit.scroll"))!.scrollHidden).toBe(22);
    expect(walk(describe).find((n) => n.children.some(byId("web-button")))!.scrollHidden).toBe(1);
    expect(assertText(leaf(flow, byId("appkit.table"))!)).toBe(ROWS_1_TO_8);
    // The library counts the rows it left out and the items the page itself hides.
    const scrolled = probeTree();
    findWireNode(windowRoot(scrolled), byWireId("appkit.table"))!.scrolledOutRows = 1970;
    const counted = (await bothTrees({ trees: [scrolled], web: { ...probeWeb(), hidden: 2 } }))
      .describe;
    expect(walk(counted).find(byId("appkit.scroll"))!.scrollHidden).toBe(1992);
    expect(walk(counted).find((n) => n.children.some(byId("web-button")))!.scrollHidden).toBe(3);
  });

  it("lifts an open combo box list out of the scroll area it was opened in", async () => {
    const tree = probeTree();
    const items = ["Apple", "Banana", "Cherry"].map((value, i) =>
      axNode("AXTextField", rect(0.511, 0.3228 + i * 0.0348, 0.167, 0.0348), { value })
    );
    const list = axNode("AXScrollArea", rect(0.511, 0.3228, 0.167, 0.1044), {}, [
      axNode("AXList", rect(0.511, 0.3228, 0.167, 0.1044), {}, items),
    ]);
    const combo = axNode("AXComboBox", rect(0.511, 0.285, 0.133, 0.038), {}, [list]);
    (findWireNode(windowRoot(tree), byWireId("settings.scroll"))!.children as Json[]).push(combo);
    const { describe, flow } = await bothTrees({ trees: [tree] });
    // "Cherry" lies below the settings scroll view, still inside the window.
    expect(walk(describe).find(byText("Cherry"))).toBeDefined();
    expect(
      walk(walk(describe).find(byId("settings.scroll"))!).find(byText("Cherry"))
    ).toBeUndefined();
    expect(leaf(flow, byText("Cherry"))).toMatchObject({ role: "AXTextField" });
  });

  it("lifts an open menu out of the scroll area it was opened in", async () => {
    const { describe, flow } = await bothTrees();
    // "Purple" lies below the settings scroll view, still inside the window.
    const menu = describe.children.find((n) => n.role === "AXMenu")!;
    expect(walk(menu).find(byText("Purple"))).toMatchObject({
      role: "AXMenuItem",
      clickable: true,
    });
    expect(
      walk(walk(describe).find(byId("settings.scroll"))!).find(byText("Purple"))
    ).toBeUndefined();
    expect(leaf(flow, byText("Purple"))).toMatchObject({ role: "AXMenuItem" });
  });

  it("picks the match in an open menu, alert or sheet over the same-named control behind it", async () => {
    const tree = probeTree();
    // The controls behind are smaller and read first, so without the stacking they would win.
    (windowRoot(tree).children as Json[]).push(
      axNode("AXButton", rect(0.3, 0.2, 0.1, 0.02), {
        identifier: "win.delete",
        title: "Delete item",
      }),
      axNode("AXButton", rect(0.7, 0.2, 0.05, 0.02), { identifier: "win.done", title: "Done" }),
      axNode("AXSheet", rect(0.3, 0.3, 0.4, 0.3), {}, [
        axNode("AXButton", rect(0.43, 0.53, 0.13, 0.04), {
          identifier: "sheet.done",
          title: "Done",
        }),
        axNode("AXButton", rect(0.31, 0.31, 0.05, 0.02), {
          identifier: "sheet.cancel",
          title: "Cancel",
        }),
        axNode("AXButton", rect(0.31, 0.56, 0.05, 0.02), {
          identifier: "sheet.apply",
          title: "Apply",
        }),
        // An alert over the sheet.
        axNode("AXSheet", rect(0.4, 0.35, 0.2, 0.15), {}, [
          axNode("AXButton", rect(0.42, 0.45, 0.07, 0.03), {
            identifier: "alert.cancel",
            title: "Cancel",
          }),
          axNode("AXButton", rect(0.5, 0.45, 0.08, 0.03), {
            identifier: "alert.delete",
            title: "Delete item",
          }),
        ]),
      ])
    );
    // An app-modal alert window over the window with the sheet.
    (tree.windows as Json[]).push({
      kind: "alert",
      root: axNode("AXWindow", rect(0.6, 0.62, 0.3, 0.2), {}, [
        axNode("AXButton", rect(0.75, 0.75, 0.1, 0.04), {
          identifier: "modal.apply",
          title: "Apply",
        }),
      ]),
    });
    (tree.windows as Json[]).push({
      kind: "menu",
      root: axNode("AXMenu", rect(0.15, 0.14, 0.26, 0.09), {}, [
        axNode("AXMenuItem", rect(0.15, 0.19, 0.26, 0.04), {
          identifier: "ctx.delete",
          title: "Delete item",
        }),
      ]),
    });
    const { describe, flow } = await bothTrees({ trees: [tree] });
    for (const t of [describe, flow]) {
      const frame = (id: string) => findAll(t, { identifier: id })[0]!.frame;
      expect(selectorToFrame(t, { text: "Delete item" })).toEqual(frame("ctx.delete"));
      expect(selectorToFrame(t, { text: "Done" })).toEqual(frame("sheet.done"));
      expect(firstInReadingOrder(findAll(t, { text: "Done" }))?.identifier).toBe("sheet.done");
      expect(selectorToFrame(t, { text: "Cancel" })).toEqual(frame("alert.cancel"));
      expect(firstInReadingOrder(findAll(t, { text: "Cancel" }))?.identifier).toBe("alert.cancel");
      expect(selectorToFrame(t, { text: "Apply" })).toEqual(frame("modal.apply"));
      expect(nodeAtPoint(t, { x: 0.35, y: 0.21 })?.identifier).toBe("ctx.delete");
    }
  });

  it("adds the identified views on screen, and drops what lies outside the window", async () => {
    const { described, describe, flow } = await bothTrees();
    for (const tree of [describe, flow]) {
      expect(findAll(tree, { identifier: "rn.text" })).toEqual([
        expect.objectContaining({ role: "AXStaticText", label: "Static text" }),
      ]);
      expect(findAll(tree, { identifier: "rn.box" })).toHaveLength(1);
      for (const id of ["rn.far", "appkit.offscreen"]) {
        expect(findAll(tree, { identifier: id }), id).toEqual([]);
      }
    }
    expect(describe.children.map((n) => n.identifier)).toEqual(
      expect.arrayContaining(["rn.text", "rn.box"])
    );
    // A view with no visible part is not on screen, but not outside the window either.
    expect(described.hint).toMatch(/\b1 element\(s\) lie outside the app window/);
  });

  const secureView = (attrs: Json) => (tree: Json) => {
    (tree.extraViews as Json[]).push({
      identifier: "pw",
      text: "hunter2",
      subtreeText: "hunter2",
      visibleNormalizedFrame: rect(0.5, 0.9, 0.2, 0.03),
      ...attrs,
    });
  };

  it.each<[string, string, (tree: Json) => void]>([
    ["a native secure field", "appkit.secure", () => {}],
    ["a web password field", "web-pass", () => {}],
    ["an identified RCTUISecureTextField", "pw", secureView({ class: "RCTUISecureTextField" })],
    [
      "an identified view with the secure subrole",
      "pw",
      secureView({ subrole: "AXSecureTextField" }),
    ],
    ["an identified NSSecureTextField", "pw", secureView({ class: "NSSecureTextField" })],
    [
      "a node the library calls secure without the secure subrole",
      "appkit.field",
      (tree) => {
        const field = findWireNode(windowRoot(tree), byWireId("appkit.field"))!;
        delete field.value;
        field.secure = true;
      },
    ],
    [
      "a node of a secure class without the secure subrole (fallback walk)",
      "appkit.secure",
      (tree) => {
        tree.source = "fallback";
        const secure = findWireNode(windowRoot(tree), byWireId("appkit.secure"))!;
        delete secure.subrole;
        secure.viewClassName = "NSSecureTextField";
        secure.value = "hunter2";
      },
    ],
  ])("withholds the text of %s in both trees", async (_name, id, edit) => {
    const tree = probeTree();
    edit(tree);
    const { describe, flow } = await bothTrees({ trees: [tree] });
    const [described] = findAll(describe, { identifier: id });
    expect(described).toMatchObject({ password: true });
    expect([described!.label, described!.value]).toEqual([undefined, undefined]);
    const [flowLeaf] = findAll(flow, { identifier: id });
    expect(flowLeaf).toMatchObject({ label: "[password]", password: true });
    expect(flowLeaf!.value).toBeUndefined();
    expect(JSON.stringify(describe) + JSON.stringify(flow)).not.toMatch(/hunter2|•/);
  });

  it.each([
    "_NS:87",
    "_popUpItemAction:",
    "NSTableViewRowViewKey",
    "SwiftUI.WindowGroup<Probe.ContentView>-1-AppWindow-1",
    "SwiftUI.WindowGroup<Probe.ContentView>-1-AppWindow-1, SidebarNavigationSplitView",
    "ListRow",
    "ListCell",
  ])("drops the automatic identifier %s, keeping the element", async (id) => {
    const tree = probeTree();
    findWireNode(windowRoot(tree), byWireId("appkit.button"))!.identifier = id;
    (tree.extraViews as Json[])[0]!.identifier = id;
    const { describe, flow } = await bothTrees({ trees: [tree] });
    for (const t of [describe, flow]) {
      const [button] = findAll(t, { text: "Tap me" });
      expect(button).toMatchObject({ role: "AXButton", clickable: true });
      expect(button!.identifier).toBeUndefined();
      // An identified view is listed only for its identifier.
      expect(findAll(t, { text: "Static text" })).toEqual([]);
      expect(JSON.stringify(t)).not.toContain(id);
    }
  });

  it("lets an AppKit identifier neither match nor shield, and never makes a sheet a leaf", async () => {
    const tree = probeTree();
    findWireNode(windowRoot(tree), byWireId("appkit.table"))!.identifier = "_NS:87";
    // An alert sheet as AppKit reports it.
    (windowRoot(tree).children as Json[]).push(
      axNode(
        "AXSheet",
        rect(0.36, 0.42, 0.29, 0.15),
        { identifier: "_NS:87", description: "alert" },
        [
          axNode("AXButton", rect(0.5, 0.5, 0.12, 0.05), {
            identifier: "alert.proceed",
            title: "Proceed",
          }),
        ]
      )
    );
    const { describe, flow } = await bothTrees({ trees: [tree] });
    expect(JSON.stringify(describe) + JSON.stringify(flow)).not.toContain("_NS:");
    expect(findAll(flow, { identifier: "alert.proceed" })).toEqual([
      expect.objectContaining({ role: "AXButton", label: "Proceed" }),
    ]);
    expect(flow.children.some((n) => n.role === "AXSheet")).toBe(false);
    // Unshielded, the rows' text hoists to the nearest identified ancestor.
    expect(assertText(leaf(flow, byId("appkit.scroll"))!)).toBe(ROWS_1_TO_8);
  });

  // An RN row scrolled up out of a list: its frame lies inside the window, over
  // the controls above the list, but the library's visible frame says what shows.
  it.each<[string, Json | null | undefined, Json | undefined]>([
    ["a visible frame with no area", rect(0.02, 0.21, 0, 0), undefined],
    ["a null visible frame", null, undefined],
    ["no visible frame", undefined, undefined],
    ["a partly visible frame", rect(0.02, 0.6, 0.4, 0.01), rect(0.02, 0.6, 0.4, 0.01)],
    ["the whole frame visible", rect(0.02, 0.21, 0.4, 0.03), rect(0.02, 0.21, 0.4, 0.03)],
  ])("places an identified view sent with %s where it shows", async (_name, visible, expected) => {
    const tree = probeTree();
    tree.extraViews = [{ identifier: "rn.row", text: "Row", visibleNormalizedFrame: visible }];
    const { described, describe, flow } = await bothTrees({ trees: [tree] });
    const round = (f: DescribeNode["frame"]) =>
      Object.fromEntries(Object.entries(f).map(([k, v]) => [k, Math.round(v * 1e9) / 1e9]));
    for (const t of [describe, flow]) {
      const frames = findAll(t, { identifier: "rn.row" }).map((n) => round(n.frame));
      expect(frames).toEqual(expected ? [expected] : []);
    }
    expect(described.hint).toMatch(/\b1 element\(s\) lie outside the app window/);
  });
});

describe("queryMacosTree", () => {
  const device = resolveDevice(MACOS_DEVICE_ID);

  it("is the macos flow tree source and reports macos-devtools", async () => {
    const lib = fakeMacosLibrary();
    const data = await fetchFlowTree(macosRegistry(lib.api), device);
    expect(data.source).toBe("macos-devtools");
    expect(data.tree.role).toBe("Screen");
    expect(data.hint).toBeUndefined();
    expect(lib.calls.map((c) => c.method)).toEqual(["Accessibility.getTree", "Web.tree"]);
  });

  it("reads with the judging limits, and describe with the library's defaults", async () => {
    expect(MACOS_JUDGING_LIMITS).toEqual({ maxNodes: 12_000, maxItems: 12_000 });
    const flowLib = fakeMacosLibrary();
    await queryMacosTree(macosRegistry(flowLib.api), device);
    const describeLib = fakeMacosLibrary();
    await describeMacos(macosRegistry(describeLib.api), device);
    for (const [lib, max] of [
      [flowLib, 12_000],
      [describeLib, 3000],
    ] as const) {
      expect(lib.calls.map((c) => [c.method, c.params])).toEqual([
        ["Accessibility.getTree", { maxNodes: max }],
        ["Web.tree", { webView: 0, maxItems: max }],
      ]);
    }
  });

  it.each<[string, LibraryOpts, string, string, string | RegExp]>([
    [
      "the locked-Mac walk",
      { trees: [{ ...probeTree(), source: "fallback", locked: true }] },
      "macos-fallback",
      MACOS_LOCKED_HINT,
      MACOS_LOCKED_HINT,
    ],
    [
      "the fallback walk on an unlocked Mac",
      { trees: [{ ...probeTree(), source: "fallback" }] },
      "macos-fallback",
      MACOS_FALLBACK_HINT,
      MACOS_FALLBACK_HINT,
    ],
    [
      "a tree cut at the node limit",
      { trees: [{ ...probeTree(), truncated: true }] },
      "macos-devtools",
      "cut at the library's limit (3000 elements or depth 40)",
      "cut at the library's limit (12000 elements or depth 40)",
    ],
    [
      "web content cut at the item limit",
      { web: { ...probeWeb(), truncated: true } },
      "macos-devtools",
      "Web content was cut at the library's limit (3000 items per web view)",
      "Web content was cut at the library's limit (12000 items per web view)",
    ],
    [
      "a web view that cannot be read",
      { web: new Error("Web view 0 is gone") },
      "macos-devtools",
      "Web content could not be read (web view 0: Web view 0 is gone)",
      /could not read the web content of com\.argent\.probe: web view 0/,
    ],
    [
      "elements that still do not answer after the re-read",
      { trees: [probeTree({ dead: true })] },
      "macos-devtools",
      "1 element(s) did not answer",
      /the tree of com\.argent\.probe is incomplete: 1 element\(s\) did not answer/,
    ],
  ])(
    "on %s: describe hints, the flow tree hints or refuses",
    async (_name, opts, source, describeHint, flowOutcome) => {
      const { described } = await bothTrees(opts);
      expect(described.source).toBe(source);
      expect(described.hint).toContain(describeHint);
      // describe keeps the native tree when the web content is missing.
      expect(findAll(described.tree, { identifier: "appkit.button" })).toHaveLength(1);
      const query = queryMacosTree(macosRegistry(fakeMacosLibrary(opts).api), device);
      if (flowOutcome instanceof RegExp) {
        // A `hidden` check must not pass on content the read missed.
        await expect(query).rejects.toThrow(flowOutcome);
        return;
      }
      const data = await query;
      expect(data.source).toBe(source);
      expect(data.hint).toContain(flowOutcome);
      expect(findAll(data.tree, { identifier: "web-button" })).toHaveLength(1);
    }
  );
});
