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
  it("iOS: takes tappable roles (button/link/cell/tab), skips static content and the tab bar itself", () => {
    const tree = root(
      n("AXButton", [0.1, 0.1, 0.3, 0.08], { label: "Compose" }),
      n("AXLink", [0.1, 0.2, 0.3, 0.08], { label: "Learn more" }),
      n("AXCell", [0.1, 0.3, 0.8, 0.08], { label: "Row" }),
      n("AXStaticText", [0.1, 0.4, 0.8, 0.08], { label: "Just text" }),
      n("AXImage", [0.1, 0.5, 0.3, 0.08], { label: "Hero" }),
      n("AXGroup", [0.1, 0.6, 0.8, 0.08], { label: "Wrapper" }),
      // The bar is a container, not a target — its items are the buttons.
      n("AXTabBar", [0, 0.9, 1, 0.1], { label: "Tab bar" })
    );
    const labels = enumerateActions(tree, IOS).map((a) => a.label);
    expect(labels).toEqual(["Compose", "Learn more", "Row"]);
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

  it("skips zero/tiny frames (<0.5% of the screen)", () => {
    const tree = root(
      n("AXButton", [0.1, 0.1, 0.3, 0.08], { label: "Big enough" }),
      n("AXButton", [0.5, 0.5, 0.05, 0.05], { label: "Tiny" }),
      n("AXButton", [0.5, 0.6, 0, 0], { label: "Zero" })
    );
    expect(enumerateActions(tree, IOS).map((a) => a.label)).toEqual(["Big enough"]);
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
});

describe("enumerateActions — list collapse, cap, ordering", () => {
  it("collapses >3 aligned same-role/same-height siblings to the first 3 (a vertical list)", () => {
    const rows = [0.1, 0.2, 0.3, 0.4, 0.5].map((y, i) =>
      n("AXCell", [0.1, y, 0.8, 0.09], { label: `Item ${i + 1}` })
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
        labels.map((label, i) => n("AXCell", [0.1, 0.1 + i * 0.1, 0.8, 0.09], { label }))
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
