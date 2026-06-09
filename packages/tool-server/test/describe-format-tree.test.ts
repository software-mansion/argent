import { describe, expect, it } from "vitest";
import { formatDescribeTree } from "../src/tools/describe/format-tree";
import type { DescribeNode } from "../src/tools/describe/contract";

function leaf(
  partial: Partial<DescribeNode> & { role: string; frame: DescribeNode["frame"] }
): DescribeNode {
  return { children: [], ...partial };
}

function elementLines(out: string): string[] {
  return out.split("\n").filter((l) => /^ {2}\S/.test(l));
}

describe("formatDescribeTree", () => {
  it("renders flat ax-service children in reading order, one node per line", () => {
    const root: DescribeNode = {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        leaf({ role: "AXButton", label: "C", frame: { x: 0.3, y: 0.5, width: 0.1, height: 0.05 } }),
        leaf({
          role: "AXButton",
          label: "A",
          frame: { x: 0.05, y: 0.05, width: 0.1, height: 0.05 },
        }),
        leaf({ role: "AXButton", label: "B", frame: { x: 0.2, y: 0.5, width: 0.1, height: 0.05 } }),
      ],
    };
    const out = formatDescribeTree(root, { source: "ax-service" });
    expect(out).toContain("Source: ax-service");
    expect(out).toContain("Mode: flat");
    const lines = elementLines(out);
    expect(lines).toHaveLength(3);
    // top-to-bottom, then left-to-right
    expect(lines[0]).toContain('"A"');
    expect(lines[1]).toContain('"B"');
    expect(lines[2]).toContain('"C"');
  });

  it("renders a nested uiautomator tree with depth indentation and flags", () => {
    const root: DescribeNode = {
      role: "Screen",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        {
          role: "ScrollView",
          frame: { x: 0, y: 0.1, width: 1, height: 0.8 },
          scrollable: true,
          children: [
            leaf({
              role: "Button",
              label: "Like",
              frame: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
              clickable: true,
            }),
            leaf({
              role: "WebView",
              label: "[web-view] About",
              frame: { x: 0, y: 0.4, width: 1, height: 0.4 },
            }),
          ],
        },
      ],
    };
    const out = formatDescribeTree(root, { source: "uiautomator" });
    expect(out).toContain("Mode: nested");
    expect(out).toContain("ScrollView");
    expect(out).toMatch(/Button\s+"Like".*\[clickable\]/);
    expect(out).toContain("[web-view] About");
    const lines = out.split("\n");
    const buttonLine = lines.find((l) => l.includes('"Like"'))!;
    const scrollLine = lines.find((l) => l.includes("ScrollView"))!;
    // child indented deeper than its parent
    expect(buttonLine.search(/\S/)).toBeGreaterThan(scrollLine.search(/\S/));
  });

  it("escapes embedded newlines so per-line alignment survives", () => {
    const root: DescribeNode = {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        leaf({
          role: "AXGroup",
          label: "Hello\nWorld",
          frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.1 },
        }),
      ],
    };
    const out = formatDescribeTree(root, { source: "ax-service" });
    expect(out).toContain('"Hello\\nWorld"');
    const labelLines = out.split("\n").filter((l) => l.includes("Hello"));
    expect(labelLines).toHaveLength(1);
  });

  it("handles an empty tree without crashing", () => {
    const root: DescribeNode = {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [],
    };
    const out = formatDescribeTree(root, { source: "ax-service" });
    expect(out).toContain("Mode: flat");
    expect(out).toContain("ROOT  AXGroup");
    expect(elementLines(out)).toHaveLength(0);
  });

  // Regression for the user-reported bug: a Bluesky landing screen full of
  // images was rendering with both images stripped. Any node whose role marks
  // it as content (AXImage, AXButton, …) must survive even when label is
  // absent, so the agent at least sees that something is at that frame.
  it("keeps unlabeled content roles visible in flat mode", () => {
    const root: DescribeNode = {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        leaf({ role: "AXImage", frame: { x: 0.1, y: 0.1, width: 0.3, height: 0.2 } }),
        leaf({
          role: "AXImage",
          label: "Hero illustration",
          frame: { x: 0.1, y: 0.3, width: 0.3, height: 0.2 },
        }),
        leaf({ role: "AXButton", frame: { x: 0.4, y: 0.5, width: 0.2, height: 0.1 } }),
        // AXGroup with no label is a pure container — should still be dropped.
        leaf({ role: "AXGroup", frame: { x: 0.7, y: 0.7, width: 0.2, height: 0.1 } }),
      ],
    };
    const out = formatDescribeTree(root, { source: "ax-service" });
    const lines = elementLines(out);
    expect(lines.some((l) => /^\s*AXImage\b/.test(l) && !l.includes('"'))).toBe(true);
    expect(lines.some((l) => l.includes('"Hero illustration"'))).toBe(true);
    expect(lines.some((l) => /^\s*AXButton\b/.test(l) && !l.includes('"'))).toBe(true);
    expect(lines.some((l) => /^\s*AXGroup\b/.test(l))).toBe(false);
  });

  // Regression for issue #3 — the header already prints
  // `ROOT  <role>  <frame>`, so renderNested must not re-emit the root as the
  // first body line.
  it("does not duplicate the root node in nested mode", () => {
    const root: DescribeNode = {
      role: "Screen",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        {
          role: "FrameLayout",
          frame: { x: 0, y: 0.1, width: 1, height: 0.4 },
          children: [
            leaf({
              role: "Button",
              label: "Tap",
              frame: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
              clickable: true,
            }),
          ],
        },
      ],
    };
    const out = formatDescribeTree(root, { source: "uiautomator" });
    // Exactly one mention of Screen — the ROOT header line, never the body.
    const screenLines = out.split("\n").filter((l) => l.includes("Screen"));
    expect(screenLines).toHaveLength(1);
    expect(screenLines[0]).toMatch(/^ROOT\s/);
  });

  // Regression for issue #5 — iOS reports placeholder text under both `label`
  // and `value` for text inputs, doubling the byte cost for zero added signal.
  it("omits value= when value matches label", () => {
    const root: DescribeNode = {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        leaf({
          role: "AXGroup",
          label: "Username",
          value: "Username",
          frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.05 },
        }),
        leaf({
          role: "AXGroup",
          label: "Password",
          value: "•••••",
          frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.05 },
        }),
      ],
    };
    const out = formatDescribeTree(root, { source: "ax-service" });
    const usernameLine = out.split("\n").find((l) => l.includes('"Username"'))!;
    expect(usernameLine).not.toContain("value=");
    const passwordLine = out.split("\n").find((l) => l.includes('"Password"'))!;
    expect(passwordLine).toContain('value="•••••"');
  });

  // Regression for issue #4 — a long Compose / uiautomator class name no
  // longer pushes adjacent columns out of alignment. The role is emitted
  // verbatim (no truncation) with a single space before the rest.
  it("emits long role names without truncation and without padding-driven misalignment", () => {
    const root: DescribeNode = {
      role: "android.widget.FrameLayout",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        {
          role: "androidx.compose.ui.platform.ComposeView",
          frame: { x: 0, y: 0.1, width: 1, height: 0.4 },
          children: [
            leaf({
              role: "Image",
              label: "avatar",
              frame: { x: 0.1, y: 0.2, width: 0.2, height: 0.2 },
            }),
          ],
        },
      ],
    };
    const out = formatDescribeTree(root, { source: "uiautomator" });
    expect(out).toContain("androidx.compose.ui.platform.ComposeView");
    // Each body line: indentation, then the role token, then a single space,
    // then either annotations + double-space + frame, or directly the frame.
    for (const line of elementLines(out)) {
      const match = line.match(/^(\s+)(\S+)( .*)?$/);
      expect(match).not.toBeNull();
    }
  });

  // Regression for issue #7 — mode is decided by `source`, not by counting
  // grandchildren of the root. A native-devtools fallback that happens to
  // produce a flat-shaped tree must NOT drop to flat mode, and an ax-service
  // payload that happens to have a wrapping group with one grandchild must
  // stay flat.
  it("picks mode by source, not by tree silhouette", () => {
    const flatShaped: DescribeNode = {
      role: "Screen",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        leaf({ role: "Button", label: "X", frame: { x: 0.1, y: 0.1, width: 0.2, height: 0.05 } }),
      ],
    };
    expect(formatDescribeTree(flatShaped, { source: "uiautomator" })).toContain("Mode: nested");

    const accidentallyDeep: DescribeNode = {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        {
          role: "AXGroup",
          frame: { x: 0, y: 0, width: 1, height: 0.5 },
          children: [
            leaf({
              role: "AXStaticText",
              label: "Hi",
              frame: { x: 0.1, y: 0.1, width: 0.5, height: 0.04 },
            }),
          ],
        },
      ],
    };
    expect(formatDescribeTree(accidentallyDeep, { source: "ax-service" })).toContain("Mode: flat");
  });

  // The iOS native-devtools fallback shares the flat layout that ax-service
  // emits, so it should also report `Mode: flat`. (Source line still
  // distinguishes the two for agents that care.)
  it("treats native-devtools as flat", () => {
    const root: DescribeNode = {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        leaf({
          role: "AXButton",
          label: "Settings",
          frame: { x: 0.1, y: 0.1, width: 0.2, height: 0.05 },
        }),
      ],
    };
    const out = formatDescribeTree(root, { source: "native-devtools" });
    expect(out).toContain("Source: native-devtools");
    expect(out).toContain("Mode: flat");
  });

  // The header text is part of the agent-visible response, so it must keep
  // pointing at gesture-tap / gesture-swipe / gesture-pinch and the centre
  // formula. If this drifts again the runtime help is silently misleading.
  it("renders the coordinate-space + tap-formula header on every call", () => {
    const empty: DescribeNode = {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [],
    };
    const out = formatDescribeTree(empty, { source: "ax-service" });
    expect(out).toContain("normalized [0,1] fractions of the screen");
    expect(out).toContain("gesture-tap");
    expect(out).toContain("tap_x = frame.x + frame.width / 2");
    expect(out).toContain("tap_y = frame.y + frame.height / 2");
  });

  // Bluesky-style names mix emoji, ZWJ sequences, and bidirectional isolate
  // markers (U+202A/U+202C). Those must pass through escapeForLine unchanged
  // — only ASCII control chars (\\n, \\r, \\t) get backslash-escaped.
  it("preserves emoji and bidi isolates in labels", () => {
    const root: DescribeNode = {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        leaf({
          role: "AXStaticText",
          label: "‪Dovewoman 💙 🇺🇦 💙‬",
          frame: { x: 0.1, y: 0.1, width: 0.5, height: 0.02 },
        }),
      ],
    };
    const out = formatDescribeTree(root, { source: "ax-service" });
    expect(out).toContain("‪Dovewoman 💙 🇺🇦 💙‬");
    expect(out).not.toContain("\\u");
  });

  // Combined interactivity flags all need to surface in a single `[…]` group
  // in a deterministic order, otherwise an LLM cannot pattern-match on them.
  it("emits all interactivity flags together in a stable order", () => {
    const root: DescribeNode = {
      role: "Screen",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        leaf({
          role: "Switch",
          label: "Wifi",
          frame: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
          clickable: true,
          longClickable: true,
          scrollable: false,
          checkable: true,
          checked: true,
          disabled: true,
        }),
        leaf({
          role: "View",
          frame: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 },
          scrollHidden: 7,
        }),
      ],
    };
    const out = formatDescribeTree(root, { source: "uiautomator" });
    expect(out).toMatch(/\[clickable,long-clickable,checked,disabled\]/);
    expect(out).toMatch(/\[scrollHidden=7\]/);
  });

  // scrollHidden=0 is the "no clipped children" signal from the Android
  // parser; emitting the flag at zero would be misleading.
  it("does not emit scrollHidden when the count is zero", () => {
    const root: DescribeNode = {
      role: "Screen",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        leaf({
          role: "Button",
          label: "Tap",
          frame: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
          scrollHidden: 0,
        }),
      ],
    };
    const out = formatDescribeTree(root, { source: "uiautomator" });
    expect(out).not.toContain("scrollHidden");
  });

  // identifier is the Android resource-id (and the iOS native-devtools
  // accessibility identifier). It's the most stable thing to match on, so it
  // must round-trip through the formatter verbatim.
  it("surfaces the identifier as an id= attribute", () => {
    const root: DescribeNode = {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        leaf({
          role: "AXButton",
          identifier: "com.bluesky:id/like_button",
          label: "Like",
          frame: { x: 0.1, y: 0.5, width: 0.2, height: 0.05 },
        }),
      ],
    };
    const out = formatDescribeTree(root, { source: "ax-service" });
    expect(out).toContain('id="com.bluesky:id/like_button"');
  });

  // The reading-order sort in flat mode must be stable, so two elements that
  // share the same (y, x) keep their source order. (Bluesky-style timelines
  // have rows where action buttons sometimes report identical frames.)
  it("stably sorts equal-frame nodes in flat mode", () => {
    const sharedFrame = { x: 0.1, y: 0.5, width: 0.2, height: 0.05 };
    const root: DescribeNode = {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        leaf({ role: "AXButton", label: "first", frame: sharedFrame }),
        leaf({ role: "AXButton", label: "second", frame: sharedFrame }),
        leaf({ role: "AXButton", label: "third", frame: sharedFrame }),
      ],
    };
    const lines = elementLines(formatDescribeTree(root, { source: "ax-service" }));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('"first"');
    expect(lines[1]).toContain('"second"');
    expect(lines[2]).toContain('"third"');
  });

  // Frames are always rendered to exactly three decimals. This is the
  // precision agents pass back to gesture-tap; drifting it would silently
  // change tap targets across screens.
  it("always renders frames to three decimal places", () => {
    const root: DescribeNode = {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        leaf({
          role: "AXButton",
          label: "X",
          frame: { x: 0.123456789, y: 0.5, width: 0.1, height: 0.05 },
        }),
      ],
    };
    const out = formatDescribeTree(root, { source: "ax-service" });
    expect(out).toMatch(/\(0\.123, 0\.500, 0\.100, 0\.050\)/);
  });

  // Long Compose / RN trees can stack 200+ wrapper layers. The renderer uses
  // an iterative DFS specifically to avoid a recursive stack overflow there.
  it("handles deeply nested trees without recursing the JS stack", () => {
    let inner: DescribeNode = leaf({
      role: "Button",
      label: "deep",
      frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.05 },
      clickable: true,
    });
    for (let i = 0; i < 500; i++) {
      inner = {
        role: "FrameLayout",
        frame: { x: 0, y: 0, width: 1, height: 1 },
        children: [inner],
      };
    }
    const root: DescribeNode = {
      role: "Screen",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [inner],
    };
    const out = formatDescribeTree(root, { source: "uiautomator" });
    expect(out).toContain('"deep"');
    expect(out.split("\n").length).toBeGreaterThan(500);
  });

  // The trim rule must only strip "value === label" — value strings that
  // happen to start with the label (e.g. a search field whose label is
  // "Search" and value is "Search query") need to survive.
  it("keeps value when it differs from label even by a suffix", () => {
    const root: DescribeNode = {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        leaf({
          role: "AXTextField",
          label: "Search",
          value: "Search ",
          frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.05 },
        }),
      ],
    };
    const out = formatDescribeTree(root, { source: "ax-service" });
    expect(out).toContain('value="Search "');
  });

  // hasContent() must NOT count a wrapper as content just because checked is
  // false — the field defaults to `undefined`, but a node where the
  // adapter explicitly set checkable=false should still drop out.
  it("does not treat checkable=false as a content signal", () => {
    const root: DescribeNode = {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        leaf({
          role: "AXGroup",
          frame: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
          checkable: false,
        }),
      ],
    };
    const out = formatDescribeTree(root, { source: "ax-service" });
    expect(elementLines(out)).toHaveLength(0);
  });

  // Regression: nested mode previously keyed on "uiautomator" only, so
  // "android-devtools" responses rendered flat and lost all descendants.
  it("renders android-devtools source in nested mode", () => {
    const root: DescribeNode = {
      role: "Screen",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        {
          role: "ScrollView",
          frame: { x: 0, y: 0.1, width: 1, height: 0.8 },
          scrollable: true,
          children: [
            leaf({
              role: "Button",
              label: "Like",
              frame: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
              clickable: true,
            }),
          ],
        },
      ],
    };
    const out = formatDescribeTree(root, { source: "android-devtools" });
    expect(out).toContain("Mode: nested");
    expect(out).toMatch(/Button\s+"Like"/);
  });
});
