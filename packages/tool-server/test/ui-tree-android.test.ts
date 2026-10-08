import { describe, it, expect } from "vitest";
import { adaptAndroidTree, type AndroidTreeCapture } from "../src/tools/ui-tree/android";

const SCREEN = { width: 1000, height: 2000 };

function node(attrs: Record<string, string>, children = ""): string {
  const raw = Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
  return children ? `<node ${raw}>${children}</node>` : `<node ${raw} />`;
}

function adapt(
  xml: string,
  truncated: boolean,
  screen = SCREEN,
  helper: Partial<AndroidTreeCapture> = {}
) {
  return adaptAndroidTree({ xml, truncated, ...helper }, screen);
}

// A helper at treeVersion 2 on a current API level, listing windows.
const V2 = { treeVersion: 2, sdkInt: 36, captureMode: "interactive-windows" };

function dump(...windows: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0">${windows.join("")}</hierarchy>`;
}

describe("ui-tree Android adapter", () => {
  it("maps each window to a root, in dump order, with its package", () => {
    const tree = adapt(
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
    const tree = adapt(
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
    const tree = adapt(
      dump(node({ class: "android.widget.EditText", password: "true", text: "hunter2" })),
      false,
      SCREEN
    );
    expect(tree.roots[0]).toMatchObject({ password: true, editable: true });
    expect(JSON.stringify(tree)).not.toContain("hunter2");
  });

  it("sets checked only on checkable nodes, and maps the other states", () => {
    const tree = adapt(
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
    const tree = adapt(
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
    const tree = adapt(dump(), false, SCREEN);
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

  it("reads the v2 attributes", () => {
    const tree = adapt(
      dump(
        node(
          { "class": "android.widget.FrameLayout", "window-type": "1", "package": "com.example" },
          node({
            "class": "android.widget.EditText",
            "text": "Email",
            "hint": "Email",
            "showing-hint": "true",
            "editable": "true",
          }) +
            node({ class: "android.widget.EditText", text: "x", hint: "Name", editable: "true" }) +
            node({
              "class": "android.widget.EditText",
              "text": "PIN",
              "hint": "PIN",
              "showing-hint": "true",
              "password": "true",
              "editable": "true",
              "content-desc": "pin",
            }) +
            node({ class: "android.widget.TextView", text: "Title", heading: "true" }) +
            node({
              "class": "android.widget.TextView",
              "text": "Row 9",
              "visible-to-user": "false",
            }) +
            node({ class: "android.view.View", text: "Clipped", bounds: "[0,500][1000,500]" })
        )
      ),
      false,
      SCREEN,
      V2
    );
    const [empty, filled, pin, title, row, clipped] = tree.roots[0]!.children;
    expect(empty).toMatchObject({ placeholder: "Email", hintShowing: true, editable: true });
    expect(empty!.label).toBeUndefined();
    expect(empty!.value).toBeUndefined();
    expect(filled).toMatchObject({ label: "x", value: "x", placeholder: "Name" });
    expect(filled!.hintShowing).toBeUndefined();
    expect(pin).toMatchObject({ label: "pin", placeholder: "PIN", password: true });
    expect(pin!.value).toBeUndefined();
    expect(title).toMatchObject({ heading: true });
    expect(title!.hidden).toBeUndefined();
    expect(row).toMatchObject({ hidden: true });
    expect(clipped).toMatchObject({ hidden: true });
    expect(tree.unsupportedFields).toEqual([]);
  });

  it("takes editable from the helper, and keeps a disabled field a text input", () => {
    const tree = adapt(
      dump(
        node({ class: "com.google.android.material.textfield.TextInputEditText" }) +
          node({ class: "android.widget.TextView", editable: "true" }) +
          node({ class: "android.widget.EditText", enabled: "false", text: "kept" })
      ),
      false,
      SCREEN,
      V2
    );
    const [noFlag, custom, disabled] = tree.roots;
    expect(noFlag!.editable).toBeUndefined();
    expect(custom!.editable).toBe(true);
    expect(disabled).toMatchObject({ editable: true, disabled: true, value: "kept" });
  });

  it("finds the keyboard and the foreground app from window types", () => {
    const win = (type: string, pkg: string, bounds = "[0,0][1000,2000]") =>
      node({ "class": "android.widget.FrameLayout", "window-type": type, "package": pkg, bounds });
    const tree = adapt(
      dump(
        win("2", "com.android.inputmethod"),
        win("3", "com.android.systemui"),
        win("1", "com.example"),
        win("1", "com.android.launcher")
      ),
      false,
      SCREEN,
      V2
    );
    expect(tree).toMatchObject({
      keyboardVisible: true,
      foregroundApp: "com.example",
      alertVisible: false,
    });
    expect(tree.roots[2]!.covered).toBeUndefined();

    const hiddenIme = adapt(
      dump(win("2", "com.android.inputmethod", "[0,2000][1000,2000]"), win("1", "com.example")),
      false,
      SCREEN,
      V2
    );
    expect(hiddenIme.keyboardVisible).toBe(false);
    expect(adapt(dump(win("1", "com.example")), true, SCREEN, V2).keyboardVisible).toBeUndefined();
    const slidingOut = adapt(
      dump(win("2", "com.android.inputmethod", "[0,2000][1000,2600]"), win("1", "com.example")),
      false,
      SCREEN,
      V2
    );
    expect(slidingOut.keyboardVisible).toBe(false);
    const noPackage = adapt(
      dump(node({ "window-type": "1" }), win("1", "com.example")),
      false,
      SCREEN,
      V2
    );
    expect(noPackage.foregroundApp).toBe("com.example");
    const cut = adapt(dump(win("3", "com.android.systemui")), true, SCREEN, V2);
    expect(cut.alertVisible).toBeUndefined();
    expect(cut.foregroundApp).toBeUndefined();
  });

  it("reports the app under a permission dialog, covered", () => {
    const tree = adapt(
      dump(
        node(
          {
            "class": "android.widget.FrameLayout",
            "window-type": "1",
            "package": "com.google.android.permissioncontroller",
          },
          node({ class: "android.widget.Button", text: "Allow" })
        ),
        node(
          { "class": "android.widget.FrameLayout", "window-type": "1", "package": "com.example" },
          node({ class: "android.widget.Button", text: "Go" })
        )
      ),
      false,
      SCREEN,
      V2
    );
    expect(tree).toMatchObject({ alertVisible: true, foregroundApp: "com.example" });
    expect(tree.roots[0]!.children[0]!.covered).toBeUndefined();
    expect(tree.roots[1]!.children[0]!.covered).toBe(true);

    const alone = adapt(
      dump(node({ "window-type": "1", "package": "com.android.packageinstaller" })),
      false,
      SCREEN,
      V2
    );
    expect(alone.alertVisible).toBe(true);
    expect(alone.foregroundApp).toBeUndefined();

    // The permission settings page is a full-screen activity, not a dialog.
    const page = adapt(
      dump(
        node({
          "window-type": "1",
          "package": "com.google.android.permissioncontroller",
          "bounds": "[0,0][1000,2000]",
        })
      ),
      false,
      SCREEN,
      V2
    );
    expect(page).toMatchObject({
      alertVisible: false,
      foregroundApp: "com.google.android.permissioncontroller",
    });

    // A crash dialog is a system window from the system server.
    const crash = adapt(
      dump(
        node({ "window-type": "3", "package": "android", "bounds": "[28,907][972,1446]" }),
        node({ "window-type": "1", "package": "com.example", "bounds": "[0,0][1000,2000]" })
      ),
      false,
      SCREEN,
      V2
    );
    expect(crash).toMatchObject({ alertVisible: true, foregroundApp: "com.example" });
  });

  it("lists what an old API level or the active-window fallback cannot report", () => {
    expect(adapt(dump(), false, SCREEN, { ...V2, sdkInt: 25 }).unsupportedFields).toEqual([
      "placeholder",
      "hintShowing",
      "heading",
    ]);
    expect(adapt(dump(), false, SCREEN, { ...V2, sdkInt: 27 }).unsupportedFields).toEqual([
      "heading",
    ]);
    const fallback = adapt(dump(node({ package: "com.example" })), false, SCREEN, {
      ...V2,
      captureMode: "active-window",
    });
    expect(fallback.unsupportedFields).toEqual([
      "keyboardVisible",
      "foregroundApp",
      "alertVisible",
    ]);
    expect(fallback.keyboardVisible).toBeUndefined();
    expect(fallback.foregroundApp).toBeUndefined();
  });
});
