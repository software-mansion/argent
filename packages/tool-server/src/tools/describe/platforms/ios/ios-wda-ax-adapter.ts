import { XMLParser } from "fast-xml-parser";
import { parseDescribeResult, type DescribeNode } from "../../contract";

type XmlNode = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: false,
  trimValues: false,
});

function numeric(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function bool(value: unknown): boolean | undefined {
  if (value === "true" || value === true) return true;
  if (value === "false" || value === false) return false;
  return undefined;
}

function childEntries(node: XmlNode): Array<[string, XmlNode]> {
  const children: Array<[string, XmlNode]> = [];
  for (const [key, value] of Object.entries(node)) {
    if (!key.startsWith("XCUIElementType")) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item && typeof item === "object") children.push([key, item as XmlNode]);
    }
  }
  return children;
}

function firstElement(value: unknown): [string, XmlNode] | undefined {
  if (!value || typeof value !== "object") return undefined;
  for (const [key, item] of Object.entries(value as XmlNode)) {
    if (key.startsWith("XCUIElementType") && item && typeof item === "object") {
      const node = (Array.isArray(item) ? item[0] : item) as XmlNode;
      return [key, node];
    }
    const nested = firstElement(item);
    if (nested) return nested;
  }
  return undefined;
}

function adaptNode(type: string, node: XmlNode, screenWidth: number, screenHeight: number): DescribeNode {
  const rawX = numeric(node.x);
  const rawY = numeric(node.y);
  const rawWidth = Math.max(0, numeric(node.width));
  const rawHeight = Math.max(0, numeric(node.height));
  const x1 = Math.max(0, Math.min(screenWidth, rawX));
  const y1 = Math.max(0, Math.min(screenHeight, rawY));
  const x2 = Math.max(x1, Math.min(screenWidth, rawX + rawWidth));
  const y2 = Math.max(y1, Math.min(screenHeight, rawY + rawHeight));
  const label = typeof node.label === "string" && node.label ? node.label : undefined;
  const name = typeof node.name === "string" && node.name ? node.name : undefined;
  const identifier =
    typeof node.identifier === "string" && node.identifier
      ? node.identifier
      : name && name !== label
        ? name
        : undefined;
  const value = typeof node.value === "string" && node.value ? node.value : undefined;
  const enabled = bool(node.enabled);
  const focused = bool(node.focused);
  const selected = bool(node.selected);

  return {
    role: type.replace(/^XCUIElementType/, "AX") || "AXUnknown",
    frame: {
      x: screenWidth > 0 ? x1 / screenWidth : 0,
      y: screenHeight > 0 ? y1 / screenHeight : 0,
      width: screenWidth > 0 ? (x2 - x1) / screenWidth : 0,
      height: screenHeight > 0 ? (y2 - y1) / screenHeight : 0,
    },
    children: childEntries(node).map(([childType, child]) =>
      adaptNode(childType, child, screenWidth, screenHeight)
    ),
    ...(label ? { label } : {}),
    ...(identifier ? { identifier } : {}),
    ...(value ? { value } : {}),
    ...(enabled === false ? { disabled: true } : {}),
    ...(focused != null ? { focused } : {}),
    ...(selected != null ? { selected } : {}),
  };
}

/** Convert WebDriverAgent's exact XCTest hierarchy into Argent's normalized describe tree. */
export function adaptWdaSourceToDescribeResult(
  xml: string,
  screen: { width: number; height: number }
): DescribeNode {
  const root = firstElement(parser.parse(xml));
  if (!root) {
    return parseDescribeResult({
      role: "AXApplication",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [],
    });
  }
  return parseDescribeResult(adaptNode(root[0], root[1], screen.width, screen.height));
}
