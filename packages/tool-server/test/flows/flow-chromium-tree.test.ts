import { describe, it, expect } from "vitest";
import { adaptChromiumTreeForFlows } from "../../src/tools/flows/flow-chromium-tree";
import { assertText, evaluateCondition, findAll } from "../../src/utils/ui-tree-match";
import type { DescribeNode } from "../../src/tools/describe/contract";

const FULL = { x: 0, y: 0, width: 1, height: 1 };

function el(partial: Partial<DescribeNode>): DescribeNode {
  return { role: "div", frame: FULL, children: [], ...partial } as DescribeNode;
}

// A screen shaped like the CDP DOM walker's output for an RN-web app: a
// testID'd log container whose lines are child text nodes, a labelled button,
// a password input, and a row scrolled off-viewport (frame clamped to zero
// area by the walker).
function screen(): DescribeNode {
  return el({
    role: "html",
    children: [
      el({
        identifier: "log-box",
        frame: { x: 0.02, y: 0.68, width: 0.96, height: 0.2 },
        children: [
          el({ value: "Event log", frame: { x: 0.03, y: 0.7, width: 0.94, height: 0.02 } }),
          el({
            value: "[15:06:21] outer tap gesture",
            frame: { x: 0.03, y: 0.73, width: 0.94, height: 0.02 },
          }),
        ],
      }),
      el({
        role: "button",
        clickable: true,
        frame: { x: 0.45, y: 0.3, width: 0.09, height: 0.04 },
        children: [
          el({ value: "Clear logs", frame: { x: 0.45, y: 0.3, width: 0.09, height: 0.04 } }),
        ],
      }),
      el({
        role: "input",
        identifier: "pw",
        password: true,
        label: "Enter password",
        frame: { x: 0.1, y: 0.1, width: 0.5, height: 0.04 },
      }),
      el({ value: "Below the fold", frame: { x: 0.03, y: 1, width: 0.94, height: 0 } }),
    ],
  });
}

describe("adaptChromiumTreeForFlows", () => {
  it("hoists descendant text onto an identified container for text asserts", () => {
    const tree = adaptChromiumTreeForFlows(screen());
    const matches = findAll(tree, { identifier: "log-box" });
    expect(matches).toHaveLength(1);
    expect(assertText(matches[0]!)).toContain("outer tap gesture");
    expect(
      evaluateCondition("text", "outer tap gesture", matches, "contains")
    ).toBe(true);
  });

  it("scopes hoisted text to the nearest identified ancestor", () => {
    const tree = adaptChromiumTreeForFlows(screen());
    // log-box shields its lines: the root/screen must not swallow them, and
    // sibling containers must not see them.
    const button = findAll(tree, { role: "button" }).find((n) => n.clickable);
    expect(button).toBeDefined();
    expect(assertText(button!)).not.toContain("outer tap gesture");
  });

  it("keeps selector targeting on child text (tap by text still resolves)", () => {
    const tree = adaptChromiumTreeForFlows(screen());
    const matches = findAll(tree, { text: "Clear logs" });
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]!.frame.height).toBeGreaterThan(0);
  });

  it("never hoists text from zero-area (off-viewport) nodes", () => {
    const tree = adaptChromiumTreeForFlows(screen());
    const walk = (n: DescribeNode): string[] => [
      n.subtreeText ?? "",
      ...n.children.flatMap(walk),
    ];
    expect(walk(tree).join(" ")).not.toContain("Below the fold");
  });

  it("shields a password field's text from bubbling upward", () => {
    const inner = el({
      identifier: "form",
      frame: { x: 0, y: 0, width: 1, height: 0.5 },
      children: [
        el({
          role: "input",
          password: true,
          label: "hunter2",
          frame: { x: 0, y: 0.1, width: 1, height: 0.05 },
        }),
      ],
    });
    const tree = adaptChromiumTreeForFlows(el({ role: "html", children: [inner] }));
    const form = findAll(tree, { identifier: "form" });
    expect(form).toHaveLength(1);
    expect(assertText(form[0]!)).not.toContain("hunter2");
  });

  it("drops pure scaffolding but keeps addressable descendants", () => {
    const tree = adaptChromiumTreeForFlows(screen());
    // Root wrapper: flat leaves under one synthetic Screen node.
    expect(tree.role).toBe("Screen");
    for (const child of tree.children) {
      expect(child.children).toHaveLength(0);
      expect(
        Boolean(child.identifier || child.label || child.value || child.clickable)
      ).toBe(true);
    }
  });
});
