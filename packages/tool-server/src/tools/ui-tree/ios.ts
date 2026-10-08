import type { DeviceInfo, Registry } from "@argent/registry";
import { axServiceRef, type AXServiceApi, type AXTreeResponse } from "../../blueprints/ax-service";
import type { DescribeFrame } from "../describe/contract";
import { mapNativeTraitsToDescribeRole } from "../describe/platforms/ios/ios-native-adapter";
import type { UiTree, UiTreeNode } from "./index";

// What an ax-service older than `treeVersion` 2 does not send. `hidden`
// comes from frames, so every version reports it.
const LEGACY_UNSUPPORTED_FIELDS = [
  "type",
  "password",
  "placeholder",
  "hintShowing",
  "foregroundApp",
];

// XCUIElementType, by value, as XCTest names it.
const ELEMENT_TYPES = [
  "Any",
  "Other",
  "Application",
  "Group",
  "Window",
  "Sheet",
  "Drawer",
  "Alert",
  "Dialog",
  "Button",
  "RadioButton",
  "RadioGroup",
  "CheckBox",
  "DisclosureTriangle",
  "PopUpButton",
  "ComboBox",
  "MenuButton",
  "ToolbarButton",
  "Popover",
  "Keyboard",
  "Key",
  "NavigationBar",
  "TabBar",
  "TabGroup",
  "Toolbar",
  "StatusBar",
  "Table",
  "TableRow",
  "TableColumn",
  "Outline",
  "OutlineRow",
  "Browser",
  "CollectionView",
  "Slider",
  "PageIndicator",
  "ProgressIndicator",
  "ActivityIndicator",
  "SegmentedControl",
  "Picker",
  "PickerWheel",
  "Switch",
  "Toggle",
  "Link",
  "Image",
  "Icon",
  "SearchField",
  "ScrollView",
  "ScrollBar",
  "StaticText",
  "TextField",
  "SecureTextField",
  "DatePicker",
  "TextView",
  "Menu",
  "MenuItem",
  "MenuBar",
  "MenuBarItem",
  "Map",
  "WebView",
  "IncrementArrow",
  "DecrementArrow",
  "Timeline",
  "RatingIndicator",
  "ValueIndicator",
  "SplitGroup",
  "Splitter",
  "RelevanceIndicator",
  "ColorWell",
  "HelpTag",
  "Matte",
  "DockItem",
  "Ruler",
  "RulerMarker",
  "Grid",
  "LevelIndicator",
  "Cell",
  "LayoutArea",
  "LayoutItem",
  "Handle",
  "Stepper",
  "Tab",
  "TouchBar",
  "StatusItem",
];

const FULL_SCREEN: DescribeFrame = { x: 0, y: 0, width: 1, height: 1 };

function intersect(a: DescribeFrame, b: DescribeFrame): DescribeFrame | undefined {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : undefined;
}

/**
 * A node is hidden when no part of its frame is on screen inside every framed
 * ancestor: scrolled out, or clipped by a scroll view. AX's own visibility
 * attribute costs the app milliseconds per node, and it agrees with this.
 */
function markHidden(node: UiTreeNode, clip: DescribeFrame | undefined): void {
  let inner = clip;
  if (node.frame) {
    inner = clip && intersect(node.frame, clip);
    if (!inner) node.hidden = true;
  }
  for (const child of node.children) markHidden(child, inner);
}

/** Nests the daemon's document-order nodes by `parentIndex`; a node whose parent is missing becomes a root. */
export function adaptAxTree(response: AXTreeResponse): UiTree {
  const byIndex = new Map<number, UiTreeNode>();
  const roots: UiTreeNode[] = [];
  let keyboardVisible = false;
  for (const raw of response.nodes) {
    const traits = raw.traits ?? [];
    const has = (name: string) => traits.includes(name);
    if (has("keyboardKey")) keyboardVisible = true;
    const node: UiTreeNode = {
      role: mapNativeTraitsToDescribeRole(traits),
      label: raw.label,
      // AX answers an empty input's placeholder as its value.
      value: raw.hintShowing ? undefined : raw.value,
      identifier: raw.identifier,
      roleDescription: raw.roleDescription,
      frame: raw.frame,
      children: [],
    };
    // AX answers 0 (Any, a query wildcard) for a plain container; XCTest reports it as Other.
    if (raw.elementType !== undefined)
      node.type =
        raw.elementType === 0
          ? "Other"
          : (ELEMENT_TYPES[raw.elementType] ?? String(raw.elementType));
    if (traits.length > 0) node.traits = traits;
    if (raw.bundleId) node.bundleId = raw.bundleId;
    if (has("header")) node.heading = true;
    if (has("notEnabled")) node.disabled = true;
    if (has("selected")) node.selected = true;
    if (has("isEditing")) node.focused = true;
    if (has("textEntry") || has("searchField")) node.editable = true;
    if (has("secureTextEntry")) node.password = true;
    if (raw.placeholder) node.placeholder = raw.placeholder;
    if (raw.hintShowing) node.hintShowing = true;
    if (has("toggleButton") && (raw.value === "1" || raw.value === "0")) {
      node.checked = raw.value === "1";
    }
    if (raw.covered) node.covered = true;
    const parent = raw.parentIndex === undefined ? undefined : byIndex.get(raw.parentIndex);
    byIndex.set(raw.index, node);
    (parent ? parent.children : roots).push(node);
  }
  for (const root of roots) markHidden(root, FULL_SCREEN);
  return {
    schemaVersion: 1,
    source: "ax-service",
    screen: response.screenFrame,
    roots,
    truncated: response.truncated,
    alertVisible: response.alertVisible,
    // A truncated walk may have cut the keyboard, so absence is unknown there.
    keyboardVisible: keyboardVisible || (response.truncated ? undefined : false),
    foregroundApp: response.foregroundApp,
    unsupportedFields: (response.treeVersion ?? 1) >= 2 ? [] : LEGACY_UNSUPPORTED_FIELDS,
  };
}

export async function readIosUiTree(registry: Registry, device: DeviceInfo): Promise<UiTree> {
  const ref = axServiceRef(device);
  const ax = await registry.resolveService<AXServiceApi>(ref.urn, ref.options);
  return adaptAxTree(await ax.tree());
}
