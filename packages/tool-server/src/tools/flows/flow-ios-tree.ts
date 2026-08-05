import type { DeviceInfo, Registry } from "@argent/registry";
import {
  adviseOnUninjectedApp,
  isInjectableBundleId,
  nativeDevtoolsRef,
  type NativeDevtoolsApi,
} from "../../blueprints/native-devtools";
import { resolveNativeTargetApp } from "../../utils/native-target-app";
import { flattenHoisting, type FlatNode } from "./flow-tree-flatten";
import {
  type DescribeFrame,
  type DescribeNode,
  type DescribeTreeData,
  parseDescribeResult,
} from "../describe/contract";

/**
 * Flow-owned iOS tree source (see `flow-tree.ts` for the per-platform dispatch).
 *
 * On iOS, flows resolve selectors against the native UIView hierarchy
 * (`ViewHierarchy.getFullHierarchy`) rather than the AX tree the agent-facing
 * `describe` uses. Unlike the AX tree and `describeScreen` — both of which walk
 * the *accessibility* tree and collapse an `accessible` container into a single
 * leaf (VoiceOver semantics) — the full hierarchy walks the raw UIView tree and
 * carries every view's `accessibilityIdentifier` (React Native `testID`). That
 * lets a flow address a container by its testID *and* its children
 * independently, with no `accessible` prop required.
 *
 * This lives under flows/ (not the describe layer) on purpose: it's a flow-only
 * concern, and the describe path is untouched. When native-devtools is
 * unavailable it throws rather than letting the caller degrade to the AX tree —
 * see `fetchFlowTree` for why a silent fallback would flip flow outcomes.
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
  firstResponder?: boolean;
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
    firstResponder: r.firstResponder === true ? true : undefined,
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
  if (/(Slider|Stepper|Switch|ProgressView)/i.test(cn)) return "AXAdjustable";
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
 * is emitted as a leaf when it carries an `identifier` (React Native `testID`),
 * a `label`, or a specific semantic role — or is the first responder, which the
 * type directive's focus wait reads — and has an on-screen frame;
 * hidden/transparent subtrees are skipped; an identified node shields its text
 * so hoisting scopes to the nearest identified ancestor. Its own text is just
 * its label.
 */
function projectIosNode(
  node: RawViewNode,
  screenW: number,
  screenH: number
): FlatNode<RawViewNode> {
  // Skip an invisible subtree entirely — its descendants are off-screen too.
  const skip = node.hidden === true || (node.alpha !== undefined && node.alpha < 0.01);
  const role = roleFromClassName(node.className);

  // Scroll-clip inputs (see `flattenHoisting`): a UIScrollView's window frame
  // clips its subtree, so a row it has scrolled out of its viewport — still
  // inside the device screen — is dropped, matching the AX describe path,
  // which never reports scroll-clipped elements. Window-space only: `frame`
  // is parent-local, so falling back to it (as the leaf frame may) would
  // compare rects across coordinate spaces and mis-prune; without a
  // `windowFrame` the node is simply never scroll-pruned and, if a scroller,
  // imposes no clip.
  const win = node.windowFrame;
  const rect = win ? { x: win.x, y: win.y, w: win.width, h: win.height } : null;

  let leaf: DescribeNode | null = null;
  let frame: DescribeFrame | null = null;
  if (!skip && (node.identifier || node.label || role !== "AXGroup" || node.firstResponder)) {
    const leafRect = node.windowFrame ?? node.frame;
    frame = leafRect ? normalizeFrame(leafRect, screenW, screenH) : null;
    if (frame) {
      leaf = {
        role,
        frame,
        children: [],
        label: node.label,
        identifier: node.identifier,
        focused: node.firstResponder || undefined,
      };
    }
  }

  return {
    skip,
    children: node.children ?? [],
    // Text hoists only from on-screen nodes (frame is null when the view is
    // scrolled off or zero-area) — otherwise a text assert against an ancestor
    // would pass on content the screen doesn't show. Every labelled node is
    // leaf-eligible, so `frame` was computed for any node with text.
    ownText: frame ? (node.label ?? "") : "",
    leaf,
    shield: Boolean(node.identifier),
    rect,
    scrolls: role === "AXScrollArea",
  };
}

/**
 * Flatten a `getFullHierarchy` payload into the flat-leaves-under-one-root shape
 * the other describe adapters emit, keeping only views with an `identifier`,
 * `label`, or specific semantic role and an on-screen frame. Pure layout
 * containers are dropped, which keeps the tree comparable in size to the
 * accessibility tree while preserving the children an `accessible` ancestor
 * would otherwise have hidden.
 */
export function adaptFullHierarchyToDescribeResult(raw: unknown): DescribeNode {
  return adaptFullHierarchy(raw).tree;
}

/**
 * Like {@link adaptFullHierarchyToDescribeResult}, but also reports the screen
 * size (points) the frames were normalized against — the rotate directive's
 * physical-circle geometry needs the aspect ratio.
 */
export function adaptFullHierarchy(raw: unknown): {
  tree: DescribeNode;
  screen?: { width: number; height: number };
} {
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

  const tree = parseDescribeResult({
    role: "AXGroup",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children,
  });
  return screenW > 0 && screenH > 0
    ? { tree, screen: { width: screenW, height: screenH } }
    : { tree };
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
  // The type directive's focus wait; an older injected framework ignores the
  // request, which just leaves the wait's poll unconfirmed.
  "firstResponder",
];

/**
 * The flow-level way past an app whose view hierarchy native devtools will never
 * serve. Both terminal branches of {@link unreadableHierarchyReason} name it, so
 * neither can come to offer a different escape than the other; only the
 * non-injectable branch appends the alternative that is specific to an Apple
 * system app (targeting one argent installs instead).
 */
const FLOW_COORDINATE_REMEDY =
  "Replace the selector steps with coordinate ones — `tap: { x: 0.5, y: 0.35 }` takes a point " +
  "directly and reads no tree";

const FLOW_SELECTOR_RECOVERY = `${FLOW_COORDINATE_REMEDY}.`;

/**
 * Why the app a flow launched serves no view hierarchy, for the case where
 * nothing at all is connected.
 *
 * An app the dylib cannot be relied on to load into is terminal for a selector
 * and must be said so: no relaunch and no tool-server restart changes whether it
 * loads, and the measured states would each offer one of those (the launchd env carrying the bootstrap dylib is
 * simulator-wide, so the process inherits the injection tokens the measurement
 * reads and can score as merely `unregistered`). Selector resolution is the
 * point at which that impossibility actually bites — the launch gate lets these
 * apps through precisely so a coordinate-driven flow still runs — so this is
 * where the flow author is told, with the remedy that exists at flow level.
 *
 * Everything else is measured off the running process, and a rejection degrades
 * to the state that says exactly that, as the other consumers do: the call
 * re-applies the launchd env before it measures anything, so a sim that goes
 * away mid-run rejects here, and a raw simctl subprocess error carries none of
 * the guidance the diagnosis does.
 */
async function unreadableHierarchyReason(
  nativeApi: NativeDevtoolsApi,
  bundleId: string
): Promise<string> {
  if (!isInjectableBundleId(bundleId)) {
    return (
      `${bundleId} is an Apple system app: it is a platform binary with library validation, so ` +
      `argent's native devtools cannot be relied on to inject into it, and without them a flow has ` +
      `no view hierarchy to resolve selectors against. ${FLOW_COORDINATE_REMEDY} — or target an app ` +
      `argent installs.`
    );
  }
  const state = await nativeApi.appConnectionState(bundleId).catch(() => "indeterminate" as const);
  if (state === "connected") {
    // Reachable: `appConnectionState` re-reads the live connections map after
    // its env re-apply and process probe — several simctl round-trips after the
    // empty list that sent us here — precisely so a dial landing in that window
    // is not reported as an app the service never registered. So the connection
    // arrived mid-read, and the only thing wrong with this attempt is that it
    // was taken too early.
    return (
      `native devtools reported no connected app while this tree was being read, but ${bundleId} is ` +
      `connected now — the connection arrived mid-read. Retry: flows resolve selectors against the ` +
      `full view hierarchy native devtools serve.`
    );
  }
  // The diagnosis already names the corrective action, and for `unregistered`
  // that action is a tool-server restart — telling a flow author to relaunch
  // there sends them round a loop the app cannot exit. The trailing sentence
  // says what the message is FOR: every caller here was resolving a selector,
  // and none of the measured remedies mentions why a tree read needed it.
  const advice = adviseOnUninjectedApp(nativeApi, bundleId, state, FLOW_SELECTOR_RECOVERY);
  // The terminal diagnosis carries the flow-level remedy already, so the
  // "why a tree was needed" sentence would only restate what it just said.
  if (advice.terminal) return advice.message;
  return `${advice.message} Flows resolve selectors against the full view hierarchy native devtools serve.`;
}

/**
 * Query the raw UIView tree via native-devtools `getFullHierarchy` and adapt
 * it. Throws — with the reason — when native-devtools is unavailable / not yet
 * connected / errored: flows never degrade to the AX tree (see
 * `fetchFlowTree`), so the caller's retry loop either rides out a transient
 * failure or surfaces this message as the step's failure reason.
 *
 * `launchedBundleId` is the app the run's `launch` step started, when it had
 * one. Auto-targeting cannot name an app that is not connected, and those are
 * exactly the cases worth explaining, so this id is what the explanation is
 * measured for.
 */
export async function queryFullHierarchyTree(
  registry: Registry,
  device: DeviceInfo,
  launchedBundleId?: string
): Promise<DescribeTreeData> {
  let nativeApi: NativeDevtoolsApi;
  try {
    const ndRef = nativeDevtoolsRef(device);
    nativeApi = await registry.resolveService<NativeDevtoolsApi>(ndRef.urn, ndRef.options);
  } catch (err) {
    throw new Error(
      `native devtools is unavailable (${errMsg(err)}) — flows resolve selectors against the full view hierarchy it serves`,
      { cause: err }
    );
  }
  // Auto-targeting draws its candidates from `listConnectedBundleIds` — the
  // same map `appConnectionState` reads to answer `connected` — so an empty
  // list is exactly the set of states that explain a missing connection, and
  // the error it raises there ("Launch or restart the app first") is the
  // restart loop this measurement exists to break. A flow that launched an app
  // knows which one, and that id does not come from the connections map, so it
  // survives the disconnection auto-targeting could not describe.
  //
  // The empty list is tested directly rather than by catching and classifying
  // the throw: the failure code travels on a module-local symbol, so a
  // duplicate `@argent/registry` instance would read it as absent and silently
  // fall back to the stock auto-target message. Auto-targeting's OTHER errors
  // — ambiguous frontmost, a lone connected app that isn't foreground-like —
  // arise only with a non-empty list, already name their own next step, and so
  // propagate unwrapped from the call below.
  if (launchedBundleId !== undefined && nativeApi.listConnectedBundleIds().length === 0) {
    throw new Error(await unreadableHierarchyReason(nativeApi, launchedBundleId));
  }
  const target = await resolveNativeTargetApp(nativeApi, undefined);

  const rawResult = (await nativeApi.queryViewHierarchy(
    target.bundleId,
    "ViewHierarchy.getFullHierarchy",
    {
      fields: FULL_HIERARCHY_FIELDS,
      maxDepth: 40,
    }
  )) as { windows?: unknown[]; error?: string };

  if (rawResult.error) {
    throw new Error(`getFullHierarchy failed for ${target.bundleId}: ${rawResult.error}`);
  }

  const { tree, screen } = adaptFullHierarchy(rawResult);
  return { tree, source: "native-devtools", ...(screen ? { screen } : {}) };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
