import type { DeviceInfo, Registry } from "@argent/registry";
import { androidDevtoolsRef, type AndroidDevtoolsApi } from "../../blueprints/android-devtools";
import {
  clipBoundsToScreen,
  describeUiAutomatorRoot,
  deriveUiAutomatorRole,
  isNoisyUiAutomatorClass,
  isUiAutomatorLayoutContainer,
  isUiAutomatorScrollable,
  parseUiAutomatorBounds,
  parseUiAutomatorXml,
  type ParsedXmlNode,
} from "../describe/platforms/android/uiautomator-parser";
import { flattenHoisting, type FlatNode } from "./flow-tree-flatten";
import {
  type DescribeFrame,
  type DescribeNode,
  type DescribeTreeData,
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
  screenH: number,
  leafOf: Map<ParsedXmlNode, DescribeNode>
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
      leafOf.set(node, leaf);
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
 */
export function adaptFullAndroidHierarchyToDescribeResult(
  xml: string,
  screenW: number,
  screenH: number
): DescribeNode {
  const children: DescribeNode[] = [];
  let describeShown: (() => DescribeNode) | undefined;
  if (screenW > 0 && screenH > 0) {
    const root = parseUiAutomatorXml(xml);
    if (root) {
      const leafOf = new Map<ParsedXmlNode, DescribeNode>();
      for (const c of childNodes(root)) {
        flattenHoisting(c, (n) => projectAndroidNode(n, screenW, screenH, leafOf), children);
      }
      const emitted = new Set(children);
      const shown = (n: ParsedXmlNode) => {
        const leaf = leafOf.get(n);
        return leaf !== undefined && emitted.has(leaf);
      };
      describeShown = () =>
        describeUiAutomatorRoot(
          { ...root, children: root.children.flatMap((c) => shownOnly(c, shown)) },
          screenW,
          screenH
        );
    }
  }
  const tree = parseDescribeResult({
    role: "Screen",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children,
  });
  if (describeShown) {
    const build = describeShown;
    // Null once building failed.
    let built: DescribeNode | null | undefined;
    describeFallbacks.set(tree, () => {
      if (built === undefined) {
        try {
          built = build();
        } catch {
          // Best effort: without the fallback a selector resolves on the flow tree alone.
          built = null;
        }
      }
      return built ?? undefined;
    });
  }
  return tree;
}

const describeFallbacks = new WeakMap<DescribeNode, () => DescribeNode | undefined>();

/**
 * The tree a selector falls back to when it matches no visible element in the
 * flow tree: `describe`'s trim of the on-screen part of the same dump, built on
 * first use. A selector copied from `describe` finds the element it showed
 * there, such as a row labelled with its children's text. The trim reads only
 * the views the flow tree shows and their ancestors, with no text field's or
 * password field's content, so nothing scrolled out of view or typed resolves
 * through it.
 */
export function flowDescribeFallback(tree: DescribeNode): DescribeNode | undefined {
  return describeFallbacks.get(tree)?.();
}

function isTextField(attrs: Record<string, string>): boolean {
  const cls = attrs.class ?? "";
  return cls.endsWith("EditText") || cls.endsWith("AutoCompleteTextView");
}

function shownOnly(node: ParsedXmlNode, shown: (n: ParsedXmlNode) => boolean): ParsedXmlNode[] {
  if (node.tag !== "node") return [];
  const children = node.children.flatMap((c) => shownOnly(c, shown));
  const own = shown(node);
  if (!own && children.length === 0) return [];
  const a = node.attrs;
  let attrs = a;
  if (!own) attrs = { ...a, "text": "", "content-desc": "", "resource-id": "" };
  else if (isTextField(a)) attrs = { ...a, "text": "", "content-desc": "" };
  // A touchable around a text field or a scroller (an RN keyboard-dismiss
  // wrapper around a form) is not one tap target: describe would label it with
  // every text inside it, so it lends no label here.
  if ((a.clickable === "true" || a["long-clickable"] === "true") && holdsFieldOrScroller(node))
    attrs = { ...attrs, "clickable": "false", "long-clickable": "false" };
  return [{ tag: node.tag, attrs, children }];
}

function holdsFieldOrScroller(node: ParsedXmlNode): boolean {
  return childNodes(node).some(
    (c) => isTextField(c.attrs) || isUiAutomatorScrollable(c.attrs) || holdsFieldOrScroller(c)
  );
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
  const [{ xml }, size] = await Promise.all([
    // clearCache: await/assert polls must see text changes, not cached reads.
    devtools.getHierarchy({ maxNodes: FLOW_MAX_NODES, clearCache: true }),
    devtools.getScreenSize(),
  ]);
  const tree = adaptFullAndroidHierarchyToDescribeResult(xml, size.width, size.height);
  return {
    tree,
    source: "android-devtools",
    ...(size.width > 0 && size.height > 0
      ? { screen: { width: size.width, height: size.height } }
      : {}),
  };
}
