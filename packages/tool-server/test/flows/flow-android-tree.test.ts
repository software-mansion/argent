import { describe, it, expect } from "vitest";
import { adaptFullAndroidHierarchyToDescribeResult } from "../../src/tools/flows/flow-android-tree";
import { parseUiAutomatorDump } from "../../src/tools/describe/platforms/android/uiautomator-parser";
import {
  assertText,
  deriveUniqueSelector,
  evaluateCondition,
  findAll,
  selectorToFrame,
  matchNode,
  selectorToNode,
  type Selector,
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

  // Word-boundary overlap: a container labelled "Submit" over a child
  // rendering "Submit now" hoists the child's fuller text once, not
  // "Submit Submit now" — the child already renders "Submit" as a whole word.
  it("drops an own label the child text already renders as whole words", () => {
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
    // The element's own label IS exactly "Submit", so an `equals` assert
    // against it passes via the node's own text — hoisting is additive and
    // must not fail a check the label itself satisfies.
    expect(evaluateCondition("text", "Submit", submit, "equals")).toBe(true);
    expect(evaluateCondition("text", "Submit", submit, "contains")).toBe(true);
    // Text the element nowhere shows still fails exactly.
    expect(evaluateCondition("text", "Submit later", submit, "equals")).toBe(false);
  });

  // The dedup is word-boundary, NOT substring: a container labelled "Save"
  // over a child reading "Saved successfully" shows BOTH texts — "Save" only
  // appears inside the word "Saved", so it must stay in the hoist, and the
  // reviewer-facing acceptance `assert { equals: "Save" }` against the
  // container must pass.
  it("keeps an own label that only appears inside a descendant word", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.view.ViewGroup" resource-id="save-button" content-desc="Save" package="com.acme.app" bounds="[40,1700][1040,1800]">
      <node index="0" class="android.widget.TextView" text="Saved successfully" package="com.acme.app" bounds="[240,1730][840,1770]" />
    </node>
  </node>
</hierarchy>`;
    const tree = adaptFullAndroidHierarchyToDescribeResult(xml, SCREEN_W, SCREEN_H);
    const save = findAll(tree, { identifier: "save-button" });

    // The label survives in the hoist alongside the child text...
    expect(save[0]!.subtreeText).toBe("Save Saved successfully");
    // ...and the assert reads the label exactly, not "Saved successfully".
    expect(evaluateCondition("text", "Save", save, "equals")).toBe(true);
    expect(evaluateCondition("text", "Saved successfully", save, "contains")).toBe(true);
  });

  // Ordinary prefix pairs — Setting/Settings, Comment/Comments, Load/Loading,
  // Item/Items — are the same shape: the label is a substring of the child
  // text but not a word of it, so it is kept.
  it("keeps a prefix own label distinct from its pluralized child text", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.view.ViewGroup" resource-id="comment-tab" content-desc="Comment" package="com.acme.app" bounds="[40,400][1040,500]">
      <node index="0" class="android.widget.TextView" text="Comments" package="com.acme.app" bounds="[440,420][640,480]" />
    </node>
  </node>
</hierarchy>`;
    const tree = adaptFullAndroidHierarchyToDescribeResult(xml, SCREEN_W, SCREEN_H);
    const tab = findAll(tree, { identifier: "comment-tab" });

    expect(tab[0]!.subtreeText).toBe("Comment Comments");
    expect(evaluateCondition("text", "Comment", tab, "equals")).toBe(true);
  });

  // Multi-child joins dedup against the JOINED child text: a label one child
  // renders among several is not repeated...
  it("dedups the own label against the joined text of several children", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.view.ViewGroup" resource-id="save-row" content-desc="Save" package="com.acme.app" bounds="[40,400][1040,500]">
      <node index="0" class="android.widget.TextView" text="Save" package="com.acme.app" bounds="[140,420][340,480]" />
      <node index="1" class="android.widget.TextView" text="icon" package="com.acme.app" bounds="[440,420][640,480]" />
    </node>
  </node>
</hierarchy>`;
    const tree = adaptFullAndroidHierarchyToDescribeResult(xml, SCREEN_W, SCREEN_H);
    const row = findAll(tree, { identifier: "save-row" });

    // Not "Save Save icon" — the first child already renders the label.
    expect(row[0]!.subtreeText).toBe("Save icon");
    expect(evaluateCondition("text", "Save", row, "equals")).toBe(true);
  });

  // ...and a label the children spell out together is not repeated either.
  it("dedups an own label its children's joined text spells out", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.view.ViewGroup" resource-id="save-changes" content-desc="Save changes" package="com.acme.app" bounds="[40,400][1040,500]">
      <node index="0" class="android.widget.TextView" text="Save" package="com.acme.app" bounds="[140,420][340,480]" />
      <node index="1" class="android.widget.TextView" text="changes" package="com.acme.app" bounds="[440,420][740,480]" />
    </node>
  </node>
</hierarchy>`;
    const tree = adaptFullAndroidHierarchyToDescribeResult(xml, SCREEN_W, SCREEN_H);
    const row = findAll(tree, { identifier: "save-changes" });

    // The joined child text equals the own label, so nothing is stamped and
    // the assert reads the node's own "Save changes" — no duplication.
    expect(row[0]!.subtreeText).toBeUndefined();
    expect(assertText(row[0]!)).toBe("Save changes");
    expect(evaluateCondition("text", "Save changes", row, "equals")).toBe(true);
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

  // Scroll-clip prune, mirroring the describe path (`pruneSubtree` →
  // `rectFullyOutside`): a row scrolled out of a mid-screen RecyclerView's
  // viewport is still in the dump with on-screen bounds — it must be dropped,
  // or `assert { hidden }` falsely fails, `visible` falsely passes, and a
  // tap resolves below the scroller's fold.
  it("drops a row scrolled out of a mid-screen RecyclerView viewport", () => {
    // Viewport y[1000,1400]; row-7 sits at y[1500,1620] — outside the viewport
    // yet inside the 1920px screen.
    const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="androidx.recyclerview.widget.RecyclerView" resource-id="list" scrollable="true" package="com.acme.app" bounds="[0,1000][1080,1400]">
      <node index="0" class="android.view.ViewGroup" resource-id="row-2" package="com.acme.app" bounds="[0,1080][1080,1200]">
        <node index="0" class="android.widget.TextView" text="Row 2" package="com.acme.app" bounds="[0,1100][1080,1180]" />
      </node>
      <node index="1" class="android.view.ViewGroup" resource-id="row-7" package="com.acme.app" bounds="[0,1500][1080,1620]">
        <node index="0" class="android.widget.TextView" text="Row 7" package="com.acme.app" bounds="[0,1520][1080,1600]" />
      </node>
    </node>
  </node>
</hierarchy>`;
    const tree = adaptFullAndroidHierarchyToDescribeResult(xml, SCREEN_W, SCREEN_H);

    // The in-viewport row resolves; the scrolled-out one is gone entirely —
    // node, testID, and text.
    expect(findAll(tree, { identifier: "row-2" })).toHaveLength(1);
    const clipped = findAll(tree, { identifier: "row-7" });
    expect(clipped).toHaveLength(0);
    expect(JSON.stringify(tree)).not.toContain("Row 7");
    expect(evaluateCondition("hidden", undefined, clipped)).toBe(true);
    expect(evaluateCondition("visible", undefined, clipped)).toBe(false);
    // No tap point resolves below the 1400px fold — by id or by text.
    expect(selectorToFrame(tree, { identifier: "row-7" })).toBeUndefined();
    expect(selectorToFrame(tree, { text: "Row 7" })).toBeUndefined();
    // Parity: the agent-facing describe drops the same row.
    expect(JSON.stringify(parseUiAutomatorDump(xml, SCREEN_W, SCREEN_H))).not.toContain("Row 7");
  });

  // Partial overlap keeps the node with its screen-clipped frame, exactly like
  // the describe path (which prunes only rects FULLY outside the window).
  it("keeps a row partially inside the scroll viewport", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="androidx.recyclerview.widget.RecyclerView" resource-id="list" scrollable="true" package="com.acme.app" bounds="[0,1000][1080,1400]">
      <node index="0" class="android.view.ViewGroup" resource-id="row-edge" package="com.acme.app" bounds="[0,1300][1080,1500]">
        <node index="0" class="android.widget.TextView" text="Row 5" package="com.acme.app" bounds="[0,1320][1080,1380]" />
      </node>
    </node>
  </node>
</hierarchy>`;
    const tree = adaptFullAndroidHierarchyToDescribeResult(xml, SCREEN_W, SCREEN_H);

    const [edge] = findAll(tree, { identifier: "row-edge" });
    expect(edge).toBeDefined();
    // The frame stays the full bounds clipped to the screen only — not to the
    // scroll window — matching the describe path's partial-overlap handling.
    expect(edge!.frame.y).toBeCloseTo(1300 / 1920, 5);
    expect(edge!.frame.height).toBeCloseTo(200 / 1920, 5);
    expect(edge!.subtreeText).toBe("Row 5");
  });

  // Only scrollable ancestors clip: a badge hanging outside its plain parent
  // (a notification dot, an overlay) must not be pruned.
  it("keeps a badge overflowing a non-scrollable parent", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.view.ViewGroup" resource-id="card" package="com.acme.app" bounds="[200,600][880,760]">
      <node index="0" class="android.view.ViewGroup" resource-id="badge" content-desc="3 unread" package="com.acme.app" bounds="[840,560][940,640]" />
    </node>
  </node>
</hierarchy>`;
    const tree = adaptFullAndroidHierarchyToDescribeResult(xml, SCREEN_W, SCREEN_H);

    const [badge] = findAll(tree, { identifier: "badge" });
    expect(badge).toBeDefined();
    expect(badge!.frame.y).toBeCloseTo(560 / 1920, 5);
  });

  // Nested scrolls: the inner scroller's window narrows the clip for its
  // subtree (intersecting with the outer one), so a chip scrolled out of the
  // inner window is dropped even though it sits inside the outer one.
  it("clips against the nearest scrollable ancestor's window", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.ScrollView" resource-id="page" package="com.acme.app" bounds="[0,0][1080,1920]">
      <node index="0" class="android.view.ViewGroup" package="com.acme.app" bounds="[0,0][1080,1920]">
        <node index="0" class="android.widget.HorizontalScrollView" resource-id="chips" package="com.acme.app" bounds="[0,500][540,700]">
          <node index="0" class="android.view.ViewGroup" resource-id="chip-in" content-desc="Alpha" package="com.acme.app" bounds="[40,520][300,680]" />
          <node index="1" class="android.view.ViewGroup" resource-id="chip-out" content-desc="Zeta" package="com.acme.app" bounds="[600,520][860,680]" />
        </node>
      </node>
    </node>
  </node>
</hierarchy>`;
    const tree = adaptFullAndroidHierarchyToDescribeResult(xml, SCREEN_W, SCREEN_H);

    expect(findAll(tree, { identifier: "chip-in" })).toHaveLength(1);
    // chip-out is inside the outer scroller's window (and the screen) but
    // fully right of the chip row's 540px edge → dropped.
    expect(findAll(tree, { identifier: "chip-out" })).toHaveLength(0);
    expect(selectorToFrame(tree, { text: "Zeta" })).toBeUndefined();
  });

  // Nested scroll clips COMPOSE (intersect) rather than replace: an embedded,
  // content-sized RecyclerView (nestedScrollingEnabled=false — dumped with
  // scrollable="false" but matched as a scroller by class) straddles the outer
  // NestedScrollView's fold. Its own rect must not re-admit rows the outer
  // viewport has clipped — a row inside the inner rect but below the outer
  // fold is invisible and must be dropped.
  it("drops a row below the outer fold inside a content-sized inner scroller", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="androidx.core.widget.NestedScrollView" resource-id="page" scrollable="true" package="com.acme.app" bounds="[0,200][1080,1000]">
      <node index="0" class="androidx.recyclerview.widget.RecyclerView" resource-id="embedded" scrollable="false" package="com.acme.app" bounds="[0,200][1080,2800]">
        <node index="0" class="android.view.ViewGroup" resource-id="item-1" content-desc="Item 1" package="com.acme.app" bounds="[0,240][1080,360]" />
        <node index="1" class="android.view.ViewGroup" resource-id="item-8" content-desc="Item 8" package="com.acme.app" bounds="[0,1100][1080,1220]" />
      </node>
    </node>
  </node>
</hierarchy>`;
    const tree = adaptFullAndroidHierarchyToDescribeResult(xml, SCREEN_W, SCREEN_H);

    // In-viewport row resolves; the straddling scroller itself survives its
    // partial overlap.
    expect(findAll(tree, { identifier: "item-1" })).toHaveLength(1);
    expect(findAll(tree, { identifier: "embedded" })).toHaveLength(1);
    // item-8 is on screen and inside the RecyclerView's content-sized rect,
    // but below the NestedScrollView's 1000px fold → dropped.
    const below = findAll(tree, { identifier: "item-8" });
    expect(below).toHaveLength(0);
    expect(evaluateCondition("hidden", undefined, below)).toBe(true);
    expect(evaluateCondition("visible", undefined, below)).toBe(false);
    expect(selectorToFrame(tree, { text: "Item 8" })).toBeUndefined();
  });

  it("marks the leaves of the input method's window only, and none without window-type", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" window-type="1" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.Button" text="Back" package="com.acme.app" bounds="[40,200][400,280]" />
  </node>
  <node index="0" class="android.widget.FrameLayout" package="com.acme.ime" window-type="2" bounds="[0,1200][1080,1920]">
    <node index="0" class="android.widget.FrameLayout" resource-id="com.acme.ime:id/key_pos_del" content-desc="Delete" package="com.acme.ime" bounds="[900,1700][1060,1800]" />
  </node>
</hierarchy>`;
    const adapt = (x: string) => adaptFullAndroidHierarchyToDescribeResult(x, SCREEN_W, SCREEN_H);
    expect(adapt(xml).children.map((c) => c.label)).toEqual(["Back", "Delete"]);
    expect(adapt(xml).children.map((c) => c.keyboard)).toEqual([undefined, true]);
    const bare = xml.replace(/ window-type="\d+"/g, "");
    expect(adapt(bare).children.map((c) => c.keyboard)).toEqual([undefined, undefined]);
  });
});

// Parts of real API 36 dumps (1080x2400), cut to the attributes the adapter
// reads. Each row is a clickable view with no id or label of its own.
const DUMP_W = 1080;
const DUMP_H = 2400;

function dump(body: string): string {
  return `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,2400]">
${body}
  </node>
</hierarchy>`;
}

// Settings, main screen.
const SETTINGS_MAIN = dump(`
<node class="androidx.recyclerview.widget.RecyclerView" resource-id="com.android.settings:id/recycler_view" scrollable="true" bounds="[0,380][1080,2337]">
  <node class="android.widget.LinearLayout" clickable="true" bounds="[0,628][1080,834]">
    <node class="android.widget.LinearLayout" resource-id="com.android.settings:id/icon_frame" bounds="[42,678][189,783]">
      <node class="android.widget.ImageView" resource-id="android:id/icon" bounds="[84,678][189,783]" />
    </node>
    <node class="android.widget.RelativeLayout" resource-id="com.android.settings:id/text_frame" bounds="[168,628][1038,834]">
      <node class="android.widget.TextView" resource-id="android:id/title" text="Network &amp; internet" bounds="[210,670][646,741]" />
      <node class="android.widget.TextView" resource-id="android:id/summary" text="Mobile, Wi‑Fi, hotspot" bounds="[210,741][561,792]" />
    </node>
  </node>
  <node class="android.widget.LinearLayout" clickable="true" bounds="[0,834][1080,1082]">
    <node class="android.widget.LinearLayout" resource-id="com.android.settings:id/icon_frame" bounds="[42,884][189,989]">
      <node class="android.widget.ImageView" resource-id="android:id/icon" bounds="[84,884][189,989]" />
    </node>
    <node class="android.widget.RelativeLayout" resource-id="com.android.settings:id/text_frame" bounds="[168,834][1038,1040]">
      <node class="android.widget.TextView" resource-id="android:id/title" text="Connected devices" bounds="[210,876][657,947]" />
      <node class="android.widget.TextView" resource-id="android:id/summary" text="Bluetooth, pairing" bounds="[210,947][497,998]" />
    </node>
  </node>
  <node class="android.widget.LinearLayout" clickable="true" bounds="[0,1082][1080,1288]">
    <node class="android.widget.RelativeLayout" resource-id="com.android.settings:id/text_frame" bounds="[168,1082][1038,1288]">
      <node class="android.widget.TextView" resource-id="android:id/title" text="Apps" bounds="[210,1124][332,1195]" />
      <node class="android.widget.TextView" resource-id="android:id/summary" text="Assistant, recent apps, default apps" bounds="[210,1195][795,1246]" />
    </node>
  </node>
</node>`);

// Settings, Network & internet > Internet: a row with a gear button, a row with
// a switch, and a status line that cannot be tapped.
const SETTINGS_INTERNET = dump(`
<node class="androidx.recyclerview.widget.RecyclerView" resource-id="com.android.settings:id/recycler_view" scrollable="true" bounds="[0,606][1080,2081]">
  <node class="android.widget.LinearLayout" clickable="true" bounds="[0,606][1080,812]">
    <node class="android.widget.RelativeLayout" bounds="[189,606][804,812]">
      <node class="android.widget.TextView" resource-id="android:id/title" text="T-Mobile" bounds="[189,648][390,719]" />
      <node class="android.widget.TextView" resource-id="android:id/summary" text="5G" bounds="[189,719][235,770]" />
    </node>
    <node class="android.widget.LinearLayout" resource-id="android:id/widget_frame" bounds="[849,606][1038,812]">
      <node class="android.widget.ImageView" resource-id="com.android.settings:id/settings_button" content-desc="Settings" clickable="true" bounds="[849,606][1038,812]" />
    </node>
  </node>
  <node class="android.widget.LinearLayout" clickable="true" bounds="[0,812][1080,967]">
    <node class="android.widget.RelativeLayout" bounds="[63,812][859,967]">
      <node class="android.widget.TextView" resource-id="android:id/title" text="Wi-Fi" bounds="[63,854][180,925]" />
    </node>
    <node class="android.widget.LinearLayout" resource-id="android:id/widget_frame" bounds="[859,812][1038,967]">
      <node class="android.widget.Switch" resource-id="com.android.settings:id/switchWidget" checkable="true" checked="true" bounds="[901,826][1038,952]" />
    </node>
  </node>
  <node class="android.widget.LinearLayout" bounds="[0,1173][1080,1308]">
    <node class="android.widget.RelativeLayout" bounds="[63,1173][1038,1308]">
      <node class="android.widget.TextView" resource-id="android:id/summary" text="Searching for networks…" bounds="[63,1215][469,1266]" />
    </node>
  </node>
</node>`);

// Contacts > Organize: Compose rows, with no id on any view.
const CONTACTS_ORGANIZE = dump(`
<node class="android.widget.ScrollView" bounds="[0,296][1080,2126]">
  <node class="android.widget.TextView" text="This device" bounds="[42,338][267,401]" />
  <node class="android.view.View" clickable="true" bounds="[0,443][1080,623]">
    <node class="android.widget.TextView" text="Contact ringtones" bounds="[147,475][493,538]" />
    <node class="android.widget.TextView" text="Set ringtones for specific contacts" bounds="[147,538][710,591]" />
  </node>
  <node class="android.view.View" clickable="true" bounds="[0,930][1080,1110]">
    <node class="android.widget.TextView" text="Blocked numbers" bounds="[147,962][481,1025]" />
    <node class="android.widget.TextView" text="Numbers you won’t receive calls or texts from" bounds="[147,1025][892,1078]" />
  </node>
</node>`);

// The runtime permission dialog: the dialog itself is clickable.
const GRANT_DIALOG = dump(`
<node class="android.widget.LinearLayout" resource-id="com.android.permissioncontroller:id/grant_dialog" clickable="true" bounds="[28,817][1052,1648]">
  <node class="android.widget.LinearLayout" resource-id="com.android.permissioncontroller:id/content_container" bounds="[70,859][1010,1234]">
    <node class="android.widget.TextView" resource-id="com.android.permissioncontroller:id/permission_message" text="Allow YouTube to send you notifications?" bounds="[133,1038][947,1171]" />
  </node>
  <node class="android.widget.LinearLayout" bounds="[70,1234][1010,1606]">
    <node class="android.widget.Button" resource-id="com.android.permissioncontroller:id/permission_allow_button" text="Allow" clickable="true" bounds="[133,1239][947,1386]" />
    <node class="android.widget.Button" resource-id="com.android.permissioncontroller:id/permission_deny_button" text="Don’t allow" clickable="true" bounds="[133,1396][947,1543]" />
  </node>
</node>`);

// Chrome's toolbar while a URL is typed: a long-clickable view around the field.
const CHROME_TOOLBAR = dump(`
<node class="android.widget.FrameLayout" resource-id="com.android.chrome:id/toolbar" long-clickable="true" bounds="[0,128][1080,275]">
  <node class="android.widget.FrameLayout" resource-id="com.android.chrome:id/location_bar" bounds="[21,128][1059,275]">
    <node class="android.widget.LinearLayout" resource-id="com.android.chrome:id/location_bar_status" clickable="true" long-clickable="true" bounds="[53,128][137,275]">
      <node class="android.widget.ImageView" resource-id="com.android.chrome:id/location_bar_status_icon" content-desc="Connection is secure" bounds="[63,170][126,233]" />
    </node>
    <node class="android.widget.EditText" resource-id="com.android.chrome:id/url_bar" text="argentzq typed words" clickable="true" long-clickable="true" editable="true" bounds="[169,136][901,267]" />
    <node class="android.widget.TextView" text="Search or type URL" bounds="[169,136][901,267]" />
  </node>
</node>`);

// Files, grid view: a card around a file with a long name.
const LONG_NAME = "argent-row-long-name-" + "abcdefghij".repeat(12) + ".txt";
const FILES_CARD = dump(`
<node class="androidx.cardview.widget.CardView" resource-id="com.google.android.documentsui:id/item_root" clickable="true" bounds="[64,1298][529,1899]">
  <node class="android.widget.RelativeLayout" bounds="[196,1763][529,1899]">
    <node class="android.widget.TextView" resource-id="android:id/title" text="${LONG_NAME}" bounds="[196,1784][497,1835]" />
    <node class="android.widget.TextView" resource-id="com.google.android.documentsui:id/details" text="5 B" bounds="[196,1835][242,1878]" />
  </node>
</node>`);

// Settings > Network & internet on API 34, icon frames left out. The two "Off"
// summaries make the recorder look past the rows for an anchor.
const SETTINGS_NETWORK_API34 = dump(`
<node class="android.widget.ScrollView" resource-id="com.android.settings:id/content_parent" scrollable="true" bounds="[0,0][1080,2337]">
  <node class="android.widget.LinearLayout" resource-id="com.android.settings:id/app_bar" bounds="[0,0][1080,606]">
    <node class="android.widget.FrameLayout" resource-id="com.android.settings:id/collapsing_toolbar" content-desc="Network &amp; internet" bounds="[0,0][1080,606]">
      <node class="android.view.ViewGroup" resource-id="com.android.settings:id/action_bar" bounds="[0,136][1080,283]">
        <node class="android.widget.ImageButton" content-desc="Navigate up" clickable="true" bounds="[0,136][147,283]" />
        <node class="android.view.View" bounds="[189,136][1080,283]" />
      </node>
    </node>
  </node>
  <node class="android.widget.FrameLayout" resource-id="com.android.settings:id/content_frame" bounds="[0,606][1080,2337]">
    <node class="android.widget.LinearLayout" bounds="[0,606][1080,2337]">
      <node class="android.widget.FrameLayout" resource-id="com.android.settings:id/main_content" bounds="[0,606][1080,2337]">
        <node class="android.widget.LinearLayout" resource-id="com.android.settings:id/container_material" bounds="[0,606][1080,2337]">
          <node class="android.widget.FrameLayout" resource-id="android:id/list_container" bounds="[0,606][1080,2337]">
            <node class="androidx.recyclerview.widget.RecyclerView" resource-id="com.android.settings:id/recycler_view" bounds="[0,606][1080,2337]">
              <node class="android.widget.LinearLayout" clickable="true" bounds="[0,606][1080,812]">
                <node class="android.widget.RelativeLayout" bounds="[189,606][1038,812]">
                  <node class="android.widget.TextView" text="Internet" resource-id="android:id/title" bounds="[189,648][369,719]" />
                  <node class="android.widget.TextView" text="AndroidWifi" resource-id="android:id/summary" bounds="[189,719][381,770]" />
                </node>
              </node>
              <node class="android.widget.LinearLayout" clickable="true" bounds="[0,812][1080,1018]">
                <node class="android.widget.RelativeLayout" bounds="[189,812][1038,1018]">
                  <node class="android.widget.TextView" text="Calls &amp; SMS" resource-id="android:id/title" bounds="[189,854][473,925]" />
                  <node class="android.widget.TextView" text="T-Mobile" resource-id="android:id/summary" bounds="[189,925][329,976]" />
                </node>
              </node>
              <node class="android.widget.LinearLayout" clickable="true" bounds="[0,1018][1080,1224]">
                <node class="android.widget.RelativeLayout" bounds="[189,1018][1038,1224]">
                  <node class="android.widget.TextView" text="SIMs" resource-id="android:id/title" bounds="[189,1060][307,1131]" />
                  <node class="android.widget.TextView" text="T-Mobile" resource-id="android:id/summary" bounds="[189,1131][329,1182]" />
                </node>
              </node>
              <node class="android.widget.LinearLayout" clickable="true" bounds="[0,1224][1080,1379]">
                <node class="android.widget.RelativeLayout" bounds="[189,1224][850,1379]">
                  <node class="android.widget.TextView" text="Airplane mode" resource-id="android:id/title" bounds="[189,1266][531,1337]" />
                </node>
                <node class="android.widget.LinearLayout" resource-id="android:id/widget_frame" bounds="[850,1224][1038,1379]">
                  <node class="android.widget.Switch" resource-id="android:id/switch_widget" bounds="[892,1238][1038,1364]" />
                </node>
              </node>
              <node class="android.widget.LinearLayout" clickable="true" bounds="[0,1379][1080,1585]">
                <node class="android.widget.RelativeLayout" bounds="[189,1379][1038,1585]">
                  <node class="android.widget.TextView" text="Hotspot &amp; tethering" resource-id="android:id/title" bounds="[189,1421][646,1492]" />
                  <node class="android.widget.TextView" text="Off" resource-id="android:id/summary" bounds="[189,1492][240,1543]" />
                </node>
              </node>
              <node class="android.widget.LinearLayout" clickable="true" bounds="[0,1585][1080,1791]">
                <node class="android.widget.RelativeLayout" bounds="[189,1585][1038,1791]">
                  <node class="android.widget.TextView" text="Data Saver" resource-id="android:id/title" bounds="[189,1627][444,1698]" />
                  <node class="android.widget.TextView" text="Off" resource-id="android:id/summary" bounds="[189,1698][240,1749]" />
                </node>
              </node>
              <node class="android.widget.LinearLayout" clickable="true" bounds="[0,1791][1080,1997]">
                <node class="android.widget.RelativeLayout" bounds="[189,1791][849,1997]">
                  <node class="android.widget.TextView" text="VPN" resource-id="android:id/title" bounds="[189,1833][294,1904]" />
                  <node class="android.widget.TextView" text="None" resource-id="android:id/summary" bounds="[189,1904][276,1955]" />
                </node>
                <node class="android.widget.LinearLayout" resource-id="android:id/widget_frame" bounds="[849,1791][1038,1997]" />
              </node>
              <node class="android.widget.LinearLayout" clickable="true" bounds="[0,1997][1080,2152]">
                <node class="android.widget.RelativeLayout" bounds="[63,1997][1038,2152]">
                  <node class="android.widget.TextView" text="Mobile plan" resource-id="android:id/title" bounds="[63,2039][337,2110]" />
                </node>
              </node>
              <node class="android.widget.LinearLayout" clickable="true" bounds="[0,2152][1080,2337]">
                <node class="android.widget.RelativeLayout" bounds="[63,2152][1038,2337]">
                  <node class="android.widget.TextView" text="Private DNS" resource-id="android:id/title" bounds="[63,2194][344,2265]" />
                  <node class="android.widget.TextView" text="On" resource-id="android:id/summary" bounds="[63,2265][108,2316]" />
                </node>
              </node>
              <node class="android.widget.LinearLayout" clickable="true" bounds="[0,2358][1080,2337]">
                <node class="android.widget.RelativeLayout" bounds="[63,2358][1038,2337]" />
              </node>
            </node>
          </node>
        </node>
      </node>
    </node>
  </node>
</node>`);

function leaves(tree: DescribeNode): DescribeNode[] {
  const out: DescribeNode[] = [];
  const walk = (n: DescribeNode) => {
    out.push(n);
    n.children.forEach(walk);
  };
  tree.children.forEach(walk);
  return out;
}

const runnerTree = (xml: string) => adaptFullAndroidHierarchyToDescribeResult(xml, DUMP_W, DUMP_H);
const describeTree = (xml: string) => parseUiAutomatorDump(xml, DUMP_W, DUMP_H);

// The runner tree as it was before rows were elements: no leaf kept only for
// its tap.
function withoutBorrowed(tree: DescribeNode): DescribeNode {
  return { ...tree, children: tree.children.filter((n) => n.tapOnly !== true) };
}

describe("a view that can be tapped in the runner tree", () => {
  it("is a leaf labelled with its children's text, as describe labels it", () => {
    const tree = runnerTree(SETTINGS_MAIN);
    const rows = findAll(tree, { role: "LinearLayout", text: "Network & internet" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      label: "Network & internet / Mobile, Wi‑Fi, hotspot",
      borrowedLabel: true,
      clickable: true,
    });
    const described = findAll(describeTree(SETTINGS_MAIN), { text: "Network & internet" });
    expect(described.map((n) => n.label)).toEqual(["Network & internet / Mobile, Wi‑Fi, hotspot"]);
    // A label of its own is not borrowed.
    expect(findAll(tree, { role: "StaticText" }).some((n) => n.borrowedLabel)).toBe(false);
  });

  it("leaves the hoisted text of the container above it as it was", () => {
    const tree = runnerTree(CONTACTS_ORGANIZE);
    expect(
      leaves(tree)
        .filter((n) => n.role === "View")
        .map((n) => [n.label, n.borrowedLabel, n.subtreeText])
    ).toEqual([
      [
        "Contact ringtones / Set ringtones for specific contacts",
        true,
        "Contact ringtones Set ringtones for specific contacts",
      ],
      [
        "Blocked numbers / Numbers you won’t receive calls or texts from",
        true,
        "Blocked numbers Numbers you won’t receive calls or texts from",
      ],
    ]);
    const list = findAll(tree, { role: "ScrollView" });
    expect(list).toHaveLength(1);
    expect(list[0]!.subtreeText).toBe(
      "This device Contact ringtones Set ringtones for specific contacts Blocked numbers " +
        "Numbers you won’t receive calls or texts from"
    );
  });

  it("borrows nothing when it holds a text field, so typed text is never a label", () => {
    const tree = runnerTree(CHROME_TOOLBAR);
    const toolbar = findAll(tree, { identifier: "com.android.chrome:id/toolbar" });
    expect(toolbar).toHaveLength(1);
    expect(toolbar[0]!.label).toBeUndefined();
    expect(toolbar[0]!.borrowedLabel).toBeUndefined();
    // The field still reads as itself; nothing else carries the typed text.
    expect(findAll(tree, { text: "argentzq" }).map((n) => n.identifier)).toEqual([
      "com.android.chrome:id/url_bar",
    ]);
    // A tappable view next to the field still borrows its own icon's name.
    expect(findAll(tree, { identifier: "location_bar_status" })[0]!.label).toBe(
      "Connection is secure"
    );
  });

  it("leaves a password field out of a borrowed label", () => {
    const tree = runnerTree(
      dump(`
<node class="android.view.ViewGroup" clickable="true" bounds="[0,400][1080,600]">
  <node class="android.widget.TextView" text="PIN" bounds="[40,420][300,480]" />
  <node class="android.view.View" password="true" text="4711" bounds="[40,500][600,580]" />
</node>`)
    );
    const row = findAll(tree, { role: "ViewGroup" });
    expect(row.map((n) => n.label)).toEqual(["PIN"]);
    expect(leaves(tree).some((n) => (n.label ?? "").includes("4711"))).toBe(false);
  });

  it("leaves text with no on-screen frame out of a borrowed label", () => {
    // A row at the bottom edge: its summary is drawn below the screen.
    const tree = runnerTree(
      dump(`
<node class="android.widget.LinearLayout" clickable="true" bounds="[0,2250][1080,2456]">
  <node class="android.widget.TextView" text="System" bounds="[210,2292][400,2363]" />
  <node class="android.widget.TextView" text="Languages, gestures, time, backup" bounds="[210,2405][800,2456]" />
  <node class="android.widget.TextView" text="Collapsed" bounds="[210,2300][210,2300]" />
</node>`)
    );
    expect(findAll(tree, { role: "LinearLayout" }).map((n) => n.label)).toEqual(["System"]);
  });

  it("leaves text scrolled out of the list around it out of a borrowed label", () => {
    // The row is partly in the list's window; its title is under the header.
    const tree = runnerTree(
      dump(`
<node class="android.widget.TextView" text="Header" bounds="[0,0][1080,400]" />
<node class="android.widget.ScrollView" bounds="[0,400][1080,2000]">
  <node class="android.view.ViewGroup" clickable="true" bounds="[0,300][1080,500]">
    <node class="android.widget.TextView" text="Hidden title" bounds="[40,310][400,380]" />
    <node class="android.widget.TextView" text="Shown summary" bounds="[40,420][400,480]" />
  </node>
</node>`)
    );
    expect(findAll(tree, { role: "ViewGroup" }).map((n) => n.label)).toEqual(["Shown summary"]);
    const hidden = findAll(tree, { text: "Hidden title" });
    expect(hidden).toEqual([]);
    expect(evaluateCondition("visible", undefined, hidden)).toBe(false);
  });

  it("borrows nothing when it holds a scroller", () => {
    // A React Native wrapper that closes the keyboard, around a list.
    const tree = runnerTree(
      dump(`
<node class="android.view.ViewGroup" clickable="true" bounds="[0,300][1080,1000]">
  <node class="android.widget.TextView" text="Recent" bounds="[40,320][400,380]" />
  <node class="android.widget.ScrollView" bounds="[0,400][1080,1000]">
    <node class="android.widget.TextView" text="Item 1" bounds="[40,420][400,480]" />
  </node>
</node>`)
    );
    const wrapper = findAll(tree, { role: "ViewGroup" });
    expect(wrapper).toHaveLength(1);
    expect(wrapper[0]!.label).toBeUndefined();
  });

  it("borrows nothing when it scrolls, covers more than half the screen or hosts a WebView", () => {
    const unlabelled = (cls: string, bounds: string, extra = "") =>
      findAll(
        runnerTree(
          dump(`
<node class="${cls}" clickable="true"${extra} bounds="${bounds}">
  <node class="android.widget.TextView" text="Inside" bounds="[40,420][400,480]" />
</node>`)
        ),
        { role: deriveRoleOf(cls) }
      ).map((n) => n.label);
    expect(unlabelled("android.view.ViewGroup", "[0,400][1080,900]", ' scrollable="true"')).toEqual(
      [undefined]
    );
    // 1080x1300 of 1080x2400: more than half.
    expect(unlabelled("android.view.ViewGroup", "[0,0][1080,1300]")).toEqual([undefined]);
    expect(unlabelled("android.webkit.WebView", "[0,400][1080,900]")).toEqual([undefined]);
    // Half the screen or less borrows.
    expect(unlabelled("android.view.ViewGroup", "[0,0][1080,1200]")).toEqual(["Inside"]);
  });

  it("borrows no text from a view inside it that can be tapped itself", () => {
    const dialog = findAll(runnerTree(GRANT_DIALOG), { identifier: "grant_dialog" });
    expect(dialog.map((n) => n.label)).toEqual(["Allow YouTube to send you notifications?"]);
    // describe also takes the buttons' text.
    expect(findAll(describeTree(GRANT_DIALOG), { identifier: "grant_dialog" })[0]!.label).toBe(
      "Allow YouTube to send you notifications? / Allow / Don’t allow"
    );

    const tree = runnerTree(SETTINGS_INTERNET);
    expect(findAll(tree, { role: "LinearLayout", text: "T-Mobile" }).map((n) => n.label)).toEqual([
      "T-Mobile / 5G",
    ]);
    expect(findAll(tree, { identifier: "settings_button" }).map((n) => n.label)).toEqual([
      "Settings",
    ]);
  });

  it("borrows nothing for a view that cannot be tapped", () => {
    const tree = runnerTree(SETTINGS_INTERNET);
    expect(findAll(tree, { role: "LinearLayout", text: "Searching" })).toEqual([]);
    expect(findAll(tree, { text: "Searching" }).map((n) => n.role)).toEqual(["StaticText"]);
  });

  it("cuts a long borrowed label at 120 characters, as describe does", () => {
    const card = findAll(runnerTree(FILES_CARD), { identifier: "item_root" });
    expect(card).toHaveLength(1);
    expect(card[0]!.label).toBe(`${LONG_NAME} / 5 B`.slice(0, 120) + "…");
    expect(findAll(describeTree(FILES_CARD), { identifier: "item_root" })[0]!.label).toBe(
      card[0]!.label
    );
  });

  it("gives way to the element inside it in the pick of a selector with no field", () => {
    // A wrapper that closes the keyboard, around the whole screen: base tapped the text.
    const form = runnerTree(
      dump(`
<node class="android.view.ViewGroup" resource-id="form" bounds="[0,0][1080,2400]">
  <node class="android.view.ViewGroup" clickable="true" bounds="[0,0][1080,2400]">
    <node class="android.widget.TextView" text="Hi" bounds="[40,300][400,380]" />
  </node>
</node>`)
    );
    const wrapper = findAll(form, { role: "ViewGroup", within: { identifier: "form" } });
    expect(wrapper.map((n) => n.tapOnly)).toEqual([true]);
    expect(selectorToNode(form, { within: { identifier: "form" } })?.label).toBe("Hi");
    expect(
      evaluateCondition("text", "Hi", findAll(form, { within: { identifier: "form" } }), "equals")
    ).toBe(true);

    // A list of rows: the title of the first row, as before.
    const tree = runnerTree(SETTINGS_MAIN);
    const inList: Selector = { within: { identifier: "recycler_view" } };
    expect(selectorToNode(tree, inList)?.label).toBe(
      selectorToNode(withoutBorrowed(tree), inList)?.label
    );
    // A card with an id was an element before; it stays the pick.
    const card = runnerTree(
      dump(`
<node class="android.widget.FrameLayout" resource-id="grid" bounds="[0,1200][1080,2000]">
  <node class="androidx.cardview.widget.CardView" resource-id="com.google.android.documentsui:id/item_root" clickable="true" bounds="[64,1298][529,1899]">
    <node class="android.widget.TextView" text="argent-row-a.txt" bounds="[196,1784][497,1835]" />
  </node>
</node>`)
    );
    expect(selectorToNode(card, { within: { identifier: "grid" } })?.identifier).toBe(
      "com.google.android.documentsui:id/item_root"
    );
  });

  it("never puts the borrowed-label mark in the describe tree", () => {
    for (const xml of [
      SETTINGS_MAIN,
      SETTINGS_INTERNET,
      CONTACTS_ORGANIZE,
      GRANT_DIALOG,
      CHROME_TOOLBAR,
      FILES_CARD,
    ]) {
      expect(JSON.stringify(describeTree(xml))).not.toContain("borrowedLabel");
      expect(JSON.stringify(describeTree(xml))).not.toContain("tapOnly");
    }
  });

  it("gives way to the title inside it in a text check", () => {
    const tree = runnerTree(SETTINGS_MAIN);
    const matches = findAll(tree, { text: "Network & internet" });
    expect(matches.map((n) => n.role).sort()).toEqual(["LinearLayout", "StaticText"]);
    expect(evaluateCondition("text", "Network & internet", matches, "equals")).toBe(true);
    expect(evaluateCondition("text", "^Network & internet$", matches, "matches")).toBe(true);
    expect(evaluateCondition("text", "hotspot", matches, "contains")).toBe(false);
    // A selector only the row matches reads the row.
    const row = findAll(tree, { role: "LinearLayout", text: "Network & internet" });
    expect(evaluateCondition("text", "hotspot", row, "contains")).toBe(true);
  });

  it("counts `next` and `after` from the title inside it, as before", () => {
    const tree = runnerTree(SETTINGS_MAIN);
    for (const selector of [
      { role: "StaticText", next: { text: "Connected devices" } },
      { next: { text: "Network & internet" } },
      { text: "Connected devices", next: { text: "Network & internet" } },
      { role: "StaticText", after: { text: "Connected devices" } },
      { text: "Network & internet", after: { text: "Connected devices" } },
    ] as Selector[]) {
      expect(findAll(tree, selector).map((n) => n.label)).toEqual(
        findAll(withoutBorrowed(tree), selector).map((n) => n.label)
      );
    }
    expect(
      findAll(tree, { role: "StaticText", next: { text: "Connected devices" } }).map((n) => n.label)
    ).toEqual(["Bluetooth, pairing"]);
    // `next` picks the title, not the row starting just above it.
    const picked = findAll(tree, {
      text: "Connected devices",
      next: { text: "Network & internet" },
    });
    expect(evaluateCondition("text", "Connected devices", picked, "equals")).toBe(true);
  });

  it("leaves the recorder's `next` anchor on the title inside it", () => {
    // Compose rows: a clickable view around the title, its switch beside it or
    // inside it. The anchor is the title, never the row named by its title.
    const pair = (title: string, y: number, inside: boolean): string => {
      const text = `<node class="android.widget.TextView" text="${title}" bounds="[40,${y + 40}][400,${y + 110}]" />`;
      const toggle = `<node class="android.widget.Switch" clickable="true" checkable="true" bounds="[900,${y + 30}][1040,${y + 120}]" />`;
      const right = inside ? 1080 : 860;
      const view = `<node class="android.view.View" clickable="true" bounds="[0,${y}][${right},${y + 150}]">${text}${inside ? toggle : ""}</node>`;
      return inside ? view : view + toggle;
    };
    for (const inside of [false, true]) {
      const tree = runnerTree(
        dump(`<node class="android.widget.ScrollView" scrollable="true" bounds="[0,300][1080,2300]">
${pair("Wi-Fi", 400, inside)}${pair("Bluetooth", 550, inside)}
</node>`)
      );
      const toggle = leaves(tree).find((n) => n.role === "Switch")!;
      const f = toggle.frame;
      const point = { x: f.x + f.width / 2, y: f.y + f.height / 2 };
      expect(deriveUniqueSelector(tree, toggle, point)).toEqual({
        role: "Switch",
        next: { text: "Wi-Fi" },
      });
    }
  });

  it("keeps the recorder's anchors to the views that were elements before", () => {
    // Twelve anchors are tried, nearest first. The rows around the summary have
    // no name of their own, and must not take the slots of the toolbar.
    const tree = runnerTree(SETTINGS_NETWORK_API34);
    const off = leaves(tree).find((n) => n.label === "Off")!;
    const f = off.frame;
    const point = { x: f.x + f.width / 2, y: f.y + f.height / 2 };
    expect(deriveUniqueSelector(tree, off, point)).toEqual({
      text: "Off",
      next: { identifier: "com.android.settings:id/collapsing_toolbar" },
    });
  });

  it("is a `within` scope that holds its switch", () => {
    const tree = runnerTree(SETTINGS_INTERNET);
    expect(findAll(tree, { role: "Switch", within: { text: "Wi-Fi" } })).toHaveLength(1);
    expect(findAll(withoutBorrowed(tree), { role: "Switch", within: { text: "Wi-Fi" } })).toEqual(
      []
    );
  });
});

function deriveRoleOf(cls: string): string {
  return cls.split(".").pop()!;
}
