import { describe, expect, it } from "vitest";
import { formatDescribeTree } from "../src/tools/describe/format-tree";
import type { DescribeNode } from "../src/tools/describe/contract";
import { parseUiAutomatorDump } from "../src/tools/describe/platforms/android/uiautomator-parser";

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

describe("formatDescribeTree — Expo dev Tools button", () => {
  const node = (role: string, x: number, y: number, w: number, h: number, extra = {}) => ({
    role,
    frame: { x, y, width: w, height: h },
    children: [],
    ...extra,
  });
  // Frames from an Expo app's list screen in a dev build.
  const root = {
    role: "AXGroup",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children: [
      node("AXGroup", 0.861, 0.071, 0.1, 0.047, { identifier: "list-settings-button" }),
      node("AXGroup", 0.746, 0.071, 0.1, 0.047, { identifier: "list-invites-button" }),
      node("AXImage", 0.866, 0.11, 0.065, 0.03, {
        identifier: "gearshape.fill",
        label: "gearshape.fill",
      }),
      node("AXTextField", 0.07, 0.133, 0.861, 0.046, { identifier: "list-search-input" }),
    ],
  };

  const lineOf = (out: string, needle: string) => out.split("\n").find((l) => l.includes(needle))!;

  it("marks a control whose centre is under the button", () => {
    const out = formatDescribeTree(root as any, { source: "ax-service" });
    const settings = lineOf(out, "list-settings-button");
    expect(settings).toContain("under the Expo dev Tools button");
    expect(settings).toContain("'Tools button'");
    expect(settings).toContain("keeps it off until it is switched back on");
  });

  it("covers the touch area, which is wider than the icon", () => {
    // The button takes taps up to 46 pt left of the icon centre (x 0.7835 on
    // this 402 pt wide screen); a tap at the invites button's centre was swallowed.
    const out = formatDescribeTree(root as any, { source: "ax-service" });
    expect(lineOf(out, "list-invites-button")).toContain("Expo dev Tools button");
  });

  it("leaves controls whose centre is clear alone", () => {
    const clear = {
      ...root,
      children: [
        ...root.children,
        // Centre x 0.752: the app got this tap on a device.
        node("AXButton", 0.742, 0.075, 0.02, 0.023, { label: "H" }),
        // In the button's column, further down the screen.
        node("AXButton", 0.861, 0.4, 0.1, 0.047, { label: "Below" }),
      ],
    };
    const out = formatDescribeTree(clear as any, { source: "ax-service" });
    for (const id of ["list-search-input", '"H"', '"Below"']) {
      expect(lineOf(out, id)).not.toContain("Expo");
    }
  });

  it("does not mark the icon or its caption", () => {
    const withCaption = {
      ...root,
      children: [
        ...root.children,
        node("AXStaticText", 0.87, 0.15, 0.06, 0.02, { label: "Tools" }),
      ],
    };
    const out = formatDescribeTree(withCaption as any, { source: "ax-service" });
    expect(lineOf(out, "gearshape.fill")).not.toContain("Expo");
    expect(lineOf(out, '"Tools"')).not.toContain("Expo");
  });

  it("ignores a gear icon that is not snapped to a side edge", () => {
    // An unlabeled SwiftUI gear in an app without Expo: 34 pt from the edge.
    const plainApp = {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        node("AXImage", 0.899, 0.1, 0.056, 0.026, {
          identifier: "gearshape.fill",
          label: "gearshape.fill",
        }),
        node("AXButton", 0.851, 0.154, 0.109, 0.023, { label: "Share" }),
      ],
    };
    expect(formatDescribeTree(plainApp as any, { source: "ax-service" })).not.toContain("Expo");
  });

  it("needs an image, not a control labelled after the icon", () => {
    const button = {
      ...root,
      children: root.children.map((n) => (n.role === "AXImage" ? { ...n, role: "AXButton" } : n)),
    };
    expect(formatDescribeTree(button as any, { source: "ax-service" })).not.toContain("Expo");
  });

  it("finds the button snapped to the left edge", () => {
    // Icon centre 41 pt from the left edge of a 402 x 874 pt screen.
    const left = {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        node("AXImage", 0.0697, 0.11, 0.0647, 0.0297, { label: "gearshape.fill" }),
        node("AXButton", 0.13, 0.115, 0.04, 0.02, { label: "Back" }),
        node("AXButton", 0.4, 0.115, 0.1, 0.02, { label: "Title" }),
      ],
    };
    const out = formatDescribeTree(left as any, { source: "ax-service" });
    expect(lineOf(out, '"Back"')).toContain("Expo dev Tools button");
    expect(lineOf(out, '"Title"')).not.toContain("Expo");
  });

  it("finds the button in a landscape UI, whose frames stay portrait-native", () => {
    // The UI's side edge is the top of the frame space: icon centre 41 pt below it.
    const landscape = {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        node("AXImage", 0.3, 0.0321, 0.0647, 0.0297, { label: "gearshape.fill" }),
        node("AXButton", 0.41, 0.06, 0.02, 0.02, { label: "Near" }),
        node("AXButton", 0.6, 0.06, 0.02, 0.02, { label: "Far" }),
      ],
    };
    const out = formatDescribeTree(landscape as any, { source: "ax-service" });
    expect(lineOf(out, '"Near"')).toContain("Expo dev Tools button");
    expect(lineOf(out, '"Far"')).not.toContain("Expo");
  });

  it("marks nested elements on a physical device, but not the icon's containers", () => {
    const nested = {
      role: "Application",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        {
          role: "Window",
          frame: { x: 0, y: 0, width: 1, height: 1 },
          children: [
            node("Button", 0.861, 0.071, 0.1, 0.047, { label: "Settings" }),
            {
              role: "Other",
              label: "Expo FAB",
              frame: { x: 0.84, y: 0.09, width: 0.12, height: 0.08 },
              children: [node("Image", 0.866, 0.11, 0.065, 0.03, { identifier: "gearshape.fill" })],
            },
          ],
        },
      ],
    };
    const out = formatDescribeTree(nested as any, { source: "xcuitest-runner" });
    expect(out).toContain("Mode: nested");
    expect(lineOf(out, '"Settings"')).toContain("Expo dev Tools button");
    expect(lineOf(out, "Expo FAB")).not.toContain("Tools button");
  });

  it("does not look for the iOS gear on Android or the web", () => {
    expect(formatDescribeTree(root as any, { source: "uiautomator" })).not.toContain("Expo");
    expect(formatDescribeTree(root as any, { source: "cdp-dom" })).not.toContain("Expo");
  });

  it("looks for the gear in the native-devtools fallback too", () => {
    const out = formatDescribeTree(root as any, { source: "native-devtools" });
    expect(lineOf(out, "list-settings-button")).toContain("Expo dev Tools button");
  });

  it("finds the button where expo-dev-menu 58.0.5+ places it in portrait", () => {
    // Icon centre 36 pt from the right edge of a 402 x 874 pt screen.
    const v58 = {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        node("AXImage", 0.8781, 0.1101, 0.0647, 0.0297, { label: "gearshape.fill" }),
        node("AXButton", 0.85, 0.11, 0.08, 0.03, { label: "Skip" }),
      ],
    };
    const out = formatDescribeTree(v58 as any, { source: "ax-service" });
    expect(lineOf(out, '"Skip"')).toContain("Expo dev Tools button");
  });

  it("finds the button where expo-dev-menu 58.0.5+ places it in a notched landscape UI", () => {
    // iPhone 16 Pro: 62 pt side safe area, so the icon centre is 88 pt from
    // the UI's side edge, the top of the portrait-native frame space.
    const v58Landscape = {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        node("AXImage", 0.3, 0.0858, 0.0647, 0.0297, { label: "gearshape.fill" }),
        node("AXButton", 0.41, 0.09, 0.02, 0.02, { label: "Near" }),
        node("AXButton", 0.6, 0.09, 0.02, 0.02, { label: "Far" }),
      ],
    };
    const out = formatDescribeTree(v58Landscape as any, { source: "ax-service" });
    expect(lineOf(out, '"Near"')).toContain("Expo dev Tools button");
    expect(lineOf(out, '"Far"')).not.toContain("Expo");
  });

  it("ignores the dev launcher's Settings tab icon", () => {
    // Frames from the Expo dev launcher's home screen.
    const launcher = {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        node("AXGroup", 0, 0.905, 1, 0.095, { label: "Tab Bar" }),
        node("AXButton", 0.597, 0.91, 0.234, 0.062, { label: "Settings" }),
        node("AXImage", 0.679, 0.916, 0.07, 0.032, {
          identifier: "gearshape.fill",
          label: "gearshape.fill",
        }),
      ],
    };
    expect(formatDescribeTree(launcher as any, { source: "ax-service" })).not.toContain("Expo");
  });

  it("adds nothing without the button", () => {
    const plain = { ...root, children: root.children.filter((n) => n.role !== "AXImage") };
    expect(formatDescribeTree(plain as any, { source: "ax-service" })).not.toContain("Expo");
  });
});

describe("formatDescribeTree — Expo dev Tools button on Android", () => {
  // A 1080 x 2400 px screen at 2.625 px/dp. The button snaps to the right
  // edge below a 63 px status bar: its 26 dp icon is centred 42 dp from the
  // edge, at (969.75, 173.25) px. The touch area runs 26 dp to each side,
  // 26 dp above and 68 dp below that centre: x 901.5..1038, y 105..351.75.
  const dump = (extra: string) => `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example.app" content-desc="" bounds="[0,0][1080,2400]">
    <node index="0" text="Skip" resource-id="" class="android.widget.Button" package="com.example.app" content-desc="" clickable="true" bounds="[880,140][1040,220]" />
    <node index="1" text="Back" resource-id="" class="android.widget.Button" package="com.example.app" content-desc="" clickable="true" bounds="[20,140][150,220]" />
    <node index="2" text="Help" resource-id="" class="android.widget.Button" package="com.example.app" content-desc="" clickable="true" bounds="[840,150][920,210]" />
    <node index="3" text="Next" resource-id="" class="android.widget.Button" package="com.example.app" content-desc="" clickable="true" bounds="[900,300][1040,360]" />
    ${extra}
  </node>
</hierarchy>`;
  const fab = `<node index="4" text="" resource-id="" class="android.view.View" package="com.example.app" content-desc="Tools" bounds="[936,139][1004,207]" />
    <node index="5" text="Tools" resource-id="" class="android.widget.TextView" package="com.example.app" content-desc="" bounds="[940,225][1000,255]" />`;

  const describeAndroid = (xml: string) =>
    formatDescribeTree(parseUiAutomatorDump(xml, 1080, 2400), { source: "uiautomator" });
  const lineOf = (out: string, needle: string) => out.split("\n").find((l) => l.includes(needle))!;

  it("marks app controls under the button's touch area", () => {
    const out = describeAndroid(dump(fab));
    expect(lineOf(out, '"Skip"')).toContain("under the Expo dev Tools button");
    expect(lineOf(out, '"Next"')).toContain("under the Expo dev Tools button");
  });

  it("leaves controls whose centre is clear, the icon and its caption alone", () => {
    const out = describeAndroid(dump(fab));
    expect(lineOf(out, '"Back"')).not.toContain("Expo");
    expect(lineOf(out, '"Help"')).not.toContain("Expo");
    const toolsLines = out.split("\n").filter((l) => l.includes('"Tools"'));
    expect(toolsLines).toHaveLength(2);
    for (const line of toolsLines) expect(line).not.toContain("Expo");
  });

  it("ignores a Tools icon that is not snapped to a side edge", () => {
    const moved = fab.replace("[936,139][1004,207]", "[700,139][768,207]");
    expect(describeAndroid(dump(moved))).not.toContain("Expo");
  });

  it("adds nothing without the button", () => {
    expect(describeAndroid(dump(""))).not.toContain("Expo");
  });

  it("checks the android-devtools source the same way", () => {
    const out = formatDescribeTree(parseUiAutomatorDump(dump(fab), 1080, 2400), {
      source: "android-devtools",
    });
    expect(lineOf(out, '"Skip"')).toContain("under the Expo dev Tools button");
    expect(lineOf(out, '"Back"')).not.toContain("Expo");
  });

  it("shrinks the area to the circle once the caption has gone", () => {
    const iconOnly = fab.split("\n")[0]!;
    const out = describeAndroid(dump(iconOnly));
    expect(lineOf(out, '"Skip"')).toContain("under the Expo dev Tools button");
    expect(lineOf(out, '"Next"')).not.toContain("Expo");
  });

  it("finds the button beside a landscape navigation bar", () => {
    // Rotation 1, 2400 x 1080 px with a 48 dp (126 px) navigation bar on the
    // right: the icon centre is 42 dp from the safe edge, 90 dp from the screen edge.
    const landscape = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="1">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example.app" content-desc="" bounds="[0,0][2400,1080]">
    <node index="0" text="Skip" resource-id="" class="android.widget.Button" package="com.example.app" content-desc="" clickable="true" bounds="[2100,140][2230,210]" />
    <node index="1" text="Back" resource-id="" class="android.widget.Button" package="com.example.app" content-desc="" clickable="true" bounds="[20,140][150,210]" />
    <node index="2" text="" resource-id="" class="android.view.View" package="com.example.app" content-desc="Tools" bounds="[2130,139][2198,207]" />
  </node>
</hierarchy>`;
    const out = formatDescribeTree(parseUiAutomatorDump(landscape, 2400, 1080), {
      source: "uiautomator",
    });
    expect(lineOf(out, '"Skip"')).toContain("under the Expo dev Tools button");
    expect(lineOf(out, '"Back"')).not.toContain("Expo");
  });

  it("ignores an app's own Tools tab", () => {
    // A bottom bar of five equal tabs in a page without Expo: the Tools tab's
    // centre is 1.5 tab widths from the right edge.
    const tab = (label: string, x: number) => ({
      role: "Button",
      label,
      clickable: true,
      frame: { x, y: 0.904, width: 0.2, height: 0.07 },
      children: [],
    });
    const tabs = {
      role: "Screen",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [tab("Feed", 0.4), tab("Tools", 0.6), tab("Profile", 0.8)],
    };
    expect(formatDescribeTree(tabs as any, { source: "android-devtools" })).not.toContain("Expo");
    const plainView = {
      ...tabs,
      children: tabs.children.map((n) => ({ ...n, role: "View", clickable: false })),
    };
    expect(formatDescribeTree(plainView as any, { source: "android-devtools" })).not.toContain(
      "Expo"
    );
  });

  it("adds no note on a screen without touch input", () => {
    const tree = parseUiAutomatorDump(dump(fab), 1080, 2400);
    const out = formatDescribeTree(tree, { source: "uiautomator", touchScreen: false });
    expect(out).toContain('"Skip"');
    expect(out).not.toContain("Expo");
  });
});

// Builds trees in the icon's own units (pt on iOS, dp on Android) from
// element centres, so each case reads as a distance from the icon.
function screenOf(width: number, height: number) {
  const at = (role: string, cx: number, cy: number, w: number, h: number, extra = {}) => ({
    role,
    frame: {
      x: (cx - w / 2) / width,
      y: (cy - h / 2) / height,
      width: w / width,
      height: h / height,
    },
    children: [],
    ...extra,
  });
  const screen = (...children: object[]) =>
    ({
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children,
    }) as unknown as DescribeNode;
  return { at, screen };
}

const notedLabels = (out: string) =>
  out
    .split("\n")
    .filter((l) => l.includes("Expo dev Tools button"))
    .map((l) => l.match(/"([^"]+)"/)?.[1]);

describe("formatDescribeTree: Expo dev Tools button reach on iOS", () => {
  // iPhone 16 Pro, 402 x 874 pt.
  const { at, screen } = screenOf(402, 874);
  const gear = (cx: number, cy: number) =>
    at("AXImage", cx, cy, 26, 26, { identifier: "gearshape.fill", label: "gearshape.fill" });
  const button = (label: string, cx: number, cy: number) =>
    at("AXButton", cx, cy, 14, 14, { label });
  const describeIos = (...children: object[]) =>
    notedLabels(formatDescribeTree(screen(...children), { source: "ax-service" }));

  it("reaches 57 pt along the edge once the caption has gone", () => {
    // Icon centre 36 pt from the right edge, 88 pt from the top.
    const noted = describeIos(
      gear(366, 88),
      button("above in", 366, 33),
      button("above out", 366, 28),
      button("below in", 366, 143),
      button("below out", 366, 148),
      button("beside in", 322, 88),
      button("beside out", 317, 88)
    );
    expect(noted.sort()).toEqual(["above in", "below in", "beside in"]);
  });

  it("reaches 42.5 pt above and 71.5 pt below while the caption shows", () => {
    const noted = describeIos(
      gear(366, 88),
      at("AXStaticText", 366, 110, 30, 12, { label: "Tools" }),
      button("above in", 366, 46),
      button("above out", 366, 41),
      button("below in", 366, 158),
      button("below out", 366, 162)
    );
    expect(noted.sort()).toEqual(["above in", "below in"]);
  });

  it("takes the caption above the icon in an upside-down portrait UI", () => {
    // iPad in PortraitUpsideDown keeps portrait-native frames, so the UI's
    // bottom is the frame top.
    const noted = describeIos(
      gear(366, 800),
      at("AXStaticText", 366, 778, 30, 12, { label: "Tools" }),
      button("UI below in", 366, 732),
      button("UI above out", 366, 846)
    );
    expect(noted).toEqual(["UI below in"]);
  });

  it("keeps the side-edge reading when short texts outnumber the lines", () => {
    const shortTexts = ["3", "12", "7"].map((label, i) =>
      at("AXStaticText", 100 + i * 30, 500, 17, 20, { label })
    );
    const line = at("AXStaticText", 201, 300, 60, 17, { label: "TAPLOG" });
    expect(
      describeIos(
        ...shortTexts,
        line,
        gear(366, 88),
        button("above", 366, 40),
        button("beside", 314, 88)
      )
    ).toEqual(["above"]);
    expect(describeIos(...shortTexts, line, gear(366, 176), button("dragged", 366, 200))).toEqual([
      "dragged",
    ]);
  });

  it("marks controls under every snapped gear", () => {
    const appGear = gear(362, 400);
    const noted = describeIos(
      appGear,
      button("NearAppGear", 362, 430),
      gear(366, 88),
      button("Edit", 366, 100)
    );
    expect(noted.sort()).toEqual(["Edit", "NearAppGear"]);
  });

  it("marks app text under the button that is not its caption", () => {
    const noted = describeIos(
      gear(366, 88),
      at("AXStaticText", 366, 120, 40, 16, { label: "Hello" })
    );
    expect(noted).toEqual(["Hello"]);
  });

  it("ignores a gear in a portrait nav bar, 84 pt from the top", () => {
    const noted = describeIos(
      at("AXStaticText", 201, 84, 120, 20, { label: "Inbox" }),
      button("Edit", 330, 84),
      gear(373, 84),
      button("Filter", 390, 120)
    );
    expect(noted).toEqual([]);
  });

  it("uses the gear snapped to a side edge whatever the child order", () => {
    // An app's own gear 74 pt from the bottom, next to the Expo one.
    const expoGear = gear(366, 85);
    const appGear = gear(201, 800);
    const header = button("HeaderRightUnderFAB", 366, 100);
    const tab = button("TabNearAppGear", 230, 800);
    expect(describeIos(expoGear, header, tab, appGear)).toEqual(["HeaderRightUnderFAB"]);
    expect(describeIos(appGear, header, tab, expoGear)).toEqual(["HeaderRightUnderFAB"]);
  });

  describe("in a landscape UI, whose frames stay portrait-native", () => {
    // Text lines run down the frame space when the UI is rotated.
    const text = [
      at("AXStaticText", 200, 400, 20, 120, { label: "Welcome" }),
      at("AXStaticText", 240, 400, 20, 160, { label: "Pick a plan" }),
    ];

    it("measures the snap from the UI's side edge, the frame top", () => {
      // Gear 36 pt from the UI top (frame x) and 88 pt from its right edge
      // (frame y), as expo-dev-menu 58.0.11 places it on an iPhone 16 Pro.
      const noted = describeIos(
        ...text,
        gear(36, 88),
        button("in", 88, 88),
        button("beside in", 88, 128),
        button("beside out", 88, 140),
        button("along out", 100, 88),
        button("near edge", 40, 40)
      );
      expect(noted.sort()).toEqual(["beside in", "in"]);
    });

    it("finds the button snapped to the frame bottom", () => {
      const noted = describeIos(
        ...text,
        gear(200, 833),
        button("Near", 240, 833),
        button("Far", 300, 833)
      );
      expect(noted).toEqual(["Near"]);
    });

    it("reaches further towards the caption, the UI's bottom", () => {
      const toPlusX = describeIos(
        ...text,
        gear(200, 88),
        at("AXStaticText", 222, 88, 12, 30, { label: "Tools" }),
        button("UI above", 140, 88),
        button("UI below", 260, 88)
      );
      expect(toPlusX).toEqual(["UI below"]);
      const toMinusX = describeIos(
        ...text,
        gear(200, 88),
        at("AXStaticText", 178, 88, 12, 30, { label: "Tools" }),
        button("UI above", 260, 88),
        button("UI below", 140, 88)
      );
      expect(toMinusX).toEqual(["UI below"]);
    });

    it("snaps 68 to 90 pt from the UI's side edge in a notched landscape UI", () => {
      // iPhone 14: 47 pt safe area, so the icon centre is 73 pt in.
      expect(describeIos(...text, gear(200, 73), button("Near", 240, 73))).toEqual(["Near"]);
      expect(describeIos(...text, gear(200, 95), button("Near", 240, 95))).toEqual([]);
    });
  });
});

describe("formatDescribeTree: Expo dev Tools button reach on Android", () => {
  // A 1080 x 2400 px screen at 2.625 px/dp.
  const width = 1080 / 2.625;
  const { at, screen } = screenOf(width, 2400 / 2.625);
  const icon = (cx: number, cy: number, extra = {}) =>
    at("View", cx, cy, 26, 26, { label: "Tools", ...extra });
  const caption = (cx: number, cy: number) => at("TextView", cx, cy, 30, 12, { label: "Tools" });
  const button = (label: string, cx: number, cy: number) =>
    at("Button", cx, cy, 12, 12, { label, clickable: true });
  const describeAndroid = (...children: object[]) =>
    notedLabels(formatDescribeTree(screen(...children), { source: "android-devtools" }));
  // Icon centre 42 dp from the right edge, 66 dp from the top.
  const cx = width - 42;

  it("reaches 26 dp across and above, and 68 dp below while the caption shows", () => {
    const noted = describeAndroid(
      icon(cx, 66),
      caption(cx, 92),
      button("above in", cx, 42),
      button("above out", cx, 38),
      button("beside in", cx - 24, 66),
      button("beside out", cx - 28, 66),
      button("below in", cx, 132),
      button("below out", cx, 136)
    );
    expect(noted.sort()).toEqual(["above in", "below in", "beside in"]);
  });

  it("reaches 26 dp below once the caption has gone", () => {
    const noted = describeAndroid(
      icon(cx, 66),
      button("below in", cx, 90),
      button("below out", cx, 94)
    );
    expect(noted).toEqual(["below in"]);
  });

  it("takes only the text under the icon as its caption", () => {
    // App "Tools" texts above the icon or far down its column do not stretch
    // the area, and one beside the icon still gets the note.
    const noted = describeAndroid(
      icon(cx, 66),
      at("TextView", cx, 860, 60, 20, { label: "Tools" }),
      at("TextView", cx, 20, 30, 12, { label: "Tools" }),
      at("TextView", cx - 20, 70, 30, 12, { label: "Tools" }),
      button("above out", cx, 30),
      button("below out", cx, 110)
    );
    expect(noted).toEqual(["Tools"]);
  });

  it("needs a plain, unclickable view labelled Tools as the icon", () => {
    for (const notIcon of [
      icon(cx, 66, { clickable: true }),
      icon(cx, 66, { label: "Gear" }),
      icon(cx, 66, { role: "Button" }),
      icon(cx, 66, { role: "TextView" }),
    ]) {
      expect(describeAndroid(notIcon, button("Skip", cx, 70))).toEqual([]);
    }
  });

  it("ignores an icon that is not snapped to a side edge", () => {
    for (const fromEdge of [30, 110]) {
      const x = width - fromEdge;
      expect(describeAndroid(icon(x, 66), button("Under", x, 70))).toEqual([]);
    }
  });
});
