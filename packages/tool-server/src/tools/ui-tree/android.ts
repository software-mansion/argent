import type { DeviceInfo, Registry } from "@argent/registry";
import { androidDevtoolsRef, type AndroidDevtoolsApi } from "../../blueprints/android-devtools";
import {
  attrIsTrue,
  deriveUiAutomatorRole,
  parseUiAutomatorBounds,
  parseUiAutomatorXml,
} from "../describe/platforms/android/uiautomator-parser";
import { FLOW_MAX_NODES } from "../flows/flow-android-tree";
import type { UiTree, UiTreeNode } from "./index";

// The helper writes no hint, visible-to-user, heading or window-type attributes.
const UNSUPPORTED_FIELDS = [
  "placeholder",
  "hintShowing",
  "hidden",
  "heading",
  "keyboardVisible",
  "foregroundApp",
];

type XmlNode = NonNullable<ReturnType<typeof parseUiAutomatorXml>>;

// As agent-device: label = text, else content-desc. `value` only on editable nodes.
function mapNode(xml: XmlNode, screenW: number, screenH: number, isRoot: boolean): UiTreeNode {
  const a = xml.attrs;
  const type = a.class ?? "";
  const password = attrIsTrue(a, "password");
  const text = password ? "" : (a.text ?? "");
  const desc = a["content-desc"] ?? "";
  const rect = parseUiAutomatorBounds(a.bounds ?? "");
  // Every EditText subclass, Compose fields too, reports an EditText class;
  // `TextInputLayout`, the Material wrapper, must not match.
  const editable = type.endsWith("EditText") || type.endsWith("AutoCompleteTextView");
  const node: UiTreeNode = { role: deriveUiAutomatorRole(type), children: [] };
  if (type) node.type = type;
  if (text || desc) node.label = text || desc;
  if (editable && text) node.value = text;
  if (desc) node.contentDescription = desc;
  if (a["resource-id"]) node.identifier = a["resource-id"];
  if (isRoot && a.package) node.bundleId = a.package;
  if (rect && screenW > 0 && screenH > 0) {
    node.frame = {
      x: rect.x / screenW,
      y: rect.y / screenH,
      width: rect.w / screenW,
      height: rect.h / screenH,
    };
  }
  if (a.enabled === "false") node.disabled = true;
  if (attrIsTrue(a, "selected")) node.selected = true;
  if (attrIsTrue(a, "focused")) node.focused = true;
  if (attrIsTrue(a, "checkable")) node.checked = attrIsTrue(a, "checked");
  if (password) node.password = true;
  if (editable) node.editable = true;
  for (const child of xml.children) {
    if (child.tag === "node") node.children.push(mapNode(child, screenW, screenH, false));
  }
  return node;
}

export function adaptAndroidTree(
  xml: string,
  truncated: boolean,
  screen: { width: number; height: number }
): UiTree {
  const root = parseUiAutomatorXml(xml);
  const roots = (root?.children ?? [])
    .filter((c) => c.tag === "node")
    .map((c) => mapNode(c, screen.width, screen.height, true));
  return {
    schemaVersion: 1,
    source: "android-devtools",
    screen: { width: screen.width, height: screen.height },
    roots,
    truncated,
    unsupportedFields: UNSUPPORTED_FIELDS,
  };
}

export async function readAndroidUiTree(registry: Registry, device: DeviceInfo): Promise<UiTree> {
  const ref = androidDevtoolsRef(device);
  const devtools = await registry.resolveService<AndroidDevtoolsApi>(ref.urn, ref.options);
  const [{ xml, truncated }, size] = await Promise.all([
    devtools.getHierarchy({ maxNodes: FLOW_MAX_NODES, clearCache: true }),
    devtools.getScreenSize(),
  ]);
  return adaptAndroidTree(xml, truncated, size);
}
