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
 * same dump without that trim, keeping every view a selector could address
 * plus the two the runner needs whether or not a selector can name them: the
 * focused view and a framework-marked scrollable one (see
 * `projectAndroidNode` for what each buys). The trim's scroll-clip prune IS
 * preserved (see `flattenHoisting`), so both trees agree on what is visible.
 * Throws rather than degrade to the trimmed uiautomator tree — see
 * `fetchFlowTree`.
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
  const isScrollable = attrs.scrollable === "true";

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
  // wait needs even for an anonymous EditText, and any scrollable view: the
  // scroll-to nudge resolves a target's scroll container by geometric
  // containment over emitted leaves, and an id-less RN ScrollView / Compose
  // LazyColumn (a scrollable bare ViewGroup / View) would otherwise yield no
  // candidate - the nudge would silently skip on Android while the same app
  // nudges on iOS. The same leaf also scopes plain search rounds: scroll-to
  // fingerprints the scroll containers under its gesture anchor for
  // end-of-scroll, so without it that scope falls back to the whole screen and
  // a header spinner masks the end (see anchorScrollFrames in flow-actions).
  // Scaffolding is dropped but still walked, so a testID nested under it
  // survives.
  if (!skip && (identifier || label || hasSemanticRole || isFocused || isScrollable)) {
    frame = rect ? normalizeRect(rect, screenW, screenH) : null;
    if (frame) {
      leaf = { role, frame, children: [] };
      if (label) leaf.label = label;
      if (identifier) leaf.identifier = identifier;
      if (hasValue) leaf.value = rawText;
      if (attrs.clickable === "true") leaf.clickable = true;
      if (attrs["long-clickable"] === "true") leaf.longClickable = true;
      if (isScrollable) leaf.scrollable = true;
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
 * only on-screen views with a `resource-id`, label, specific semantic role,
 * focus, or a scrollable flag. Other layout scaffolding is dropped, its
 * selectable descendants preserved.
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
