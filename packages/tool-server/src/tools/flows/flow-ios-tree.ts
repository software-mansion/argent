import type { DeviceInfo, Registry } from "@argent/registry";
import { nativeDevtoolsRef, type NativeDevtoolsApi } from "../../blueprints/native-devtools";
import { resolveNativeTargetApp } from "../../utils/native-target-app";
import { fetchTree } from "../../utils/ui-tree-match";
import { queryAndroidFullHierarchy } from "./flow-android-tree";
import { flattenHoisting, type FlatNode } from "./flow-tree-flatten";
import {
  type DescribeFrame,
  type DescribeNode,
  type DescribeTreeData,
  parseDescribeResult,
} from "../describe/contract";

/**
 * Flow-owned tree fetch.
 *
 * Flows resolve selectors against the native iOS UIView hierarchy
 * (`ViewHierarchy.getFullHierarchy`) rather than the AX tree the agent-facing
 * `describe` uses. Unlike the AX tree and `describeScreen` — both of which walk
 * the *accessibility* tree and collapse an `accessible` container into a single
 * leaf (VoiceOver semantics) — the full hierarchy walks the raw UIView tree and
 * carries every view's `accessibilityIdentifier` (React Native `testID`). That
 * lets a flow address a container by its testID *and* its children
 * independently, with no `accessible` prop required.
 *
 * This lives under flows/ (not the describe layer) on purpose: it's a flow-only
 * concern, and it falls back to the unchanged shared `fetchTree` (the AX tree)
 * whenever native-devtools isn't available, so the describe path is untouched.
 */

// ── getFullHierarchy → DescribeNode adapter ──────────────────────────────────

interface RawRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RawViewNode {
  className?: string;
  identifier?: string;
  label?: string;
  frame?: RawRect;
  windowFrame?: RawRect;
  hidden?: boolean;
  alpha?: number;
  children?: RawViewNode[];
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function roundNormalized(value: number): number {
  return Math.round(value * 1e12) / 1e12;
}

function finiteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function asRect(v: unknown): RawRect | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const r = v as Record<string, unknown>;
  const x = finiteNumber(r.x);
  const y = finiteNumber(r.y);
  const width = finiteNumber(r.width);
  const height = finiteNumber(r.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  return { x, y, width, height };
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asViewNode(v: unknown): RawViewNode | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  const children = Array.isArray(r.children)
    ? r.children.map(asViewNode).filter((n): n is RawViewNode => n !== null)
    : undefined;
  return {
    className: nonEmptyString(r.className),
    identifier: nonEmptyString(r.identifier),
    label: nonEmptyString(r.label),
    frame: asRect(r.frame),
    windowFrame: asRect(r.windowFrame),
    hidden: typeof r.hidden === "boolean" ? r.hidden : undefined,
    alpha: finiteNumber(r.alpha),
    children,
  };
}

// Best-effort role from the UIView class name (the full hierarchy carries no
// accessibility traits). Selectors lean on text/identifier, so a coarse mapping
// is enough; unknowns fall back to a generic group.
function roleFromClassName(cn: string | undefined): string {
  if (!cn) return "AXGroup";
  if (/Button/i.test(cn)) return "AXButton";
  if (/(TextField|TextView|SearchField)/i.test(cn)) return "AXTextField";
  if (/(Label|Text)/i.test(cn)) return "AXStaticText";
  if (/Image/i.test(cn)) return "AXImage";
  if (/(ScrollView|TableView|CollectionView)/i.test(cn)) return "AXScrollArea";
  return "AXGroup";
}

function normalizeFrame(rect: RawRect, screenW: number, screenH: number): DescribeFrame | null {
  if (screenW <= 0 || screenH <= 0) return null;
  const x1 = clamp01(rect.x / screenW);
  const y1 = clamp01(rect.y / screenH);
  const x2 = clamp01((rect.x + rect.width) / screenW);
  const y2 = clamp01((rect.y + rect.height) / screenH);
  const width = x2 - x1;
  const height = y2 - y1;
  if (width <= 0 || height <= 0) return null;
  return {
    x: roundNormalized(x1),
    y: roundNormalized(y1),
    width: roundNormalized(width),
    height: roundNormalized(height),
  };
}

/**
 * Project a UIView node for the shared flatten (see `flow-tree-flatten`). A view
 * is emitted as a leaf when it carries an `identifier` (React Native `testID`)
 * or a `label` and has an on-screen frame; hidden/transparent subtrees are
 * skipped; an identified node shields its text so hoisting scopes to the nearest
 * identified ancestor. Its own text is just its label.
 */
function projectIosNode(
  node: RawViewNode,
  screenW: number,
  screenH: number
): FlatNode<RawViewNode> {
  // Skip an invisible subtree entirely — its descendants are off-screen too.
  const skip = node.hidden === true || (node.alpha !== undefined && node.alpha < 0.01);

  let leaf: DescribeNode | null = null;
  if (!skip && (node.identifier || node.label)) {
    const rect = node.windowFrame ?? node.frame;
    const frame = rect ? normalizeFrame(rect, screenW, screenH) : null;
    if (frame) {
      leaf = {
        role: roleFromClassName(node.className),
        frame,
        children: [],
        label: node.label,
        identifier: node.identifier,
      };
    }
  }

  return {
    skip,
    children: node.children ?? [],
    ownText: node.label ?? "",
    leaf,
    shield: Boolean(node.identifier),
  };
}

/**
 * Flatten a `getFullHierarchy` payload into the flat-leaves-under-one-root shape
 * the other describe adapters emit, keeping only views with an `identifier` or
 * `label` and an on-screen frame. Pure layout containers are dropped, which
 * keeps the tree comparable in size to the accessibility tree while preserving
 * the children an `accessible` ancestor would otherwise have hidden.
 */
export function adaptFullHierarchyToDescribeResult(raw: unknown): DescribeNode {
  const windows =
    typeof raw === "object" && raw !== null && Array.isArray((raw as { windows?: unknown }).windows)
      ? (raw as { windows: unknown[] }).windows
          .map(asViewNode)
          .filter((n): n is RawViewNode => n !== null)
      : [];

  // The screen size is the largest window frame — the key window spans the
  // screen, so its width/height are the normalization denominators.
  let screenW = 0;
  let screenH = 0;
  for (const win of windows) {
    const rect = win.frame ?? win.windowFrame;
    if (rect) {
      screenW = Math.max(screenW, rect.width);
      screenH = Math.max(screenH, rect.height);
    }
  }

  const children: DescribeNode[] = [];
  if (screenW > 0 && screenH > 0) {
    for (const win of windows) {
      flattenHoisting(win, (n) => projectIosNode(n, screenW, screenH), children);
    }
  }

  return parseDescribeResult({
    role: "AXGroup",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children,
  });
}

// ── Fetch ────────────────────────────────────────────────────────────────────

/** Fields requested from getFullHierarchy — the minimum to flatten + match. */
const FULL_HIERARCHY_FIELDS = [
  "className",
  "identifier",
  "label",
  "frame",
  "windowFrame",
  "hidden",
  "alpha",
];

/**
 * Query the raw UIView tree via native-devtools `getFullHierarchy`. Returns the
 * adapted tree, or `null` when native-devtools is unavailable / not yet
 * connected / errored — in which case the caller falls back to the AX tree.
 */
async function queryFullHierarchyTree(
  registry: Registry,
  device: DeviceInfo
): Promise<DescribeTreeData | null> {
  try {
    const ndRef = nativeDevtoolsRef(device);
    const nativeApi = await registry.resolveService<NativeDevtoolsApi>(ndRef.urn, ndRef.options);
    const target = await resolveNativeTargetApp(nativeApi, undefined);

    if (await nativeApi.requiresAppRestart(target.bundleId)) return null;

    const rawResult = (await nativeApi.queryViewHierarchy(
      target.bundleId,
      "ViewHierarchy.getFullHierarchy",
      {
        fields: FULL_HIERARCHY_FIELDS,
        maxDepth: 40,
      }
    )) as { windows?: unknown[]; error?: string };

    if (rawResult.error) return null;

    return { tree: adaptFullHierarchyToDescribeResult(rawResult), source: "native-devtools" };
  } catch {
    return null;
  }
}

/**
 * Fetch the tree a flow resolves selectors against.
 *
 * On iOS this is the native UIView hierarchy (full testID coverage, no
 * `accessible`-container collapse). On Android it is the full accessibility
 * hierarchy including not-important views (full `resource-id`/testID coverage,
 * no interactables trim) — the Android counterpart to the same idea, since the
 * raw View tree is only reachable in-process there and the a11y tree is the
 * only cross-process source. Both degrade to the shared `fetchTree` (the
 * trimmed AX/uiautomator tree) when their helper is unavailable. Other
 * platforms use `fetchTree` directly — unchanged.
 */
export async function fetchFlowTree(
  registry: Registry,
  device: DeviceInfo
): Promise<DescribeTreeData> {
  if (device.platform === "ios") {
    const native = await queryFullHierarchyTree(registry, device);
    if (native) return native;
  } else if (device.platform === "android") {
    const full = await queryAndroidFullHierarchy(registry, device);
    if (full) return full;
  }
  return fetchTree(registry, device);
}
