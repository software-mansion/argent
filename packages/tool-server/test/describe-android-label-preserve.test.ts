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
  it("decorative ImageView collapse keeps its resource-id even with no label", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8'?>\n<hierarchy>\n  <node class="android.widget.ImageView" bounds="[0,0][50,50]" resource-id="com.app:id/decorative_icon"/>\n</hierarchy>`;
    const identifiers = flatten(parseUiAutomatorDump(xml, 100, 100))
      .map((n) => n.identifier)
      .filter(Boolean);
    expect(identifiers).toContain("com.app:id/decorative_icon");
  });
  it("layout-container collapse keeps its resource-id even with no label", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8'?>\n<hierarchy>\n  <node class="android.widget.FrameLayout" bounds="[0,0][100,100]" resource-id="com.app:id/header_container">\n    <node class="android.widget.TextView" bounds="[0,0][100,100]" text="Hello"/>\n  </node>\n</hierarchy>`;
    const tree = parseUiAutomatorDump(xml, 100, 100);
    const identifiers = flatten(tree)
      .map((n) => n.identifier)
      .filter(Boolean);
    const labels = flatten(tree)
      .map((n) => n.label)
      .filter(Boolean);
    expect(identifiers).toContain("com.app:id/header_container");
    expect(labels).toContain("Hello");
  });
});
