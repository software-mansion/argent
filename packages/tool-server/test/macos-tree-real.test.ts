import * as fs from "node:fs";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { DescribeNode } from "../src/tools/describe/contract";
import { projectMacosDescribeTree, readMacosTree } from "../src/tools/describe/platforms/macos";
import { adaptMacosTreeForFlows } from "../src/tools/flows/flow-macos-tree";
import { findAll } from "../src/utils/ui-tree-match";
import { fakeMacosLibrary, isUnitFrame } from "./helpers/macos-tree-fixture";

/**
 * Real library output: `Accessibility.getTree` and `Web.tree` answered inside
 * the fixture app on macOS 27 with its popup button's menu open.
 */
const FIXTURES = path.join(__dirname, "fixtures", "macos");
const load = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8")) as Record<string, unknown>;

function walk(node: DescribeNode, out: DescribeNode[] = []): DescribeNode[] {
  out.push(node);
  for (const c of node.children) walk(c, out);
  return out;
}

describe("macOS tree projections of real library output (fixture app)", () => {
  const raw = load("fixture-app-popup-menu-tree.json");
  let tree: DescribeNode;
  let flow: DescribeNode;
  beforeAll(async () => {
    const lib = fakeMacosLibrary({ trees: [raw], web: load("fixture-app-web.json") });
    const read = await readMacosTree(lib.api);
    tree = projectMacosDescribeTree(read).tree;
    flow = adaptMacosTreeForFlows(read);
  });

  it("keeps every frame valid and finds the fixture's controls in both trees", () => {
    for (const n of walk(tree)) expect(isUnitFrame(n.frame)).toBe(true);
    for (const id of [
      "appkit.button",
      "appkit.field",
      "appkit.checkbox",
      "appkit.popup",
      "swift.button",
      "swift.toggle",
      "web-button",
      "web-input",
      "web-link",
    ]) {
      expect(findAll(tree, { identifier: id }), id).toHaveLength(1);
      expect(findAll(flow, { identifier: id }), id).toHaveLength(1);
    }
    // The web items sit under the web view node, with the AX roles.
    const webView = walk(tree).find((n) => n.identifier === "web.view")!;
    expect(webView.children.map((c) => c.role)).toEqual(
      expect.arrayContaining(["AXButton", "AXTextField", "AXLink", "AXPopUpButton"])
    );
    // The scroll view shows two rows; the library reports the hidden ones too.
    expect(walk(tree).find((n) => n.identifier === "appkit.scroll")!.scrollHidden).toBe(18);
    expect(flow.children.filter((n) => /^appkit\.row\./.test(n.identifier ?? ""))).toHaveLength(2);
  });

  it("hoists the open popup menu and drops the AppKit identifiers its items and rows share", () => {
    const text = JSON.stringify(raw);
    expect(text).toContain('"_popUpItemAction:"');
    // The menu's row views come back as identified views keyed by AppKit.
    expect(text).toContain('"NSTableViewRowViewKey"');
    const menu = tree.children.find((n) => n.role === "AXMenu")!;
    expect(menu.children.map((c) => [c.label, c.identifier])).toEqual([
      ["One", undefined],
      ["Two", undefined],
      ["Three", undefined],
    ]);
    expect(findAll(flow, { role: "menuitem", text: "Two" })).toHaveLength(1);
    expect(JSON.stringify(tree) + JSON.stringify(flow)).not.toMatch(
      /_popUpItemAction:|NSTableViewRowViewKey/
    );
  });
});
