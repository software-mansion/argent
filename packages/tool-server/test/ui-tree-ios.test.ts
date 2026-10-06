import { describe, it, expect } from "vitest";
import type { AXTreeNode, AXTreeResponse } from "../src/blueprints/ax-service";
import { adaptAxTree } from "../src/tools/ui-tree/ios";

function reply(nodes: AXTreeNode[], extra: Partial<AXTreeResponse> = {}): AXTreeResponse {
  return {
    alertVisible: false,
    screenFrame: { width: 402, height: 874 },
    nodes,
    truncated: false,
    ...extra,
  };
}

describe("ui-tree iOS adapter", () => {
  it("nests nodes by parentIndex and keeps document order", () => {
    const tree = adaptAxTree(
      reply([
        { index: 0, label: "Settings" },
        { index: 1, parentIndex: 0, roleDescription: "tab bar" },
        { index: 2, parentIndex: 1, label: "General", traits: ["button"] },
        { index: 3, parentIndex: 0, label: "Title", traits: ["header"] },
        // Its parent is missing, so it becomes a root.
        { index: 5, parentIndex: 4, label: "orphan" },
      ])
    );
    expect(tree.roots.map((r) => r.label)).toEqual(["Settings", "orphan"]);
    const [app] = tree.roots;
    expect(app!.children.map((c) => c.roleDescription ?? c.label)).toEqual(["tab bar", "Title"]);
    expect(app!.children[0]!.children[0]).toMatchObject({
      role: "AXButton",
      label: "General",
      traits: ["button"],
    });
    expect(app!.children[1]).toMatchObject({ role: "AXHeading", heading: true });
    expect(tree.screen).toEqual({ width: 402, height: 874 });
  });

  it("puts the system app second while an alert shows", () => {
    const tree = adaptAxTree(
      reply(
        [
          { index: 0, label: "MyApp" },
          { index: 1, parentIndex: 0, label: "Login", covered: true },
          { index: 2, label: "SpringBoard" },
          { index: 3, parentIndex: 2, label: "Allow", traits: ["button"] },
        ],
        { alertVisible: true }
      )
    );
    expect(tree.alertVisible).toBe(true);
    expect(tree.roots.map((r) => r.label)).toEqual(["MyApp", "SpringBoard"]);
    expect(tree.roots[0]!.children[0]!.covered).toBe(true);
  });

  it("derives states from traits", () => {
    const tree = adaptAxTree(
      reply([
        { index: 0, traits: ["button", "notEnabled", "selected"] },
        { index: 1, traits: ["textEntry", "isEditing"], value: "a@b.c" },
        { index: 2, traits: ["searchField"] },
        { index: 3, traits: ["toggleButton"], value: "1" },
        { index: 4, traits: ["toggleButton"], value: "0" },
        { index: 5, traits: ["toggleButton"], value: "mixed" },
        { index: 6, label: "Plain", frame: { x: -0.5, y: 0.1, width: 2, height: 0.1 } },
      ])
    );
    const [button, field, search, on, off, mixed, plain] = tree.roots;
    expect(button).toMatchObject({ disabled: true, selected: true });
    expect(field).toMatchObject({ editable: true, focused: true, value: "a@b.c" });
    expect(field!.password).toBeUndefined();
    expect(search!.editable).toBe(true);
    expect(on!.checked).toBe(true);
    expect(off!.checked).toBe(false);
    expect(mixed!.checked).toBeUndefined();
    // Not clamped.
    expect(plain!.frame).toEqual({ x: -0.5, y: 0.1, width: 2, height: 0.1 });
    expect(plain!.disabled).toBeUndefined();
    expect(plain!.editable).toBeUndefined();
  });

  it("reports the keyboard and truncation, and names what it cannot report", () => {
    expect(adaptAxTree(reply([{ index: 0 }])).keyboardVisible).toBe(false);
    expect(adaptAxTree(reply([{ index: 0 }], { truncated: true })).keyboardVisible).toBeUndefined();
    const tree = adaptAxTree(reply([{ index: 0, traits: ["keyboardKey"] }], { truncated: true }));
    expect(tree).toMatchObject({
      schemaVersion: 1,
      source: "ax-service",
      truncated: true,
      keyboardVisible: true,
    });
    expect(tree.unsupportedFields).toEqual([
      "type",
      "password",
      "placeholder",
      "hintShowing",
      "hidden",
      "foregroundApp",
    ]);
  });
});
