import { AXDescribeElement, AXDescribeResponse } from "../../../../blueprints/ax-service";
import { DescribeNode, parseDescribeResult } from "../../contract";
import { mapNativeTraitsToDescribeRole } from "./ios-native-adapter";

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

export function adaptAXDescribeToDescribeResult(response: AXDescribeResponse): DescribeNode {
  let children = response.elements.map(adaptAXElement).filter((n): n is DescribeNode => n !== null);

  // Springboard-hosted overlays (e.g. AKAppleIDAuthentication sheets) can be
  // invisible to the `primaryApp` AX walk while still being reachable from
  // `systemApplication`. The daemon already collects that tree as
  // `systemElements` when `isSystemAppShowingAnAlert` is true, but for every
  // in-process dialog the same buttons appear in `elements` and we'd just be
  // duplicating them. Fall back only when the primary walk produced nothing.
  if (children.length === 0 && response.systemElements && response.systemElements.length > 0) {
    children = response.systemElements
      .map(adaptAXElement)
      .filter((n): n is DescribeNode => n !== null);
  }

  return parseDescribeResult({
    role: "AXGroup",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children,
  });
}
