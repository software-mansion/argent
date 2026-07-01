import { describe, it, expect } from "vitest";
import { adaptFullAndroidHierarchyToDescribeResult } from "../../src/tools/flows/flow-android-tree";
import { parseUiAutomatorDump } from "../../src/tools/describe/platforms/android/uiautomator-parser";
import { findAll, selectorToFrame, matchNode } from "../../src/utils/ui-tree-match";
import type { DescribeNode } from "../../src/tools/describe/contract";

const SCREEN_W = 1080;
const SCREEN_H = 1920;

// A React Native screen dumped with FLAG_INCLUDE_NOT_IMPORTANT_VIEWS: the
// `submit-button` testID lives on a plain, non-interactive layout container
// (the pattern the interactables trim discards), and its tappable child carries
// no id of its own. There is a status-bar system-chrome node, an off-screen
// row, and a password field.
const RN_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.view.View" resource-id="com.android.systemui:id/status_bar" package="com.android.systemui" bounds="[0,0][1080,60]" />
    <node index="1" class="android.view.ViewGroup" resource-id="submit-button" package="com.acme.app" clickable="false" bounds="[40,1700][1040,1800]">
      <node index="0" class="android.widget.TextView" text="Submit" package="com.acme.app" bounds="[440,1730][640,1770]" />
    </node>
    <node index="2" class="android.widget.EditText" resource-id="password" package="com.acme.app" password="true" text="hunter2" bounds="[40,400][1040,480]" />
    <node index="3" class="android.view.ViewGroup" resource-id="offscreen-row" package="com.acme.app" bounds="[0,2000][1080,2100]" />
  </node>
</hierarchy>`;

function ids(tree: DescribeNode): string[] {
  const out: string[] = [];
  const walk = (n: DescribeNode) => {
    if (n.identifier) out.push(n.identifier);
    n.children.forEach(walk);
  };
  walk(tree);
  return out;
}

describe("adaptFullAndroidHierarchyToDescribeResult", () => {
  it("keeps a testID on a non-interactive container the trim would drop", () => {
    // Baseline: the agent-facing interactables trim discards the unlabelled,
    // non-clickable `submit-button` container — it is unresolvable by identifier.
    const trimmed = parseUiAutomatorDump(RN_XML, SCREEN_W, SCREEN_H);
    expect(findAll(trimmed, { identifier: "submit-button" })).toHaveLength(0);

    // Flow adapter: the same container is preserved and resolvable.
    const tree = adaptFullAndroidHierarchyToDescribeResult(RN_XML, SCREEN_W, SCREEN_H);
    const matches = findAll(tree, { identifier: "submit-button" });
    expect(matches).toHaveLength(1);

    const frame = selectorToFrame(tree, { identifier: "submit-button" });
    expect(frame).not.toBeNull();
    // Normalized bounds [40,1700][1040,1800] on a 1080x1920 screen.
    expect(frame!.x).toBeCloseTo(40 / 1080, 5);
    expect(frame!.y).toBeCloseTo(1700 / 1920, 5);
    expect(frame!.width).toBeCloseTo(1000 / 1080, 5);
  });

  it("drops system chrome", () => {
    const tree = adaptFullAndroidHierarchyToDescribeResult(RN_XML, SCREEN_W, SCREEN_H);
    expect(ids(tree)).not.toContain("com.android.systemui:id/status_bar");
  });

  it("drops off-screen views (clipped to zero area)", () => {
    const tree = adaptFullAndroidHierarchyToDescribeResult(RN_XML, SCREEN_W, SCREEN_H);
    expect(findAll(tree, { identifier: "offscreen-row" })).toHaveLength(0);
  });

  it("never leaks a password field's text as its value", () => {
    const tree = adaptFullAndroidHierarchyToDescribeResult(RN_XML, SCREEN_W, SCREEN_H);
    const pw = findAll(tree, { identifier: "password" });
    expect(pw).toHaveLength(1);
    expect(pw[0]!.value).toBeUndefined();
    expect(pw[0]!.password).toBe(true);
    expect(JSON.stringify(tree)).not.toContain("hunter2");
  });

  it("surfaces a testID as an identifier match, not a text match", () => {
    const tree = adaptFullAndroidHierarchyToDescribeResult(RN_XML, SCREEN_W, SCREEN_H);
    const [submit] = findAll(tree, { identifier: "submit-button" });
    expect(submit).toBeDefined();
    // Loose selectors match identifier first; confirm the node is addressable
    // by id even though its own label is empty (the label lives on the child).
    expect(matchNode(submit!, { identifier: "submit-button" })).toBe(true);
  });

  it("returns an empty screen tree for a bogus screen size", () => {
    const tree = adaptFullAndroidHierarchyToDescribeResult(RN_XML, 0, 0);
    expect(tree.children).toHaveLength(0);
  });
});
