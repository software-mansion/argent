import { describe, it, expect } from "vitest";
import { adaptCoreDeviceAxToDescribeResult } from "../src/tools/describe/platforms/ios/ios-coredevice-ax-adapter";
import { mapNativeTraitsToDescribeRole } from "../src/tools/describe/platforms/ios/ios-native-adapter";

interface Node {
  role: string;
  frame: { x: number; y: number; width: number; height: number };
  children: Node[];
  label?: string;
  value?: string;
  disabled?: boolean;
  selected?: boolean;
}
function flatten(n: Node, out: Node[] = []): Node[] {
  out.push(n);
  for (const c of n.children) flatten(c, out);
  return out;
}
const center = (f: Node["frame"]) => ({ x: f.x + f.width / 2, y: f.y + f.height / 2 });

// FORWARD-COMPATIBILITY fixture only. The sim-server does NOT send geometry
// today — its payload is captions + reading order, with no `screen` and no
// per-element `rect` (pinned on the producer side by radon's
// `ax_tree_payload_carries_no_geometry`). This fixture exists so the adapter's
// real-rect path keeps working if a geometry source is ever added; the
// no-geometry suite below is what actually runs in production.
const AXTREE = {
  screen: { w: 393, h: 852 },
  elements: [
    { caption: "Settings, Button", id: "a1", rect: "{{318, 63}, {55, 36}}" },
    { caption: "Wi-Fi, Header", id: "a2", rect: "{{32, 168}, {55, 26}}" },
    { caption: "Wi-Fi, 1, Button, Toggle", id: "a3" }, // no rect -> interpolated
    { caption: "Other…, Button", id: "a4", rect: "{{16, 553}, {361, 52}}" },
    { caption: "Known networks will be joined automatically.", id: "a5" }, // static text
  ],
};

// What `/api/ax-tree` actually returns today: captions + reading order only.
const AXTREE_NO_GEOMETRY = {
  elements: [
    { caption: "Settings, Button", id: "a1" },
    { caption: "Wi-Fi, Header", id: "a2" },
    { caption: "Wi-Fi, 1, Button, Toggle", id: "a3" },
    { caption: "Other…, Button", id: "a4" },
    { caption: "Known networks will be joined automatically.", id: "a5" },
  ],
};

describe("adaptCoreDeviceAxToDescribeResult (production payload: no geometry)", () => {
  const tree = adaptCoreDeviceAxToDescribeResult(AXTREE_NO_GEOMETRY);
  const nodes = flatten(tree as Node).slice(1); // drop the synthetic AXGroup root

  it("still parses roles and labels from the captions", () => {
    expect(nodes.map((n) => n.role)).toEqual([
      "AXButton",
      "AXHeading",
      "AXButton",
      "AXButton",
      "AXStaticText",
    ]);
    expect(nodes[1].label).toBe("Wi-Fi");
  });

  // The roles must be the ones `mapNativeTraitsToDescribeRole` produces for the
  // other two iOS backends: selectors, format-tree's CONTENT_ROLES and Lens's
  // exact `role ===` all key off those spellings, so a private vocabulary here
  // would make every role selector work on a simulator and match nothing on a
  // device. Pinned against the shared mapper itself, not a copied literal.
  it("emits the same role vocabulary as the sibling iOS adapters", () => {
    for (const [trait, caption] of [
      ["button", "Send, Button"],
      ["header", "Wi-Fi, Header"],
      ["link", "Learn more, Link"],
      ["image", "Avatar, Image"],
      ["adjustable", "Volume, Adjustable"],
      ["tabBar", "Home, Tab"],
      ["searchField", "Query, Search Field"],
      ["staticText", "just text"],
    ] as const) {
      const [node] = adaptCoreDeviceAxToDescribeResult({
        elements: [{ caption, id: "x" }],
      }).children as Node[];
      expect(node.role).toBe(mapNativeTraitsToDescribeRole([trait]));
    }
  });

  // The audit hands back one comma-joined caption; the sibling adapters expose
  // label and value separately and every selector matcher treats `value` as a
  // first-class field, so collapsing both into `label` would silently downgrade
  // `{ value }` selectors to label-substring guesses.
  it("splits a caption's trailing content token into `value`", () => {
    const [node] = adaptCoreDeviceAxToDescribeResult({
      elements: [{ caption: "Wi-Fi, FiberMansion, Button", id: "x" }],
    }).children as Node[];
    expect(node.label).toBe("Wi-Fi");
    expect(node.value).toBe("FiberMansion");
  });

  it("keeps an all-trait caption whole instead of promoting a trait to `value`", () => {
    // "Dimmed, Button" is state + role, with no name and no value. Splitting it
    // like content leaves `{ label: "Dimmed", value: "Button" }`: a
    // `{ value: "Button" }` selector then matches an element that has no value,
    // and the element reads as being called "Dimmed". The single-token spelling
    // of the same caption ("Button") already avoided this, so the fallback used
    // to answer two ways for one case.
    for (const caption of ["Dimmed, Button", "Selected, Button", "Not Enabled, Button"]) {
      const [node] = adaptCoreDeviceAxToDescribeResult({
        elements: [{ caption, id: "x" }],
      }).children as Node[];
      expect(node.label, caption).toBe(caption);
      expect(node.value, caption).toBeUndefined();
    }

    // …while a caption that really does carry a value still splits.
    const [withValue] = adaptCoreDeviceAxToDescribeResult({
      elements: [{ caption: "Wi-Fi, FiberMansion, Button", id: "x" }],
    }).children as Node[];
    expect(withValue.value).toBe("FiberMansion");
  });

  it("interpolates EVERY frame: full-width rows, strictly ordered top to bottom", () => {
    for (const n of nodes) {
      // approxFrame is full-width with a symmetric margin, never a real rect.
      expect(n.frame.x).toBeCloseTo(0.04, 6);
      expect(n.frame.width).toBeCloseTo(0.92, 6);
      expect(n.frame.height).toBeCloseTo(0.05, 6);
    }
    const ys = nodes.map((n) => center(n.frame).y);
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i]).toBeGreaterThan(ys[i - 1]);
    }
  });

  // Ordering alone doesn't pin the layout: reversing the interpolation still
  // yields a monotonically-increasing run, because each fill anchors off its
  // already-filled predecessor. Pin the absolute span so a top-to-bottom spread
  // can't silently become bottom-to-top.
  it("spreads the run from the top anchor to the bottom anchor, in that direction", () => {
    const ys = nodes.map((n) => center(n.frame).y);
    // 5 rect-less elements spread as 0.06 + 0.88·k/(n+1).
    expect(ys[0]).toBeCloseTo(0.06 + 0.88 / 6, 3);
    expect(ys[0]).toBeLessThan(0.3);
    expect(ys[ys.length - 1]).toBeGreaterThan(0.7);
  });

  it("keeps every interpolated frame inside the normalized [0,1] box", () => {
    for (const n of nodes) {
      expect(n.frame.y).toBeGreaterThanOrEqual(0);
      expect(n.frame.y + n.frame.height).toBeLessThanOrEqual(1.0001);
    }
  });

  it("clamps a synthesised frame whose anchor sits past the bottom of the screen", () => {
    // Interpolating between real rects can put the anchor anywhere, including
    // past 1. The no-geometry fixture's fallback anchors are 0.06 and 0.94, so
    // its frames land mid-screen whether or not approxFrame clamps — only a
    // low-anchored rect exercises it.
    const nodes = adaptCoreDeviceAxToDescribeResult({
      screen: { w: 393, h: 852 },
      elements: [
        { caption: "Top, Button", id: "1", rect: "{{16, 838}, {361, 10}}" },
        { caption: "Interpolated, Button", id: "2" },
        { caption: "Bottom, Button", id: "3", rect: "{{16, 845}, {361, 6}}" },
      ],
    }).children as Node[];
    for (const n of nodes) {
      expect(n.frame.y).toBeGreaterThanOrEqual(0);
      expect(n.frame.y + n.frame.height).toBeLessThanOrEqual(1.0001);
    }
  });

  it("interpolates into the gap between two anchors, not across the whole list", () => {
    // With rect-less elements both between and after a pair of real rects, the
    // gap fraction and the tail spread are different denominators — a single
    // "spread over the whole list" rule keeps the order but puts the in-gap
    // element in the wrong place, which the ordering-only assertions above
    // cannot see.
    const nodes = adaptCoreDeviceAxToDescribeResult({
      screen: { w: 393, h: 852 },
      elements: [
        { caption: "Top, Button", id: "1", rect: "{{16, 100}, {361, 40}}" },
        { caption: "Middle, Button", id: "2" },
        { caption: "Bottom, Button", id: "3", rect: "{{16, 500}, {361, 40}}" },
        { caption: "Tail, Button", id: "4" },
      ],
    }).children as Node[];
    const yc = (n: Node) => n.frame.y + n.frame.height / 2;
    // Halfway between the two anchors (120/852 and 520/852), not somewhere the
    // whole-list denominator would put it.
    expect(yc(nodes[1]!)).toBeCloseTo((yc(nodes[0]!) + yc(nodes[2]!)) / 2, 2);
    expect(yc(nodes[3]!)).toBeGreaterThan(yc(nodes[2]!));
  });
});

describe("adaptCoreDeviceAxToDescribeResult (forward-compat: payload with geometry)", () => {
  const tree = adaptCoreDeviceAxToDescribeResult(AXTREE);
  const nodes = flatten(tree as Node);
  const byLabel = (l: string) => nodes.find((n) => n.label === l);

  it("parses roles from caption traits and strips them from the label", () => {
    expect(byLabel("Settings")?.role).toBe("AXButton");
    expect(byLabel("Wi-Fi")?.role).toBe("AXHeading");
    // Button trait wins the role; trailing Button/Toggle stripped, and the last
    // remaining content token becomes the value.
    const toggle = nodes.find((n) => n.label === "Wi-Fi" && n.value === "1");
    expect(toggle?.role).toBe("AXButton");
    // No trait -> static text, full caption kept as label.
    const stat = nodes.find((n) => n.label?.startsWith("Known networks"));
    expect(stat?.role).toBe("AXStaticText");
  });

  it("normalizes an audited rect (points) into a [0,1] frame", () => {
    const other = byLabel("Other…")!;
    // {{16, 553}, {361, 52}} on 393x852
    expect(other.frame.x).toBeCloseTo(16 / 393, 3);
    expect(other.frame.y).toBeCloseTo(553 / 852, 3);
    expect(other.frame.width).toBeCloseTo(361 / 393, 3);
  });

  it("interpolates a rect-less element between its neighbours (list order)", () => {
    const wifiHeader = center(byLabel("Wi-Fi")!.frame).y; // ~168/852
    const other = center(byLabel("Other…")!.frame).y; // ~553/852
    // "Wi-Fi, 1, Button, Toggle" carries no rect: label "Wi-Fi", value "1".
    const toggleNode = nodes.find((n) => n.label === "Wi-Fi" && n.value === "1")!;
    const toggle = center(toggleNode.frame).y;
    expect(toggle).toBeGreaterThan(wifiHeader);
    expect(toggle).toBeLessThan(other);
  });

  it("keeps every frame within the normalized [0,1] box", () => {
    for (const n of nodes) {
      const { x, y, width, height } = n.frame;
      for (const v of [x, y, width, height]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(x + width).toBeLessThanOrEqual(1.0001);
      expect(y + height).toBeLessThanOrEqual(1.0001);
    }
  });

  it("clamps a rect that reaches outside the screen, and drops a short one", () => {
    // The fixture above is entirely inside the screen bounds, so it holds
    // whether or not `parseRect` clamps — this feeds it the out-of-range and
    // truncated rects the clamp and the arity guard exist for. A negative
    // origin or an over-wide rect would otherwise reach the formatter as a
    // frame outside [0,1], which every consumer treats as a screen fraction.
    const [outside, short] = adaptCoreDeviceAxToDescribeResult({
      screen: { w: 393, h: 852 },
      elements: [
        { caption: "Offscreen, Button", id: "1", rect: "{{-40, -80}, {900, 2000}}" },
        { caption: "Truncated, Button", id: "2", rect: "{{16, 553}}" },
      ],
    }).children as Node[];

    for (const v of [outside.frame.x, outside.frame.y, outside.frame.width, outside.frame.height]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    // A rect with fewer than four numbers is not geometry: it must fall back to
    // an interpolated frame rather than destructure to NaN.
    for (const v of [short.frame.x, short.frame.y, short.frame.width, short.frame.height]) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("splits a value on every value-bearing role, not just buttons", () => {
    // The set has three members and only AXButton is exercised elsewhere, so
    // dropping either of the others goes unnoticed — and an Adjustable's value
    // is the whole point of reading it.
    const [adjustable, textField] = adaptCoreDeviceAxToDescribeResult({
      elements: [
        { caption: "Brightness, 62%, Adjustable", id: "1" },
        { caption: "Search, kittens, Search Field", id: "2" },
      ],
    }).children as Node[];
    expect(adjustable.role).toBe("AXAdjustable");
    expect(adjustable.label).toBe("Brightness");
    expect(adjustable.value).toBe("62%");
    expect(textField.role).toBe("AXTextField");
    expect(textField.value).toBe("kittens");
  });

  it("resolves a caption with two structural traits by the declared precedence", () => {
    // TRAIT_TOKEN_TO_NATIVE is an ordered list and its comment says the first
    // structural trait wins, but a caption carrying only one trait cannot tell
    // any ordering apart from any other.
    const [node] = adaptCoreDeviceAxToDescribeResult({
      elements: [{ caption: "Profile photo, Button, Image", id: "1" }],
    }).children as Node[];
    expect(node.role).toBe("AXButton");
  });

  it("records the enabled / selected state the caption carries", () => {
    // The caption is the only place the device reports state, and the tokens are
    // stripped from the label either way — so dropping them makes an enabled
    // control byte-identical to a disabled one, while the describe hint promises
    // the traits are exact.
    const [enabled, dimmed, chosen, notChosen, notEnabled] = adaptCoreDeviceAxToDescribeResult({
      elements: [
        { caption: "Continue, Button", id: "0x1" },
        { caption: "Continue, Dimmed, Button", id: "0x2" },
        { caption: "Photos, Selected, Tab", id: "0x3" },
        { caption: "Albums, Not Selected, Tab", id: "0x4" },
        { caption: "Submit, Not Enabled, Button", id: "0x5" },
      ],
    }).children as Node[];

    expect(enabled.disabled).toBeUndefined();
    expect(dimmed.disabled).toBe(true);
    expect(notEnabled.disabled).toBe(true);
    // The two "Continue" buttons must not be indistinguishable.
    expect({ ...dimmed, frame: null }).not.toEqual({ ...enabled, frame: null });

    // "Not Selected" is an explicit false: the device stating a selection state
    // is different from an element that has none.
    expect(chosen.selected).toBe(true);
    expect(notChosen.selected).toBe(false);
    expect(enabled.selected).toBeUndefined();

    // The state token is not part of the name.
    expect(dimmed.label).toBe("Continue");
    expect(chosen.label).toBe("Photos");
  });

  it("splits label from value only on value-bearing roles, so prose keeps its commas", () => {
    // The restriction exists because static text and headings are sentences:
    // treating the last comma-separated run as a value truncates the label. Every
    // static-text fixture above is comma-free, so only this exercises it.
    const prose =
      "Known networks will be joined automatically, otherwise you will have to select a network";
    const [node] = adaptCoreDeviceAxToDescribeResult({
      elements: [{ caption: prose, id: "x" }],
    }).children as Node[];
    expect(node.role).toBe("AXStaticText");
    expect(node.label).toBe(prose);
    expect(node.value).toBeUndefined();
  });

  it("does not throw on an empty / screen-less tree", () => {
    expect(() => adaptCoreDeviceAxToDescribeResult({ elements: [] })).not.toThrow();
    expect(() =>
      adaptCoreDeviceAxToDescribeResult({
        elements: [{ caption: "x", id: "1" }],
      })
    ).not.toThrow();
  });
});
