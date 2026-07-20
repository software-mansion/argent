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

  it("falls back to the longest label in the top 25% when nothing header-ish exists", () => {
    const tree = root(
      n("AXStaticText", [0.1, 0.1, 0.3, 0.04], { label: "Hi" }),
      n("AXStaticText", [0.1, 0.2, 0.8, 0.05], { label: "Welcome back, Jane" }),
      n("AXStaticText", [0.1, 0.5, 0.8, 0.05], { label: "Even longer text far below the fold" })
    );
    expect(screenTitle(tree)).toBe("Welcome back, Jane");
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
