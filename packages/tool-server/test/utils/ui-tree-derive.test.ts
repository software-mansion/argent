import { describe, expect, it } from "vitest";
import type { DescribeNode } from "../../src/tools/describe/contract";
import { deriveUniqueSelector, nodeAtPoint } from "../../src/utils/ui-tree-match";

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
