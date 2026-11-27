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
    expect(out).not.toContain("ROOT ");
    expect(elementLines(out)).toHaveLength(0);

    const raw = formatDescribeTree(root, { source: "ax-service", raw: true });
    expect(raw).toContain("ROOT AXGroup (0,0,1,1)");
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
  it("does not emit the synthetic root node in nested mode", () => {
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
    expect(out.split("\n").filter((l) => l.includes("Screen"))).toHaveLength(0);
    // In raw mode, Screen appears only once as the ROOT header line, never duplicated in body.
    const raw = formatDescribeTree(root, { source: "uiautomator", raw: true });
    const screenLines = raw.split("\n").filter((l) => l.includes("Screen"));
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
          label: "Feed",
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
    // Each body line: indentation, then the role token, then a single space.
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

  it("renders a compact header naming source, mode, and frame format", () => {
    const empty: DescribeNode = {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [],
    };
    const out = formatDescribeTree(empty, { source: "ax-service" });
    expect(out).toContain("Source: ax-service | Mode: flat | Frame: (x,y,w,h) [0,1]");
  });

  it("renders the xcuitest-runner header in nested mode without two-finger caveats", () => {
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
    expect(out).toContain("Source: xcuitest-runner | Mode: nested | Frame: (x,y,w,h) [0,1]");
    expect(out).not.toContain("No two-finger gestures");
  });

  it("renders an empty simulator tree in flat mode", () => {
    const empty: DescribeNode = {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [],
    };
    const out = formatDescribeTree(empty, { source: "ax-service" });
    expect(out).toContain("Source: ax-service");
    expect(out).toContain("Mode: flat");
    expect(elementLines(out)).toHaveLength(0);
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

  it("prints the VoiceOver hint after the id and before the flags, escaped like the other attributes", () => {
    const root: DescribeNode = {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        leaf({
          role: "AXButton",
          label: "Pay",
          value: "Ready",
          identifier: "pay",
          hint: 'Line one\nsays "go" C:\\tmp',
          selected: true,
          frame: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
        }),
      ],
    };
    const [line] = elementLines(formatDescribeTree(root, { source: "ax-service" }));
    expect(line).toContain(
      'AXButton "Pay" value="Ready" id="pay" hint="Line one\\nsays "go" C:\\\\tmp" [selected]'
    );
  });

  it("prints no hint attribute when the hint is absent or empty", () => {
    const frame = { x: 0.1, y: 0.2, width: 0.3, height: 0.1 };
    const root: DescribeNode = {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        leaf({ role: "AXButton", label: "A", frame }),
        leaf({ role: "AXButton", label: "B", hint: "", frame }),
      ],
    };
    expect(formatDescribeTree(root, { source: "ax-service" })).not.toContain("hint=");
  });

  it("omits a hint identical to the label and keeps one that differs in any way", () => {
    const frame = { x: 0.1, y: 0.2, width: 0.3, height: 0.1 };
    const root: DescribeNode = {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        leaf({ role: "AXLink", label: "Poland", hint: "Poland", frame }),
        leaf({ role: "AXLink", label: "Warsaw", hint: "Capital of Poland", frame }),
        leaf({ role: "AXButton", label: "Save", hint: "save", frame }),
      ],
    };
    const out = formatDescribeTree(root, { source: "ax-service" });
    expect(out).toContain('AXLink "Poland" (');
    expect(out).toContain('AXLink "Warsaw" hint="Capital of Poland"');
    expect(out).toContain('AXButton "Save" hint="save"');
  });

  it.each(["ax-service", "native-devtools"] as const)(
    "lists an unlabelled %s element that reports only a hint, disabled or selected",
    (source) => {
      const frame = { x: 0.1, y: 0.2, width: 0.3, height: 0.1 };
      const root: DescribeNode = {
        role: "AXGroup",
        frame: { x: 0, y: 0, width: 1, height: 1 },
        children: [
          leaf({ role: "AXGroup", hint: "Opens the menu", frame }),
          leaf({ role: "AXGroup", disabled: true, frame }),
          leaf({ role: "AXGroup", selected: true, frame }),
          leaf({ role: "AXGroup", hint: "Current tab", selected: true, frame }),
          // Reports nothing, so it stays out as a decorative grouping.
          leaf({ role: "AXGroup", hint: "", frame }),
        ],
      };
      expect(elementLines(formatDescribeTree(root, { source }))).toEqual([
        '  AXGroup hint="Opens the menu" (0.1,0.2,0.3,0.1)',
        "  AXGroup [disabled] (0.1,0.2,0.3,0.1)",
        "  AXGroup [selected] (0.1,0.2,0.3,0.1)",
        '  AXGroup hint="Current tab" [selected] (0.1,0.2,0.3,0.1)',
      ]);
    }
  );

  it.each([
    "uiautomator",
    "cdp-dom",
    "vega-automation",
    "harmony-uitest",
    "xcuitest-runner",
  ] as const)("keeps pruning an empty %s leaf that is only disabled or selected", (source) => {
    const frame = { x: 0.1, y: 0.2, width: 0.3, height: 0.1 };
    const root: DescribeNode = {
      role: "Screen",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        leaf({ role: "View", disabled: true, frame }),
        leaf({ role: "View", selected: true, frame }),
      ],
    };
    expect(elementLines(formatDescribeTree(root, { source }))).toEqual([]);
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

  // Frames round to 3 decimal places and drop trailing fractional zeros while
  // keeping leading zeros so copied coordinates stay valid JSON numbers.
  it("rounds frames to up to three decimal places without trailing zeros", () => {
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
    expect(out).toMatch(/\(0\.123,0\.5,0\.1,0\.05\)/);
  });

  it("keeps the sign and the leading zero of a negative coordinate", () => {
    const root: DescribeNode = {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        leaf({
          role: "AXButton",
          label: "X",
          frame: { x: -0.125, y: 0.5, width: 1, height: 0.05 },
        }),
      ],
    };
    const out = formatDescribeTree(root, { source: "ax-service" });
    expect(out).toContain("(-0.125,0.5,1,0.05)");
  });

  // Long Compose / RN trees can stack 200+ wrapper layers. The renderer uses
  // an iterative DFS specifically to avoid a recursive stack overflow there,
  // collapsing bare wrappers by default and keeping all layers with `raw: true`.
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
    const compact = formatDescribeTree(root, { source: "uiautomator" });
    expect(elementLines(compact)).toEqual(['  Button "deep" [clickable] (0.4,0.4,0.2,0.05)']);

    const raw = formatDescribeTree(root, { source: "uiautomator", raw: true });
    expect(raw).toContain('"deep"');
    expect(raw.split("\n").length).toBeGreaterThan(500);
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

  it("prunes contained duplicate iOS rows and decorative chevrons by default, keeping them with raw: true", () => {
    const root: DescribeNode = {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        // Row 1: outer AXGroup + inner AXButton with same id/label + 2 contained StaticTexts
        leaf({
          role: "AXGroup",
          label: "Model Name, iPhone 17 Pro",
          identifier: "ProductModelName",
          frame: { x: 0.05, y: 0.27, width: 0.9, height: 0.06 },
        }),
        leaf({
          role: "AXStaticText",
          label: "Model Name",
          frame: { x: 0.09, y: 0.29, width: 0.24, height: 0.02 },
        }),
        leaf({
          role: "AXStaticText",
          label: "iPhone 17 Pro",
          frame: { x: 0.65, y: 0.29, width: 0.26, height: 0.02 },
        }),
        leaf({
          role: "AXButton",
          label: "Model Name, iPhone 17 Pro",
          identifier: "ProductModelName",
          frame: { x: 0.09, y: 0.29, width: 0.82, height: 0.02 },
        }),
        // Row 2: outer AXButton + duplicate inner AXButton + disabled chevron + distinct-id text
        leaf({
          role: "AXButton",
          label: "About",
          identifier: "About",
          frame: { x: 0.05, y: 0.45, width: 0.9, height: 0.06 },
        }),
        leaf({
          role: "AXButton",
          label: "About",
          identifier: "About",
          frame: { x: 0.085, y: 0.46, width: 0.22, height: 0.03 },
        }),
        leaf({
          role: "AXButton",
          label: "chevron",
          disabled: true,
          frame: { x: 0.875, y: 0.47, width: 0.026, height: 0.016 },
        }),
        // Distinct sibling buttons with the same label at non-overlapping positions must both survive.
        leaf({
          role: "AXButton",
          label: "Delete",
          frame: { x: 0.1, y: 0.6, width: 0.2, height: 0.05 },
        }),
        leaf({
          role: "AXButton",
          label: "Delete",
          frame: { x: 0.1, y: 0.7, width: 0.2, height: 0.05 },
        }),
      ],
    };

    const compact = elementLines(formatDescribeTree(root, { source: "ax-service" }));
    expect(compact).toEqual([
      '  AXButton "Model Name, iPhone 17 Pro" id="ProductModelName" (0.09,0.29,0.82,0.02)',
      '  AXButton "About" id="About" (0.05,0.45,0.9,0.06)',
      '  AXButton "Delete" (0.1,0.6,0.2,0.05)',
      '  AXButton "Delete" (0.1,0.7,0.2,0.05)',
    ]);

    const raw = elementLines(formatDescribeTree(root, { source: "ax-service", raw: true }));
    expect(raw).toHaveLength(9);
  });

  it("drops redundant child Image matching its clickable parent label in nested mode unless raw: true", () => {
    const root: DescribeNode = {
      role: "Screen",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        {
          role: "List",
          frame: { x: 0, y: 0.1, width: 1, height: 0.2 },
          children: [
            {
              role: "View",
              label: "Wikipedia",
              clickable: true,
              frame: { x: 0.1, y: 0.12, width: 0.3, height: 0.04 },
              children: [
                leaf({
                  role: "Image",
                  label: "Wikipedia",
                  frame: { x: 0.1, y: 0.12, width: 0.3, height: 0.04 },
                }),
              ],
            },
          ],
        },
      ],
    };

    const compact = formatDescribeTree(root, { source: "android-devtools" });
    expect(elementLines(compact)).toEqual(['  View "Wikipedia" [clickable] (0.1,0.12,0.3,0.04)']);

    const raw = formatDescribeTree(root, { source: "android-devtools", raw: true });
    expect(raw).toContain("  List (0,0.1,1,0.2)");
    expect(raw).toContain('      Image "Wikipedia" (0.1,0.12,0.3,0.04)');
  });

  it("uses whole-part matching on AXGroup so enclosing container labels do not drop unrelated child text", () => {
    const root: DescribeNode = {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        // Contacts-style full-screen AXGroup "Toolbar" enclosing single-letter section headers
        leaf({
          role: "AXGroup",
          label: "Toolbar",
          identifier: "Toolbar",
          frame: { x: 0, y: 0, width: 1, height: 1 },
        }),
        leaf({
          role: "AXStaticText",
          label: "A",
          frame: { x: 0.045, y: 0.144, width: 0.025, height: 0.021 },
        }),
        leaf({
          role: "AXStaticText",
          label: "B",
          frame: { x: 0.045, y: 0.262, width: 0.024, height: 0.021 },
        }),
        // Safari-style web area AXGroup enclosing an infobox title
        leaf({
          role: "AXGroup",
          label: "Statue of Charles Marion Russell - Wikipedia",
          frame: { x: 0, y: 0.071, width: 1, height: 0.929 },
        }),
        leaf({
          role: "AXStaticText",
          label: "Charles Marion Russell",
          frame: { x: 0.256, y: 0.811, width: 0.488, height: 0.027 },
        }),
        // Comma-separated AXGroup row still drops its exact comma parts
        leaf({
          role: "AXGroup",
          label: "Wi-Fi, OfficeNet",
          frame: { x: 0.05, y: 0.5, width: 0.9, height: 0.06 },
        }),
        leaf({
          role: "AXStaticText",
          label: "OfficeNet",
          frame: { x: 0.6, y: 0.51, width: 0.2, height: 0.03 },
        }),
      ],
    };

    const lines = elementLines(formatDescribeTree(root, { source: "ax-service" }));
    expect(lines.some((l) => l.includes('AXStaticText "A"'))).toBe(true);
    expect(lines.some((l) => l.includes('AXStaticText "B"'))).toBe(true);
    expect(lines.some((l) => l.includes('AXStaticText "Charles Marion Russell"'))).toBe(true);
    expect(lines.some((l) => l.includes('AXStaticText "OfficeNet"'))).toBe(false);
  });

  it("keeps wrappers with selected/disabled/hint state or dialog roles while still pruning bare leaves", () => {
    const androidRoot: DescribeNode = {
      role: "Screen",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        {
          role: "ScrollView",
          focused: true,
          frame: { x: 0, y: 0, width: 0.417, height: 0.185 },
          children: [
            leaf({
              role: "StaticText",
              label: "Network",
              frame: { x: 0, y: 0, width: 0.417, height: 0.093 },
            }),
            {
              role: "FrameLayout",
              selected: true,
              frame: { x: 0, y: 0.093, width: 0.417, height: 0.093 },
              children: [
                leaf({
                  role: "StaticText",
                  label: "Display",
                  frame: { x: 0, y: 0.093, width: 0.417, height: 0.093 },
                }),
              ],
            },
            // Empty leaf with only `selected` stays pruned.
            leaf({
              role: "FrameLayout",
              selected: true,
              frame: { x: 0, y: 0.2, width: 0.1, height: 0.05 },
            }),
          ],
        },
      ],
    };
    const androidOut = formatDescribeTree(androidRoot, { source: "uiautomator" });
    expect(androidOut).toContain("FrameLayout [selected]");
    expect(androidOut).not.toContain("(0,0.2,0.1,0.05)");

    const chromiumRoot: DescribeNode = {
      role: "document",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        {
          role: "fieldset",
          disabled: true,
          frame: { x: 0, y: 0.1, width: 0.5, height: 0.1 },
          children: [
            leaf({
              role: "button",
              value: "Apply coupon",
              clickable: true,
              frame: { x: 0.1, y: 0.12, width: 0.2, height: 0.05 },
            }),
          ],
        },
        {
          role: "dialog",
          frame: { x: 0.1, y: 0.3, width: 0.8, height: 0.2 },
          children: [
            leaf({
              role: "button",
              value: "Delete",
              clickable: true,
              frame: { x: 0.12, y: 0.38, width: 0.1, height: 0.03 },
            }),
          ],
        },
      ],
    };
    const chromiumOut = formatDescribeTree(chromiumRoot, { source: "cdp-dom" });
    expect(chromiumOut).toContain("  fieldset [disabled]");
    expect(chromiumOut).toContain("  dialog (0.1,0.3,0.8,0.2)");
  });

  it("omits iOS scroll bars by default and keeps them when raw: true", () => {
    const root: DescribeNode = {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        leaf({
          role: "AXAdjustable",
          label: "Vertical scroll bar, 2 pages",
          value: "0%",
          frame: { x: 0.96, y: 0.1, width: 0.03, height: 0.8 },
        }),
        leaf({
          role: "AXButton",
          label: "Settings",
          frame: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
        }),
      ],
    };

    const compact = elementLines(formatDescribeTree(root, { source: "ax-service" }));
    expect(compact).toEqual(['  AXButton "Settings" (0.1,0.1,0.3,0.05)']);

    const raw = elementLines(formatDescribeTree(root, { source: "ax-service", raw: true }));
    expect(raw).toEqual([
      '  AXButton "Settings" (0.1,0.1,0.3,0.05)',
      '  AXAdjustable "Vertical scroll bar, 2 pages" value="0%" (0.96,0.1,0.03,0.8)',
    ]);
  });
});
