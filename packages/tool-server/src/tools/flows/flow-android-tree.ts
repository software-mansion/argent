import type { DeviceInfo, Registry } from "@argent/registry";
import {
  androidDevtoolsRef,
  type AndroidDevtoolsApi,
} from "../../blueprints/android-devtools";
import {
  clipBoundsToScreen,
  deriveUiAutomatorRole,
  parseUiAutomatorBounds,
  parseUiAutomatorXml,
} from "../describe/platforms/android/uiautomator-parser";
import { flattenHoisting, type FlatNode } from "./flow-tree-flatten";
import {
  type DescribeFrame,
  type DescribeNode,
  type DescribeTreeData,
  parseDescribeResult,
} from "../describe/contract";

/**
 * Flow-owned Android tree fetch — the counterpart to `flow-native-tree.ts` on
 * iOS.
 *
 * The agent-facing `describe` walks the accessibility tree (`uiautomator` /
 * android-devtools) and runs an interactables-only trim that drops
 * non-interactive, unlabelled layout containers. Two things then make a React
 * Native `testID` unresolvable by a flow:
 *
 *   1. RN wraps `testID`-bearing layout views in `importantForAccessibility="no"`,
 *      so the framework filters them (and their descendants) out of the
 *      `AccessibilityNodeInfo` tree entirely — they never reach the host.
 *   2. Even when present, the trim collapses a testID-only container (no label,
 *      not clickable) into a passthrough and discards the node carrying the id.
 *
 * This module addresses both: it asks the helper for a *full* hierarchy
 * (`includeNotImportant: true`, which turns on
 * `FLAG_INCLUDE_NOT_IMPORTANT_VIEWS | FLAG_REPORT_VIEW_IDS` — see the helper's
 * `configureServiceInfo`), then flattens it keeping **every** view with a
 * `resource-id` (RN `testID`) or a label, with no interactables trim — exactly
 * the shape `flow-native-tree.ts` produces on iOS. Falls back to the shared
 * `fetchTree` (the trimmed AX tree) when the helper is unavailable.
 */

// A fuller tree than the agent describe: not-important views inflate the node
// count, so raise the cap above the helper's 5000 default to avoid truncating a
// dense screen mid-walk.
const FLOW_MAX_NODES = 12_000;

interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const SYSTEM_PACKAGES = new Set(["com.android.systemui"]);
const SYSTEM_RID_PREFIXES = [
  "android:id/navigationBarBackground",
  "android:id/statusBarBackground",
  "com.android.systemui:id/",
];

function isSystemChrome(attrs: Record<string, string>): boolean {
  if (SYSTEM_PACKAGES.has(attrs.package ?? "")) return true;
  const rid = attrs["resource-id"] ?? "";
  return SYSTEM_RID_PREFIXES.some((p) => rid.startsWith(p));
}

// Screen-reader label: prefer content-desc (role/placeholder), else text.
// Mirrors the trim's `labelOf` so the flow tree reads the same field an author
// would from a `describe`.
function labelOf(attrs: Record<string, string>): string {
  const cd = (attrs["content-desc"] ?? "").trim();
  if (cd) return cd;
  return (attrs.text ?? "").trim();
}

function normalizeRect(rect: PixelRect, screenW: number, screenH: number): DescribeFrame | null {
  const clipped = clipBoundsToScreen(rect, screenW, screenH);
  if (clipped.w <= 0 || clipped.h <= 0) return null;
  return {
    x: clipped.x / screenW,
    y: clipped.y / screenH,
    width: clipped.w / screenW,
    height: clipped.h / screenH,
  };
}

interface ParsedXmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: ParsedXmlNode[];
}

// Only child `<node>` elements carry views; other tags are uiautomator noise.
function childNodes(node: ParsedXmlNode): ParsedXmlNode[] {
  return node.children.filter((c) => c.tag === "node");
}

/**
 * Project a uiautomator XML node for the shared flatten (see
 * `flow-tree-flatten`). A view is emitted as a leaf when it carries a
 * `resource-id` (React Native `testID`) or a label and has an on-screen frame;
 * system chrome is skipped; an identified node — or a password field — shields
 * its text so hoisting scopes to the nearest identified ancestor. A password
 * field never contributes its secret: its own text is the `[password]`
 * placeholder and its raw `text` is never read into the leaf value.
 */
function projectAndroidNode(
  node: ParsedXmlNode,
  screenW: number,
  screenH: number
): FlatNode<ParsedXmlNode> {
  const attrs = node.attrs;
  // System chrome (status bar / nav bar / SystemUI) is noise for a flow and can
  // introduce false matches (a system "Back"); drop the node and its subtree.
  const skip = isSystemChrome(attrs);

  const identifier = (attrs["resource-id"] ?? "").trim();
  const isPassword = attrs.password === "true";
  const label = isPassword ? "[password]" : labelOf(attrs);
  const rawText = (attrs.text ?? "").trim();
  const hasValue = !isPassword && Boolean(rawText) && rawText !== label;

  // The node's own visible text mirrors what `nodeText` reads off the leaf
  // (label plus a distinct text value) — never the secret behind a password.
  const ownText = [label, hasValue ? rawText : ""].filter(Boolean).join(" ");

  let leaf: DescribeNode | null = null;
  // Keep any view a selector could address: a resource-id (RN testID) or a
  // label. Pure layout scaffolding with neither is dropped — but its children
  // are still walked, so a testID nested under an unlabelled container survives.
  if (!skip && (identifier || label)) {
    const rect = parseUiAutomatorBounds(attrs.bounds ?? "");
    const frame = rect ? normalizeRect(rect, screenW, screenH) : null;
    if (frame) {
      leaf = { role: deriveUiAutomatorRole(attrs.class ?? ""), frame, children: [] };
      if (label) leaf.label = label;
      if (identifier) leaf.identifier = identifier;
      if (hasValue) leaf.value = rawText;
      if (attrs.clickable === "true") leaf.clickable = true;
      if (attrs["long-clickable"] === "true") leaf.longClickable = true;
      if (attrs.scrollable === "true") leaf.scrollable = true;
      if (attrs.checkable === "true") leaf.checkable = true;
      if (attrs.checked === "true") leaf.checked = true;
      if (attrs.enabled === "false") leaf.disabled = true;
      if (isPassword) leaf.password = true;
    }
  }

  return {
    skip,
    children: childNodes(node),
    ownText,
    leaf,
    // A password node shields its placeholder text like any identified node —
    // even if it somehow lacks an id — so the secret can never bubble upward.
    shield: Boolean(identifier) || isPassword,
  };
}

/**
 * Flatten a full-hierarchy `uiautomator`-schema XML dump into the
 * flat-leaves-under-one-root shape the other describe adapters emit, keeping
 * only views with a `resource-id`/label and an on-screen frame. Layout
 * scaffolding is dropped while its labelled/identified descendants are
 * preserved — the same trade the iOS full-hierarchy adapter makes.
 */
export function adaptFullAndroidHierarchyToDescribeResult(
  xml: string,
  screenW: number,
  screenH: number
): DescribeNode {
  const children: DescribeNode[] = [];
  if (screenW > 0 && screenH > 0) {
    const root = parseUiAutomatorXml(xml);
    if (root) {
      for (const c of childNodes(root)) {
        flattenHoisting(c, (n) => projectAndroidNode(n, screenW, screenH), children);
      }
    }
  }
  return parseDescribeResult({
    role: "Screen",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children,
  });
}

/**
 * Query the full Android view hierarchy via the android-devtools helper with
 * not-important views included. Returns the adapted tree, or `null` when the
 * helper is unavailable / errors — in which case the caller falls back to the
 * trimmed AX tree.
 */
export async function queryAndroidFullHierarchy(
  registry: Registry,
  device: DeviceInfo
): Promise<DescribeTreeData | null> {
  try {
    const ref = androidDevtoolsRef(device);
    const devtools = await registry.resolveService<AndroidDevtoolsApi>(ref.urn, ref.options);
    const [{ xml }, size] = await Promise.all([
      devtools.getHierarchy({ includeNotImportant: true, maxNodes: FLOW_MAX_NODES }),
      devtools.getScreenSize(),
    ]);
    const tree = adaptFullAndroidHierarchyToDescribeResult(xml, size.width, size.height);
    return { tree, source: "android-devtools" };
  } catch {
    return null;
  }
}
