import { describe, it, expect } from "vitest";
import { parseDescribeResult } from "../src/tools/describe/contract";
import {
  deriveUiAutomatorRole,
  parseUiAutomatorBounds,
  parseUiAutomatorDump,
} from "../src/tools/describe/platforms/android/uiautomator-parser";

describe("parseUiAutomatorBounds", () => {
  it("parses [x1,y1][x2,y2]", () => {
    expect(parseUiAutomatorBounds("[0,0][1080,1920]")).toEqual({
      x: 0,
      y: 0,
      w: 1080,
      h: 1920,
    });
  });

  it("handles non-zero origins", () => {
    expect(parseUiAutomatorBounds("[100,200][400,800]")).toEqual({
      x: 100,
      y: 200,
      w: 300,
      h: 600,
    });
  });

  it("returns null for unparseable input", () => {
    expect(parseUiAutomatorBounds("garbage")).toBeNull();
  });
});

describe("deriveUiAutomatorRole", () => {
  const cases: Array<[string, string]> = [
    ["android.widget.Button", "Button"],
    ["android.widget.ImageButton", "Button"],
    ["android.widget.EditText", "TextField"],
    ["android.widget.TextView", "StaticText"],
    ["android.widget.ImageView", "Image"],
    ["android.widget.Switch", "Switch"],
    ["android.widget.CheckBox", "CheckBox"],
    ["android.widget.RadioButton", "RadioButton"],
    ["androidx.recyclerview.widget.RecyclerView", "ScrollView"],
    ["android.webkit.WebView", "WebView"],
    ["", "View"],
    ["com.example.CustomWidget", "CustomWidget"],
  ];
  for (const [input, expected] of cases) {
    it(`maps ${input || "(empty)"} → ${expected}`, () => {
      expect(deriveUiAutomatorRole(input)).toBe(expected);
    });
  }
});

describe("parseUiAutomatorDump", () => {
  const sampleXml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example.app" content-desc="" bounds="[0,0][1080,1920]">
    <node index="0" text="Sign in" resource-id="com.example.app:id/title" class="android.widget.TextView" package="com.example.app" content-desc="" bounds="[100,200][980,280]" />
    <node index="1" text="" resource-id="com.example.app:id/email" class="android.widget.EditText" package="com.example.app" content-desc="Email address" focusable="true" clickable="true" bounds="[100,400][980,500]" />
    <node index="2" text="Submit" resource-id="com.example.app:id/submit" class="android.widget.Button" package="com.example.app" content-desc="" clickable="true" bounds="[100,800][980,900]" />
  </node>
</hierarchy>`;

  // The v2 trim flattens layout-only wrappers (FrameLayout with no own
  // info) so the inner widgets surface directly under the Screen root —
  // tree.children = [TextView, EditText, Button]. The TextView/EditText/Button
  // path now lives at tree.children[0], not tree.children[0].children[0].

  it("returns a synthetic Screen root with full-screen frame", () => {
    const tree = parseUiAutomatorDump(sampleXml, 1080, 1920);
    expect(tree.role).toBe("Screen");
    expect(tree.frame).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    // FrameLayout passthrough → 3 leaf widgets surface as Screen children.
    expect(tree.children).toHaveLength(3);
  });

  it("normalizes pixel bounds to 0–1 using the provided screen size", () => {
    const tree = parseUiAutomatorDump(sampleXml, 1080, 1920);
    const title = tree.children[0]!;
    expect(title.label).toBe("Sign in");
    expect(title.frame.x).toBeCloseTo(100 / 1080, 3);
    expect(title.frame.y).toBeCloseTo(200 / 1920, 3);
    expect(title.frame.width).toBeCloseTo((980 - 100) / 1080, 3);
    expect(title.frame.height).toBeCloseTo((280 - 200) / 1920, 3);
  });

  it("maps class → role and populates label/identifier/value appropriately", () => {
    const tree = parseUiAutomatorDump(sampleXml, 1080, 1920);
    const [title, email, submit] = tree.children as [typeof tree, typeof tree, typeof tree];

    expect(title.role).toBe("StaticText");
    expect(title.label).toBe("Sign in");
    expect(title.identifier).toBe("com.example.app:id/title");

    expect(email.role).toBe("TextField");
    expect(email.label).toBe("Email address"); // content-desc wins over empty text
    expect(email.value).toBeUndefined();
    expect(email.clickable).toBe(true); // v2 surfaces interactivity flags

    expect(submit.role).toBe("Button");
    expect(submit.label).toBe("Submit"); // text is used when content-desc is empty
    expect(submit.clickable).toBe(true);
  });

  it("produces output matching the shared DescribeNode schema", () => {
    const tree = parseUiAutomatorDump(sampleXml, 1080, 1920);
    expect(() => parseDescribeResult(tree)).not.toThrow();
  });

  it("strips the trailing `UI hierchary dumped to:` status line from the raw dump", () => {
    const withTrailer = sampleXml + "\nUI hierchary dumped to: /dev/tty\n";
    const tree = parseUiAutomatorDump(withTrailer, 1080, 1920);
    // Same flattened shape as the trim-free run.
    expect(tree.children).toHaveLength(3);
  });

  it("drops every node when the screen size is zero (defensive)", () => {
    // The v2 trim treats screen size 0×0 as "nothing on screen", so every
    // node fails the visibility check and the tree empties out. Previous
    // behaviour was to surface a zero-area frame; the trim's invariant is
    // stronger and easier to reason about.
    const tree = parseUiAutomatorDump(sampleXml, 0, 0);
    expect(tree.children).toHaveLength(0);
  });
});
