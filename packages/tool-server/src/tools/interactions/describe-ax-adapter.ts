import { mapNativeTraitsToDescribeRole } from "./describe-native-adapter";
import { parseDescribeResult, type DescribeNode } from "./describe-contract";
import type { AXDescribeResponse, AXDescribeElement } from "../../blueprints/ax-service";

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function roundNormalized(value: number): number {
  return Math.round(value * 1e12) / 1e12;
}

export function adaptAXElement(el: AXDescribeElement): DescribeNode | null {
  if (!el.frame) return null;
  const x1 = clamp01(el.frame.x);
  const y1 = clamp01(el.frame.y);
  const x2 = clamp01(el.frame.x + el.frame.width);
  const y2 = clamp01(el.frame.y + el.frame.height);
  const width = x2 - x1;
  const height = y2 - y1;
  if (width <= 0 || height <= 0) return null;

  return {
    role: mapNativeTraitsToDescribeRole(el.traits ?? []),
    frame: {
      x: roundNormalized(x1),
      y: roundNormalized(y1),
      width: roundNormalized(width),
      height: roundNormalized(height),
    },
    children: [],
    label: el.label,
    value: el.value,
  };
}

export function adaptAXDescribeToDescribeResult(
  response: AXDescribeResponse
): DescribeNode {
  const children = response.elements
    .map(adaptAXElement)
    .filter((n): n is DescribeNode => n !== null);

  return parseDescribeResult({
    role: "AXGroup",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children,
  });
}
