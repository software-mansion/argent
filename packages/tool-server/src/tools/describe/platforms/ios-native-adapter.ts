import type {
  NativeDescribeElement,
  NativeDescribeScreenResult,
} from "../../native-devtools/native-describe-contract";
import { parseDescribeResult, type DescribeFrame, type DescribeNode } from "../contract";

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function roundNormalized(value: number): number {
  return Math.round(value * 1e12) / 1e12;
}

function clampNormalizedFrame(
  frame: NativeDescribeElement["normalizedFrame"]
): DescribeFrame | null {
  const x1 = clamp01(frame.x);
  const y1 = clamp01(frame.y);
  const x2 = clamp01(frame.x + frame.width);
  const y2 = clamp01(frame.y + frame.height);
  const width = x2 - x1;
  const height = y2 - y1;
  if (width <= 0 || height <= 0) {
    return null;
  }
  return {
    x: roundNormalized(x1),
    y: roundNormalized(y1),
    width: roundNormalized(width),
    height: roundNormalized(height),
  };
}

export function mapNativeTraitsToDescribeRole(traits: string[]): string {
  const set = new Set(traits);
  if (set.has("header")) return "AXHeading";
  if (set.has("button") || set.has("toggleButton")) return "AXButton";
  if (set.has("searchField")) return "AXTextField";
  if (set.has("link")) return "AXLink";
  if (set.has("image")) return "AXImage";
  if (set.has("staticText")) return "AXStaticText";
  if (set.has("tabBar")) return "AXTabBar";
  if (set.has("adjustable")) return "AXAdjustable";
  return "AXGroup";
}

export function adaptNativeDescribeElementToDescribeNode(
  element: NativeDescribeElement
): DescribeNode | null {
  const frame = clampNormalizedFrame(element.normalizedFrame);
  if (!frame) return null;

  return {
    role: mapNativeTraitsToDescribeRole(element.traits),
    frame,
    children: [],
    label: element.label,
    identifier: element.identifier,
    value: element.value,
  };
}

export function adaptNativeDescribeToDescribeResult(
  result: NativeDescribeScreenResult
): DescribeNode {
  const children = result.elements
    .map(adaptNativeDescribeElementToDescribeNode)
    .filter((node): node is DescribeNode => node !== null);

  return parseDescribeResult({
    role: "AXGroup",
    frame: {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    },
    children,
  });
}
