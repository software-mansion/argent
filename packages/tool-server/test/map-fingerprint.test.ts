import { describe, it, expect } from "vitest";
import type { DescribeNode } from "../src/tools/describe/contract";
import { screenKey, screenTitle } from "../src/tools/map/fingerprint";

// Compact DescribeNode builder: role, [x, y, w, h], extras, children.
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

describe("screenKey — coarse structural fingerprint", () => {
  it("ignores labels and values: same structure with different dynamic text ⇒ same key", () => {
    // The whole point of the coarse key: a feed revisited with fresh content
    // (new post text, changed counters) must still be the same screen.
    const visit1 = root(
      n("AXHeading", [0.1, 0.02, 0.8, 0.05], { label: "Feed" }),
      n("AXStaticText", [0.1, 0.2, 0.8, 0.1], { label: "First post", value: "12 likes" }),
      n("AXButton", [0.1, 0.85, 0.8, 0.08], { label: "Refresh" })
    );
    const visit2 = root(
      n("AXHeading", [0.1, 0.02, 0.8, 0.05], { label: "Feed (3 new)" }),
      n("AXStaticText", [0.1, 0.2, 0.8, 0.1], { label: "Another post", value: "99 likes" }),
      n("AXButton", [0.1, 0.85, 0.8, 0.08], { label: "Refresh" })
    );
    expect(screenKey(visit1)).toBe(screenKey(visit2));
  });

  it("is stable under sub-rounding frame jitter (0.05 rounding step)", () => {
    const a = root(n("AXButton", [0.1, 0.101, 0.8, 0.08], { label: "Go" }));
    const b = root(n("AXButton", [0.1, 0.099, 0.8, 0.08], { label: "Go" }));
    expect(screenKey(a)).toBe(screenKey(b));
  });

  it("changes when the structure changes: extra node, different role, moved frame", () => {
    const base = root(n("AXHeading", [0.1, 0.02, 0.8, 0.05]), n("AXButton", [0.1, 0.2, 0.8, 0.08]));
    const extraNode = root(
      n("AXHeading", [0.1, 0.02, 0.8, 0.05]),
      n("AXButton", [0.1, 0.2, 0.8, 0.08]),
      n("AXButton", [0.1, 0.4, 0.8, 0.08])
    );
    const differentRole = root(
      n("AXHeading", [0.1, 0.02, 0.8, 0.05]),
      n("AXLink", [0.1, 0.2, 0.8, 0.08])
    );
    const movedFrame = root(
      n("AXHeading", [0.1, 0.02, 0.8, 0.05]),
      n("AXButton", [0.1, 0.5, 0.8, 0.08])
    );
    expect(screenKey(extraNode)).not.toBe(screenKey(base));
    expect(screenKey(differentRole)).not.toBe(screenKey(base));
    expect(screenKey(movedFrame)).not.toBe(screenKey(base));
  });

  it("includes identifiers: two structurally identical screens with different ids stay distinct", () => {
    // Identifiers are the one text-ish field that is DESIGN, not content — two
    // template-identical screens (e.g. two tabs rendering the same list shape)
    // are told apart only by them.
    const a = root(n("AXGroup", [0, 0.1, 1, 0.9], { identifier: "home-screen" }));
    const b = root(n("AXGroup", [0, 0.1, 1, 0.9], { identifier: "search-screen" }));
    expect(screenKey(a)).not.toBe(screenKey(b));
  });

  it("is deterministic", () => {
    const tree = root(n("AXButton", [0.1, 0.2, 0.8, 0.08], { label: "Go", identifier: "go" }));
    expect(screenKey(tree)).toBe(screenKey(tree));
    expect(screenKey(tree)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("ignores transient scroll-bar overlays: with and without the indicator ⇒ same key", () => {
    // iOS scroll indicators fade in and out on an untouched screen; their
    // presence must not flip the screen's identity between visits.
    const content = n("AXButton", [0.1, 0.3, 0.8, 0.05], { label: "General" });
    const bare = root(content);
    const withIndicator = root(
      content,
      n("AXGroup", [0.916, 0.121, 0.076, 0.821], { label: "Vertical scroll bar, 2 pages" })
    );
    expect(screenKey(withIndicator)).toBe(screenKey(bare));
  });
});

describe("screenTitle — best-effort human title", () => {
  it("prefers a header/nav-ish node's label in the top 15%", () => {
    const tree = root(
      n("AXStaticText", [0.05, 0.05, 0.2, 0.04], { label: "9:41" }),
      n("AXHeading", [0.3, 0.06, 0.4, 0.05], { label: "Settings" }),
      n("AXStaticText", [0.1, 0.2, 0.8, 0.1], {
        label: "A much longer paragraph of body text that should not win",
      })
    );
    expect(screenTitle(tree)).toBe("Settings");
  });

  it("falls back to the topmost thin text row when nothing header-ish exists", () => {
    const tree = root(
      n("AXStaticText", [0.1, 0.1, 0.3, 0.04], { label: "Overview" }),
      n("AXStaticText", [0.1, 0.2, 0.8, 0.05], { label: "Welcome back, Jane" }),
      n("AXStaticText", [0.1, 0.5, 0.8, 0.05], { label: "Even longer text far below the fold" })
    );
    expect(screenTitle(tree)).toBe("Overview");
  });

  it("names a pushed screen after its centred nav title, not the left-edge back label", () => {
    // An iOS nav bar holds the back button (parent screen's name, hugging the
    // left edge) and the centred title at the same height — position order
    // alone would name every pushed screen after its parent.
    const tree = root(
      n("AXButton", [0.02, 0.07, 0.18, 0.03], { label: "Settings" }),
      n("AXStaticText", [0.4, 0.07, 0.2, 0.03], { label: "General" })
    );
    expect(screenTitle(tree)).toBe("General");
  });

  it("never titles a screen after a scroll-bar overlay or a tall banner (Settings-root regression)", () => {
    // Shapes lifted from a real iOS 18 Settings-root describe: the large title
    // is a bare AXGroup, the scroll indicator a tall right-edge AXGroup strip
    // whose y-origin sits inside the top band, and the Apple Account banner a
    // 0.09-tall button with a long label. The old longest-label rule picked
    // the banner (or, on other screens, the scroll bar).
    const tree = root(
      n("AXGroup", [0.041, 0.119, 0.338, 0.048], { label: "Settings" }),
      n("AXGroup", [0.916, 0.121, 0.076, 0.821], { label: "Vertical scroll bar, 2 pages" }),
      n("AXButton", [0.102, 0.25, 0.795, 0.092], {
        label:
          "Apple Account, Sign in to access your iCloud data, the App Store, Apple services and more.",
      })
    );
    expect(screenTitle(tree)).toBe("Settings");
  });

  it("ignores a header-ish node below the top 15%", () => {
    const tree = root(n("AXHeading", [0.1, 0.5, 0.8, 0.05], { label: "Section header" }));
    expect(screenTitle(tree)).toBeNull();
  });

  it("returns null when no label sits in the top quarter", () => {
    const tree = root(
      n("AXStaticText", [0.1, 0.6, 0.8, 0.05], { label: "Body only" }),
      n("AXButton", [0.1, 0.85, 0.8, 0.08], { label: "OK" })
    );
    expect(screenTitle(tree)).toBeNull();
  });

  it("never uses bare navigation-chrome labels (Back / Cancel) as the title", () => {
    // A sheet's title bar often holds only its dismiss control; the sheet is
    // better off unnamed ("Screen N") than called "Cancel".
    const chromeOnly = root(n("AXButton", [0.02, 0.05, 0.15, 0.04], { label: "Cancel" }));
    expect(screenTitle(chromeOnly)).toBeNull();

    const withTitle = root(
      n("AXButton", [0.02, 0.05, 0.15, 0.04], { label: "Cancel" }),
      n("AXStaticText", [0.4, 0.06, 0.2, 0.035], { label: "Apple Account" })
    );
    expect(screenTitle(withTitle)).toBe("Apple Account");
  });

  it("skips icon-font (invisible) labels", () => {
    // A glyph-only label renders as nothing outside the app's private font —
    // it must not become the screen's name.
    const tree = root(
      n("AXHeading", [0.1, 0.02, 0.2, 0.05], { label: "\uE163" }),
      n("AXStaticText", [0.4, 0.05, 0.4, 0.05], { label: "Inbox" })
    );
    expect(screenTitle(tree)).toBe("Inbox");
  });
});
