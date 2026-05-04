import { describe, expect, it } from "vitest";
import { compressDescribeTree } from "../src/tools/describe/compress";
import type { DescribeNode } from "../src/tools/describe/contract";

function leaf(role: string, label?: string, identifier?: string): DescribeNode {
  return {
    role,
    frame: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
    children: [],
    ...(label !== undefined ? { label } : {}),
    ...(identifier !== undefined ? { identifier } : {}),
  };
}

function wrap(
  role: string,
  children: DescribeNode[],
  extras: Partial<DescribeNode> = {}
): DescribeNode {
  return {
    role,
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children,
    ...extras,
  };
}

describe("compressDescribeTree — wrapper promotion", () => {
  it("collapses a chain of empty structural wrappers around a leaf", () => {
    // Mirrors the Android pixel-launcher dump: 5+ FrameLayout/LinearLayout
    // wrappers with no content-desc, no resource-id, full-screen bounds.
    const input = wrap("FrameLayout", [
      wrap("LinearLayout", [
        wrap("FrameLayout", [
          wrap("FrameLayout", [
            wrap("FrameLayout", [leaf("Button", "Submit", "com.example:id/submit")]),
          ]),
        ]),
      ]),
    ]);

    const out = compressDescribeTree(input);

    expect(out.role).toBe("FrameLayout"); // root preserved
    expect(out.children).toHaveLength(1);
    expect(out.children[0]?.role).toBe("Button");
    expect(out.children[0]?.label).toBe("Submit");
    expect(out.children[0]?.identifier).toBe("com.example:id/submit");
  });

  it("preserves structural wrappers that carry an identifier", () => {
    // resource-ids like `id/scrim_view` may not be human-targeted, but they're
    // the only stable handle uiautomator gives for some screens — keep them.
    const input = wrap("FrameLayout", [
      wrap("ScrollView", [leaf("StaticText", "Mon, May 4")], {
        identifier: "com.example:id/workspace",
      }),
    ]);
    const out = compressDescribeTree(input);
    expect(out.children).toHaveLength(1);
    expect(out.children[0]?.identifier).toBe("com.example:id/workspace");
    expect(out.children[0]?.children[0]?.role).toBe("StaticText");
  });

  it("preserves structural wrappers that carry a label", () => {
    const input = wrap("FrameLayout", [
      wrap("AXGroup", [leaf("AXStaticText", "Subtitle")], { label: "Calendar" }),
    ]);
    const out = compressDescribeTree(input);
    expect(out.children[0]?.label).toBe("Calendar");
    expect(out.children[0]?.role).toBe("AXGroup");
  });

  it("preserves wrappers whose role is semantic (ScrollView, WebView, …)", () => {
    // ScrollView matters even without a label: agents look at the role to
    // decide whether to scroll. Same for WebView / Button / etc.
    const input = wrap("FrameLayout", [
      wrap("ScrollView", [leaf("StaticText", "Row 1"), leaf("StaticText", "Row 2")]),
    ]);
    const out = compressDescribeTree(input);
    expect(out.children).toHaveLength(1);
    expect(out.children[0]?.role).toBe("ScrollView");
    expect(out.children[0]?.children).toHaveLength(2);
  });

  it("drops empty noise leaves entirely", () => {
    const input = wrap("FrameLayout", [
      leaf("FrameLayout"),
      leaf("View"),
      leaf("Button", "Keep me"),
    ]);
    const out = compressDescribeTree(input);
    expect(out.children).toHaveLength(1);
    expect(out.children[0]?.label).toBe("Keep me");
  });

  it("promotes multiple children of a noise wrapper up one level", () => {
    const input = wrap("FrameLayout", [
      wrap("LinearLayout", [
        leaf("Button", "Phone"),
        leaf("Button", "Messages"),
        leaf("Button", "Camera"),
      ]),
    ]);
    const out = compressDescribeTree(input);
    expect(out.children.map((c) => c.label)).toEqual(["Phone", "Messages", "Camera"]);
  });

  it("preserves the root node even when it would otherwise be a noise wrapper", () => {
    // Without this guard the tree contract (single root) would be violated
    // whenever the synthetic Screen / AXGroup root gets flattened.
    const input: DescribeNode = {
      role: "Screen",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [leaf("Button", "OK")],
    };
    const out = compressDescribeTree(input);
    expect(out.role).toBe("Screen");
    expect(out.children).toHaveLength(1);
  });
});

describe("compressDescribeTree — same-frame single-child wrapper collapse", () => {
  it("drops a structural wrapper whose only child has the same frame", () => {
    // Reproduces the launcher chain: Screen → FrameLayout(id=content) →
    // FrameLayout(id=launcher) → FrameLayout(id=drag_layer). All three
    // FrameLayouts are full-screen single-child containers.
    const input = wrap("Screen", [
      wrap(
        "FrameLayout",
        [
          wrap(
            "FrameLayout",
            [wrap("FrameLayout", [leaf("Button", "Submit")], { identifier: "id/drag_layer" })],
            { identifier: "id/launcher" }
          ),
        ],
        { identifier: "id/content" }
      ),
    ]);
    const out = compressDescribeTree(input);
    // FrameLayout id=drag_layer has 1 child (Button) — Button frame is 0.1/0.2/0.3/0.4 vs
    // wrapper 0/0/1/1, so drag_layer is kept (different frame). The two
    // outer FrameLayouts (content, launcher) are full-screen single-child
    // wrappers around drag_layer (same frame), so they collapse with their
    // identifiers folded into drag_layer (which already has its own).
    expect(out.role).toBe("Screen");
    expect(out.children).toHaveLength(1);
    expect(out.children[0]?.role).toBe("FrameLayout");
    expect(out.children[0]?.identifier).toBe("id/drag_layer");
  });

  it("forwards a wrapper's identifier to a child that has none", () => {
    // Realistic shape: a `Button label='Submit'` (no resource-id of its own)
    // wrapped in a same-bounds FrameLayout that owns the resource-id. After
    // collapse the Button keeps its label and inherits id=action_button so
    // the targetable handle survives.
    const child: DescribeNode = {
      role: "Button",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [],
      label: "Submit",
    };
    const input = wrap("Screen", [
      wrap("FrameLayout", [child], { identifier: "id/action_button" }),
    ]);
    const out = compressDescribeTree(input);
    expect(out.children[0]?.role).toBe("Button");
    expect(out.children[0]?.label).toBe("Submit");
    expect(out.children[0]?.identifier).toBe("id/action_button");
  });

  it("does not collapse a multi-child wrapper even if all bounds align", () => {
    // hotseat-style grouping: spatial siblings under one ID. Collapsing it
    // would lose a meaningful container handle.
    const input = wrap("Screen", [
      wrap(
        "ViewGroup",
        [leaf("StaticText", "Phone"), leaf("StaticText", "Messages"), leaf("StaticText", "Camera")],
        { identifier: "id/hotseat" }
      ),
    ]);
    const out = compressDescribeTree(input);
    expect(out.children[0]?.identifier).toBe("id/hotseat");
    expect(out.children[0]?.children).toHaveLength(3);
  });

  it("does not collapse when frames differ", () => {
    const child: DescribeNode = {
      role: "Button",
      frame: { x: 0.4, y: 0.45, width: 0.2, height: 0.05 },
      children: [],
      label: "OK",
    };
    const wrapper = wrap("FrameLayout", [child], { identifier: "id/footer" });
    const input = wrap("Screen", [wrapper]);
    const out = compressDescribeTree(input);
    // wrapper frame {0,0,1,1} != child frame {0.4,...} → wrapper kept
    expect(out.children[0]?.identifier).toBe("id/footer");
    expect(out.children[0]?.children[0]?.label).toBe("OK");
  });

  it("refuses to collapse when wrapper and child carry conflicting labels", () => {
    // Two real semantic layers stacked at the same bounds. Folding into the
    // child would silently drop "Calendar widget" — keep both layers visible.
    const child: DescribeNode = {
      role: "AXButton",
      frame: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
      children: [],
      label: "Open",
    };
    const wrapper: DescribeNode = {
      role: "AXGroup",
      frame: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
      children: [child],
      label: "Calendar widget",
    };
    const out = compressDescribeTree(wrap("Screen", [wrapper]));
    expect(out.children[0]?.role).toBe("AXGroup");
    expect(out.children[0]?.label).toBe("Calendar widget");
    expect(out.children[0]?.children[0]?.label).toBe("Open");
  });

  it("collapses when wrapper and child have differing identifiers, keeping the child's", () => {
    // resource-id stacks like `id/content → id/launcher → id/drag_layer` are
    // platform-internal noise — collapse them aggressively so agents reach
    // the actionable child without crawling five layers. The child's id wins
    // since it's the closest to the actual rendered element.
    const child: DescribeNode = {
      role: "Button",
      frame: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
      children: [],
      identifier: "id/inner",
      label: "Submit",
    };
    const wrapper: DescribeNode = {
      role: "FrameLayout",
      frame: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
      children: [child],
      identifier: "id/outer",
    };
    const out = compressDescribeTree(wrap("Screen", [wrapper]));
    expect(out.children).toHaveLength(1);
    expect(out.children[0]?.role).toBe("Button");
    expect(out.children[0]?.identifier).toBe("id/inner");
    expect(out.children[0]?.label).toBe("Submit");
  });

  it("still collapses when the wrapper's label matches the child's exactly", () => {
    // No information lost — fold the redundant layer.
    const child: DescribeNode = {
      role: "Button",
      frame: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
      children: [],
      label: "Submit",
    };
    const wrapper: DescribeNode = {
      role: "FrameLayout",
      frame: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
      children: [child],
      label: "Submit",
    };
    const out = compressDescribeTree(wrap("Screen", [wrapper]));
    expect(out.children).toHaveLength(1);
    expect(out.children[0]?.role).toBe("Button");
    expect(out.children[0]?.label).toBe("Submit");
  });
});

describe("compressDescribeTree — sibling deduplication", () => {
  it("drops adjacent and non-adjacent identical siblings", () => {
    // Reproduces the iOS home-screen widget repeat: AX service emits the Map /
    // calendar header / "No events today" trio twice. With three other items
    // mixed in, adjacent-only dedup would miss it.
    const child = (label: string): DescribeNode => ({
      role: "AXStaticText",
      frame: { x: 0.1, y: 0.1, width: 0.5, height: 0.05 },
      children: [],
      label,
    });
    const input = wrap("AXGroup", [
      child("Map"),
      child("MONDAY, 04 MAY"),
      child("No events today"),
      child("Map"), // duplicate
      child("MONDAY, 04 MAY"), // duplicate
      child("No events today"), // duplicate
      child("Calendar"),
    ]);
    const out = compressDescribeTree(input);
    expect(out.children.map((c) => c.label)).toEqual([
      "Map",
      "MONDAY, 04 MAY",
      "No events today",
      "Calendar",
    ]);
  });

  it("treats subtree shape as part of the dedup key", () => {
    // Same role+frame+label, but different children — must not collapse.
    const a: DescribeNode = {
      role: "AXGroup",
      frame: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
      children: [
        {
          role: "AXButton",
          frame: { x: 0.2, y: 0.2, width: 0.1, height: 0.1 },
          children: [],
          label: "A",
        },
      ],
      label: "Group",
    };
    const b: DescribeNode = {
      ...a,
      children: [
        {
          role: "AXButton",
          frame: { x: 0.2, y: 0.2, width: 0.1, height: 0.1 },
          children: [],
          label: "B",
        },
      ],
    };
    const out = compressDescribeTree(wrap("AXGroup", [a, b], { label: "root" }));
    expect(out.children).toHaveLength(2);
  });

  it("does not dedup elements that differ only in identifier", () => {
    // resource-ids are how agents target Android views — never collapse two
    // siblings whose only distinguishing field is identifier.
    const input = wrap(
      "AXGroup",
      [
        {
          role: "Image",
          frame: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 },
          children: [],
          label: "Icon",
          identifier: "id/a",
        },
        {
          role: "Image",
          frame: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 },
          children: [],
          label: "Icon",
          identifier: "id/b",
        },
      ],
      { label: "root" }
    );
    const out = compressDescribeTree(input);
    expect(out.children).toHaveLength(2);
    expect(out.children.map((c) => c.identifier)).toEqual(["id/a", "id/b"]);
  });
});

describe("compressDescribeTree — frame rounding", () => {
  it("rounds normalized components to 4 decimals", () => {
    // 0.07960199005 → 0.0796 keeps the tap point inside the same pixel on a
    // 1080-wide screen (Δ ≈ 0.0000019 ≈ 0.002 px) while halving the byte count.
    const input: DescribeNode = {
      role: "Button",
      frame: { x: 0.07960199005, y: 0.180778032037, width: 0.39303482587, height: 0.05823942 },
      children: [],
      label: "x",
    };
    const out = compressDescribeTree(wrap("AXGroup", [input], { label: "root" }));
    expect(out.children[0]?.frame).toEqual({
      x: 0.0796,
      y: 0.1808,
      width: 0.393,
      height: 0.0582,
    });
  });

  it("rounds the root frame too", () => {
    const input: DescribeNode = {
      role: "Screen",
      frame: { x: 0.0001234, y: 0.0001234, width: 0.9999876, height: 0.9999876 },
      children: [],
    };
    const out = compressDescribeTree(input);
    expect(out.frame).toEqual({ x: 0.0001, y: 0.0001, width: 1, height: 1 });
  });
});

describe("compressDescribeTree — idempotence", () => {
  it("is idempotent: compressing twice equals compressing once", () => {
    const input = wrap("FrameLayout", [
      wrap("LinearLayout", [leaf("Button", "Submit", "id/submit"), leaf("FrameLayout")]),
      leaf("StaticText", "Hello"),
    ]);
    const once = compressDescribeTree(input);
    const twice = compressDescribeTree(once);
    expect(twice).toEqual(once);
  });

  it("preserves explicit value field", () => {
    const input = wrap("AXGroup", [
      {
        role: "AXAdjustable",
        frame: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 },
        children: [],
        label: "Volume",
        value: "50%",
      },
    ]);
    const out = compressDescribeTree(input);
    expect(out.children[0]?.value).toBe("50%");
  });
});

describe("compressDescribeTree — does not strip undefined optional fields", () => {
  it("emits children-only nodes without label/identifier/value keys", () => {
    // A node with no semantic info but a semantic role (e.g. ScrollView) should
    // serialise without `label: undefined` / `identifier: undefined` / `value:
    // undefined` keys, otherwise the JSON gets noisier than before compression.
    const input = wrap("AXGroup", [wrap("ScrollView", [leaf("StaticText", "x")])]);
    const out = compressDescribeTree(input);
    const sv = out.children[0]!;
    expect(sv.role).toBe("ScrollView");
    expect("label" in sv).toBe(false);
    expect("identifier" in sv).toBe(false);
    expect("value" in sv).toBe(false);
  });
});

describe("compressDescribeTree — input safety & no-op shapes", () => {
  it("does not mutate the input tree", () => {
    const input: DescribeNode = {
      role: "Screen",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        wrap("FrameLayout", [
          wrap("LinearLayout", [
            {
              role: "Button",
              frame: { x: 0.07960199005, y: 0.180778032037, width: 0.3, height: 0.05 },
              children: [],
              label: "Submit",
              identifier: "id/submit",
            },
          ]),
        ]),
      ],
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    compressDescribeTree(input);
    expect(input).toEqual(snapshot);
  });

  it("handles a root with empty children", () => {
    const input: DescribeNode = {
      role: "Screen",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [],
    };
    const out = compressDescribeTree(input);
    expect(out.role).toBe("Screen");
    expect(out.children).toEqual([]);
  });

  it("returns an equivalent tree when no node is compressible", () => {
    const input = wrap("Screen", [
      {
        role: "Button",
        frame: { x: 0.1, y: 0.1, width: 0.2, height: 0.05 },
        children: [],
        label: "Yes",
      },
      {
        role: "Button",
        frame: { x: 0.4, y: 0.1, width: 0.2, height: 0.05 },
        children: [],
        label: "No",
      },
    ]);
    const out = compressDescribeTree(input);
    expect(out.children).toHaveLength(2);
    expect(out.children.map((c) => c.label)).toEqual(["Yes", "No"]);
  });
});
