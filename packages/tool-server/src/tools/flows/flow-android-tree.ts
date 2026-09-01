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
 * The region a node's descendants cover, for a node whose own box is unusable —
 * clipped to zero or negative area. The describe trim publishes such a node at
 * that region (`boundsOverChildren`); without the same substitution here the
 * node is an addressable element there and absent from this tree, so an
 * `assert { visible: … }` an author copies out of `describe` fails and an
 * `assert { hidden: … }` passes on an element describe reports on screen.
 *
 * Descent stops at the first descendant whose own box IS usable, so the union
 * is over the topmost usable boxes — the level the describe trim's own
 * survivors sit at. Skipped subtrees contribute nothing, as they do there.
 */
function rectOverDescendants(node: ParsedXmlNode): PixelRect | null {
  let out: PixelRect | null = null;
  const stack: ParsedXmlNode[] = childNodes(node).slice();
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (isSystemChrome(n.attrs) || isNoisyUiAutomatorClass(n.attrs.class ?? "")) continue;
    const r = parseUiAutomatorBounds(n.attrs.bounds ?? "");
    if (!r || r.w <= 0 || r.h <= 0) {
      for (const c of childNodes(n)) stack.push(c);
      continue;
    }
    if (!out) {
      out = { ...r };
      continue;
    }
    const x = Math.min(out.x, r.x);
    const y = Math.min(out.y, r.y);
    out = {
      x,
      y,
      w: Math.max(out.x + out.w, r.x + r.w) - x,
      h: Math.max(out.y + out.h, r.y + r.h) - y,
    };
  }
  return out;
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
  inWebView: boolean
): FlatNode<ParsedXmlNode> {
  const attrs = node.attrs;
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
  // Drop the outer half and let the inner one stand for the pair. It is the
  // half that carries the page title and, when the page scrolls, the
  // `scrollable` flag — measured across four live API 35 captures, the app's
  // view carries neither. Its bounds run a few px past the screen on some
  // builds and clip back to the same rect, so the surviving leaf's frame is the
  // one describe reports. Only an only-child pair merges, exactly as the trim
  // requires, so a control an app adds beside the web content keeps both nodes.
  const isOuterWebViewHalf =
    isUiAutomatorWebView(attrs.class ?? "") &&
    kids.length === 1 &&
    isUiAutomatorWebView(kids[0]!.attrs.class ?? "");

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
  if (!skip && !isOuterWebViewHalf && (identifier || label || hasSemanticRole || isFocused)) {
    frame = rect ? normalizeRect(rect, screenW, screenH) : null;
    // A box the node HAS but cannot use falls back to the region its
    // descendants cover, exactly as the describe trim does. A node with no
    // `bounds` at all keeps no frame: describe leaves that one to its own
    // bounds-less rule rather than to this substitution.
    if (!frame && rect) {
      const over = rectOverDescendants(node);
      frame = over ? normalizeRect(over, screenW, screenH) : null;
    }
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

/**
 * Every node below an `android.webkit.WebView` is web DOM, not a native widget.
 * The shared flatten hands the projection one node at a time with no parent
 * context, so mark the descendants up front in one walk. The describe trim
 * carries the same flag down its own traversal frame.
 */
function collectWebViewDescendants(root: ParsedXmlNode): Set<ParsedXmlNode> {
  const inWebView = new Set<ParsedXmlNode>();
  const stack: Array<{ node: ParsedXmlNode; under: boolean }> = [{ node: root, under: false }];
  while (stack.length > 0) {
    const { node, under } = stack.pop()!;
    if (under) inWebView.add(node);
    const childUnder = under || isUiAutomatorWebView(node.attrs.class ?? "");
    for (const c of childNodes(node)) stack.push({ node: c, under: childUnder });
  }
  return inWebView;
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
      const webDom = collectWebViewDescendants(root);
      for (const c of childNodes(root)) {
        flattenHoisting(c, (n) => projectAndroidNode(n, screenW, screenH, webDom.has(n)), children);
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
