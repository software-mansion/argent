import { describe, it, expect } from "vitest";
import {
  adaptNativeDescribeElementToDescribeNode,
  adaptNativeDescribeToDescribeResult,
  mapNativeTraitsToDescribeRole,
} from "../src/tools/describe/platforms/ios/ios-native-adapter";
import type { NativeDescribeScreenResult } from "../src/tools/native-devtools/native-describe-contract";

describe("describe native adapter", () => {
  it("maps native traits to public describe roles", () => {
    expect(mapNativeTraitsToDescribeRole(["header"])).toBe("AXHeading");
    expect(mapNativeTraitsToDescribeRole(["button"])).toBe("AXButton");
    expect(mapNativeTraitsToDescribeRole(["toggleButton"])).toBe("AXButton");
    expect(mapNativeTraitsToDescribeRole(["staticText"])).toBe("AXStaticText");
    expect(mapNativeTraitsToDescribeRole([])).toBe("AXGroup");
  });

  it("converts a native element into a leaf describe node", () => {
    const node = adaptNativeDescribeElementToDescribeNode({
      frame: { x: 16, y: 80, width: 100, height: 44 },
      tapPoint: { x: 66, y: 102 },
      normalizedFrame: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
      normalizedTapPoint: { x: 0.25, y: 0.25 },
      traits: ["button"],
      label: "Continue",
      identifier: "continue-button",
    });

    expect(node).toEqual({
      role: "AXButton",
      frame: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
      children: [],
      label: "Continue",
      identifier: "continue-button",
      value: undefined,
    });
  });

  it("clamps partially off-screen normalized frames into the public [0,1] contract", () => {
    const node = adaptNativeDescribeElementToDescribeNode({
      frame: { x: -10, y: 800, width: 420, height: 100 },
      tapPoint: { x: 200, y: 850 },
      normalizedFrame: { x: -0.1, y: 0.95, width: 1.2, height: 0.2 },
      normalizedTapPoint: { x: 0.5, y: 1.02 },
      traits: ["button"],
    });

    expect(node?.frame).toEqual({
      x: 0,
      y: 0.95,
      width: 1,
      height: 0.05,
    });
  });

  it("drops elements that have no visible normalized area after clamping", () => {
    const node = adaptNativeDescribeElementToDescribeNode({
      frame: { x: 0, y: 0, width: 10, height: 10 },
      tapPoint: { x: 5, y: 5 },
      normalizedFrame: { x: 1.2, y: 1.1, width: 0.2, height: 0.2 },
      normalizedTapPoint: { x: 1.25, y: 1.2 },
      traits: ["button"],
    });

    expect(node).toBeNull();
  });

  it("wraps native elements in the old recursive describe root shape", () => {
    const result = adaptNativeDescribeToDescribeResult({
      screenFrame: { x: 0, y: 0, width: 390, height: 844 },
      elements: [
        {
          frame: { x: 16, y: 80, width: 100, height: 44 },
          tapPoint: { x: 66, y: 102 },
          normalizedFrame: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
          normalizedTapPoint: { x: 0.25, y: 0.25 },
          traits: ["button"],
          label: "Continue",
        },
      ],
    } satisfies NativeDescribeScreenResult);

    expect(result.role).toBe("AXGroup");
    expect(result.frame).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(result.children).toHaveLength(1);
    expect(result.children[0]?.role).toBe("AXButton");
    expect(result.children[0]?.children).toEqual([]);
  });
});
