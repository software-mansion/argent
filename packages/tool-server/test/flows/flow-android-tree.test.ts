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

  // A `role` an agent reads out of `describe` has to match when a flow replays
  // it, so the flow tree reads a web text run the same contextual way the
  // describe trim does. Before this agreed, a step selecting
  // `text: Username, role: StaticText` matched nothing and burned its timeout.
  it("reads a web text run as StaticText, exactly as describe does", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.webkit.WebView" package="com.acme.app" bounds="[0,200][1080,1200]">
      <node index="0" class="android.view.View" text="Username" package="com.acme.app" bounds="[20,260][220,320]" />
      <node index="1" class="android.view.View" content-desc="Alpha" clickable="true" package="com.acme.app" bounds="[20,340][240,400]" />
    </node>
    <node index="1" class="android.view.View" text="Native label" package="com.acme.app" bounds="[20,1400][400,1460]" />
  </node>
</hierarchy>`;
    const flow = adaptFullAndroidHierarchyToDescribeResult(xml, SCREEN_W, SCREEN_H);
    const describeTree = parseUiAutomatorDump(xml, SCREEN_W, SCREEN_H);
    const roleOf = (tree: DescribeNode, label: string): string | undefined =>
      findAll(tree, { text: label })[0]?.role;

    expect(roleOf(flow, "Username")).toBe("StaticText");
    expect(roleOf(describeTree, "Username")).toBe("StaticText");
    // A tappable web node is a control, not a text run — both trees leave it.
    expect(roleOf(flow, "Alpha")).toBe("View");
    expect(roleOf(describeTree, "Alpha")).toBe("View");
    // The same class outside the WebView is a Compose semantics node; the
    // remap must not reach it.
    expect(roleOf(flow, "Native label")).toBe("View");
    expect(roleOf(describeTree, "Native label")).toBe("View");
  });

  // "Childless" has to be read off the dump both trees parse, never off each
  // tree's own survivors: the two trim differently, so a labelled web container
  // whose only child the describe trim drops would read as `StaticText` there
  // and stay `View` here — the same copied-role mismatch, one shape further in.
  it("agrees on a web container whose only child the describe trim drops", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.webkit.WebView" package="com.acme.app" bounds="[0,200][1080,1200]">
      <node index="0" class="android.view.View" content-desc="Heading" package="com.acme.app" bounds="[20,260][220,320]">
        <node index="0" class="android.view.View" package="com.acme.app" bounds="[0,0][0,0]" />
      </node>
    </node>
  </node>
</hierarchy>`;
    const flow = adaptFullAndroidHierarchyToDescribeResult(xml, SCREEN_W, SCREEN_H);
    const describeTree = parseUiAutomatorDump(xml, SCREEN_W, SCREEN_H);
    const roleOf = (tree: DescribeNode, label: string): string | undefined =>
      findAll(tree, { text: label })[0]?.role;

    expect(roleOf(describeTree, "Heading")).toBe(roleOf(flow, "Heading"));
  });
  // describe merges the doubled WebView pair into one landmark. Emitting both
  // halves here gave two leaves at the same frame, each carrying the page's
  // whole subtree text: a `role: WebView` copied out of describe matched twice,
  // and a `text` assert against the page counted double.
  it("emits one WebView leaf for the doubled pair, as describe does", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.webkit.WebView" resource-id="com.acme:id/host" package="com.acme.app" bounds="[0,0][1080,1920]">
      <node index="0" class="android.webkit.WebView" package="com.acme.app" text="Login Page" scrollable="true" bounds="[0,0][1084,1922]">
        <node index="0" class="android.widget.TextView" package="com.acme.app" text="Username" bounds="[20,100][400,160]" />
      </node>
    </node>
  </node>
</hierarchy>`;
    const flow = adaptFullAndroidHierarchyToDescribeResult(xml, SCREEN_W, SCREEN_H);
    const leaves = findAll(flow, { role: "WebView" });
    expect(leaves).toHaveLength(1);
    // The surviving leaf carries what either half had: the page title and the
    // scroll flag from Chromium's node, the app's own id from the app's view.
    expect(leaves[0]!.label).toBe("Login Page");
    expect(leaves[0]!.scrollable).toBe(true);
    expect(leaves[0]!.identifier).toBe("com.acme:id/host");
    const landmark = findAll(parseUiAutomatorDump(xml, SCREEN_W, SCREEN_H), { role: "WebView" });
    expect(landmark).toHaveLength(1);
    expect(leaves[0]!.frame).toEqual(landmark[0]!.frame);
  });

  // The frame has to come from the half describe reports it from. The inner
  // half's box overhangs the OUTER on some builds, not the screen, so it does
  // not clip back to the same rect and the two trees drifted a few pixels
  // apart on exactly the node an author selects the page by.
  it("reports the frame describe reports when the halves differ", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,2400]">
    <node index="0" class="android.webkit.WebView" package="com.acme.app" clickable="true" bounds="[0,326][1080,2337]">
      <node index="0" class="android.webkit.WebView" package="com.acme.app" text="Login Page" scrollable="true" bounds="[0,326][1080,2340]">
        <node index="0" class="android.widget.TextView" package="com.acme.app" text="Username" bounds="[20,400][400,460]" />
      </node>
    </node>
  </node>
</hierarchy>`;
    const leaves = findAll(adaptFullAndroidHierarchyToDescribeResult(xml, SCREEN_W, 2400), {
      role: "WebView",
    });
    const landmark = findAll(parseUiAutomatorDump(xml, SCREEN_W, 2400), { role: "WebView" });
    expect(leaves).toHaveLength(1);
    expect(landmark).toHaveLength(1);
    expect(leaves[0]!.frame).toEqual(landmark[0]!.frame);
    // Every flag either half sets reaches the survivor, as it does in describe.
    expect(leaves[0]!.clickable).toBe(true);
    expect(leaves[0]!.scrollable).toBe(true);
  });

  // The merge fires on the shape the trim merges, not only on an only child:
  // a sibling that adds nothing to either tree must not split the pair in one
  // of them.
  it("merges the pair past a sibling that adds nothing", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.webkit.WebView" package="com.acme.app" bounds="[0,0][1080,1920]">
      <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]" />
      <node index="1" class="android.webkit.WebView" package="com.acme.app" text="Login Page" bounds="[0,0][1080,1920]">
        <node index="0" class="android.widget.TextView" package="com.acme.app" text="Username" bounds="[20,100][400,160]" />
      </node>
    </node>
  </node>
</hierarchy>`;
    expect(
      findAll(adaptFullAndroidHierarchyToDescribeResult(xml, SCREEN_W, SCREEN_H), {
        role: "WebView",
      })
    ).toHaveLength(1);
    expect(
      findAll(parseUiAutomatorDump(xml, SCREEN_W, SCREEN_H), { role: "WebView" })
    ).toHaveLength(1);
  });

  it("keeps a control an app adds beside the web content", () => {
    // A WebView that publishes a control of its own alongside the web root is
    // not a doubled host: the control is something a selector can address, so
    // both halves stay. The count has to be exact — a control whose class name
    // merely contains "webview" is a `role: WebView` leaf in its own right, and
    // it would hide the merged half behind a "more than one" test.
    const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.webkit.WebView" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.webkit.WebView" package="com.acme.app" text="Login Page" bounds="[0,0][1084,1922]" />
    <node index="1" class="com.acme.player.PlayerOverlay" package="com.acme.app" resource-id="com.acme:id/player" content-desc="Video player" clickable="true" bounds="[0,20][200,140]" />
  </node>
</hierarchy>`;
    const flow = adaptFullAndroidHierarchyToDescribeResult(xml, SCREEN_W, SCREEN_H);
    expect(findAll(flow, { role: "WebView" })).toHaveLength(2);
    expect(findAll(flow, { identifier: "com.acme:id/player" })).toHaveLength(1);
  });

  // The role cannot tell the host's own landmark apart from a control an app
  // adds under a `*WebView*` class name — `deriveUiAutomatorRole` maps every
  // such name to "WebView". Folding that control into the landmark would delete
  // a tappable element and move its id onto the whole page. The describe trim
  // has the same case pinned.
  it("keeps a control merely named like a WebView out of the merge", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.webkit.WebView" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="com.acme.player.MyWebViewOverlay" package="com.acme.app" resource-id="com.acme:id/player" content-desc="Video player" clickable="true" bounds="[0,20][200,140]" />
  </node>
</hierarchy>`;
    const flow = adaptFullAndroidHierarchyToDescribeResult(xml, SCREEN_W, SCREEN_H);
    const player = findAll(flow, { identifier: "com.acme:id/player" });
    expect(player).toHaveLength(1);
    expect(player[0]!.label).toBe("Video player");
    expect(player[0]!.clickable).toBe(true);
    // The host keeps its own anonymous leaf and never adopts the control's id.
    const host = findAll(flow, { role: "WebView" }).filter((n) => !n.identifier);
    expect(host).toHaveLength(1);
    expect(host[0]!.label).toBeUndefined();
  });

  // The other half of describe's degenerate-box handling. A node whose own box
  // clips to zero area while its children are on screen is published there at
  // the region those children cover, so it is a normal addressable element —
  // and used to be missing here, which splits what an `assert` decides: a
  // `visible` copied out of describe failed and a `hidden` passed on an element
  // describe reports on screen.
  // The fallback frame reads the descendants the trim KEEPS, not the first
  // usable box under the node. A bare wrapper `<div>` publishes as an
  // `android.view.View` that describe hands its children up for, so stopping on
  // it read the page's whole scroll height as the WebView's frame: describe put
  // the landmark on a 400x60 box and this tree covered the screen, a tap centre
  // 770px apart on the same node.
  it("reads the fallback frame past a wrapper the trim drops", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.webkit.WebView" resource-id="com.example.app:id/webview" bounds="[0,200][1080,100]">
    <node index="0" class="android.view.View" bounds="[0,0][1080,4800]">
      <node index="0" class="android.widget.TextView" text="Body text" bounds="[100,400][500,460]"/>
    </node>
  </node>
</hierarchy>`;
    const flow = findAll(adaptFullAndroidHierarchyToDescribeResult(xml, SCREEN_W, SCREEN_H), {
      identifier: "com.example.app:id/webview",
    });
    const described = findAll(parseUiAutomatorDump(xml, SCREEN_W, SCREEN_H), {
      identifier: "com.example.app:id/webview",
    });
    expect(described).toHaveLength(1);
    expect(flow).toHaveLength(1);
    expect(flow[0]!.frame).toEqual(described[0]!.frame);
    // ...and it is the text's box, not the wrapper's 4800px scroll height.
    expect(flow[0]!.frame.height).toBeCloseTo(60 / SCREEN_H, 5);
  });

  // The other input the trim's own union has: a descendant an ancestor scroller
  // has scrolled out of view is not on screen, so it is not part of the region
  // the node covers either.
  it("leaves a scrolled-away descendant out of the fallback frame", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.ScrollView" resource-id="scroller" scrollable="true" bounds="[0,0][1080,600]">
    <node index="0" class="android.view.ViewGroup" resource-id="card" content-desc="Card" bounds="[0,200][1080,100]">
      <node index="0" class="android.widget.TextView" text="On screen" bounds="[100,100][500,160]"/>
      <node index="1" class="android.widget.TextView" text="Scrolled away" bounds="[100,1800][500,1860]"/>
    </node>
  </node>
</hierarchy>`;
    const flow = findAll(adaptFullAndroidHierarchyToDescribeResult(xml, SCREEN_W, SCREEN_H), {
      identifier: "card",
    });
    const described = findAll(parseUiAutomatorDump(xml, SCREEN_W, SCREEN_H), {
      identifier: "card",
    });
    expect(described).toHaveLength(1);
    expect(flow).toHaveLength(1);
    expect(flow[0]!.frame).toEqual(described[0]!.frame);
  });

  it("keeps a node whose own box is unusable, as describe does", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.ListView" resource-id="com.acme:id/menu" package="com.acme.app" bounds="[40,600][1040,600]">
      <node index="0" class="android.widget.TextView" package="com.acme.app" text="Row A" bounds="[40,600][1040,700]" />
      <node index="1" class="android.widget.TextView" package="com.acme.app" text="Row B" bounds="[40,700][1040,800]" />
    </node>
  </node>
</hierarchy>`;
    const flow = findAll(adaptFullAndroidHierarchyToDescribeResult(xml, SCREEN_W, SCREEN_H), {
      identifier: "com.acme:id/menu",
    });
    const described = findAll(parseUiAutomatorDump(xml, SCREEN_W, SCREEN_H), {
      identifier: "com.acme:id/menu",
    });
    expect(described).toHaveLength(1);
    expect(flow).toHaveLength(1);
    expect(flow[0]!.frame).toEqual(described[0]!.frame);
  });

  // A node with no `bounds` attribute at all is not the same case: describe
  // leaves it to its own bounds-less rule, so this tree must not invent a frame
  // for it either.
  it("invents no frame for a node the dump gave no box", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="androidx.compose.ui.platform.ComposeView" resource-id="com.acme:id/host" package="com.acme.app">
    <node index="0" class="android.widget.Button" package="com.acme.app" text="left" bounds="[0,0][100,50]" />
  </node>
</hierarchy>`;
    const flow = adaptFullAndroidHierarchyToDescribeResult(xml, SCREEN_W, SCREEN_H);
    expect(findAll(flow, { identifier: "com.acme:id/host" })).toHaveLength(0);
    expect(findAll(flow, { text: "left" })).toHaveLength(1);
  });

  // The clip guard's flow-tree half. A zero-height window makes
  // `rectFullyOutside` true for everything, so a scroller whose own box is
  // unusable must clip nothing — otherwise this tree drops a page describe
  // still shows.
  it("keeps content under a scroller whose own box is unusable", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.webkit.WebView" package="com.acme.app" text="FIXED" scrollable="true" bounds="[0,128][1084,-1174]">
      <node index="0" class="android.widget.TextView" package="com.acme.app" text="Section three" bounds="[20,200][1060,290]" />
    </node>
  </node>
</hierarchy>`;
    const flow = adaptFullAndroidHierarchyToDescribeResult(xml, SCREEN_W, SCREEN_H);
    expect(findAll(flow, { text: "Section three" })).toHaveLength(1);
    expect(
      findAll(parseUiAutomatorDump(xml, SCREEN_W, SCREEN_H), { text: "Section three" })
    ).toHaveLength(1);
  });

  // Both trees clip a scroller's own children now, so they list the same rows.
  // A step recorded off a row describe showed used to resolve at record time and
  // match nothing at replay, because only this tree had dropped it.
  it("agrees with describe on which rows a scroller has scrolled away", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.ScrollView" package="com.acme.app" scrollable="true" bounds="[0,300][1080,700]">
      <node index="0" class="android.widget.TextView" package="com.acme.app" text="Row 1" bounds="[0,310][1080,380]" />
      <node index="1" class="android.widget.TextView" package="com.acme.app" text="Row 2" bounds="[0,900][1080,970]" />
      <node index="2" class="android.widget.TextView" package="com.acme.app" text="Row 3" bounds="[0,1000][1080,1070]" />
    </node>
  </node>
</hierarchy>`;
    const rowsIn = (tree: DescribeNode) =>
      ["Row 1", "Row 2", "Row 3"].filter((t) => findAll(tree, { text: t }).length > 0);

    expect(rowsIn(adaptFullAndroidHierarchyToDescribeResult(xml, SCREEN_W, SCREEN_H))).toEqual([
      "Row 1",
    ]);
    expect(rowsIn(parseUiAutomatorDump(xml, SCREEN_W, SCREEN_H))).toEqual(["Row 1"]);
  });

  // Both trees read the role through the same contextual rule, so a web list
  // that the framework says does not scroll reports the same non-scrolling role
  // in each — otherwise a `role` copied out of describe misses at replay, and
  // `isScrollContainer` (which reads any /scroll/i role) contradicts the
  // `scrolls: false` this tree sets for the very same node.
  it("agrees with describe on a web list's role", () => {
    const xml = (scrollable: string) => `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.webkit.WebView" package="com.acme.app" bounds="[0,0][1080,1920]">
      <node index="0" class="android.widget.ListView" resource-id="mylist" scrollable="${scrollable}" package="com.acme.app" bounds="[20,170][1060,400]">
        <node index="0" class="android.widget.TextView" package="com.acme.app" text="alpha" bounds="[20,180][220,240]" />
      </node>
    </node>
  </node>
</hierarchy>`;
    const roleIn = (tree: DescribeNode) => findAll(tree, { identifier: "mylist" })[0]?.role;

    const plain = xml("false");
    expect(roleIn(adaptFullAndroidHierarchyToDescribeResult(plain, SCREEN_W, SCREEN_H))).toBe(
      "List"
    );
    expect(roleIn(parseUiAutomatorDump(plain, SCREEN_W, SCREEN_H))).toBe("List");

    const scrolling = xml("true");
    expect(roleIn(adaptFullAndroidHierarchyToDescribeResult(scrolling, SCREEN_W, SCREEN_H))).toBe(
      "ScrollView"
    );
    expect(roleIn(parseUiAutomatorDump(scrolling, SCREEN_W, SCREEN_H))).toBe("ScrollView");
  });

  // The label gate on the same remap, which also only this tree can pin: an
  // unlabelled web node never reaches the remap in describe (the layout-container
  // passthrough returns its children before a role is computed), but the flow
  // tree computes a role for every node it keeps. Chromium publishes a
  // `<div id="banner">` as a childless, nameless `android.view.View`, and
  // `StaticText` for a node with no text is the wrong answer.
  it("does not call an id-only web node a text run", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.webkit.WebView" package="com.acme.app" bounds="[0,200][1080,1200]">
      <node index="0" class="android.view.View" resource-id="banner" package="com.acme.app" bounds="[20,260][1060,320]" />
    </node>
  </node>
</hierarchy>`;
    const [banner] = findAll(adaptFullAndroidHierarchyToDescribeResult(xml, SCREEN_W, SCREEN_H), {
      identifier: "banner",
    });
    expect(banner).toBeDefined();
    expect(banner!.label).toBeUndefined();
    expect(banner!.role).toBe("View");
  });

  // The web half of the scroll rule, which only this tree can pin: Chromium
  // maps a `<ul>` onto `android.widget.ListView`, a SCROLL_CLASSES member, and
  // the flow flatten clips a scroller's own children. Reading the class name
  // there turns the list's box into a clip window and drops a control the page
  // paints below it — while describe, which trusts the framework flag, still
  // shows it.
  it("does not let a non-scrolling web list clip the flow tree", () => {
    const web = (scrollable: string) => `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.webkit.WebView" package="com.acme.app" text="Menu Page" bounds="[0,0][1080,1920]">
      <node index="0" class="android.widget.ListView" package="com.acme.app" scrollable="${scrollable}" bounds="[20,170][1060,260]">
        <node index="0" class="android.view.View" package="com.acme.app" bounds="[20,170][220,230]">
          <node index="0" class="android.widget.TextView" package="com.acme.app" text="Inbox item" bounds="[20,170][220,230]" />
          <node index="1" class="android.view.View" package="com.acme.app" content-desc="Escaped link" clickable="true" bounds="[20,1220][260,1280]" />
        </node>
      </node>
    </node>
  </node>
</hierarchy>`;

    // Chromium says the list does not scroll, so nothing below it is hidden.
    const open = adaptFullAndroidHierarchyToDescribeResult(web("false"), SCREEN_W, SCREEN_H);
    expect(findAll(open, { text: "Escaped link" })).toHaveLength(1);
    expect(
      findAll(parseUiAutomatorDump(web("false"), SCREEN_W, SCREEN_H), { text: "Escaped link" })
    ).toHaveLength(1);

    // Chromium says it does (`overflow: scroll`), so its box is a real viewport
    // and both trees drop what sits outside it.
    const scrolling = adaptFullAndroidHierarchyToDescribeResult(web("true"), SCREEN_W, SCREEN_H);
    expect(findAll(scrolling, { text: "Escaped link" })).toHaveLength(0);
    expect(
      findAll(parseUiAutomatorDump(web("true"), SCREEN_W, SCREEN_H), { text: "Escaped link" })
    ).toHaveLength(0);
  });

  // The same class outside a WebView is a real Android list, and there the
  // class name is the signal — a RecyclerView-era `ListView` that reports
  // `scrollable="false"` still clips.
  it("still clips a native list the class name marks as a scroller", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.ListView" package="com.acme.app" scrollable="false" bounds="[20,170][1060,260]">
      <node index="0" class="android.view.View" package="com.acme.app" bounds="[20,170][220,230]">
        <node index="0" class="android.widget.TextView" package="com.acme.app" text="Inbox item" bounds="[20,170][220,230]" />
        <node index="1" class="android.view.View" package="com.acme.app" content-desc="Escaped link" clickable="true" bounds="[20,1220][260,1280]" />
      </node>
    </node>
  </node>
</hierarchy>`;
    const flow = adaptFullAndroidHierarchyToDescribeResult(xml, SCREEN_W, SCREEN_H);
    expect(findAll(flow, { text: "Inbox item" })).toHaveLength(1);
    expect(findAll(flow, { text: "Escaped link" })).toHaveLength(0);
  });
});
