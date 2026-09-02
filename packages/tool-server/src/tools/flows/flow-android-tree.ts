import type { DeviceInfo, Registry } from "@argent/registry";
import { androidDevtoolsRef, type AndroidDevtoolsApi } from "../../blueprints/android-devtools";
import {
  clipBoundsToScreen,
  deriveUiAutomatorRoleInContext,
  isNoisyUiAutomatorClass,
  isUiAutomatorLayoutContainer,
  isUiAutomatorScrollable,
  isUiAutomatorWebView,
  parseUiAutomatorBounds,
  parseUiAutomatorXml,
  regionOverDescendants,
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
  screenH: number,
  ctx: AndroidTreeContext
): FlatNode<ParsedXmlNode> {
  const attrs = node.attrs;
  const inWebView = ctx.inWebView.has(node);
  // System chrome yields false matches (a system "Back"); SVG implementation
  // nodes add dozens of meaningless leaves per icon. Both go with their
  // subtrees, as the shared parser does.
  const skip = isSystemChrome(attrs) || isNoisyUiAutomatorClass(attrs.class ?? "");
  const kids = childNodes(node);

  // An app that hosts its own WebView reaches the dump twice, nested: the app's
  // view, and Chromium's root web area under the same class name. The describe
  // trim merges the pair into one landmark; emitting both here gives two leaves
  // at the same frame, each carrying the page's whole subtree text, so a
  // `role: WebView` an author copies out of describe matches twice and a `text`
  // assert against the page counts double.
  //
  // The merge keeps the app's view — the OUTER half — and folds the inner one
  // into it, exactly as the trim does. Which half carries what varies by
  // WebView build: the page title and the `scrollable` flag ride on Chromium's
  // node, an app's own `android:id` on the app's view, so the surviving leaf
  // takes the union of the two and the outer half's frame. Taking the inner
  // half's frame instead only matched describe when its box happened to
  // overhang the SCREEN and clip back; on a build where it overhangs the OUTER
  // the two trees reported frames a few pixels apart.
  const absorbedHalf = ctx.absorbedWebViewHalf.has(node);
  const innerHalf = ctx.webViewPair.get(node);
  const innerAttrs = innerHalf?.attrs;

  const identifier = (attrs["resource-id"] ?? "").trim();
  const isPassword = attrs.password === "true";
  const isFocused = attrs.focused === "true";
  const label = isPassword ? "[password]" : labelOf(attrs);
  const rawText = (attrs.text ?? "").trim();
  const hasValue = !isPassword && Boolean(rawText) && rawText !== label;
  const className = attrs.class ?? "";
  // Read the role in the context of the tree, exactly as the describe trim
  // does, so a `role` an author copies out of `describe` matches at replay.
  const role = deriveUiAutomatorRoleInContext(className, attrs, {
    inWebView,
    label,
    hasChildren: kids.length > 0,
  });
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
  if (!skip && !absorbedHalf && (identifier || label || hasSemanticRole || isFocused)) {
    frame = rect ? normalizeRect(rect, screenW, screenH) : null;
    // A box the node HAS but cannot use falls back to the region its
    // descendants cover, read by the trim's own rule so both trees publish the
    // same box. A node with no `bounds` at all keeps no frame: describe leaves
    // that one to its own bounds-less rule rather than to this substitution.
    if (!frame && rect) {
      const over = regionOverDescendants(node, {
        screenW,
        screenH,
        inWebView,
        // The window this node's children live under. Its own box is unusable,
        // so it scrolls nothing and the window is the one it inherited.
        scrollClip: ctx.scrollClip.get(node) ?? null,
      });
      frame = over ? normalizeRect(over, screenW, screenH) : null;
    }
    if (frame) {
      const flag = (key: string): boolean => attrs[key] === "true" || innerAttrs?.[key] === "true";
      leaf = { role, frame, children: [] };
      const mergedLabel = label || (innerAttrs ? labelOf(innerAttrs) : "");
      const mergedId = identifier || (innerAttrs?.["resource-id"] ?? "").trim();
      if (mergedLabel) leaf.label = mergedLabel;
      if (mergedId) leaf.identifier = mergedId;
      if (hasValue) leaf.value = rawText;
      if (flag("clickable")) leaf.clickable = true;
      if (flag("long-clickable")) leaf.longClickable = true;
      if (flag("scrollable")) leaf.scrollable = true;
      if (flag("checkable")) leaf.checkable = true;
      if (flag("checked")) leaf.checked = true;
      if (attrs.enabled === "false" || innerAttrs?.enabled === "false") leaf.disabled = true;
      if (isPassword) leaf.password = true;
      if (isFocused || innerAttrs?.focused === "true") leaf.focused = true;
    }
  }

  return {
    skip,
    children: childNodes(node),
    // Off-screen text must not hoist, or an ancestor text assert would pass on
    // content the screen doesn't show. Any node with text is leaf-eligible (its
    // label is non-empty), so `frame` was computed for it — and never for an
    // absorbed half, whose label is on the surviving leaf already.
    ownText: frame ? ownText : "",
    leaf,
    // A password field shields even when it carries no id, so nothing from it
    // bubbles into an ancestor's hoisted text. An absorbed half never shields:
    // it would keep the page's text from reaching the leaf that stands for it.
    shield: !absorbedHalf && (Boolean(identifier) || isPassword),
    // Scroll-clip inputs (see `flattenHoisting`): a scroller's raw bounds clip
    // its subtree, so a row scrolled out of view — but still on the device
    // screen — is dropped, matching the describe path's prune.
    rect,
    // A scroller whose own box is unusable clips nothing. `rectFullyOutside`
    // reads a zero-height window as "everything is outside", so trusting a
    // degenerate box drops the whole subtree — and Chromium reports a WebView
    // at negative height while its content is still on screen. The describe
    // trim applies the same guard, so the two trees agree on the shape.
    scrolls:
      isUiAutomatorScrollable(attrs, inWebView) &&
      Boolean(rect && normalizeRect(rect, screenW, screenH)),
  };
}

/** What the projection needs about a node's place in the tree around it. */
interface AndroidTreeContext {
  /** Nodes below an `android.webkit.WebView`: web DOM, not native widgets. */
  inWebView: Set<ParsedXmlNode>;
  /** The outer half of a doubled WebView host -> the inner half it absorbs. */
  webViewPair: Map<ParsedXmlNode, ParsedXmlNode>;
  /** The inner halves, which emit no leaf of their own. */
  absorbedWebViewHalf: Set<ParsedXmlNode>;
  /**
   * The scroll-clip window each node's own children live under, computed as the
   * describe trim computes it. Only the degenerate-box fallback reads it: the
   * clip that prunes this tree is applied by `flattenHoisting`, which carries
   * the window down its own walk.
   */
  scrollClip: Map<ParsedXmlNode, PixelRect | null>;
}

/**
 * Whether a subtree adds anything to this tree — any node in it a selector
 * could address. A bare layout wrapper with nothing under it adds nothing, and
 * the describe trim discards it too.
 */
function yieldsLeaf(node: ParsedXmlNode): boolean {
  const stack: ParsedXmlNode[] = [node];
  while (stack.length > 0) {
    const n = stack.pop()!;
    const attrs = n.attrs;
    if (isSystemChrome(attrs) || isNoisyUiAutomatorClass(attrs.class ?? "")) continue;
    if (
      (attrs["resource-id"] ?? "").trim() ||
      labelOf(attrs) ||
      !isUiAutomatorLayoutContainer(attrs.class ?? "") ||
      attrs.focused === "true"
    ) {
      return true;
    }
    for (const c of childNodes(n)) stack.push(c);
  }
  return false;
}

/**
 * Read the tree's shape once, up front: the shared flatten hands the projection
 * one node at a time with no parent context. The describe trim carries the same
 * two facts down its own traversal frame.
 *
 * A WebView host is doubled when exactly one WebView sits under it and no other
 * child of it adds anything to the tree. The trim's own test is on the children
 * that survive it, which is not a number this tree can compute — it keeps the
 * testID-only containers the trim drops. A child that yields no leaf at all is
 * the case the two agree on.
 */
function readAndroidTree(
  root: ParsedXmlNode,
  screenW: number,
  screenH: number
): AndroidTreeContext {
  const ctx: AndroidTreeContext = {
    inWebView: new Set<ParsedXmlNode>(),
    webViewPair: new Map<ParsedXmlNode, ParsedXmlNode>(),
    absorbedWebViewHalf: new Set<ParsedXmlNode>(),
    scrollClip: new Map<ParsedXmlNode, PixelRect | null>(),
  };
  const stack: Array<{ node: ParsedXmlNode; under: boolean; clip: PixelRect | null }> = [
    { node: root, under: false, clip: null },
  ];
  while (stack.length > 0) {
    const { node, under, clip } = stack.pop()!;
    if (under) ctx.inWebView.add(node);
    const kids = childNodes(node);
    const hostsWeb = isUiAutomatorWebView(node.attrs.class ?? "");
    if (hostsWeb) {
      const webKids = kids.filter((c) => isUiAutomatorWebView(c.attrs.class ?? ""));
      const inner = webKids.length === 1 ? webKids[0]! : undefined;
      if (inner && kids.every((c) => c === inner || !yieldsLeaf(c))) {
        ctx.webViewPair.set(node, inner);
        ctx.absorbedWebViewHalf.add(inner);
      }
    }
    // A scroller clips its children to its own box; one whose box is unusable
    // clips nothing and passes the window it was handed on, exactly as
    // `scrollClipOf` does on the describe side.
    const rect = parseUiAutomatorBounds(node.attrs.bounds ?? "");
    const scrolls =
      isUiAutomatorScrollable(node.attrs, under) &&
      Boolean(rect && normalizeRect(rect, screenW, screenH));
    const childClip = scrolls ? rect : clip;
    ctx.scrollClip.set(node, childClip);
    for (const c of kids) stack.push({ node: c, under: under || hostsWeb, clip: childClip });
  }
  return ctx;
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
  if (screenW > 0 && screenH > 0) {
    const root = parseUiAutomatorXml(xml);
    if (root) {
      const ctx = readAndroidTree(root, screenW, screenH);
      for (const c of childNodes(root)) {
        flattenHoisting(c, (n) => projectAndroidNode(n, screenW, screenH, ctx), children);
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
    throw new Error(
      `the android devtools helper is unavailable (${msg}) — flows resolve testID selectors against the full hierarchy it serves; confirm the device is unlocked and the helper can be installed (\`adb install -t\`)`,
      { cause: err }
    );
  }
  const [{ xml, truncated }, size] = await Promise.all([
    // clearCache: await/assert polls must see text changes, not cached reads.
    devtools.getHierarchy({ maxNodes: FLOW_MAX_NODES, clearCache: true }),
    devtools.getScreenSize(),
  ]);
  const tree = adaptFullAndroidHierarchyToDescribeResult(xml, size.width, size.height);
  return {
    tree,
    source: "android-devtools",
    // The helper stopped at a walk limit, so the tree is missing on-screen
    // content while looking complete. `waitForCondition` reads this as a blind
    // read, so an `assert { hidden }` cannot pass on an element that is merely
    // past the cut.
    ...(truncated ? { truncated: true } : {}),
    ...(size.width > 0 && size.height > 0
      ? { screen: { width: size.width, height: size.height } }
      : {}),
  };
}
