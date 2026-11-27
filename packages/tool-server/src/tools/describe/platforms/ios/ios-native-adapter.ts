import {
  NativeDescribeElement,
  NativeDescribeScreenResult,
} from "../../../native-devtools/native-describe-contract";
import { DescribeFrame, DescribeNode, parseDescribeResult } from "../../contract";

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
  // `textEntry` is on every text input (ax-service reads it from a private trait bit).
  if (set.has("searchField") || set.has("textEntry")) return "AXTextField";
  if (set.has("link")) return "AXLink";
  if (set.has("image")) return "AXImage";
  if (set.has("staticText")) return "AXStaticText";
  if (set.has("tabBar")) return "AXTabBar";
  if (set.has("adjustable")) return "AXAdjustable";
  return "AXGroup";
}

// UIKit exposes every UIScrollView's vertical and horizontal scroll indicators
// as adjustable elements ("Vertical scroll bar, 1 page" value="0%"), even for
// single-page containers and inside table cells. They are not actionable tap
// targets (scroll with `gesture-swipe`), matching macOS, HarmonyOS and physical
// iOS which already drop scroll bars. Real adjustable controls (sliders,
// steppers, pickers, section indices) and anything with an explicit identifier
// or hint stay.
const IOS_SCROLL_BAR_LABEL = /^(Vertical|Horizontal) scroll bar, .+\bpages?$/;
const PERCENT_VALUE = /^\d+(?:\.\d+)?%$/;

export function isIosScrollBar(
  role: string,
  el: { label?: string; value?: string; identifier?: string; hint?: string }
): boolean {
  return (
    role === "AXAdjustable" &&
    !el.identifier &&
    !el.hint &&
    typeof el.label === "string" &&
    IOS_SCROLL_BAR_LABEL.test(el.label) &&
    (el.value === undefined || PERCENT_VALUE.test(el.value))
  );
}

export function adaptNativeDescribeElementToDescribeNode(
  element: NativeDescribeElement
): DescribeNode | null {
  const frame = clampNormalizedFrame(element.normalizedFrame);
  if (!frame) return null;

  const role = mapNativeTraitsToDescribeRole(element.traits);
  if (isIosScrollBar(role, element)) return null;

  return {
    role,
    frame,
    children: [],
    label: element.label,
    hint: element.hint,
    identifier: element.identifier,
    value: element.value,
    ...(element.traits.includes("notEnabled") ? { disabled: true } : {}),
    ...(element.traits.includes("selected") ? { selected: true } : {}),
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
