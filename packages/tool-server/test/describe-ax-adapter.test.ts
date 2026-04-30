import { describe, it, expect } from "vitest";
import {
  adaptAXElement,
  adaptAXDescribeToDescribeResult,
} from "../src/tools/describe/platforms/ios-ax-adapter";
import type { AXDescribeResponse } from "../src/blueprints/ax-service";

describe("describe ax-service adapter", () => {
  it("maps button trait to AXButton role", () => {
    const node = adaptAXElement({
      label: "Allow Once",
      frame: { x: 0.1, y: 0.5, width: 0.3, height: 0.05 },
      traits: ["button"],
    });
    expect(node?.role).toBe("AXButton");
  });

  it("maps header trait to AXHeading role", () => {
    const node = adaptAXElement({
      label: "General",
      frame: { x: 0.05, y: 0.3, width: 0.9, height: 0.04 },
      traits: ["header"],
    });
    expect(node?.role).toBe("AXHeading");
  });

  it("maps staticText trait to AXStaticText role", () => {
    const node = adaptAXElement({
      label: "Hello",
      frame: { x: 0.1, y: 0.1, width: 0.5, height: 0.03 },
      traits: ["staticText"],
    });
    expect(node?.role).toBe("AXStaticText");
  });

  it("defaults to AXGroup for empty traits", () => {
    const node = adaptAXElement({
      label: "Container",
      frame: { x: 0.0, y: 0.0, width: 1.0, height: 1.0 },
      traits: [],
    });
    expect(node?.role).toBe("AXGroup");
  });

  it("defaults to AXGroup when traits is undefined", () => {
    const node = adaptAXElement({
      label: "Container",
      frame: { x: 0.0, y: 0.0, width: 1.0, height: 1.0 },
    });
    expect(node?.role).toBe("AXGroup");
  });

  it("clamps frames that extend beyond [0,1]", () => {
    const node = adaptAXElement({
      label: "Overflow",
      frame: { x: -0.1, y: 0.95, width: 1.2, height: 0.2 },
      traits: ["button"],
    });
    expect(node?.frame).toEqual({
      x: 0,
      y: 0.95,
      width: 1,
      height: 0.05,
    });
  });

  it("drops elements with zero-size frames after clamping", () => {
    const node = adaptAXElement({
      label: "Offscreen",
      frame: { x: 1.5, y: 1.5, width: 0.1, height: 0.1 },
      traits: ["button"],
    });
    expect(node).toBeNull();
  });

  it("drops elements without a frame", () => {
    const node = adaptAXElement({
      label: "No frame",
      traits: ["button"],
    });
    expect(node).toBeNull();
  });

  it("preserves label and value", () => {
    const node = adaptAXElement({
      label: "Search",
      value: "query text",
      frame: { x: 0.05, y: 0.1, width: 0.9, height: 0.04 },
      traits: ["searchField"],
    });
    expect(node?.label).toBe("Search");
    expect(node?.value).toBe("query text");
    expect(node?.role).toBe("AXTextField");
  });

  it("produces nodes without a label (label is optional)", () => {
    const node = adaptAXElement({
      frame: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
      traits: ["image"],
    });
    expect(node).not.toBeNull();
    expect(node?.role).toBe("AXImage");
    expect(node?.label).toBeUndefined();
  });

  it("wraps elements in a root AXGroup", () => {
    const response: AXDescribeResponse = {
      alertVisible: false,
      screenFrame: { width: 440, height: 956 },
      elements: [
        {
          label: "General",
          frame: { x: 0.045, y: 0.337, width: 0.909, height: 0.046 },
          traits: ["button", "staticText"],
        },
        {
          label: "Search",
          frame: { x: 0.045, y: 0.16, width: 0.909, height: 0.038 },
          value: "Search",
        },
      ],
    };

    const root = adaptAXDescribeToDescribeResult(response);
    expect(root.role).toBe("AXGroup");
    expect(root.frame).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(root.children).toHaveLength(2);
    expect(root.children[0]?.label).toBe("General");
    expect(root.children[1]?.label).toBe("Search");
  });

  it("produces an empty root for an empty elements array", () => {
    const response: AXDescribeResponse = {
      alertVisible: false,
      elements: [],
    };

    const root = adaptAXDescribeToDescribeResult(response);
    expect(root.role).toBe("AXGroup");
    expect(root.children).toHaveLength(0);
  });

  it("handles an alertVisible response with dialog elements", () => {
    const response: AXDescribeResponse = {
      alertVisible: true,
      screenFrame: { width: 440, height: 956 },
      elements: [
        {
          label: "Allow Once",
          frame: { x: 0.1, y: 0.5, width: 0.8, height: 0.05 },
          traits: ["button"],
        },
        {
          label: "Don\u2019t Allow",
          frame: { x: 0.1, y: 0.56, width: 0.8, height: 0.05 },
          traits: ["button"],
        },
      ],
    };

    const root = adaptAXDescribeToDescribeResult(response);
    expect(root.children).toHaveLength(2);
    expect(root.children[0]?.role).toBe("AXButton");
    expect(root.children[0]?.label).toBe("Allow Once");
    expect(root.children[1]?.label).toBe("Don\u2019t Allow");
  });

  it("filters out elements with no visible area", () => {
    const response: AXDescribeResponse = {
      alertVisible: false,
      elements: [
        {
          label: "Visible",
          frame: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
          traits: ["button"],
        },
        {
          label: "Zero width",
          frame: { x: 0.5, y: 0.5, width: 0, height: 0.1 },
          traits: ["button"],
        },
        {
          label: "No frame",
          traits: ["staticText"],
        },
      ],
    };

    const root = adaptAXDescribeToDescribeResult(response);
    expect(root.children).toHaveLength(1);
    expect(root.children[0]?.label).toBe("Visible");
  });
});
