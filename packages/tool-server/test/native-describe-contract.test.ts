import { describe, it, expect } from "vitest";
import {
  nativeDescribeScreenResultSchema,
  parseNativeDescribeScreenResult,
} from "../src/tools/native-devtools/native-describe-contract";

describe("native describe screen contract", () => {
  it("accepts screen metadata and normalized accessibility element fields", () => {
    const result = parseNativeDescribeScreenResult({
      screenFrame: {
        x: 0,
        y: 0,
        width: 390,
        height: 844,
      },
      elements: [
        {
          frame: {
            x: 16,
            y: 104.6666666667,
            width: 133,
            height: 40.6666666667,
          },
          tapPoint: {
            x: 82.5,
            y: 125,
          },
          normalizedFrame: {
            x: 16 / 390,
            y: 104.6666666667 / 844,
            width: 133 / 390,
            height: 40.6666666667 / 844,
          },
          normalizedTapPoint: {
            x: 82.5 / 390,
            y: 125 / 844,
          },
          traits: ["header"],
          label: "Settings",
          viewClassName: "UILabel",
        },
      ],
    });

    expect(result.screenFrame.width).toBe(390);
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0]?.normalizedFrame.x).toBeCloseTo(0.041025641, 6);
    expect(result.elements[0]?.normalizedTapPoint.y).toBeCloseTo(125 / 844, 6);
  });

  it("requires screenFrame metadata", () => {
    expect(() =>
      parseNativeDescribeScreenResult({
        elements: [],
      })
    ).toThrow();
  });

  it("allows additional native metadata without breaking the contract", () => {
    const result = nativeDescribeScreenResultSchema.parse({
      screenFrame: {
        x: 0,
        y: 0,
        width: 390,
        height: 844,
      },
      elements: [],
      orientation: "Portrait",
    });

    expect(result.screenFrame.height).toBe(844);
  });
});
