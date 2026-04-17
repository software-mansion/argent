import { describe, it, expect } from "vitest";
import { parseDescribeResult } from "../src/tools/interactions/describe-contract";
import {
  deriveUiAutomatorRole,
  parseUiAutomatorBounds,
  parseUiAutomatorDump,
} from "../src/utils/uiautomator-parser";

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
    <node index="1" text="" resource-id="com.example.app:id/email" class="android.widget.EditText" package="com.example.app" content-desc="Email address" bounds="[100,400][980,500]" />
    <node index="2" text="Submit" resource-id="com.example.app:id/submit" class="android.widget.Button" package="com.example.app" content-desc="" bounds="[100,800][980,900]" />
  </node>
</hierarchy>`;

  it("returns a synthetic Screen root with full-screen frame", () => {
    const tree = parseUiAutomatorDump(sampleXml, 1080, 1920);
    expect(tree.role).toBe("Screen");
    expect(tree.frame).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(tree.children).toHaveLength(1); // FrameLayout root
  });

  it("normalizes pixel bounds to 0–1 using the provided screen size", () => {
    const tree = parseUiAutomatorDump(sampleXml, 1080, 1920);
    // Dive into the FrameLayout → first child (the TextView with "Sign in")
    const frame = tree.children[0]!.children[0]!.frame;
    expect(frame.x).toBeCloseTo(100 / 1080, 3);
    expect(frame.y).toBeCloseTo(200 / 1920, 3);
    expect(frame.width).toBeCloseTo((980 - 100) / 1080, 3);
    expect(frame.height).toBeCloseTo((280 - 200) / 1920, 3);
  });

  it("maps class → role and populates label/identifier/value appropriately", () => {
    const tree = parseUiAutomatorDump(sampleXml, 1080, 1920);
    const children = tree.children[0]!.children;
    const title = children[0]!;
    const email = children[1]!;
    const submit = children[2]!;

    expect(title.role).toBe("StaticText");
    expect(title.label).toBe("Sign in");
    expect(title.identifier).toBe("com.example.app:id/title");

    expect(email.role).toBe("TextField");
    expect(email.label).toBe("Email address"); // content-desc wins over empty text
    expect(email.value).toBeUndefined();

    expect(submit.role).toBe("Button");
    expect(submit.label).toBe("Submit"); // text is used when content-desc is empty
  });

  it("produces output matching the shared DescribeNode schema", () => {
    const tree = parseUiAutomatorDump(sampleXml, 1080, 1920);
    expect(() => parseDescribeResult(tree)).not.toThrow();
  });

  it("strips the trailing `UI hierchary dumped to:` status line from the raw dump", () => {
    const withTrailer = sampleXml + "\nUI hierchary dumped to: /dev/tty\n";
    const tree = parseUiAutomatorDump(withTrailer, 1080, 1920);
    expect(tree.children).toHaveLength(1);
  });

  it("returns a zero-frame value when the screen size is zero (defensive)", () => {
    const tree = parseUiAutomatorDump(sampleXml, 0, 0);
    expect(tree.children[0]!.frame).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});
