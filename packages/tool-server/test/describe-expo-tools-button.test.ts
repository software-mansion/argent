import { describe, expect, it } from "vitest";
import type { DescribeNode } from "../src/tools/describe/contract";
import { findUnderExpoToolsButton } from "../src/tools/describe/expo-tools-button";
import { formatDescribeTree } from "../src/tools/describe/format-tree";

const IPHONE = { width: 402, height: 874 };
const ANDROID_PHONE = { width: 411, height: 914 };

function node(
  screen: { width: number; height: number },
  role: string,
  label: string,
  [x, y, w, h]: [number, number, number, number],
  extra: Partial<DescribeNode> = {}
): DescribeNode {
  return {
    role,
    label,
    frame: {
      x: x / screen.width,
      y: y / screen.height,
      width: w / screen.width,
      height: h / screen.height,
    },
    children: [],
    ...extra,
  };
}

function root(children: DescribeNode[]): DescribeNode {
  return { role: "AXGroup", frame: { x: 0, y: 0, width: 1, height: 1 }, children };
}

const iosGear = () =>
  node(IPHONE, "AXImage", "Gear Shape, Filled", [353, 75, 26, 26], {
    identifier: "gearshape.fill",
  });
const olderIosGear = () => node(IPHONE, "AXImage", "gearshape.fill", [353, 75, 26, 26]);
const iosCaption = () => node(IPHONE, "AXStaticText", "Tools", [351, 121, 30, 13]);

function labelsUnder(tree: DescribeNode, source: Parameters<typeof findUnderExpoToolsButton>[1]) {
  return [...findUnderExpoToolsButton(tree, source)].map((n) => n.label);
}

describe("findUnderExpoToolsButton", () => {
  it("notes an iOS element under the Tools button, finding the icon by its identifier", () => {
    const tree = root([
      iosGear(),
      node(IPHONE, "AXButton", "Skip", [340, 108, 60, 24]),
      node(IPHONE, "AXHeading", "Welcome", [150, 78, 100, 20]),
      node(IPHONE, "AXButton", "Next", [340, 138, 60, 24]),
      node(IPHONE, "AXButton", "Close", [340, 26, 60, 24]),
      node(IPHONE, "AXButton", "Menu", [310, 18, 40, 20]),
      node(IPHONE, "AXButton", "Search", [296, 78, 40, 20]),
      node(IPHONE, "AXButton", "Settings", [20, 400, 26, 26], { identifier: "gearshape.fill" }),
      node(IPHONE, "AXButton", "Profile", [20, 430, 60, 20]),
    ]);

    const out = formatDescribeTree(tree, {
      source: "ax-service",
      underExpoToolsButton: findUnderExpoToolsButton(tree, "ax-service"),
    });

    const noted = out.split("\n").filter((l) => l.includes("Expo's dev Tools button"));
    expect(noted).toHaveLength(2);
    expect(noted.join("\n")).toContain('AXButton "Skip"');
    expect(noted.join("\n")).toContain('AXButton "Close"');
  });

  it("reaches further below the iOS icon while its caption shows", () => {
    const next = () => node(IPHONE, "AXButton", "Next", [340, 138, 60, 24]);
    const close = () => node(IPHONE, "AXButton", "Close", [340, 26, 60, 24]);

    expect(labelsUnder(root([olderIosGear(), next(), close()]), "ax-service")).toEqual(["Close"]);
    expect(
      labelsUnder(root([olderIosGear(), iosCaption(), next(), close()]), "ax-service")
    ).toEqual(["Next"]);
  });

  it("finds the small Android Tools icon and keeps its reach when a caption is listed", () => {
    const tree: DescribeNode = {
      role: "Screen",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        node(ANDROID_PHONE, "Image", "Tools", [356, 53, 26, 26]),
        node(ANDROID_PHONE, "StaticText", "Tools", [355, 102, 28, 15]),
        node(ANDROID_PHONE, "Button", "Skip", [345, 68, 60, 24], { clickable: true }),
        node(ANDROID_PHONE, "Button", "Next", [345, 99, 60, 24], { clickable: true }),
        node(ANDROID_PHONE, "Button", "Back", [321, 40, 40, 20], { clickable: true }),
        node(ANDROID_PHONE, "Image", "Back", [20, 500, 26, 26]),
        node(ANDROID_PHONE, "Button", "Home", [20, 525, 40, 20], { clickable: true }),
        node(ANDROID_PHONE, "View", "Tools", [0, 250, 411, 150]),
        node(ANDROID_PHONE, "Button", "Save", [180, 300, 60, 24], { clickable: true }),
        node(ANDROID_PHONE, "StaticText", "Tools", [10, 696, 40, 20]),
        node(ANDROID_PHONE, "Button", "Edit", [15, 712, 30, 14], { clickable: true }),
        node(ANDROID_PHONE, "ViewGroup", "Tools", [300, 800, 40, 40], { clickable: true }),
        node(ANDROID_PHONE, "Button", "Feed", [300, 835, 40, 16], { clickable: true }),
      ],
    };

    expect(labelsUnder(tree, "uiautomator")).toEqual(["Skip"]);
    expect(labelsUnder(tree, "android-devtools")).toEqual(["Skip"]);

    const out = formatDescribeTree(tree, {
      source: "uiautomator",
      underExpoToolsButton: findUnderExpoToolsButton(tree, "uiautomator"),
    });
    const noted = out.split("\n").filter((l) => l.includes("Expo's dev Tools button"));
    expect(noted).toHaveLength(1);
    expect(noted[0]).toContain('Button "Skip"');
  });

  it("adds no note for sources it does not model", () => {
    const tree = root([iosGear(), node(IPHONE, "AXButton", "Skip", [340, 108, 60, 24])]);

    expect(labelsUnder(tree, "cdp-dom")).toEqual([]);
    expect(labelsUnder(tree, "xcuitest-runner")).toEqual([]);
  });
});
