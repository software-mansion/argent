import type { DeviceInfo, Registry } from "@argent/registry";
import { axServiceRef, type AXServiceApi, type AXTreeResponse } from "../../blueprints/ax-service";
import { mapNativeTraitsToDescribeRole } from "../describe/platforms/ios/ios-native-adapter";
import type { UiTree, UiTreeNode } from "./index";

// `tree` sends no element type, secure-text trait, placeholder or visibility.
const UNSUPPORTED_FIELDS = [
  "type",
  "password",
  "placeholder",
  "hintShowing",
  "hidden",
  "foregroundApp",
];

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
      value: raw.value,
      identifier: raw.identifier,
      roleDescription: raw.roleDescription,
      frame: raw.frame,
      children: [],
    };
    if (traits.length > 0) node.traits = traits;
    if (has("header")) node.heading = true;
    if (has("notEnabled")) node.disabled = true;
    if (has("selected")) node.selected = true;
    if (has("isEditing")) node.focused = true;
    if (has("textEntry") || has("searchField")) node.editable = true;
    if (has("toggleButton") && (raw.value === "1" || raw.value === "0")) {
      node.checked = raw.value === "1";
    }
    if (raw.covered) node.covered = true;
    const parent = raw.parentIndex === undefined ? undefined : byIndex.get(raw.parentIndex);
    byIndex.set(raw.index, node);
    (parent ? parent.children : roots).push(node);
  }
  return {
    schemaVersion: 1,
    source: "ax-service",
    screen: response.screenFrame,
    roots,
    truncated: response.truncated,
    alertVisible: response.alertVisible,
    // A truncated walk may have cut the keyboard, so absence is unknown there.
    keyboardVisible: keyboardVisible || (response.truncated ? undefined : false),
    unsupportedFields: UNSUPPORTED_FIELDS,
  };
}

export async function readIosUiTree(registry: Registry, device: DeviceInfo): Promise<UiTree> {
  const ref = axServiceRef(device);
  const ax = await registry.resolveService<AXServiceApi>(ref.urn, ref.options);
  return adaptAxTree(await ax.tree());
}
