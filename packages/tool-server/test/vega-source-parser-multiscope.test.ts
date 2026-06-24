import { describe, it, expect } from "vitest";
import { parseVegaPageSource } from "../src/tools/describe/platforms/vega/source-parser";
import type { DescribeNode } from "../src/tools/describe/contract";

function flatten(n: DescribeNode): DescribeNode[] {
  return [n, ...n.children.flatMap(flatten)];
}
function byLabel(root: DescribeNode, label: string): DescribeNode | undefined {
  return flatten(root).find((n) => n.label === label);
}

// Split-screen / PiP: two non-launcher foreground apps with DIFFERENT window sizes.
// Each app's frames must be normalized against its own <window>, not the first app's.
const XML = `
<root>
  <app appName="com.first">
    <window x="0" y="0" width="200" height="200">
      <view role="button" focusable="true" x="50" y="50" width="100" height="100"><text>First</text></view>
    </window>
  </app>
  <app appName="com.second">
    <window x="0" y="0" width="1920" height="1080">
      <view role="button" focusable="true" x="860" y="490" width="200" height="100"><text>Second</text></view>
    </window>
  </app>
</root>`;

describe("parseVegaPageSource multi-scope normalization", () => {
  const root = parseVegaPageSource(XML);
  const first = byLabel(root, "First")!;
  const second = byLabel(root, "Second")!;

  it("normalizes the first app against its own 200x200 window", () => {
    expect(first).toBeDefined();
    expect(first.frame.x).toBeCloseTo(50 / 200, 2);
    expect(first.frame.width).toBeCloseTo(100 / 200, 2);
  });

  it("normalizes the second app against its own 1920x1080 window, not the first's", () => {
    // Buggy behavior: normalized against the first app's 200x200 window, so the
    // second app's button clamps to x:1, width:0 — a visible control reported
    // off-screen / untappable.
    expect(second).toBeDefined();
    expect(second.frame.width).toBeGreaterThan(0.05);
    expect(second.frame.x).toBeCloseTo(860 / 1920, 2);
    expect(second.frame.width).toBeCloseTo(200 / 1920, 2);
  });
});
