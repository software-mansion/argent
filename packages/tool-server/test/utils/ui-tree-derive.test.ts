import { describe, expect, it } from "vitest";
import type { DescribeNode } from "../../src/tools/describe/contract";
import { deriveUniqueSelector, nodeAtPoint, selectorToFrame } from "../../src/utils/ui-tree-match";

type Leaf = Partial<DescribeNode> & { frame: DescribeNode["frame"] };

function leaf(
  role: string,
  frame: [number, number, number, number],
  rest: Partial<DescribeNode> = {}
): Leaf {
  const [x, y, width, height] = frame;
  return { role, frame: { x, y, width, height }, ...rest };
}

function screen(leaves: Leaf[]): DescribeNode {
  return {
    role: "AXGroup",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children: leaves.map((l) => ({ ...l, children: [] }) as DescribeNode),
  };
}

function derive(root: DescribeNode, x: number, y: number) {
  const node = nodeAtPoint(root, { x, y })!;
  expect(node).toBeDefined();
  return deriveUniqueSelector(root, node, { x, y });
}

describe("deriveUniqueSelector", () => {
  it("keeps a plain id, text or role when it resolves to the tapped element alone", () => {
    const root = screen([
      leaf("AXButton", [0.1, 0.1, 0.2, 0.05], { identifier: "save", label: "Save" }),
      leaf("AXButton", [0.1, 0.2, 0.2, 0.05], { label: "Cancel" }),
      leaf("AXImage", [0.1, 0.3, 0.2, 0.05]),
    ]);
    expect(derive(root, 0.2, 0.12)).toEqual({ identifier: "save" });
    expect(derive(root, 0.2, 0.22)).toEqual({ text: "Cancel" });
    expect(derive(root, 0.2, 0.32)).toEqual({ role: "AXImage" });
  });

  it("accepts a nested stack of matches over the tapped point", () => {
    // A labelled container and the leaf inside it rendering the same text.
    const root = screen([
      leaf("AXStaticText", [0.4, 0.5, 0.2, 0.04], { label: "Save" }),
      leaf("AXButton", [0.1, 0.48, 0.8, 0.08], { label: "Save" }),
    ]);
    expect(derive(root, 0.5, 0.52)).toEqual({ text: "Save" });
  });

  it("scopes repeated text within the smallest identified container", () => {
    const root = screen([
      leaf("AXButton", [0.7, 0.12, 0.2, 0.05], { label: "Edit" }),
      leaf("AXStaticText", [0.05, 0.12, 0.3, 0.05], { label: "Grace" }),
      leaf("AXGroup", [0, 0.1, 1, 0.1], { identifier: "card-grace" }),
      leaf("AXButton", [0.7, 0.32, 0.2, 0.05], { label: "Edit" }),
      leaf("AXStaticText", [0.05, 0.32, 0.3, 0.05], { label: "Bob" }),
      leaf("AXGroup", [0, 0.3, 1, 0.1], { identifier: "card-bob" }),
      leaf("AXGroup", [0, 0, 1, 1], { identifier: "screen" }),
    ]);
    expect(derive(root, 0.8, 0.34)).toEqual({ text: "Edit", within: { identifier: "card-bob" } });
  });

  it("names a container by text when it has no id, preferring the tightest one", () => {
    const root = screen([
      leaf("AXButton", [0.7, 0.12, 0.2, 0.05], { label: "Follow" }),
      leaf("AXGroup", [0, 0.1, 1, 0.1], { label: "alice.bsky" }),
      leaf("AXButton", [0.7, 0.32, 0.2, 0.05], { label: "Follow" }),
      leaf("AXGroup", [0, 0.3, 1, 0.1], { label: "bob.bsky" }),
      leaf("AXGroup", [0, 0.05, 1, 0.5], { label: "Suggested" }),
    ]);
    expect(derive(root, 0.8, 0.14)).toEqual({ text: "Follow", within: { text: "alice.bsky" } });
  });

  it("anchors on the nearest unique neighbour with next when no container helps", () => {
    const root = screen([
      leaf("AXStaticText", [0.05, 0.12, 0.3, 0.05], { label: "Wi-Fi" }),
      leaf("AXButton", [0.8, 0.12, 0.15, 0.05], { label: "On", role: "AXButton" }),
      leaf("AXStaticText", [0.05, 0.22, 0.3, 0.05], { label: "Bluetooth" }),
      leaf("AXButton", [0.8, 0.22, 0.15, 0.05], { label: "On" }),
    ]);
    expect(derive(root, 0.85, 0.24)).toEqual({ text: "On", next: { text: "Bluetooth" } });
  });

  it("anchors across unrelated elements: next reads the nearest MATCHING follower", () => {
    const root = screen([
      leaf("AXStaticText", [0.05, 0.1, 0.3, 0.05], { label: "Section A" }),
      leaf("AXImage", [0.05, 0.2, 0.1, 0.05]),
      leaf("AXButton", [0.05, 0.3, 0.3, 0.05], { label: "Open" }),
      leaf("AXStaticText", [0.05, 0.5, 0.3, 0.05], { label: "Section B" }),
      leaf("AXImage", [0.05, 0.6, 0.1, 0.05]),
      leaf("AXButton", [0.05, 0.7, 0.3, 0.05], { label: "Open" }),
    ]);
    expect(derive(root, 0.1, 0.72)).toEqual({ text: "Open", next: { text: "Section B" } });
  });

  it("prefers a labelled anchor over a nearer id-only container", () => {
    const root = screen([
      leaf("AXGroup", [0, 0.1, 0.4, 0.05], { identifier: "drawer" }),
      leaf("AXStaticText", [0.05, 0.1, 0.3, 0.05], { label: "Results" }),
      leaf("AXGroup", [0, 0.16, 1, 0.01], { identifier: "divider" }),
      leaf("AXLink", [0.1, 0.2, 0.8, 0.05], { label: "Popular" }),
      leaf("AXLink", [0.1, 0.3, 0.8, 0.05], { label: "Popular" }),
    ]);
    expect(derive(root, 0.5, 0.22)).toEqual({ text: "Popular", next: { text: "Results" } });
  });

  it("folds a no-break space in the label so the YAML holds a plain space", () => {
    const root = screen([
      leaf("AXStaticText", [0.1, 0.1, 0.5, 0.05], { label: "Hubert\u00A0Gancarczyk" }),
    ]);
    expect(derive(root, 0.2, 0.12)).toEqual({ text: "Hubert Gancarczyk" });
  });

  it("adds the role when a control's label repeats its row title", () => {
    const root = screen([
      leaf("AXStaticText", [0.1, 0.1, 0.3, 0.04], {
        label: "Call volume",
        identifier: "android:id/title",
      }),
      leaf("AXAdjustable", [0.1, 0.15, 0.8, 0.05], {
        label: "Call volume",
        identifier: "android:id/seekbar",
      }),
      leaf("AXStaticText", [0.1, 0.3, 0.3, 0.04], {
        label: "Ring volume",
        identifier: "android:id/title",
      }),
      leaf("AXAdjustable", [0.1, 0.35, 0.8, 0.05], {
        label: "Ring volume",
        identifier: "android:id/seekbar",
      }),
    ]);
    expect(derive(root, 0.5, 0.37)).toEqual({ text: "Ring volume", role: "AXAdjustable" });
  });

  describe("a Settings switch row", () => {
    // iOS 27 Settings > General > Keyboards, as the flow tree flattens it: the
    // Cell carries the id, the row element repeats it with the label and the
    // state, the title is a button with the same id, and the switch itself has
    // only its state ("0"/"1"), which flips with every tap.
    function row(id: string, title: string, on: boolean, y: number, titleWidth: number): Leaf[] {
      const value = on ? "1" : "0";
      return [
        leaf("AXGroup", [0.05, y, 0.9, 0.061], { identifier: id }),
        leaf("AXSwitch", [0.09, y + 0.014, 0.821, 0.032], {
          label: title,
          value,
          identifier: id,
          checked: on,
        }),
        leaf("AXButton", [0.09, y + 0.018, titleWidth, 0.023], { label: title, identifier: id }),
        leaf("AXSwitch", [0.759, y + 0.014, 0.157, 0.032], { value, checked: on }),
      ];
    }
    const keyboards = screen([
      ...row("KeyboardAllowPaddle", "Character Preview", true, 0.415, 0.347),
      ...row("KeyboardVisceral", "Haptic Feedback", false, 0.476, 0.321),
      // A short title: smaller than the switch, so it must not win a replay.
      ...row("keyboard-audio", "Sound", true, 0.536, 0.122),
    ]);

    it("records the switch by role within its row, not by its state", () => {
      expect(derive(keyboards, 0.8375, 0.506)).toEqual({
        role: "AXSwitch",
        within: { identifier: "KeyboardVisceral" },
      });
    });

    it("records the switch of a row whose title is smaller than the switch", () => {
      const sel = derive(keyboards, 0.8375, 0.567)!;
      expect(sel).toEqual({ role: "AXSwitch", within: { identifier: "keyboard-audio" } });
      // Replay taps the switch, not the title or the row.
      expect(selectorToFrame(keyboards, sel)).toEqual({
        x: 0.759,
        y: 0.536 + 0.014,
        width: 0.157,
        height: 0.032,
      });
    });
  });

  it("returns null when no form singles the tapped element out", () => {
    const root = screen([
      leaf("AXButton", [0.1, 0.1, 0.2, 0.05], { label: "Add" }),
      leaf("AXButton", [0.1, 0.2, 0.2, 0.05], { label: "Add" }),
    ]);
    expect(derive(root, 0.2, 0.22)).toBeNull();
    // Nothing stable at all.
    const bare = screen([leaf("AXGroup", [0.1, 0.1, 0.2, 0.05])]);
    expect(derive(bare, 0.2, 0.12)).toBeNull();
  });

  it("never anchors on a neighbour whose own name repeats on screen", () => {
    const root = screen([
      leaf("AXStaticText", [0.05, 0.12, 0.3, 0.05], { label: "Name" }),
      leaf("AXButton", [0.8, 0.12, 0.15, 0.05], { label: "Edit" }),
      leaf("AXStaticText", [0.05, 0.22, 0.3, 0.05], { label: "Name" }),
      leaf("AXButton", [0.8, 0.22, 0.15, 0.05], { label: "Edit" }),
    ]);
    expect(derive(root, 0.85, 0.24)).toBeNull();
  });
});
