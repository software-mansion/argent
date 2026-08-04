import { describe, it, expect } from "vitest";
import type { DescribeNode } from "../src/tools/describe/contract";
import { enumerateActions, deriveMapSelector } from "../src/tools/map/actions";

function n(
  role: string,
  frame: [number, number, number, number],
  extra: Partial<DescribeNode> = {},
  children: DescribeNode[] = []
): DescribeNode {
  return {
    role,
    frame: { x: frame[0], y: frame[1], width: frame[2], height: frame[3] },
    children,
    ...extra,
  };
}

const root = (...children: DescribeNode[]): DescribeNode =>
  n("AXGroup", [0, 0, 1, 1], {}, children);

const IOS = { platform: "ios" as const, maxActions: 12 };
const ANDROID = { platform: "android" as const, maxActions: 12 };

describe("enumerateActions — role/clickable filter", () => {
  // The fixtures here use ONLY roles `mapNativeTraitsToDescribeRole` can
  // actually emit (AXHeading, AXButton, AXTextField, AXLink, AXImage,
  // AXStaticText, AXTabBar, AXAdjustable, AXGroup) — both iOS describe adapters
  // derive `role` from it, so an AXCell/AXTable/AXMenuItem fixture would pin
  // behaviour no real device can reach.
  it("iOS: takes button and link, skips every other role the adapters can emit", () => {
    const tree = root(
      n("AXButton", [0.1, 0.1, 0.3, 0.08], { label: "Compose" }),
      n("AXLink", [0.1, 0.2, 0.3, 0.08], { label: "Learn more" }),
      n("AXStaticText", [0.1, 0.3, 0.8, 0.08], { label: "Just text" }),
      n("AXImage", [0.1, 0.4, 0.3, 0.08], { label: "Hero" }),
      n("AXHeading", [0.1, 0.5, 0.8, 0.08], { label: "Section" }),
      n("AXAdjustable", [0.1, 0.6, 0.8, 0.08], { label: "Volume" }),
      n("AXGroup", [0.1, 0.7, 0.8, 0.08], { label: "Wrapper" }),
      // The bar is a container, not a target — its items are the buttons.
      n("AXTabBar", [0, 0.9, 1, 0.1], { label: "Tab bar" })
    );
    const labels = enumerateActions(tree, IOS).map((a) => a.label);
    expect(labels).toEqual(["Compose", "Learn more"]);
  });

  it("iOS: a tab bar is skipped but the buttons inside it are taken", () => {
    const tree = root(
      n("AXTabBar", [0, 0.9, 1, 0.1], { label: "Bar" }, [
        n("AXButton", [0, 0.92, 0.4, 0.06], { label: "Tab A" }),
        n("AXButton", [0.5, 0.92, 0.4, 0.06], { label: "Tab B" }),
      ])
    );
    const labels = enumerateActions(tree, IOS).map((a) => a.label);
    expect(labels).toEqual(["Tab A", "Tab B"]);
    expect(labels).not.toContain("Bar");
  });

  it("iOS: a trait-less list row arrives as AXGroup and is NOT enumerated (documented v1 gap)", () => {
    // A row built from a pressable carries the `button` trait and is covered; a
    // row that only sets isAccessibilityElement arrives as a bare AXGroup,
    // indistinguishable from a layout wrapper. Pinned so the trade-off is a
    // decision rather than an accident.
    const tree = root(
      n("AXGroup", [0.05, 0.2, 0.9, 0.1], { label: "Untappable row", identifier: "row-0" }),
      n("AXButton", [0.05, 0.35, 0.9, 0.1], { label: "Pressable row" })
    );
    expect(enumerateActions(tree, IOS).map((a) => a.label)).toEqual(["Pressable row"]);
  });

  it("Android: takes clickable=true nodes regardless of class, skips non-clickable ones", () => {
    const tree = root(
      n("android.widget.Button", [0.1, 0.1, 0.3, 0.08], { label: "Send", clickable: true }),
      n("android.widget.TextView", [0.1, 0.2, 0.3, 0.08], { label: "Plain", clickable: false }),
      n("android.view.View", [0.1, 0.3, 0.3, 0.08], { label: "Compose row", clickable: true }),
      n("android.widget.Button", [0.1, 0.4, 0.3, 0.08], { label: "Unmarked" })
    );
    const labels = enumerateActions(tree, ANDROID).map((a) => a.label);
    expect(labels).toEqual(["Send", "Compose row"]);
  });
});

describe("enumerateActions — skip rules", () => {
  it("skips disabled elements", () => {
    const tree = root(
      n("AXButton", [0.1, 0.1, 0.3, 0.08], { label: "Enabled" }),
      n("AXButton", [0.1, 0.2, 0.3, 0.08], { label: "Disabled", disabled: true })
    );
    expect(enumerateActions(tree, IOS).map((a) => a.label)).toEqual(["Enabled"]);
  });

  it("filters per axis, so a HIG-minimum square button survives and a full-width hairline does not", () => {
    // The two cases an AREA threshold gets backwards, and the reason this rule
    // is per-axis. On an iPhone 16 Pro Max (440x956pt):
    //   44x44pt (Apple's HIG minimum tap target) = 0.1 x 0.046 -> area 0.0046
    //   a 6pt full-width divider             = 1.0 x 0.006 -> area 0.0060
    // A 0.005 AREA floor drops the real button and keeps the divider. Both
    // assertions below flip if the rule goes back to comparing w*h.
    const tree = root(
      n("AXButton", [0.1, 0.1, 0.1, 0.046], { label: "HIG minimum" }),
      n("AXButton", [0, 0.4, 1, 0.006], { label: "Hairline divider" }),
      n("AXButton", [0.9, 0.5, 0.006, 1], { label: "Vertical hairline" }),
      n("AXButton", [0.5, 0.6, 0, 0], { label: "Zero" })
    );
    expect(enumerateActions(tree, IOS).map((a) => a.label)).toEqual(["HIG minimum"]);
  });

  it("skips text inputs on both platforms (keyboards derail the crawl)", () => {
    const ios = root(
      n("AXTextField", [0.1, 0.1, 0.8, 0.08], { label: "Email" }),
      n("AXButton", [0.1, 0.3, 0.3, 0.08], { label: "Next" })
    );
    expect(enumerateActions(ios, IOS).map((a) => a.label)).toEqual(["Next"]);

    const android = root(
      n("android.widget.EditText", [0.1, 0.1, 0.8, 0.08], { label: "Email", clickable: true }),
      n("android.widget.Button", [0.1, 0.3, 0.3, 0.08], { label: "Next", clickable: true })
    );
    expect(enumerateActions(android, ANDROID).map((a) => a.label)).toEqual(["Next"]);
  });

  it("skips state-destroying labels (log out / sign out / delete)", () => {
    const tree = root(
      n("AXButton", [0.1, 0.1, 0.3, 0.08], { label: "Log Out" }),
      n("AXButton", [0.1, 0.2, 0.3, 0.08], { label: "Sign out" }),
      n("AXButton", [0.1, 0.3, 0.3, 0.08], { label: "Logout" }),
      n("AXButton", [0.1, 0.4, 0.3, 0.08], { label: "Delete account" }),
      n("AXButton", [0.1, 0.5, 0.3, 0.08], { label: "Settings" })
    );
    expect(enumerateActions(tree, IOS).map((a) => a.label)).toEqual(["Settings"]);
  });

  it("skips a destructive action whose only tell is its resource-id", () => {
    // An icon-only control carries no label or value, so the resource-id is the
    // ONLY evidence that tapping it ends the session. `_` is a word character,
    // so `\blogout\b` does not match "logout_button" until the id is split on
    // its separators — both halves of that fix are pinned here.
    const tree = root(
      n("android.widget.ImageButton", [0.8, 0.1, 0.15, 0.06], {
        identifier: "com.app:id/logout_button",
        clickable: true,
      }),
      n("android.widget.ImageButton", [0.8, 0.2, 0.15, 0.06], {
        identifier: "com.app:id/delete-account",
        clickable: true,
      }),
      n("android.widget.ImageButton", [0.8, 0.3, 0.15, 0.06], {
        identifier: "com.app:id/settings_button",
        clickable: true,
      }),
      // Not destructive: the boundary after "delete" fails against "d"/"e", so
      // these stay tappable and the guard is not merely a substring search.
      n("android.widget.ImageButton", [0.8, 0.4, 0.15, 0.06], {
        identifier: "com.app:id/deleted_items",
        clickable: true,
      }),
      n("android.widget.ImageButton", [0.8, 0.5, 0.15, 0.06], {
        identifier: "com.app:id/undelete_item",
        clickable: true,
      })
    );
    expect(enumerateActions(tree, ANDROID).map((a) => a.label)).toEqual([
      "com.app:id/settings_button",
      "com.app:id/deleted_items",
      "com.app:id/undelete_item",
    ]);
  });
});

describe("enumerateActions — list collapse, cap, ordering", () => {
  it("collapses >3 aligned same-role/same-height siblings to the first 3 (a vertical list)", () => {
    const rows = [0.1, 0.2, 0.3, 0.4, 0.5].map((y, i) =>
      n("AXButton", [0.1, y, 0.8, 0.09], { label: `Item ${i + 1}` })
    );
    const labels = enumerateActions(root(...rows), IOS).map((a) => a.label);
    expect(labels).toEqual(["Item 1", "Item 2", "Item 3"]);
  });

  it("does NOT collapse a horizontal run (distinct x): every tab-bar item is its own branch", () => {
    const tabs = [0, 0.2, 0.4, 0.6, 0.8].map((x, i) =>
      n("AXButton", [x, 0.9, 0.2, 0.08], { label: `Tab ${i + 1}` })
    );
    const labels = enumerateActions(root(...tabs), IOS).map((a) => a.label);
    expect(labels).toHaveLength(5);
  });

  it("does not collapse across different parents", () => {
    const list = (labels: string[]): DescribeNode =>
      n(
        "AXGroup",
        [0, 0.1, 1, 0.8],
        {},
        labels.map((label, i) => n("AXButton", [0.1, 0.1 + i * 0.1, 0.8, 0.09], { label }))
      );
    const tree = root(list(["A1", "A2"]), list(["B1", "B2"]));
    expect(enumerateActions(tree, IOS)).toHaveLength(4);
  });

  it("caps at maxActions", () => {
    const buttons = [0.1, 0.25, 0.4, 0.55, 0.7].map((y, i) =>
      // Distinct heights so the list collapse doesn't kick in first.
      n("AXButton", [0.1, y, 0.8, 0.05 + i * 0.02], { label: `B${i + 1}` })
    );
    const actions = enumerateActions(root(...buttons), { platform: "ios", maxActions: 2 });
    expect(actions.map((a) => a.label)).toEqual(["B1", "B2"]);
  });

  it("reserves budget for bottom-anchored nav so a top-heavy feed can't truncate the tab bar", () => {
    // A feed of 8 rows, each a distinct AXGroup holding an Avatar button + a
    // post link (16 candidates, none collapsing — distinct parents), plus a
    // 5-item tab bar anchored at the bottom. maxActions = 12: the plain
    // top-down cap would take 12 feed items and drop every tab.
    const feedRows: DescribeNode[] = [];
    for (let i = 0; i < 8; i++) {
      const y = 0.1 + i * 0.08;
      feedRows.push(
        n("AXGroup", [0.05, y, 0.9, 0.07], {}, [
          n("AXButton", [0.06, y, 0.1, 0.06], { label: `Avatar ${i}` }),
          n("AXLink", [0.2, y, 0.7, 0.06], { label: `Post ${i}` }),
        ])
      );
    }
    const tabLabels = ["Home", "Search", "Notifications", "Messages", "Profile"];
    const tabs = tabLabels.map((label, i) => n("AXButton", [i * 0.2, 0.92, 0.2, 0.06], { label }));
    const tree = root(...feedRows, n("AXTabBar", [0, 0.9, 1, 0.1], { label: "Tab bar" }, tabs));

    const labels = enumerateActions(tree, IOS).map((a) => a.label);
    expect(labels).toHaveLength(12);
    // Every top-level section survives the cap...
    for (const tab of tabLabels) expect(labels).toContain(tab);
    // ...and the remaining seven slots go to the feed in reading order.
    expect(labels.filter((l) => l.startsWith("Avatar") || l.startsWith("Post"))).toHaveLength(7);
    // Output stays in reading order (feed above the bottom bar).
    expect(labels.slice(-5).sort()).toEqual([...tabLabels].sort());
  });

  it("orders top-to-bottom, then left-to-right", () => {
    const tree = root(
      n("AXButton", [0.6, 0.5, 0.3, 0.08], { label: "Mid right" }),
      n("AXButton", [0.1, 0.5, 0.3, 0.08], { label: "Mid left" }),
      n("AXButton", [0.1, 0.1, 0.3, 0.08], { label: "Top" })
    );
    expect(enumerateActions(tree, IOS).map((a) => a.label)).toEqual([
      "Top",
      "Mid left",
      "Mid right",
    ]);
  });
});

describe("selector derivation", () => {
  it("prefers identifier, then exact label, then frame", () => {
    expect(
      deriveMapSelector(
        n("AXButton", [0.1, 0.1, 0.3, 0.08], { identifier: "compose", label: "New" })
      )
    ).toEqual({ by: "identifier", value: "compose" });
    expect(deriveMapSelector(n("AXButton", [0.1, 0.1, 0.3, 0.08], { label: "New post" }))).toEqual({
      by: "label",
      value: "New post",
    });
    expect(deriveMapSelector(n("AXButton", [0.1, 0.1, 0.3, 0.08]))).toEqual({
      by: "frame",
      value: "",
    });
  });

  it("treats an icon-font-only label as no label (frame fallback)", () => {
    expect(deriveMapSelector(n("AXButton", [0.1, 0.1, 0.3, 0.08], { label: "\uE163" }))).toEqual({
      by: "frame",
      value: "",
    });
  });

  it("falls back to value when the label is absent or invisible, not straight to frame", () => {
    // `matchNode` compares a text selector against label and value separately,
    // so a node whose only stable text lives in `value` is still re-locatable \u2014
    // matching `deriveSelector` (utils/ui-tree-match). Without the value arm
    // both of these would be { by: "frame" } and replay by coordinates.
    expect(deriveMapSelector(n("AXButton", [0.1, 0.1, 0.3, 0.08], { value: "Wi-Fi" }))).toEqual({
      by: "label",
      value: "Wi-Fi",
    });
    expect(
      deriveMapSelector(n("AXButton", [0.1, 0.1, 0.3, 0.08], { label: "\uE163", value: "Mute" }))
    ).toEqual({ by: "label", value: "Mute" });
    // Label still wins when both are visible text \u2014 a value is the volatile half.
    expect(
      deriveMapSelector(n("AXButton", [0.1, 0.1, 0.3, 0.08], { label: "Volume", value: "50%" }))
    ).toEqual({ by: "label", value: "Volume" });
  });

  it("actions carry the element's frame in MapFrame shape and a human label", () => {
    const tree = root(n("AXButton", [0.25, 0.5, 0.5, 0.1], { identifier: "go-id" }));
    const action = enumerateActions(tree, IOS)[0]!;
    expect(action.frame).toEqual({ x: 0.25, y: 0.5, w: 0.5, h: 0.1 });
    // No label ⇒ the identifier is the human-readable fallback.
    expect(action.label).toBe("go-id");
    expect(action.role).toBe("AXButton");
  });
});

describe("enumerateActions — scroll-bar overlays", () => {
  it("never taps a transient scroll indicator, even when Android marks it clickable", () => {
    // iOS exposes the fading scroll indicator as a large right-edge AXGroup;
    // tapping it does nothing and its transience already excludes it from the
    // screen fingerprint — actions must skip it for the same reason.
    const ios = root(
      n("AXButton", [0.1, 0.3, 0.8, 0.05], { label: "General" }),
      n("AXButton", [0.916, 0.121, 0.076, 0.821], { label: "Vertical scroll bar, 2 pages" })
    );
    expect(enumerateActions(ios, IOS).map((a) => a.label)).toEqual(["General"]);

    const android = root(
      n("android.widget.Button", [0.1, 0.3, 0.8, 0.05], { label: "General", clickable: true }),
      n("android.view.View", [0.95, 0.1, 0.05, 0.8], {
        label: "Horizontal scroll bar, 3 pages",
        clickable: true,
      })
    );
    expect(enumerateActions(android, ANDROID).map((a) => a.label)).toEqual(["General"]);
  });
});
