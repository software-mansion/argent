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
 * Flow-owned Android tree fetch — the counterpart to `flow-ios-tree.ts` on
 * iOS.
 *
 * The android-devtools helper's `getHierarchy` dump already contains every
 * view — UiAutomation surfaces not-important views (the
 * `importantForAccessibility="no"` wrappers RN puts around `testID`-bearing
 * layout containers) and their `resource-id`s. What makes a `testID`
 * unresolvable by the agent-facing `describe` is purely host-side parsing: its
 * interactables-only trim collapses a testID-only container (no label, not
 * clickable) into a passthrough and discards the node carrying the id.
 *
 * This module parses the same dump without that trim: it flattens the
 * hierarchy keeping **every** view with a `resource-id` (RN `testID`) or a
 * label — exactly the shape `flow-ios-tree.ts` produces on iOS. The trim's
 * scroll-clip prune IS preserved (see `flattenHoisting`): a view a scrolling
 * ancestor has scrolled out of its window is dropped here too, so the flow
 * tree agrees with the agent-facing `describe` on what is visible. Throws when
 * the helper is unavailable rather than letting the caller degrade to the
 * trimmed uiautomator tree — see `fetchFlowTree` for why a silent fallback
 * would flip flow outcomes.
 */

// Flows keep far more of the dump than the trimmed agent describe, so raise
// the cap above the helper's 5000 default to avoid truncating a dense screen
// mid-walk.
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
 * `resource-id` (React Native `testID`), a label, or a specific semantic role —
 * or holds input focus, which the type directive's focus wait reads — and has
 * an on-screen frame; system chrome is skipped; an identified node — or a
 * password field — shields its text so hoisting scopes to the nearest
 * identified ancestor. A password field never contributes its secret: its own
 * text is the `[password]` placeholder and its raw `text` is never read into
 * the leaf value.
 */
function projectAndroidNode(
  node: ParsedXmlNode,
  screenW: number,
  screenH: number
): FlatNode<ParsedXmlNode> {
  const attrs = node.attrs;
  // System chrome can introduce false matches (a system "Back"), while SVG
  // implementation nodes can add dozens of meaningless leaves per icon. Drop
  // both kinds of noise with their subtrees, matching the shared parser.
  const skip = isSystemChrome(attrs) || isNoisyUiAutomatorClass(attrs.class ?? "");

  const identifier = (attrs["resource-id"] ?? "").trim();
  const isPassword = attrs.password === "true";
  const isFocused = attrs.focused === "true";
  const label = isPassword ? "[password]" : labelOf(attrs);
  const rawText = (attrs.text ?? "").trim();
  const hasValue = !isPassword && Boolean(rawText) && rawText !== label;
  const className = attrs.class ?? "";
  const role = deriveUiAutomatorRole(className);
  // Known layout containers are passthroughs. Every other concrete class is a
  // role target, including controls whose role is the class-name fallback
  // (SeekBar, Spinner, ProgressBar, and app-specific widgets).
  const hasSemanticRole = !isUiAutomatorLayoutContainer(className);

  // The node's own visible text mirrors what `nodeText` reads off the leaf
  // (label plus a distinct text value) — never the secret behind a password.
  const ownText = [label, hasValue ? rawText : ""].filter(Boolean).join(" ");

  // Raw pixel bounds — unclipped, exactly as `pruneSubtree` compares them —
  // feed the flatten's scroll-clip prune for every node, leaf-eligible or not.
  const rect = parseUiAutomatorBounds(attrs.bounds ?? "");

  let leaf: DescribeNode | null = null;
  let frame: DescribeFrame | null = null;
  // Keep any view a selector could address — a resource-id (RN testID), label,
  // or concrete semantic role — plus the focused view, which the type
  // directive's focus wait needs even when it carries neither (an anonymous
  // EditText). Pure layout scaffolding is dropped — but its children are still
  // walked, so a testID nested under an unlabelled container survives.
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
    // Text hoists only from on-screen nodes (frame is null when the bounds clip
    // to zero area) — otherwise a text assert against an ancestor would pass on
    // content the screen doesn't show. Every text-carrying node is
    // leaf-eligible (its label is non-empty), so `frame` was computed for it.
    ownText: frame ? ownText : "",
    leaf,
    // A password node shields its placeholder text like any identified node —
    // even if it somehow lacks an id — so the secret can never bubble upward.
    shield: Boolean(identifier) || isPassword,
    // Scroll-clip inputs (see `flattenHoisting`): a scrolling container's raw
    // bounds clip its subtree, so a row it has scrolled out of view — still
    // on the device screen — is dropped, matching the describe path's prune.
    rect,
    scrolls: isUiAutomatorScrollable(attrs),
  };
}

/**
 * Flatten a full-hierarchy `uiautomator`-schema XML dump into the
 * flat-leaves-under-one-root shape the other describe adapters emit, keeping
 * only views with a `resource-id`, label, or specific semantic role and an
 * on-screen frame. Layout scaffolding is dropped while its selectable
 * descendants are preserved — the same trade the iOS full-hierarchy adapter
 * makes.
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
 * Query the Android view hierarchy via the android-devtools helper and adapt
 * it untrimmed. Throws — with the reason — when the helper is unavailable /
 * errors: flows never degrade to the trimmed uiautomator tree (see
 * `fetchFlowTree`), so the caller's retry loop either rides out a transient
 * failure or surfaces this message as the step's failure reason.
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
  return { tree, source: "android-devtools" };
}
