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

// What a helper older than `treeVersion` 2 does not write.
const LEGACY_UNSUPPORTED_FIELDS = [
  "placeholder",
  "hintShowing",
  "hidden",
  "heading",
  "keyboardVisible",
  "foregroundApp",
  "alertVisible",
  "interfaceOrientation",
];

// AccessibilityWindowInfo types.
const TYPE_APPLICATION = 1;
const TYPE_INPUT_METHOD = 2;
const TYPE_SYSTEM = 3;

// System apps whose dialogs are application windows above the app: runtime
// permissions (packageinstaller before API 29) and SystemUI prompts. A
// full-screen window of one of them is a screen the user opened, not a dialog.
const SYSTEM_DIALOG_PACKAGES = new Set([
  "com.android.packageinstaller",
  "com.google.android.packageinstaller",
  "com.android.permissioncontroller",
  "com.google.android.permissioncontroller",
  "com.android.systemui",
]);

// The chooser draws its sheet inside a translucent full-screen window.
const SYSTEM_SHEET_PACKAGES = new Set(["android", "com.android.intentresolver"]);

type XmlNode = NonNullable<ReturnType<typeof parseUiAutomatorXml>>;

export interface AndroidTreeCapture {
  xml: string;
  truncated: boolean;
  treeVersion?: number;
  sdkInt?: number;
  captureMode?: string;
}

// As agent-device: label = text, else content-desc. `value` only on text inputs.
function mapNode(
  xml: XmlNode,
  screenW: number,
  screenH: number,
  isRoot: boolean,
  v2: boolean
): UiTreeNode {
  const a = xml.attrs;
  const type = a.class ?? "";
  const password = attrIsTrue(a, "password");
  const hintShowing = v2 && attrIsTrue(a, "showing-hint");
  // A field showing its hint reports the hint as its text.
  const text = password || hintShowing ? "" : (a.text ?? "");
  const desc = a["content-desc"] ?? "";
  const rect = parseUiAutomatorBounds(a.bounds ?? "");
  // Every EditText subclass, Compose fields too, reports an EditText class;
  // `TextInputLayout`, the Material wrapper, must not match.
  const textInput = type.endsWith("EditText") || type.endsWith("AutoCompleteTextView");
  // isEditable() is false on a disabled field, which is still a text input.
  const editable = v2
    ? attrIsTrue(a, "editable") || (textInput && a.enabled === "false")
    : textInput;
  const node: UiTreeNode = { role: deriveUiAutomatorRole(type), children: [] };
  if (type) node.type = type;
  if (text || desc) node.label = text || desc;
  if ((editable || textInput) && text) node.value = text;
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
  if (v2) {
    if (a.hint) node.placeholder = a.hint;
    if (hintShowing) node.hintShowing = true;
    // Views clip their bounds; a fully clipped Compose node can still report visible.
    const empty = node.frame && (node.frame.width <= 0 || node.frame.height <= 0);
    if (a["visible-to-user"] === "false" || empty) node.hidden = true;
    if (attrIsTrue(a, "heading")) node.heading = true;
  }
  for (const child of xml.children) {
    if (child.tag === "node") node.children.push(mapNode(child, screenW, screenH, false, v2));
  }
  return node;
}

function onScreen(frame: UiTreeNode["frame"]): boolean {
  if (!frame) return false;
  const w = Math.min(frame.x + frame.width, 1) - Math.max(frame.x, 0);
  const h = Math.min(frame.y + frame.height, 1) - Math.max(frame.y, 0);
  return w > 0 && h > 0;
}

// Spans the width from the top: an activity, not a dialog or a sheet.
function fillsScreen(frame: UiTreeNode["frame"]): boolean {
  return !!frame && frame.x <= 0 && frame.x + frame.width >= 1 && frame.y <= 0.1;
}

function markCovered(node: UiTreeNode): void {
  node.covered = true;
  for (const child of node.children) markCovered(child);
}

export function adaptAndroidTree(
  capture: AndroidTreeCapture,
  screen: { width: number; height: number }
): UiTree {
  const { xml, truncated } = capture;
  const v2 = (capture.treeVersion ?? 1) >= 2;
  const windows = (parseUiAutomatorXml(xml)?.children ?? []).filter((c) => c.tag === "node");
  const roots = windows.map((c) => mapNode(c, screen.width, screen.height, true, v2));
  const tree: UiTree = {
    schemaVersion: 1,
    source: "android-devtools",
    screen: { width: screen.width, height: screen.height },
    roots,
    truncated,
    unsupportedFields: LEGACY_UNSUPPORTED_FIELDS,
  };
  if (!v2) return tree;

  const unsupported: string[] = [];
  const sdk = capture.sdkInt ?? 0;
  if (sdk < 26) unsupported.push("placeholder", "hintShowing");
  if (sdk < 28) unsupported.push("heading");
  if (capture.captureMode === "active-window") {
    // No window list, so no window types.
    unsupported.push("keyboardVisible", "foregroundApp", "alertVisible");
  } else {
    // Roots are in z-order, topmost first.
    let keyboard = false;
    let foreground: number | undefined;
    let alert = false;
    windows.forEach((w, i) => {
      const windowType = Number(w.attrs["window-type"]);
      const root = roots[i]!;
      // A hidden or sliding-out IME can stay listed, off screen.
      if (windowType === TYPE_INPUT_METHOD && onScreen(root.frame)) keyboard = true;
      if (foreground !== undefined || !root.bundleId) return;
      // The system server's crash and "isn't responding" dialogs.
      if (windowType === TYPE_SYSTEM && root.bundleId === "android") alert = true;
      if (windowType !== TYPE_APPLICATION) return;
      if (
        SYSTEM_SHEET_PACKAGES.has(root.bundleId) ||
        (SYSTEM_DIALOG_PACKAGES.has(root.bundleId) && !fillsScreen(root.frame))
      ) {
        alert = true;
      } else foreground = i;
    });
    // A truncated walk may have cut the windows below.
    const unknown = truncated ? undefined : false;
    tree.keyboardVisible = keyboard || unknown;
    if (foreground !== undefined) tree.foregroundApp = roots[foreground]!.bundleId;
    tree.alertVisible = alert || (foreground === undefined ? unknown : false);
    // As on iOS: while a system dialog shows, the app under it is covered.
    if (alert && foreground !== undefined) {
      for (let i = foreground; i < roots.length; i++) {
        if (roots[i]!.bundleId === tree.foregroundApp) markCovered(roots[i]!);
      }
    }
  }
  tree.unsupportedFields = unsupported;
  return tree;
}

export async function readAndroidUiTree(registry: Registry, device: DeviceInfo): Promise<UiTree> {
  const ref = androidDevtoolsRef(device);
  const devtools = await registry.resolveService<AndroidDevtoolsApi>(ref.urn, ref.options);
  const [capture, size] = await Promise.all([
    devtools.getHierarchy({ maxNodes: FLOW_MAX_NODES, clearCache: true }),
    devtools.getScreenSize(),
  ]);
  return adaptAndroidTree(capture, size);
}
