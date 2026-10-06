import { describe, it, expect } from "vitest";
import { adaptAndroidTree } from "../src/tools/ui-tree/android";

const SCREEN = { width: 1000, height: 2000 };

function node(attrs: Record<string, string>, children = ""): string {
  const raw = Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
  return children ? `<node ${raw}>${children}</node>` : `<node ${raw} />`;
}

function dump(...windows: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0">${windows.join("")}</hierarchy>`;
}

describe("ui-tree Android adapter", () => {
  it("maps each window to a root, in dump order, with its package", () => {
    const tree = adaptAndroidTree(
      dump(
        node({ class: "android.widget.FrameLayout", package: "com.android.systemui" }),
        node(
          {
            class: "android.widget.FrameLayout",
            package: "com.example",
            bounds: "[0,0][1000,2000]",
          },
          node({
            class: "android.widget.Button",
            package: "com.example",
            text: "Go",
            bounds: "[-100,1900][500,2100]",
          })
        )
      ),
      true,
      SCREEN
    );
    expect(tree.truncated).toBe(true);
    expect(tree.roots.map((r) => r.bundleId)).toEqual(["com.android.systemui", "com.example"]);
    const button = tree.roots[1]!.children[0]!;
    expect(button).toMatchObject({ role: "Button", type: "android.widget.Button", label: "Go" });
    expect(button.frame).toEqual({ x: -0.1, y: 0.95, width: 0.6, height: 0.1 });
  });

  it("keeps text and content-desc apart, and gives value only to editable nodes", () => {
    const tree = adaptAndroidTree(
      dump(
        node(
          { class: "android.widget.FrameLayout" },
          node({ class: "android.widget.TextView", text: "Hello" }) +
            node({ "class": "android.widget.ImageView", "content-desc": "Logo" }) +
            node({ "class": "android.widget.EditText", "text": "x@y.z", "content-desc": "Email" })
        )
      ),
      false,
      SCREEN
    );
    const [text, image, field] = tree.roots[0]!.children;
    expect(text).toMatchObject({ label: "Hello" });
    expect(text!.value).toBeUndefined();
    expect(image).toMatchObject({ label: "Logo", contentDescription: "Logo" });
    expect(field).toMatchObject({
      label: "x@y.z",
      value: "x@y.z",
      contentDescription: "Email",
      editable: true,
    });
  });

  it("never reads a password field's text", () => {
    const tree = adaptAndroidTree(
      dump(node({ class: "android.widget.EditText", password: "true", text: "hunter2" })),
      false,
      SCREEN
    );
    expect(tree.roots[0]).toMatchObject({ password: true, editable: true });
    expect(JSON.stringify(tree)).not.toContain("hunter2");
  });

  it("sets checked only on checkable nodes, and maps the other states", () => {
    const tree = adaptAndroidTree(
      dump(
        node({ class: "android.widget.Switch", checkable: "true", checked: "false" }) +
          node({ class: "android.widget.CheckBox", checkable: "true", checked: "true" }) +
          node({
            class: "android.widget.Button",
            checked: "true",
            enabled: "false",
            selected: "true",
            focused: "true",
          })
      ),
      false,
      SCREEN
    );
    const [off, on, button] = tree.roots;
    expect(off!.checked).toBe(false);
    expect(on!.checked).toBe(true);
    expect(button!.checked).toBeUndefined();
    expect(button).toMatchObject({ disabled: true, selected: true, focused: true });
  });

  it("marks EditText subclasses editable, but not the TextInputLayout wrapper", () => {
    const tree = adaptAndroidTree(
      dump(
        node({ class: "com.google.android.material.textfield.TextInputLayout" }) +
          node({ class: "com.google.android.material.textfield.TextInputEditText" }) +
          node({ class: "android.widget.AutoCompleteTextView" })
      ),
      false,
      SCREEN
    );
    expect(tree.roots.map((r) => r.editable)).toEqual([undefined, true, true]);
  });

  it("names what it cannot report", () => {
    const tree = adaptAndroidTree(dump(), false, SCREEN);
    expect(tree.keyboardVisible).toBeUndefined();
    expect(tree.unsupportedFields).toEqual([
      "placeholder",
      "hintShowing",
      "hidden",
      "heading",
      "keyboardVisible",
      "foregroundApp",
    ]);
  });
});
