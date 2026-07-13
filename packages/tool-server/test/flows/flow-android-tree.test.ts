import { describe, it, expect } from "vitest";
import { adaptFullAndroidHierarchyToDescribeResult } from "../../src/tools/flows/flow-android-tree";
import { parseUiAutomatorDump } from "../../src/tools/describe/platforms/android/uiautomator-parser";
import {
  assertText,
  evaluateCondition,
  findAll,
  selectorToFrame,
  matchNode,
} from "../../src/utils/ui-tree-match";
import type { DescribeNode } from "../../src/tools/describe/contract";

const SCREEN_W = 1080;
const SCREEN_H = 1920;

// A React Native screen as the android-devtools helper dumps it: the
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

  it("keeps unlabelled mapped and fallback controls selectable by role", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.Button" package="com.acme.app" bounds="[40,200][400,280]" />
    <node index="1" class="android.widget.SeekBar" package="com.acme.app" bounds="[40,300][1040,380]" />
    <node index="2" class="android.view.View" package="com.acme.app" bounds="[40,400][400,480]" />
    <node index="3" class="com.horcrux.svg.PathView" package="com.acme.app" bounds="[40,500][400,580]">
      <node index="0" class="android.widget.Button" package="com.acme.app" bounds="[40,500][400,580]" />
    </node>
  </node>
</hierarchy>`;
    const tree = adaptFullAndroidHierarchyToDescribeResult(xml, SCREEN_W, SCREEN_H);

    expect(findAll(tree, { role: "Button" })).toHaveLength(1);
    expect(findAll(tree, { role: "SeekBar" })).toHaveLength(1);
    expect(findAll(tree, { role: "PathView" })).toHaveLength(0);
    // Neither layout scaffolding nor the noisy SVG subtree is retained.
    expect(tree.children).toHaveLength(2);
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

  it("hoists a testID container's child text into subtreeText", () => {
    // `submit-button` carries no text of its own — its label lives on the child
    // TextView. The hoist lets a `text` assert against the container read it.
    const tree = adaptFullAndroidHierarchyToDescribeResult(RN_XML, SCREEN_W, SCREEN_H);
    const [submit] = findAll(tree, { identifier: "submit-button" });
    expect(submit!.label).toBeUndefined();
    expect(submit!.subtreeText).toBe("Submit");
    expect(
      evaluateCondition("text", "Submit", findAll(tree, { identifier: "submit-button" }))
    ).toBe(true);
  });

  // A labelled container whose child renders the same text (an accessible
  // button with content-desc "Submit" over a TextView "Submit") must not hoist
  // the duplicate — "Submit Submit" would fail an `equals` assert against
  // exactly what the screen shows.
  it("does not duplicate a container's own label that its child also renders", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.view.ViewGroup" resource-id="submit-button" content-desc="Submit" package="com.acme.app" bounds="[40,1700][1040,1800]">
      <node index="0" class="android.widget.TextView" text="Submit" package="com.acme.app" bounds="[440,1730][640,1770]" />
    </node>
  </node>
</hierarchy>`;
    const tree = adaptFullAndroidHierarchyToDescribeResult(xml, SCREEN_W, SCREEN_H);
    const submit = findAll(tree, { identifier: "submit-button" });

    // The child text adds nothing over the own label, so nothing is stamped
    // and the assert reads the node's own "Submit" — not "Submit Submit".
    expect(submit[0]!.subtreeText).toBeUndefined();
    expect(assertText(submit[0]!)).toBe("Submit");
    expect(evaluateCondition("text", "Submit", submit, "equals")).toBe(true);
  });

  // ...but an additive own label (a slider named "Volume" whose child shows the
  // value "50%") still composes with the descendant text.
  it("keeps an additive own label alongside hoisted child text", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.view.ViewGroup" resource-id="volume" content-desc="Volume" package="com.acme.app" bounds="[40,400][1040,500]">
      <node index="0" class="android.widget.TextView" text="50%" package="com.acme.app" bounds="[900,420][1020,480]" />
    </node>
  </node>
</hierarchy>`;
    const tree = adaptFullAndroidHierarchyToDescribeResult(xml, SCREEN_W, SCREEN_H);
    const volume = findAll(tree, { identifier: "volume" });

    expect(volume[0]!.subtreeText).toBe("Volume 50%");
    expect(evaluateCondition("text", "50%", volume)).toBe(true);
  });

  // Partial overlap: a container labelled "Submit" over a child rendering
  // "Submit now" hoists the child's fuller text once, not "Submit Submit now".
  it("drops an own label the child text already contains", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.view.ViewGroup" resource-id="submit-button" content-desc="Submit" package="com.acme.app" bounds="[40,1700][1040,1800]">
      <node index="0" class="android.widget.TextView" text="Submit now" package="com.acme.app" bounds="[340,1730][740,1770]" />
    </node>
  </node>
</hierarchy>`;
    const tree = adaptFullAndroidHierarchyToDescribeResult(xml, SCREEN_W, SCREEN_H);
    const submit = findAll(tree, { identifier: "submit-button" });

    expect(assertText(submit[0]!)).toBe("Submit now");
    expect(evaluateCondition("text", "Submit now", submit, "equals")).toBe(true);
    expect(evaluateCondition("text", "Submit", submit, "equals")).toBe(false);
    expect(evaluateCondition("text", "Submit", submit, "contains")).toBe(true);
  });

  // Visibility: text hoists only from on-screen nodes. A row dumped with
  // bounds past the screen edge clips to zero area — its text must not satisfy
  // a `text` assert against the scroll container.
  it("does not hoist text from off-screen descendants", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.ScrollView" resource-id="feed" package="com.acme.app" bounds="[0,0][1080,1920]">
      <node index="0" class="android.widget.TextView" text="Row 1" package="com.acme.app" bounds="[0,100][1080,200]" />
      <node index="1" class="android.widget.TextView" text="Row 50" package="com.acme.app" bounds="[0,1920][1080,2020]" />
    </node>
  </node>
</hierarchy>`;
    const tree = adaptFullAndroidHierarchyToDescribeResult(xml, SCREEN_W, SCREEN_H);
    const feed = findAll(tree, { identifier: "feed" });

    // The visible row still hoists; the off-screen one does not.
    expect(feed[0]!.subtreeText).toBe("Row 1");
    expect(evaluateCondition("text", "Row 1", feed)).toBe(true);
    expect(evaluateCondition("text", "Row 50", feed)).toBe(false);
  });

  it("never hoists a password field's text (placeholder only)", () => {
    const tree = adaptFullAndroidHierarchyToDescribeResult(RN_XML, SCREEN_W, SCREEN_H);
    const [pw] = findAll(tree, { identifier: "password" });
    // subtreeText, if set at all, must not carry the secret.
    expect(pw!.subtreeText ?? "").not.toContain("hunter2");
    expect(JSON.stringify(tree)).not.toContain("hunter2");
  });

  // The type directive's focus wait reads `focused` off the tree — the mapping
  // must survive the flatten, including for an anonymous input (no
  // resource-id, no text) that would otherwise not be leaf-eligible.
  it("surfaces input focus, even on an anonymous view", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.EditText" resource-id="email" focused="false" package="com.acme.app" bounds="[40,200][1040,280]" />
    <node index="1" class="android.widget.EditText" focused="true" package="com.acme.app" bounds="[40,400][1040,480]" />
  </node>
</hierarchy>`;
    const tree = adaptFullAndroidHierarchyToDescribeResult(xml, SCREEN_W, SCREEN_H);

    const [email] = findAll(tree, { identifier: "email" });
    expect(email!.focused).toBeUndefined();

    const focused = tree.children.filter((n) => n.focused === true);
    expect(focused).toHaveLength(1);
    expect(focused[0]!.frame.y).toBeCloseTo(400 / 1920, 5);
  });
});
