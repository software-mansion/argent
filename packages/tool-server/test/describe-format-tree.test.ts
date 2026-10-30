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

  // Physical iOS: the XCUITest runner is single-finger only, so the header
  // must not recommend gesture-pinch (agents follow it verbatim, straight into
  // a capability reject) and must say where zoom lives instead.
  it("omits gesture-pinch from the xcuitest-runner header and names the alternative", () => {
    const root: DescribeNode = {
      role: "Application",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        leaf({
          role: "AXButton",
          label: "Zoom in",
          frame: { x: 0.1, y: 0.1, width: 0.2, height: 0.05 },
        }),
      ],
    };
    const out = formatDescribeTree(root, { source: "xcuitest-runner" });
    expect(out).toContain("Source: xcuitest-runner");
    expect(out).toContain("Mode: nested");
    expect(out).not.toContain("gesture-pinch");
    expect(out).toContain(
      "Pass them straight to gesture-tap / gesture-swipe, which expect this same space. " +
        "No two-finger gestures on physical iOS."
    );
  });

  // format-tree.ts is deployed shared code: the xcuitest-runner branch above
  // must leave every other source byte-identical. Pin the full simulator
  // (ax-service) output, not a substring, so any accidental drift in deployed
  // header text fails loudly.
  it("keeps the simulator-source output byte-identical to the deployed string", () => {
    const empty: DescribeNode = {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [],
    };
    const out = formatDescribeTree(empty, { source: "ax-service" });
    expect(out).toBe(
      "Source: ax-service\n" +
        "Mode: flat\n" +
        "Coordinates are normalized [0,1] fractions of the screen (x, y, width, height), not pixels.\n" +
        "Pass them straight to gesture-tap / gesture-swipe / gesture-pinch, which expect this same space.\n" +
        "To tap an element, use its centre: tap_x = frame.x + frame.width / 2, tap_y = frame.y + frame.height / 2.\n" +
        "\n" +
        "ROOT  AXGroup (0.000, 0.000, 1.000, 1.000)\n"
    );
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

    // `uitest` reports `longClickable`, but HarmonyOS has no long-press tool.
    const harmony = formatDescribeTree(root, { source: "harmony-uitest" });
    expect(harmony).toMatch(/\[clickable,checked,disabled\]/);
    expect(harmony).not.toContain("long-clickable");
    // Suppressed at render: most of those nodes carry no other flag.
    expect(harmony).toMatch(/\[scrollHidden=7\]/);
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

  // The Chromium walker sets `checked` alone, so a ticked box has to render
  // differently from an unticked one without any `checkable` companion.
  it("renders checked on a node that carries no checkable", () => {
    const box = (checked: boolean): DescribeNode => ({
      role: "Screen",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        leaf({
          role: "input",
          label: "Accept terms",
          identifier: "terms",
          frame: { x: 0, y: 0.1, width: 0.04, height: 0.04 },
          clickable: true,
          checked,
        }),
      ],
    });
    const ticked = elementLines(formatDescribeTree(box(true), { source: "cdp-dom" }));
    const unticked = elementLines(formatDescribeTree(box(false), { source: "cdp-dom" }));
    expect(ticked[0]).toContain("[clickable,checked]");
    expect(unticked[0]).toContain("[clickable]");
    expect(ticked[0]).not.toEqual(unticked[0]);
  });

  // A `<div role="checkbox" aria-checked="true">` carries no other content
  // signal, so hasContent() has to count `checked` or the node is dropped.
  it("keeps an unlabeled node whose only content signal is checked", () => {
    const root: DescribeNode = {
      role: "Screen",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        leaf({
          role: "div",
          frame: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
          checked: true,
        }),
      ],
    };
    const lines = elementLines(formatDescribeTree(root, { source: "cdp-dom" }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[checked]");
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

describe("formatDescribeTree — overlapping elements", () => {
  const node = (role: string, label: string, x: number, y: number, w: number, h: number) => ({
    role,
    label,
    frame: { x, y, width: w, height: h },
    children: [],
  });
  // A long list: the "Add Player" row slid under the sticky "Continue" footer.
  const root = {
    role: "AXGroup",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children: [
      node("AXGroup", "Add Player", 0.055, 0.845, 0.891, 0.09),
      node("AXButton", "Continue", 0.055, 0.86, 0.891, 0.088),
      node("AXStaticText", "Add Players", 0.299, 0.075, 0.402, 0.055),
      node("AXButton", "Options", 0.871, 0.086, 0.075, 0.034),
    ],
  };
  const lineOf = (out: string, label: string) =>
    out.split("\n").find((l) => new RegExp(`^\\s+\\w+ "${label}"`).test(l))!;

  it("marks both elements of a partial overlap", () => {
    const out = formatDescribeTree(root as any, { source: "ax-service" });
    expect(lineOf(out, "Add Player")).toContain(
      `overlaps "Continue": either may be on top, check a screenshot before tapping`
    );
    expect(lineOf(out, "Continue")).toContain(`overlaps "Add Player"`);
  });

  it("leaves separate elements alone", () => {
    const out = formatDescribeTree(root as any, { source: "ax-service" });
    expect(lineOf(out, "Add Players")).not.toContain("overlaps");
    expect(lineOf(out, "Options")).not.toContain("overlaps");
  });

  it("ignores two overlapping labels", () => {
    const labels = {
      ...root,
      children: [
        node("AXStaticText", "Title", 0.1, 0.1, 0.5, 0.05),
        node("AXStaticText", "Subtitle", 0.1, 0.13, 0.5, 0.05),
      ],
    };
    expect(formatDescribeTree(labels as any, { source: "ax-service" })).not.toContain("overlaps");
  });

  it("ignores an element nested inside another (text inside a button)", () => {
    const nested = {
      ...root,
      children: [
        node("AXButton", "Buy", 0.1, 0.5, 0.8, 0.1),
        node("AXStaticText", "Buy now", 0.2, 0.52, 0.3, 0.05),
      ],
    };
    expect(formatDescribeTree(nested as any, { source: "ax-service" })).not.toContain("overlaps");
  });

  const render = (...children: ReturnType<typeof node>[]) =>
    formatDescribeTree({ ...root, children } as any, { source: "ax-service" });
  const button = (label: string, x: number, y: number) => node("AXButton", label, x, y, 0.4, 0.1);

  it("ignores an overlap of a quarter or less of the smaller element", () => {
    // 0.4 x 0.02 shared out of 0.4 x 0.1: 20%.
    expect(render(button("Top", 0.1, 0.1), button("Bottom", 0.1, 0.18))).not.toContain("overlaps");
  });

  it("ignores elements that only touch diagonally", () => {
    expect(render(button("A", 0.1, 0.1), button("B", 0.6, 0.3))).not.toContain("overlaps");
    expect(
      render(node("AXButton", "A", 0.1, 0.1, 0.2, 0.1), node("AXButton", "B", 0.4, 0.3, 0.2, 0.1))
    ).not.toContain("overlaps");
  });

  it("measures the overlap against the smaller element", () => {
    // Fully inside a larger group: 100% of the smaller one, 60% of the larger.
    expect(
      render(
        node("AXGroup", "Pay", 0.1, 0.5, 0.4, 0.1),
        node("AXButton", "Now", 0.15, 0.51, 0.3, 0.08)
      )
    ).not.toContain("overlaps");
  });

  it("ignores an element that lies wholly inside another", () => {
    for (const [outer, inner] of [
      [
        node("AXButton", "Continue", 0.055, 0.86, 0.891, 0.088),
        node("AXGroup", "Add Player", 0.055, 0.858, 0.891, 0.09),
      ],
      [
        node("AXButton", "Auto-Correction", 0, 0.3, 1, 0.06),
        node("AXButton", "chevron", 0.9, 0.31, 0.05, 0.04),
      ],
      [
        node("AXTextField", "Search", 0.05, 0.1, 0.9, 0.05),
        node("AXButton", "Dictate", 0.85, 0.105, 0.08, 0.04),
      ],
      [
        node("AXGroup", "Calendar", 0.523, 0.096, 0.395, 0.206),
        node("AXGroup", "Calendar", 0.527, 0.098, 0.386, 0.178),
      ],
    ]) {
      expect(render(outer!, inner!)).not.toContain("overlaps");
      expect(render(inner!, outer!)).not.toContain("overlaps");
    }
  });

  it("notes an element whose centre lies 92% inside another, but not 97%", () => {
    const outer = node("AXButton", "Outer", 0, 0.5, 1, 0.125);
    const lineFor = (y: number) =>
      lineOf(render(outer, node("AXButton", "Inner", 0.25, y, 0.5, 0.125)), "Inner");
    expect(lineFor(0.51)).toContain(`overlaps "Outer":`);
    expect(lineFor(0.503)).not.toContain("overlaps");
  });

  it("notes only the element whose centre the other covers", () => {
    const out = render(
      node("AXTextField", "Search apps", 0.05, 0.07, 0.9, 0.05),
      node("AXButton", "Voice search", 0.8, 0.06, 0.15, 0.07)
    );
    expect(lineOf(out, "Search apps")).not.toContain("overlaps");
    expect(lineOf(out, "Voice search")).toContain(`overlaps "Search apps":`);
  });

  it("ignores buttons inside their own tab bar", () => {
    for (const role of ["AXGroup", "AXTabBar"]) {
      expect(
        render(
          node(role, "Tab Bar", 0, 0.913, 1, 0.087),
          node("AXButton", "Home", 0, 0.92, 0.25, 0.06),
          node("AXButton", "Search", 0.25, 0.92, 0.25, 0.06)
        )
      ).not.toContain("overlaps");
    }
  });

  it("ignores an overlap of exactly a quarter", () => {
    // 0.5 x 0.0625 shared out of 0.5 x 0.25, all exact in binary.
    expect(
      render(node("AXButton", "A", 0, 0, 0.5, 0.25), node("AXButton", "B", 0, 0.1875, 0.5, 0.25))
    ).not.toContain("overlaps");
  });

  it("notes what a sheet of exactly half the screen covers, but not the sheet", () => {
    const out = render(
      node("AXButton", "Sheet", 0, 0.5, 1, 0.5),
      node("AXButton", "Behind", 0.25, 0.4375, 0.5, 0.375)
    );
    expect(lineOf(out, "Behind")).toContain(`overlaps "Sheet":`);
    expect(lineOf(out, "Sheet")).not.toContain("overlaps");
  });

  it("marks a button over a text row", () => {
    const out = render(
      node("AXStaticText", "Add Player", 0.055, 0.845, 0.891, 0.09),
      node("AXButton", "Continue", 0.055, 0.86, 0.891, 0.088)
    );
    expect(lineOf(out, "Add Player")).toContain(`overlaps "Continue":`);
    expect(lineOf(out, "Continue")).toContain(`overlaps "Add Player":`);
  });

  it("marks a text that sticks out of a button", () => {
    const out = render(
      node("AXButton", "Pay", 0.1, 0.1, 0.4, 0.08),
      node("AXStaticText", "Promo", 0.1, 0.15, 0.2, 0.05)
    );
    expect(lineOf(out, "Promo")).toContain(`overlaps "Pay":`);
  });

  it("ignores headings and images over text", () => {
    for (const role of ["AXHeading", "AXImage"]) {
      expect(
        render(
          node(role, "Top", 0.1, 0.1, 0.5, 0.05),
          node("AXStaticText", "Under", 0.1, 0.12, 0.5, 0.05)
        )
      ).not.toContain("overlaps");
    }
  });

  it("marks a text field that has only a value", () => {
    const field = { ...node("AXTextField", "", 0.1, 0.15, 0.4, 0.1), value: "Jane" };
    const out = render(button("Clear", 0.1, 0.1), field);
    expect(lineOf(out, "Clear")).toContain(`overlaps value="Jane":`);
  });

  it("names a partner by its label before its identifier", () => {
    const save = { ...button("Save", 0.1, 0.15), identifier: "save-btn" };
    expect(lineOf(render(button("Cancel", 0.1, 0.1), save), "Cancel")).toContain(
      `overlaps "Save":`
    );
  });

  it("lists at most three partners, largest overlap first", () => {
    const out = render(
      node("AXButton", "Banner", 0.1, 0.1, 0.8, 0.1),
      node("AXButton", "Three", 0.45, 0.13, 0.1, 0.1),
      node("AXButton", "One", 0.45, 0.11, 0.1, 0.1),
      node("AXButton", "Four", 0.45, 0.14, 0.1, 0.1),
      node("AXButton", "Two", 0.45, 0.12, 0.1, 0.1)
    );
    expect(lineOf(out, "Banner")).toContain(`overlaps "One", "Two", "Three": either may be on top`);
  });

  it("notes what a drawer of over half the screen covers, but not the drawer", () => {
    const out = render(
      node("AXGroup", "Drawer", 0, 0.133, 0.844, 0.84),
      node("AXButton", "Search", 0.5, 0.886, 0.5, 0.087)
    );
    expect(lineOf(out, "Search")).toContain(`overlaps "Drawer":`);
    expect(lineOf(out, "Drawer")).not.toContain("overlaps");
  });

  it("skips sliders and UIKit scroll indicators", () => {
    for (const other of [
      node("AXAdjustable", "Volume", 0.1, 0.15, 0.4, 0.1),
      node("AXGroup", "Vertical scroll bar, 1 page", 0.1, 0.15, 0.4, 0.1),
      node("AXGroup", "Horizontal scroll bar, 2 pages", 0.1, 0.15, 0.4, 0.1),
      node("AXGroup", "Vertikaler Rollbalken, 1 Seite", 0.1, 0.15, 0.4, 0.1),
      node("AXGroup", "Pasek przewijania pionowego, 1 strona", 0.1, 0.15, 0.4, 0.1),
      node("AXGroup", "垂直スクロールバー、1ページ", 0.1, 0.15, 0.4, 0.1),
    ]) {
      expect(render(button("Allow Once", 0.1, 0.1), other)).not.toContain("overlaps");
    }
  });

  it("marks a button that only mentions a scroll bar", () => {
    const out = render(
      button("Allow Once", 0.1, 0.1),
      button("Always show vertical scroll bar", 0.1, 0.15)
    );
    expect(lineOf(out, "Allow Once")).toContain(`overlaps "Always show vertical scroll bar":`);
  });

  it("ignores runs of a wrapped web paragraph", () => {
    expect(
      render(
        node("AXStaticText", "is a country in", 0.05, 0.3, 0.9, 0.06),
        node("AXLink", "Baltic Sea", 0.05, 0.32, 0.9, 0.06),
        node("AXLink", "Carpathian Mountains", 0.05, 0.34, 0.9, 0.06)
      )
    ).not.toContain("overlaps");
  });

  it("skips rows parked off-screen at a shared origin", () => {
    const out = render(
      node("AXButton", "Keyboards", 0.045, 0.123, 0.909, 0.046),
      node("AXButton", "Show Predictions Inline", 0, 0.105, 0.909, 0.05),
      node("AXButton", "Space Confirmation", 0, 0.105, 0.909, 0.07),
      node("AXButton", "Stickers", 0, 0.105, 0.909, 0.06)
    );
    expect(out).not.toContain("overlaps");
  });

  it("keeps two elements that only share an origin", () => {
    const out = render(
      node("AXButton", "Screen Time", 0, 0.88, 1, 0.05),
      node("AXGroup", "Tab Bar", 0, 0.9, 1, 0.1),
      node("AXButton", "Home", 0, 0.9, 0.32, 0.09)
    );
    expect(lineOf(out, "Screen Time")).toContain(`overlaps "Tab Bar":`);
  });

  it("ignores two reports of the same element", () => {
    expect(
      render(
        node("AXGroup", "129m", 0.4, 0.4, 0.03, 0.02),
        node("AXGroup", "129m", 0.4015, 0.4015, 0.03, 0.02)
      )
    ).not.toContain("overlaps");
  });

  it("ignores elements of a pixel or less", () => {
    expect(
      render(
        button("Header", 0.1, 0.1),
        node("AXGroup", "start-of-content", 0.498, 0.15, 0.003, 0.003)
      )
    ).not.toContain("overlaps");
  });

  it("skips unlabelled elements", () => {
    const blank = {
      role: "AXButton",
      frame: { x: 0.1, y: 0.15, width: 0.4, height: 0.1 },
      children: [],
    };
    expect(render(button("Save", 0.1, 0.1), blank as any)).not.toContain("overlaps");
  });

  it("names a partner without a label by its identifier", () => {
    const unlabelled = { ...button("", 0.1, 0.15), identifier: "save-button" };
    expect(lineOf(render(button("Cancel", 0.1, 0.1), unlabelled), "Cancel")).toContain(
      `overlaps id="save-button":`
    );
  });

  it("names a partner by the last part of an Android resource id", () => {
    const key = {
      ...button("", 0.1, 0.15),
      identifier: "com.google.android.googlequicksearchbox:id/search_box",
    };
    expect(lineOf(render(button("Cancel", 0.1, 0.1), key), "Cancel")).toContain(
      `overlaps id="search_box":`
    );
  });

  it("names each partner once", () => {
    const out = render(
      button("Favorites", 0.1, 0.1),
      node("AXButton", "Kate Bell", 0.1, 0.12, 0.4, 0.1),
      node("AXStaticText", "Kate Bell", 0.12, 0.14, 0.3, 0.1)
    );
    expect(lineOf(out, "Favorites")).toContain(`overlaps "Kate Bell": either`);
  });

  it("names only the partners that cover the element's centre", () => {
    const out = render(
      node("AXButton", "Product card", 0.1, 0.3, 0.6, 0.3),
      node("AXButton", "Fav", 0.12, 0.28, 0.06, 0.05),
      node("AXButton", "Share", 0.2, 0.28, 0.06, 0.05),
      node("AXButton", "Compare", 0.28, 0.28, 0.06, 0.05),
      node("AXButton", "Cookie banner", 0, 0.42, 1, 0.2)
    );
    expect(lineOf(out, "Product card")).toContain(`overlaps "Cookie banner": either`);
    expect(lineOf(out, "Fav")).toContain(`overlaps "Product card":`);
  });

  it("keeps the partner's name on one line and JSON-safe", () => {
    const out = render(
      button('Say "hi"\nthere', 0.1, 0.1),
      button(`${"x".repeat(39)}\u{1F600}tail`, 0.1, 0.15)
    );
    const lines = out.split("\n").filter((l) => l.includes("overlaps"));
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => /\(\d\.\d{3}, \d\.\d{3}, \d\.\d{3}, \d\.\d{3}\)$/.test(l))).toBe(
      true
    );
    expect(out).toContain(`overlaps "Say 'hi'\\nthere"`);
    // Cut at 40 code points: the emoji survives whole, the rest is dropped.
    expect(out).toContain(`overlaps "${"x".repeat(39)}\u{1F600}":`);
    expect(out).not.toContain('tail":');
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe("formatDescribeTree — overlap notes in nested trees", () => {
  const node = (
    role: string,
    label: string,
    [x, y, width, height]: number[],
    children: unknown[] = []
  ) => ({ role, label, frame: { x, y, width, height }, children });
  const screen = (...children: unknown[]) =>
    ({ role: "Screen", frame: { x: 0, y: 0, width: 1, height: 1 }, children }) as any;
  const lineOf = (out: string, label: string) =>
    out.split("\n").find((l) => new RegExp(`^\\s+\\S+ "${label}"`).test(l))!;

  // A list row slid under a sticky footer: the two sit in sibling subtrees.
  const sources = [
    { source: "xcuitest-runner", row: "AXButton", button: "AXButton", group: "Other" },
    { source: "uiautomator", row: "Button", button: "Button", group: "ViewGroup" },
    { source: "android-devtools", row: "Button", button: "Button", group: "ViewGroup" },
    { source: "cdp-dom", row: "li", button: "button", group: "footer" },
  ] as const;

  for (const { source, row, button, group } of sources) {
    it(`marks a row under a footer in a ${source} tree`, () => {
      const tree = screen(
        node("List", "", [0, 0.1, 1, 0.9], [node(row, "Add Player", [0.055, 0.845, 0.891, 0.09])]),
        node(group, "", [0, 0.85, 1, 0.15], [node(button, "Continue", [0.055, 0.86, 0.891, 0.088])])
      );
      const out = formatDescribeTree(tree, { source });
      expect(lineOf(out, "Add Player")).toMatch(
        /^ {4}\S+ "Add Player" \[overlaps "Continue": either may be on top, check a screenshot before tapping\] {2}\(/
      );
      expect(lineOf(out, "Continue")).toContain(`[overlaps "Add Player":`);
    });

    it(`ignores a child that sticks out of its parent in a ${source} tree`, () => {
      const tree = screen(
        node(group, "Card", [0.1, 0.1, 0.4, 0.1], [node(button, "Close", [0.1, 0.15, 0.4, 0.1])])
      );
      expect(formatDescribeTree(tree, { source })).not.toContain("overlaps");
    });
  }

  it("ignores a button that lies wholly inside a row of another subtree", () => {
    const tree = screen(
      node("List", "", [0, 0.1, 1, 0.9], [node("Button", "Settings", [0, 0.88, 1, 0.085])]),
      node("ViewGroup", "", [0, 0.88, 1, 0.12], [node("Button", "Home", [0, 0.892, 0.25, 0.058])])
    );
    expect(formatDescribeTree(tree, { source: "uiautomator" })).not.toContain("overlaps");
  });

  it("ignores a slotted tab that lies inside its tablist", () => {
    const tree = screen(
      node("tablist", "tablist", [0.05, 0.19, 0.5, 0.07]),
      node("tab", "HTML", [0.1, 0.2, 0.1, 0.05])
    );
    expect(formatDescribeTree(tree, { source: "cdp-dom" })).not.toContain("overlaps");
  });

  it("ignores a label and an input of the same size, in either order", () => {
    const label = node("label", "Email", [0.1, 0.3, 0.8, 0.05]);
    const input = { ...node("input", "", [0.1, 0.3, 0.8, 0.05]), identifier: "a" };
    for (const tree of [screen(label, input), screen(input, label)]) {
      expect(formatDescribeTree(tree, { source: "cdp-dom" })).not.toContain("overlaps");
    }
  });

  it("marks a fixed header link over a content link of another parent", () => {
    const tree = screen(
      node("header", "", [0, 0, 0.97, 0.145], [node("a", "Home", [0.032, 0.051, 0.085, 0.044])]),
      node(
        "main",
        "",
        [0, 0, 1, 1],
        [node("a", "First article link", [0.032, 0.065, 0.213, 0.044])]
      )
    );
    const out = formatDescribeTree(tree, { source: "cdp-dom" });
    expect(lineOf(out, "Home")).toContain(`[overlaps "First article link":`);
  });

  for (const role of [
    "AXStaticText",
    "AXLink",
    "StaticText",
    "View",
    "a",
    "link",
    "span",
    "strong",
    "em",
    "b",
    "i",
    "small",
    "code",
    "label",
    "sup",
    "sub",
    "abbr",
    "time",
    "mark",
    "cite",
    "q",
    "kbd",
  ]) {
    it(`ignores a ${role} run beside a link of the same paragraph`, () => {
      const tree = screen(
        node(
          "p",
          "",
          [0.05, 0.3, 0.9, 0.1],
          [node(role, "run", [0.05, 0.3, 0.9, 0.06]), node("a", "link", [0.05, 0.32, 0.9, 0.06])]
        )
      );
      expect(formatDescribeTree(tree, { source: "cdp-dom" })).not.toContain("overlaps");
    });
  }

  for (const role of [
    "p",
    "div",
    "span",
    "label",
    "strong",
    "em",
    "b",
    "i",
    "small",
    "img",
    "figcaption",
    "svg",
    "g",
    "path",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "heading",
    "text",
  ]) {
    it(`ignores two overlapping ${role} elements`, () => {
      const tree = screen(
        node("section", "", [0, 0, 1, 0.5], [node(role, "Top", [0.1, 0.1, 0.5, 0.05])]),
        node("section", "", [0, 0, 1, 0.5], [node(role, "Under", [0.1, 0.12, 0.5, 0.05])])
      );
      expect(formatDescribeTree(tree, { source: "cdp-dom" })).not.toContain("overlaps");
    });
  }

  it("marks a clickable div over a div", () => {
    const tree = screen(
      { ...node("div", "Open", [0.1, 0.1, 0.5, 0.05]), clickable: true },
      node("div", "Under", [0.1, 0.12, 0.5, 0.05])
    );
    const out = formatDescribeTree(tree, { source: "cdp-dom" });
    expect(lineOf(out, "Open")).toContain(`[overlaps "Under":`);
  });

  it("ignores a paragraph that holds a floated link", () => {
    const tree = screen(
      { ...node("p", "", [0, 0.2, 0.7, 0.4]), identifier: "mwYA" },
      node(
        "aside",
        "",
        [0.45, 0.2, 0.3, 0.4],
        [node("a", "Polish language", [0.5, 0.3, 0.15, 0.03])]
      )
    );
    expect(formatDescribeTree(tree, { source: "cdp-dom" })).not.toContain("overlaps");
  });

  it("notes the row under a keyboard key, but not the key", () => {
    const tree = screen(
      node(
        "RecyclerView",
        "",
        [0, 0.1, 1, 0.8],
        [node("Button", "Display", [0.02, 0.69, 0.1, 0.05])]
      ),
      {
        ...node("FrameLayout", "q", [0, 0.7, 0.1, 0.06]),
        identifier: "com.google.android.inputmethod.latin:id/key_pos_0_0",
      }
    );
    const out = formatDescribeTree(tree, { source: "android-devtools" });
    expect(lineOf(out, "Display")).toContain(`[overlaps "q":`);
    expect(lineOf(out, "q")).not.toContain("overlaps");
  });

  it("does not note a key of a physical iPhone keyboard", () => {
    const tree = screen(
      node("AXButton", "Classical", [0.02, 0.69, 0.1, 0.05]),
      node("Key", "q", [0, 0.7, 0.1, 0.06])
    );
    const out = formatDescribeTree(tree, { source: "xcuitest-runner" });
    expect(lineOf(out, "q")).not.toContain("overlaps");
  });

  it("ignores rows clipped out of a scroll container", () => {
    const tree = screen(
      {
        ...node("div", "", [0, 0.1, 1, 0.2], [node("a", "Echo", [0.1, 0.35, 0.5, 0.05])]),
        scrollable: true,
      },
      node("button", "Go back", [0.1, 0.37, 0.5, 0.06])
    );
    expect(formatDescribeTree(tree, { source: "cdp-dom" })).not.toContain("overlaps");
  });

  it("ignores page dots over a carousel cell on a physical iPhone", () => {
    const tree = screen(
      node("AXButton", "Featured: Summer Sale", [0, 0.1, 1, 0.3]),
      node("PageIndicator", "Page 1 of 3", [0.4, 0.38, 0.2, 0.04])
    );
    expect(formatDescribeTree(tree, { source: "xcuitest-runner" })).not.toContain("overlaps");
  });

  it("ignores the synthetic HarmonyOS windows", () => {
    const tree = screen(
      { ...node("Window", "", [0.5, 0, 0.5, 0.1]), identifier: "com.ohos.sceneboard" },
      {
        ...node(
          "Window",
          "",
          [0, 0.05, 0.8, 0.4],
          [node("StaticText", "Movie title", [0.6, 0.06, 0.3, 0.03])]
        ),
        identifier: "com.example.video",
      }
    );
    expect(formatDescribeTree(tree, { source: "harmony-uitest" })).not.toContain("overlaps");
  });

  it("ignores overlapping text and images in an Android tree", () => {
    const tree = screen(
      node("StaticText", "Title", [0.1, 0.1, 0.5, 0.05]),
      node("Image", "Avatar", [0.1, 0.12, 0.5, 0.05])
    );
    expect(formatDescribeTree(tree, { source: "uiautomator" })).not.toContain("overlaps");
  });

  it("ignores runs of a wrapped paragraph in a DOM tree", () => {
    const tree = screen(
      node(
        "p",
        "",
        [0.05, 0.3, 0.9, 0.1],
        [
          node("a", "Baltic Sea", [0.05, 0.3, 0.9, 0.06]),
          node("span", "and the", [0.05, 0.32, 0.9, 0.06]),
        ]
      )
    );
    expect(formatDescribeTree(tree, { source: "cdp-dom" })).not.toContain("overlaps");
  });

  it("adds no overlap notes to a Vega tree, which has no tap", () => {
    const tree = screen(
      node("button", "Add Player", [0.055, 0.845, 0.891, 0.09]),
      node("button", "Continue", [0.055, 0.86, 0.891, 0.088])
    );
    expect(formatDescribeTree(tree, { source: "vega-automation" })).not.toContain("overlaps");
  });
});
