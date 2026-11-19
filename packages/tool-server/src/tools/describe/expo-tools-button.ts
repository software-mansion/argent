import { getDescribeTapPoint, type DescribeNode, type DescribeSource } from "./contract";

// Expo development builds and Expo Go draw a floating "Tools" button
// (expo-dev-menu) over the app. It takes taps in an area larger than its gear
// icon, so an app element whose tap point is in that area cannot be tapped there.

interface Reach {
  across: number;
  up: number;
  down: number;
}

interface ToolsButtonModel {
  isIcon(n: DescribeNode): boolean;
  reach: Reach;
  reachWithCaption?: Reach;
}

// The gear icon is 26 pt on iOS and 26 dp on Android. Reach is measured in
// those units from the icon centre.
const ICON_SIZE = 26;
const TOOLS_LABEL = "Tools";
const IOS_ICON_SYMBOL = "gearshape.fill";

// DevMenuFABWindow takes touches up to 10 pt outside its 72 x 94 pt frame. The
// icon centre is 36 pt from its sides and 47 pt from its top, or 32.5 pt from
// its top while the caption shows. Newer iOS labels the icon "Gear Shape,
// Filled" and keeps the symbol name as its identifier.
const IOS_MODEL: ToolsButtonModel = {
  isIcon: (n) =>
    n.role === "AXImage" && (n.identifier === IOS_ICON_SYMBOL || n.label === IOS_ICON_SYMBOL),
  reach: { across: 36 + 10, up: 47 + 10, down: 47 + 10 },
  reachWithCaption: { across: 36 + 10, up: 32.5 + 10, down: 94 - 32.5 + 10 },
};

// A 26 dp icon stays under this fraction of a screen at least 260 dp across.
const MAX_ICON_FRACTION = 0.1;

// MovableFloatingActionButton takes touches in a 52 dp square around the icon
// once its caption hides. The Android tree can keep the caption after it
// hides, so only that square is modelled.
const ANDROID_MODEL: ToolsButtonModel = {
  isIcon: (n) =>
    n.label === TOOLS_LABEL &&
    !n.clickable &&
    !/text|button/i.test(n.role) &&
    n.frame.width < MAX_ICON_FRACTION &&
    n.frame.height < MAX_ICON_FRACTION,
  reach: { across: 26, up: 26, down: 26 },
};

const MODELS: Partial<Record<DescribeSource, ToolsButtonModel>> = {
  "ax-service": IOS_MODEL,
  "android-devtools": ANDROID_MODEL,
  "uiautomator": ANDROID_MODEL,
};

export const EXPO_TOOLS_BUTTON_NOTE =
  "under Expo's dev Tools button: a tap at the centre of this element goes to that button. Tap a part of it far from the Tools icon, or scroll it clear";

function allNodes(root: DescribeNode): DescribeNode[] {
  const out: DescribeNode[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    out.push(node);
    stack.push(...node.children);
  }
  return out;
}

function offsetInIconUnits(icon: DescribeNode, n: DescribeNode): { dx: number; dy: number } {
  const iconCentre = getDescribeTapPoint(icon.frame);
  const point = getDescribeTapPoint(n.frame);
  return {
    dx: ((point.x - iconCentre.x) / icon.frame.width) * ICON_SIZE,
    dy: ((point.y - iconCentre.y) / icon.frame.height) * ICON_SIZE,
  };
}

function isUnder(icon: DescribeNode, reach: Reach, n: DescribeNode): boolean {
  const { dx, dy } = offsetInIconUnits(icon, n);
  return Math.abs(dx) <= reach.across && dy >= -reach.up && dy <= reach.down;
}

function reachFor(
  icon: DescribeNode,
  model: ToolsButtonModel,
  nodes: DescribeNode[]
): { reach: Reach; caption?: DescribeNode } {
  const withCaption = model.reachWithCaption;
  if (!withCaption) return { reach: model.reach };
  const caption = nodes.find((n) => n.label === TOOLS_LABEL && isUnder(icon, withCaption, n));
  return caption ? { reach: withCaption, caption } : { reach: model.reach };
}

/** App elements whose tap point lies under Expo's floating dev Tools button. */
export function findUnderExpoToolsButton(
  root: DescribeNode,
  source: DescribeSource
): Set<DescribeNode> {
  const covered = new Set<DescribeNode>();
  const model = MODELS[source];
  if (!model) return covered;
  const nodes = allNodes(root);
  const icons = nodes.filter((n) => model.isIcon(n));
  const buttonParts = new Set<DescribeNode>(icons);
  const areas: Array<{ icon: DescribeNode; reach: Reach }> = [];
  for (const icon of icons) {
    const { reach, caption } = reachFor(icon, model, nodes);
    if (caption) buttonParts.add(caption);
    areas.push({ icon, reach });
  }
  for (const n of nodes) {
    if (buttonParts.has(n)) continue;
    if (areas.some(({ icon, reach }) => isUnder(icon, reach, n))) covered.add(n);
  }
  return covered;
}
