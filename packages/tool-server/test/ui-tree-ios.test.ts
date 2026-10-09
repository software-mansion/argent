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

  it("puts the system app first and the app it covers second while an alert shows", () => {
    const tree = adaptAxTree(
      reply(
        [
          { index: 0, label: "SpringBoard", bundleId: "com.apple.springboard" },
          { index: 1, parentIndex: 0, label: "Allow", traits: ["button"] },
          { index: 2, label: "MyApp", bundleId: "com.example.app", covered: true },
          { index: 3, parentIndex: 2, label: "Login", covered: true },
        ],
        { alertVisible: true, foregroundApp: "com.example.app", treeVersion: 2 }
      )
    );
    expect(tree.alertVisible).toBe(true);
    expect(tree.foregroundApp).toBe("com.example.app");
    expect(tree.roots.map((r) => r.bundleId)).toEqual(["com.apple.springboard", "com.example.app"]);
    expect(tree.roots[0]!.children[0]!.covered).toBeUndefined();
    expect(tree.roots[1]!.children[0]!.covered).toBe(true);
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
    expect(on).toMatchObject({ role: "AXSwitch", checked: true });
    expect(off).toMatchObject({ role: "AXSwitch", checked: false });
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
    // An ax-service from before treeVersion 2.
    expect(tree.unsupportedFields).toEqual([
      "type",
      "password",
      "placeholder",
      "hintShowing",
      "bundleId",
      "foregroundApp",
      "interfaceOrientation",
    ]);
  });

  it("names the fields each treeVersion does not send", () => {
    const fields = (treeVersion?: number) =>
      adaptAxTree(reply([{ index: 0 }], { treeVersion })).unsupportedFields;
    const legacy = [
      "type",
      "password",
      "placeholder",
      "hintShowing",
      "bundleId",
      "foregroundApp",
      "interfaceOrientation",
    ];
    expect(fields(undefined)).toEqual(legacy);
    expect(fields(1)).toEqual(legacy);
    expect(fields(2)).toEqual(["interfaceOrientation"]);
    expect(fields(3)).toEqual([]);
    expect(fields(4)).toEqual([]);
  });

  it("reads the interface orientation as UIKit names it, and drops an unknown name", () => {
    const orientation = (interfaceOrientation?: string) =>
      adaptAxTree(reply([{ index: 0 }], { treeVersion: 3, interfaceOrientation }))
        .interfaceOrientation;
    expect(orientation("portrait")).toBe("portrait");
    expect(orientation("portraitUpsideDown")).toBe("portraitUpsideDown");
    expect(orientation("landscapeLeft")).toBe("landscapeLeft");
    expect(orientation("landscapeRight")).toBe("landscapeRight");
    // The daemon omits it when it does not know; a name UIKit does not use is not trusted.
    expect(orientation(undefined)).toBeUndefined();
    expect(orientation("faceUp")).toBeUndefined();
    expect(orientation("LandscapeRight")).toBeUndefined();
  });

  it("names the element type and reads secure, placeholder and hint fields", () => {
    const tree = adaptAxTree(
      reply(
        [
          {
            index: 0,
            elementType: 49,
            traits: ["textEntry"],
            value: "Email",
            placeholder: "Email",
            hintShowing: true,
          },
          // Typed text that equals the placeholder is still a value.
          {
            index: 1,
            elementType: 49,
            traits: ["textEntry"],
            value: "Email",
            placeholder: "Email",
          },
          {
            index: 2,
            elementType: 50,
            traits: ["textEntry", "secureTextEntry"],
            value: "•••",
            placeholder: "Password",
          },
          { index: 3, elementType: 52, traits: ["textEntry", "textView"], value: "notes" },
          { index: 4, elementType: 999 },
          { index: 5, elementType: 0 },
        ],
        { treeVersion: 2 }
      )
    );
    const [empty, typed, secure, textView, unknown, container] = tree.roots;
    expect(empty).toMatchObject({ type: "TextField", placeholder: "Email", hintShowing: true });
    expect(empty!.value).toBeUndefined();
    expect(typed).toMatchObject({ type: "TextField", placeholder: "Email", value: "Email" });
    expect(typed!.hintShowing).toBeUndefined();
    expect(secure).toMatchObject({ type: "SecureTextField", password: true, value: "•••" });
    expect(textView).toMatchObject({ type: "TextView", editable: true });
    expect(textView!.password).toBeUndefined();
    expect(unknown!.type).toBe("999");
    expect(container!.type).toBe("Other");
  });

  it("marks a node hidden when its frame is off screen or clipped by an ancestor", () => {
    const tree = adaptAxTree(
      reply([
        { index: 0, frame: { x: 0, y: 0, width: 1, height: 1 } },
        {
          index: 1,
          parentIndex: 0,
          label: "on",
          frame: { x: 0.1, y: 0.1, width: 0.5, height: 0.05 },
        },
        {
          index: 2,
          parentIndex: 0,
          label: "below",
          frame: { x: 0.1, y: 1.2, width: 0.5, height: 0.05 },
        },
        {
          index: 3,
          parentIndex: 0,
          label: "edge",
          frame: { x: 0.1, y: 0.98, width: 0.5, height: 0.05 },
        },
        {
          index: 4,
          parentIndex: 0,
          label: "scroll",
          frame: { x: 0, y: 0.3, width: 1, height: 0.2 },
        },
        {
          index: 5,
          parentIndex: 4,
          label: "row in",
          frame: { x: 0, y: 0.35, width: 1, height: 0.05 },
        },
        {
          index: 6,
          parentIndex: 4,
          label: "row clipped",
          frame: { x: 0, y: 0.6, width: 1, height: 0.05 },
        },
        // A frameless container passes its parent's clip down.
        { index: 7, parentIndex: 6, label: "group" },
        {
          index: 8,
          parentIndex: 7,
          label: "inside clipped",
          frame: { x: 0, y: 0.6, width: 1, height: 0.05 },
        },
      ])
    );
    const hidden: string[] = [];
    const walk = (n: (typeof tree.roots)[number]) => {
      if (n.hidden) hidden.push(n.label ?? "");
      n.children.forEach(walk);
    };
    tree.roots.forEach(walk);
    expect(hidden).toEqual(["below", "row clipped", "inside clipped"]);
  });
});
