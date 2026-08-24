import { FAILURE_CODES, getFailureSignal, type DeviceInfo, type Registry } from "@argent/registry";
import {
  buildAppStateMessage,
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
 * Flow-owned iOS tree source (per-platform dispatch: `flow-tree.ts`).
 *
 * Flows resolve selectors against the raw UIView hierarchy
 * (`ViewHierarchy.getFullHierarchy`), not the accessibility tree `describe` and
 * `describeScreen` walk: those collapse an `accessible` container into a single
 * leaf (VoiceOver semantics), while every view here carries its
 * `accessibilityIdentifier` (React Native `testID`), so a flow can address a
 * container and its children independently. When native-devtools is unavailable
 * — or the target returns no windows — this throws rather than degrade to the
 * AX tree; see `fetchFlowTree` for why a silent fallback would flip flow
 * outcomes.
 */

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

// Role guessed from the UIView class name — the full hierarchy carries no
// accessibility traits. Selectors lean on text/identifier, so a coarse mapping
// is enough.
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
 * becomes a leaf when it carries an `identifier` (React Native `testID`), a
 * `label`, or a specific semantic role — or is the first responder, which the
 * type directive's focus wait reads — and has an on-screen frame. An identified
 * node shields its text, scoping hoisting to the nearest identified ancestor.
 */
function projectIosNode(
  node: RawViewNode,
  screenW: number,
  screenH: number
): FlatNode<RawViewNode> {
  const skip = node.hidden === true || (node.alpha !== undefined && node.alpha < 0.01);
  const role = roleFromClassName(node.className);

  // Scroll-clip inputs (see `flattenHoisting`). Window space only: `frame` is
  // parent-local, so falling back to it (as the leaf frame does) would compare
  // rects across coordinate spaces and mis-prune; without a `windowFrame` the
  // node is never scroll-pruned and, if a scroller, imposes no clip.
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
    // would pass on content the screen doesn't show. A label makes a node
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
 * `label`, or specific semantic role and an on-screen frame. Dropping the pure
 * layout containers keeps the tree comparable in size to the accessibility tree
 * while preserving children an `accessible` ancestor would have hidden.
 */
export function adaptFullHierarchyToDescribeResult(raw: unknown): DescribeNode {
  return adaptFullHierarchy(raw).tree;
}

/**
 * Like {@link adaptFullHierarchyToDescribeResult}, but also reports the screen
 * size (points) the frames were normalized against — the rotate directive needs
 * the aspect ratio for its physical-circle geometry.
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

  // Screen size is the largest window frame: the key window spans the screen,
  // so its width/height are the normalization denominators.
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

/** Fields requested from getFullHierarchy — the minimum to flatten + match. */
const FULL_HIERARCHY_FIELDS = [
  "className",
  "identifier",
  "label",
  "frame",
  "windowFrame",
  "hidden",
  "alpha",
  // Read by the type directive's focus wait; an injected framework that omits
  // it just leaves that wait's poll unconfirmed.
  "firstResponder",
];

/**
 * Why the app a flow launched serves no view hierarchy, for the case where
 * nothing at all is connected.
 *
 * An app the dylib cannot be relied on to load into is terminal for a selector,
 * yet the state measurement cannot see that: the launchd env carrying the
 * bootstrap dylib is simulator-wide, so such a process inherits the injection
 * tokens the measurement reads and can score as merely `unregistered`. The
 * launch gate lets these apps through so a coordinate-driven flow still runs, so
 * selector resolution is where the impossibility bites and where the flow-level
 * remedy is named. Everything else is measured off the running process, whose
 * rejection degrades to `indeterminate`.
 */
async function unreadableHierarchyReason(
  nativeApi: NativeDevtoolsApi,
  bundleId: string
): Promise<string> {
  if (!isInjectableBundleId(bundleId)) {
    return (
      `${bundleId} is an Apple system app: it is a platform binary with library validation, so ` +
      `argent's native devtools cannot be relied on to inject into it, and without them a flow has ` +
      `no view hierarchy to resolve selectors against. Replace the selector steps with coordinate ` +
      `ones — \`tap: { x: 0.5, y: 0.35 }\` takes a point directly and reads no tree — or target an app ` +
      `argent installs.`
    );
  }
  const state = await nativeApi.appConnectionState(bundleId).catch(() => "indeterminate" as const);
  if (state === "connected") {
    // `appConnectionState` re-reads the live connections map after its env
    // re-apply and process probe, several simctl round-trips after the empty
    // list that sent us here: the connection arrived mid-read.
    return (
      `native devtools reported no connected app while this tree was being read, but ${bundleId} is ` +
      `connected now — the connection arrived mid-read. Retry: flows resolve selectors against the ` +
      `full view hierarchy native devtools serve.`
    );
  }
  // `buildAppStateMessage` already names the corrective action; the trailing
  // sentence says why a tree read needed one at all.
  return `${buildAppStateMessage(bundleId, state)} Flows resolve selectors against the full view hierarchy native devtools serve.`;
}

/**
 * Query the raw UIView tree via native-devtools `getFullHierarchy` and adapt
 * it. Throws — with the reason — when native-devtools is unavailable / not yet
 * connected / errored, or when the resolved target returns no windows (a
 * non-injectable or backgrounded app): flows never degrade to the AX tree (see
 * `fetchFlowTree`), so the caller's retry loop either rides out a transient
 * failure or surfaces this message as the step's failure reason.
 *
 * `launchedNativeApp` is the app this run's `launch:` step started, when it had
 * one. It serves the two reads auto-targeting cannot, both following from it
 * resolving only out of the connected list: with that list empty it names the
 * app whose disconnection needs explaining, and it arbitrates the target when
 * auto-resolution's own probe times out.
 */
export async function queryFullHierarchyTree(
  registry: Registry,
  device: DeviceInfo,
  launchedNativeApp?: string
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
  // Auto-targeting draws its candidates from `listConnectedBundleIds`, the same
  // map `appConnectionState` reads, so an empty list is exactly the set of
  // states that explain a missing connection — and the error it raises there
  // ("Launch or restart the app first") is the restart loop this measurement
  // exists to break. The flow's launched id does not come from that map, so it
  // survives the disconnection auto-targeting could not describe.
  //
  // Tested directly rather than by catching the throw: the failure code travels
  // on a module-local symbol, so a duplicate `@argent/registry` instance would
  // read it as absent and silently fall back to the stock message.
  if (launchedNativeApp !== undefined && nativeApi.listConnectedBundleIds().length === 0) {
    throw new Error(await unreadableHierarchyReason(nativeApi, launchedNativeApp));
  }
  // resolveNativeTargetApp's remaining errors already carry the actionable next
  // step, so they propagate unwrapped — with one exception. An app stalled by a
  // heavy cold start times out auto-resolution's `Application.getState` probe
  // even though it is exactly the app the flow launched and is about to read.
  // ONLY on that timeout, fall back to the app this run's `launch:` started,
  // provided its devtools connection is still up. A resolution that ANSWERS
  // (including the deliberate "single app but backgrounded" error) is always
  // preferred: the arbiter never overrides a guard that fired, it only rides out
  // a probe the stall made unanswerable.
  let target: { bundleId: string };
  try {
    target = await resolveNativeTargetApp(nativeApi, undefined);
  } catch (err) {
    const timedOut =
      getFailureSignal(err)?.error_code === FAILURE_CODES.NATIVE_DEVTOOLS_RPC_TIMEOUT;
    if (
      timedOut &&
      launchedNativeApp !== undefined &&
      nativeApi.listConnectedBundleIds().includes(launchedNativeApp)
    ) {
      target = { bundleId: launchedNativeApp };
    } else {
      throw err;
    }
  }

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

  // No windows is an untrustworthy read (non-injectable app, backgrounded, or a
  // window not yet attached), not a blank screen — and an empty tree is the one
  // thing a `hidden`/absent check accepts, so trusting it would false-pass.
  // Key on raw windows, not flattened children: windows-but-no-leaves is a
  // genuinely sparse, trusted screen.
  if (!Array.isArray(rawResult.windows) || rawResult.windows.length === 0) {
    throw new Error(
      `getFullHierarchy returned no windows for ${target.bundleId} — the app is not injectable ` +
        `(e.g. an Apple system app) or has no readable foreground window, so flows cannot resolve ` +
        `selectors against its view hierarchy`
    );
  }

  const { tree, screen } = adaptFullHierarchy(rawResult);
  return { tree, source: "native-devtools", ...(screen ? { screen } : {}) };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
