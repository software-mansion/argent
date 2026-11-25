import type { DeviceInfo, Registry } from "@argent/registry";
import { androidDevtoolsRef, type AndroidDevtoolsApi } from "../../blueprints/android-devtools";
import {
  clipBoundsToScreen,
  deriveUiAutomatorRole,
  isNoisyUiAutomatorClass,
  isUiAutomatorLayoutContainer,
  isUiAutomatorScrollable,
  parseUiAutomatorBounds,
  parseUiAutomatorXml,
} from "../describe/platforms/android/uiautomator-parser";
import {
  isSystemDialogWindow,
  startsAtTop,
  TYPE_APPLICATION,
  TYPE_INPUT_METHOD,
} from "../ui-tree/android";
import { flattenHoisting, type FlatNode } from "./flow-tree-flatten";
import {
  type DescribeFrame,
  type DescribeNode,
  type DescribeTreeData,
  type FlowCover,
  parseDescribeResult,
} from "../describe/contract";

/**
 * Flow-owned Android tree fetch — the counterpart to `flow-ios-tree.ts`.
 *
 * The helper's `getHierarchy` dump already carries every view and its
 * `resource-id` (RN `testID`); what makes a testID unresolvable by the
 * agent-facing `describe` is purely host-side parsing — its interactables-only
 * trim collapses a testID-only container (no label, not clickable) into a
 * passthrough and discards the node carrying the id. This module parses the
 * same dump without that trim. The trim's scroll-clip prune IS preserved (see
 * `flattenHoisting`), so both trees agree on what is visible. Throws rather
 * than degrade to the trimmed uiautomator tree — see `fetchFlowTree`.
 */

// Above the helper's 5000 default: flows keep far more of the dump than the
// trimmed describe, so a dense screen would truncate mid-walk.
export const FLOW_MAX_NODES = 12_000;

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

// Mirrors the trim's `labelOf` so both trees read the same field.
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

// Non-`node` tags are uiautomator noise, not views.
function childNodes(node: ParsedXmlNode): ParsedXmlNode[] {
  return node.children.filter((c) => c.tag === "node");
}

/**
 * Project a uiautomator XML node for the shared flatten (`flow-tree-flatten`).
 * A password field never contributes its secret: its text is the `[password]`
 * placeholder and its raw `text` is never read into the leaf value.
 */
function projectAndroidNode(
  node: ParsedXmlNode,
  screenW: number,
  screenH: number
): FlatNode<ParsedXmlNode> {
  const attrs = node.attrs;
  // System chrome yields false matches (a system "Back"); SVG implementation
  // nodes add dozens of meaningless leaves per icon. Both go with their
  // subtrees, as the shared parser does.
  const skip = isSystemChrome(attrs) || isNoisyUiAutomatorClass(attrs.class ?? "");

  const identifier = (attrs["resource-id"] ?? "").trim();
  const isPassword = attrs.password === "true";
  const isFocused = attrs.focused === "true";
  const label = isPassword ? "[password]" : labelOf(attrs);
  const rawText = (attrs.text ?? "").trim();
  const hasValue = !isPassword && Boolean(rawText) && rawText !== label;
  const className = attrs.class ?? "";
  const role = deriveUiAutomatorRole(className);
  // Every non-layout class is a role target, including controls whose role is
  // only the class-name fallback (SeekBar, Spinner, ProgressBar).
  const hasSemanticRole = !isUiAutomatorLayoutContainer(className);

  // Mirrors what `nodeText` reads off the leaf (label plus a distinct value) —
  // never the secret behind a password.
  const ownText = [label, hasValue ? rawText : ""].filter(Boolean).join(" ");

  // Unclipped, exactly as `pruneSubtree` compares them: the scroll-clip prune
  // needs raw bounds for every node, leaf-eligible or not.
  const rect = parseUiAutomatorBounds(attrs.bounds ?? "");

  let leaf: DescribeNode | null = null;
  let frame: DescribeFrame | null = null;
  // Keep any view a selector could address — resource-id (RN testID), label or
  // concrete role — plus the focused view, which the type directive's focus
  // wait needs even for an anonymous EditText. Scaffolding is dropped but still
  // walked, so a testID nested under it survives.
  if (!skip && (identifier || label || hasSemanticRole || isFocused)) {
    frame = rect ? normalizeRect(rect, screenW, screenH) : null;
    if (frame) {
      leaf = { role, frame, children: [] };
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
      if (isFocused) leaf.focused = true;
    }
  }

  return {
    skip,
    children: childNodes(node),
    // Off-screen text must not hoist, or an ancestor text assert would pass on
    // content the screen doesn't show. Any node with text is leaf-eligible (its
    // label is non-empty), so `frame` was computed for it.
    ownText: frame ? ownText : "",
    leaf,
    // A password field shields even when it carries no id, so nothing from it
    // bubbles into an ancestor's hoisted text.
    shield: Boolean(identifier) || isPassword,
    // Scroll-clip inputs (see `flattenHoisting`): a scroller's raw bounds clip
    // its subtree, so a row scrolled out of view — but still on the device
    // screen — is dropped, matching the describe path's prune.
    rect,
    scrolls: isUiAutomatorScrollable(attrs),
  };
}

/**
 * Flatten a full-hierarchy `uiautomator`-schema XML dump into the
 * flat-leaves-under-one-root shape the other describe adapters emit, keeping
 * only on-screen views with a `resource-id`, label or specific semantic role.
 * Layout scaffolding is dropped, its selectable descendants preserved.
 *
 * The helper dumps each window under its own root and writes `window-type` on
 * that root. Every leaf of the input method's window is marked `keyboard`: the
 * keys, the suggestion strip, the emoji and clipboard panels and the accent
 * popup the keyboard draws inside it, and its own navigation bar. A dump with
 * no `window-type` (the `active-window` capture, an older helper) marks none.
 */
export function adaptFullAndroidHierarchyToDescribeResult(
  xml: string,
  screenW: number,
  screenH: number
): DescribeNode {
  return adaptParsedHierarchy(parseDump(xml, screenW, screenH), screenW, screenH);
}

/** The parsed dump, or null when there is none or no screen to normalize against. */
function parseDump(xml: string, screenW: number, screenH: number): ParsedXmlNode | null {
  return screenW > 0 && screenH > 0 ? parseUiAutomatorXml(xml) : null;
}

function adaptParsedHierarchy(
  root: ParsedXmlNode | null,
  screenW: number,
  screenH: number
): DescribeNode {
  const children: DescribeNode[] = [];
  for (const c of root ? childNodes(root) : []) {
    const first = children.length;
    flattenHoisting(c, (n) => projectAndroidNode(n, screenW, screenH), children);
    if (Number(c.attrs["window-type"]) === TYPE_INPUT_METHOD) {
      for (let i = first; i < children.length; i++) children[i]!.keyboard = true;
    }
  }
  return parseDescribeResult({
    role: "Screen",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children,
  });
}

// AccessibilityWindowInfo.TYPE_SPLIT_SCREEN_DIVIDER.
const TYPE_SPLIT_SCREEN_DIVIDER = 5;

/**
 * The topmost application window of a dump, when it is one Android hides the
 * app's window below (see `FlowCover`): a system dialog or sheet, or a window
 * that starts below the top (`startsAtTop`: an app window a cutout or a side
 * navigation bar insets in landscape is not a dialog). Undefined when the dump
 * has no window list (the `active-window` capture, an older helper: no root
 * has a `window-type`), the topmost application window is the app's screen, or
 * the screen shows apps side by side: split screen and freeform windows list a
 * window for each app, and split screen a divider (that alone while a split
 * starts). A dialog of one app in a split screen is missed this way, and its
 * step keeps the scroll hint.
 */
function topWindowCover(
  root: ParsedXmlNode | null,
  screenW: number,
  screenH: number
): Extract<FlowCover, { kind: "window" }> | undefined {
  const roots = root ? childNodes(root) : [];
  if (roots.some((c) => Number(c.attrs["window-type"]) === TYPE_SPLIT_SCREEN_DIVIDER)) {
    return undefined;
  }
  // Roots are in z-order, topmost first. As `ui-tree`, a root with no package is passed over.
  const apps = roots.filter(
    (c) => Number(c.attrs["window-type"]) === TYPE_APPLICATION && Boolean(c.attrs.package)
  );
  const top = apps[0];
  const pkg = top?.attrs.package;
  if (!top || !pkg || apps.length > 1) return undefined;
  const rect = parseUiAutomatorBounds(top.attrs.bounds ?? "");
  // Unclipped, as `ui-tree` frames a window root.
  const frame = rect
    ? {
        x: rect.x / screenW,
        y: rect.y / screenH,
        width: rect.w / screenW,
        height: rect.h / screenH,
      }
    : undefined;
  if (isSystemDialogWindow(pkg, frame)) return { kind: "window", system: true, package: pkg };
  if (startsAtTop(frame)) return undefined;
  return {
    kind: "window",
    system: false,
    package: pkg,
    scrolls: holdsScroller(top, screenW, screenH),
  };
}

/**
 * Whether a view under `node` scrolls and shows on the screen. Only the
 * `scrollable` flag counts, not the class `isUiAutomatorScrollable` also
 * reads: the Settings "Device name" dialog holds two `ScrollView`s that do not
 * scroll.
 */
function holdsScroller(node: ParsedXmlNode, screenW: number, screenH: number): boolean {
  return childNodes(node).some((c) => {
    const rect = c.attrs.scrollable === "true" && parseUiAutomatorBounds(c.attrs.bounds ?? "");
    const shows =
      rect &&
      Math.min(rect.x + rect.w, screenW) > Math.max(rect.x, 0) &&
      Math.min(rect.y + rect.h, screenH) > Math.max(rect.y, 0);
    return shows || holdsScroller(c, screenW, screenH);
  });
}

/**
 * Query the Android view hierarchy via the android-devtools helper and adapt it
 * untrimmed. Throws with the reason when the helper is unavailable or errors:
 * flows never degrade to the trimmed uiautomator tree (see `fetchFlowTree`), so
 * the caller's retry loop either rides out a transient failure or surfaces this
 * message as the step's failure reason.
 */
export async function queryAndroidFullHierarchy(
  registry: Registry,
  device: DeviceInfo
): Promise<DescribeTreeData> {
  let devtools: AndroidDevtoolsApi;
  try {
    const ref = androidDevtoolsRef(device);
    devtools = await registry.resolveService<AndroidDevtoolsApi>(ref.urn, ref.options);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`the argent android helper is unavailable: ${msg}`, { cause: err });
  }
  const [{ xml, captureMode }, size] = await Promise.all([
    // clearCache: await/assert polls must see text changes, not cached reads.
    devtools.getHierarchy({ maxNodes: FLOW_MAX_NODES, clearCache: true }),
    devtools.getScreenSize(),
  ]);
  const root = parseDump(xml, size.width, size.height);
  const tree = adaptParsedHierarchy(root, size.width, size.height);
  // No window list in this mode, so no window types (see `ui-tree`).
  const cover =
    captureMode === "active-window" ? undefined : topWindowCover(root, size.width, size.height);
  return {
    tree,
    ...(cover ? { cover } : {}),
    source: "android-devtools",
    ...(size.width > 0 && size.height > 0
      ? { screen: { width: size.width, height: size.height } }
      : {}),
  };
}
