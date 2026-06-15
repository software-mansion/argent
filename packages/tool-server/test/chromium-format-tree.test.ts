import { describe, it, expect } from "vitest";
import { formatDescribeTree } from "../src/tools/describe/format-tree";
import type { DescribeNode } from "../src/tools/describe/contract";

const tree: DescribeNode = {
  role: "html",
  frame: { x: 0, y: 0, width: 1, height: 1 },
  children: [
    {
      role: "body",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        {
          role: "h1",
          frame: { x: 0, y: 0, width: 1, height: 0.1 },
          children: [],
          value: "Hello World",
          identifier: "title",
        },
        {
          role: "button",
          frame: { x: 0, y: 0.2, width: 0.2, height: 0.05 },
          children: [],
          label: "Click me",
          identifier: "go",
          clickable: true,
        },
      ],
    },
  ],
};

describe("formatDescribeTree (cdp-dom)", () => {
  it("renders nested mode and shows descendants beyond depth 1", () => {
    const out = formatDescribeTree(tree, { source: "cdp-dom" });
    expect(out).toContain("Mode: nested");
    // Body, h1, and button must all appear — flat mode would only emit body.
    expect(out).toContain("body");
    expect(out).toContain("h1");
    expect(out).toContain('"Click me"');
    expect(out).toContain('id="go"');
    expect(out).toContain("clickable");
    // The h1 has value "Hello World" — must surface in the rendering.
    expect(out).toContain("Hello World");
  });
});
