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
});
