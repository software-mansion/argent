import { describe, it, expect } from "vitest";
import { parseUiAutomatorDump } from "../src/tools/describe/platforms/android/uiautomator-parser";
import type { DescribeNode } from "../src/tools/describe/contract";
function flatten(tree: DescribeNode): DescribeNode[] {
  const out: DescribeNode[] = [];
  const stack: DescribeNode[] = [tree];
  while (stack.length) {
    const n = stack.pop()!;
    out.push(n);
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!);
  }
  return out;
}
describe("describe android collapse preserves label/identifier", () => {
  it("duplicate-wrapper collapse keeps the outer-only label", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8'?>\n<hierarchy>\n  <node class="android.view.ViewGroup" bounds="[0,0][100,100]" clickable="true" content-desc="Like, 5 likes">\n    <node class="android.widget.Button" bounds="[0,0][100,100]" clickable="true" content-desc="" text=""/>\n  </node>\n</hierarchy>`;
    const labels = flatten(parseUiAutomatorDump(xml, 100, 100))
      .map((n) => n.label)
      .filter(Boolean);
    expect(labels).toContain("Like, 5 likes");
  });
  it("bounds-less single-child wrapper keeps its own label", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8'?>\n<hierarchy>\n  <node class="android.view.View" content-desc="Profile photo">\n    <node class="android.widget.ImageView" bounds="[0,0][100,100]" content-desc="avatar"/>\n  </node>\n</hierarchy>`;
    const labels = flatten(parseUiAutomatorDump(xml, 100, 100))
      .map((n) => n.label)
      .filter(Boolean);
    expect(labels).toContain("Profile photo");
  });
  it("an id-bearing middle layout container does NOT block duplicate-wrapper collapse", () => {
    // A clickable parent, a non-clickable middle container, and a clickable
    // child at identical bounds must collapse to a SINGLE tap target — not
    // three stacked nodes with "Submit" repeated.
    const xml = `<?xml version='1.0' encoding='UTF-8'?>\n<hierarchy>\n  <node class="android.view.ViewGroup" bounds="[0,0][100,50]" clickable="true">\n    <node class="android.widget.FrameLayout" bounds="[0,0][100,50]" resource-id="com.app:id/wrap">\n      <node class="android.widget.Button" bounds="[0,0][100,50]" clickable="true" text="Submit"/>\n    </node>\n  </node>\n</hierarchy>`;
    const nodes = flatten(parseUiAutomatorDump(xml, 100, 50));
    const submits = nodes.filter((n) => n.label === "Submit");
    expect(submits).toHaveLength(1);
    expect(nodes.map((n) => n.role)).not.toContain("FrameLayout");
  });

  it("flattens nested id-bearing layout containers down to their content", () => {
    // Regression: nested id-only containers (android:id/content is on nearly
    // every dump) must not each survive as a wrapper level.
    const xml = `<?xml version='1.0' encoding='UTF-8'?>\n<hierarchy>\n  <node class="android.widget.FrameLayout" bounds="[0,0][100,200]" resource-id="android:id/content">\n    <node class="android.widget.LinearLayout" bounds="[0,0][100,200]" resource-id="com.app:id/root">\n      <node class="android.widget.TextView" bounds="[0,0][100,20]" text="A"/>\n      <node class="android.widget.TextView" bounds="[0,20][100,40]" text="B"/>\n    </node>\n  </node>\n</hierarchy>`;
    const nodes = flatten(parseUiAutomatorDump(xml, 100, 200));
    const roles = nodes.map((n) => n.role);
    expect(roles).not.toContain("FrameLayout");
    expect(roles).not.toContain("LinearLayout");
    expect(nodes.filter((n) => n.role === "StaticText")).toHaveLength(2);
  });

  it("duplicate-wrapper collapse must NOT leak an outer password field's value", () => {
    // Regression: the label fallback added to the duplicate-wrapper collapse
    // copies the outer node's label onto the surviving child. When the outer
    // node is a password field, that label is the secret — it must be redacted
    // to "[password]" first, never carried through raw. (Redaction happens at
    // the point the label is derived, so the collapse's early return can't
    // bypass it.)
    const xml = `<?xml version='1.0' encoding='UTF-8'?>\n<hierarchy>\n  <node class="android.widget.EditText" bounds="[0,0][100,100]" clickable="true" password="true" text="hunter2">\n    <node class="android.view.View" bounds="[0,0][100,100]" clickable="true" text=""/>\n  </node>\n</hierarchy>`;
    const nodes = flatten(parseUiAutomatorDump(xml, 100, 100));
    const strings = nodes.flatMap((n) =>
      [n.label, n.value, n.identifier].filter((s): s is string => !!s)
    );
    expect(strings.join(" | ")).not.toContain("hunter2");
    expect(nodes.map((n) => n.label).filter(Boolean)).toContain("[password]");
  });
});
