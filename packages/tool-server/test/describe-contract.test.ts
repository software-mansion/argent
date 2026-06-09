import { describe, it, expect } from "vitest";
import {
  describeNodeSchema,
  getDescribeTapPoint,
  parseDescribeResult,
} from "../src/tools/describe/contract";

const settingsDescribeSample = {
  role: "AXGroup",
  frame: { x: 0, y: 0, width: 1, height: 1 },
  children: [
    {
      role: "AXHeading",
      frame: {
        x: 0.041025641025641144,
        y: 0.12401263823064766,
        width: 0.34102564102564104,
        height: 0.0481832543443918,
      },
      label: "Settings",
      children: [],
    },
    {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        {
          role: "AXButton",
          frame: {
            x: 0.041025641025641144,
            y: 0.32977883096366506,
            width: 0.9179487179487179,
            height: 0.06161137440758294,
          },
          identifier: "com.apple.settings.general",
          label: "General",
          children: [],
        },
      ],
    },
    {
      role: "AXGroup",
      frame: {
        x: 0,
        y: 0.8981042654028436,
        width: 1,
        height: 0.1018957345971564,
      },
      identifier: "Toolbar",
      label: "Toolbar",
      children: [],
    },
  ],
};

describe("describe public contract", () => {
  it("accepts the live AX describe payload shape", () => {
    const result = parseDescribeResult(settingsDescribeSample);

    expect(result.role).toBe("AXGroup");
    expect(result.children).toHaveLength(3);
    expect(result.children[0]?.role).toBe("AXHeading");
    expect(result.children[1]?.children[0]?.identifier).toBe("com.apple.settings.general");
  });

  it("computes tap points from the normalized frame midpoint", () => {
    const tap = getDescribeTapPoint({
      x: 0.1,
      y: 0.2,
      width: 0.4,
      height: 0.6,
    });

    expect(tap.x).toBeCloseTo(0.3);
    expect(tap.y).toBeCloseTo(0.5);
  });

  it("rejects frames outside normalized [0,1] bounds", () => {
    const invalid = {
      role: "AXButton",
      frame: { x: 1.2, y: 0.1, width: 0.2, height: 0.2 },
      children: [],
    };

    expect(() => parseDescribeResult(invalid)).toThrow();
  });

  it("requires children on every node to preserve tree semantics", () => {
    const invalid = {
      role: "AXButton",
      frame: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
    };

    expect(() => parseDescribeResult(invalid)).toThrow();
  });

  it("allows additional non-contract fields without breaking compatibility", () => {
    const result = describeNodeSchema.parse({
      role: "AXButton",
      frame: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
      children: [],
      hint: "Extra metadata preserved by passthrough",
    });

    expect(result.role).toBe("AXButton");
  });
});
