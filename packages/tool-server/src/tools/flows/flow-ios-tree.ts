import {
  FAILURE_CODES,
  FailureError,
  getFailureSignal,
  type DeviceInfo,
  type Registry,
} from "@argent/registry";
import {
  buildAppStateMessage,
  isInjectableBundleId,
  nativeDevtoolsRef,
  type NativeDevtoolsApi,
} from "../../blueprints/native-devtools";
import { resolveNativeTargetApp } from "../../utils/native-target-app";
import { deviceSetForUdid, simctlPrefix } from "../../utils/ios-device-sets";
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
 * unavailable — or the target returns no windows — it throws rather than
 * degrade to the AX tree; see `fetchFlowTree` for why a silent fallback would
 * flip flow outcomes.
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
 * Depth ceiling for the flow selector tree. It counts raw UIView nesting, and
 * React Native wrappers alone (nested RNSScreenStackView/RNSScreenView plus a
 * root or drawer wrapper) run 40 to 60 levels deep. Under the old cap of 40, the
 * device truncated visible elements of a production app at depths 41 to 62, so
 * `id:` and `text:` selectors did not resolve and only coordinate taps worked.
 * Truncation is silent, so this cap keeps headroom.
 *
 * A deeper tree also moves `text` verdicts. A `text` check on an identified
 * container reads that container's hoisted `subtreeText`, and deeper descendants
 * now hoist into it. `contains` still passes, but `equals` can flip to a
 * failure: the fallback in `evaluateCondition` (`ui-tree-match.ts`) also tries
 * the node's own `label`/`value`, which a testID'd wrapper does not have. Move
 * such a check to the leaf that holds the text, or relax it to `contains`.
 *
 * The cap also makes failure reasons longer. The tree itself never reaches a
 * tool result, but text derived from it does: `assertReason`
 * (`flow-actions.ts`) quotes the matched node's hoisted `subtreeText` verbatim,
 * and nothing truncates it. On a testID'd collection view of 60 rows, a failing
 * `assert { text }` grew from 87 to 466 characters. `compatibilityMissNote`
 * quotes that same string again, so a near-miss grew from 1520 to 2210. Its
 * `exists`/`visible` arm reads `label` and `value` only, and does not grow.
 *
 * The last cost is the getFullHierarchy payload, which is field-limited
 * (`FULL_HIERARCHY_FIELDS`): about 11KB at depth 40 and 15KB at depth 48. Past
 * the real depth of the tree, a higher cap costs nothing.
 */
const FLOW_TREE_MAX_DEPTH = 100;

/**
 * Why the app a flow launched serves no view hierarchy, for the case where
 * nothing at all is connected.
 *
 * An app the dylib cannot be relied on to load into is terminal for a selector,
 * yet every measured state offers a relaunch or a tool-server restart: the
 * launchd env carrying the bootstrap dylib is simulator-wide, so such a process
 * inherits the injection tokens the measurement reads and can score as merely
 * `unregistered`. Selector resolution is where that impossibility bites — the
 * launch gate lets these apps through so a coordinate-driven flow still runs —
 * so it is said here, with the remedy that exists at flow level.
 *
 * Everything else is measured off the running process; a rejection degrades as
 * it does for the other consumers, since the call re-applies the launchd env
 * before measuring and so rejects on a sim that went away mid-run.
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
    // Reachable: `appConnectionState` re-reads the live connections map after
    // its env re-apply and process probe, several simctl round-trips after the
    // empty list that sent us here. So the connection arrived mid-read, and the
    // only thing wrong with this attempt is that it was taken too early.
    return (
      `native devtools reported no connected app while this tree was being read, but ${bundleId} is ` +
      `connected now — the connection arrived mid-read. Retry: flows resolve selectors against the ` +
      `full view hierarchy native devtools serve.`
    );
  }
  // The diagnosis already names the corrective action — for `unregistered` a
  // tool-server restart, where telling a flow author to relaunch would loop.
  // The trailing sentence says why a tree read needed one at all.
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
 * app whose disconnection needs explaining, and when auto-resolution's own probe
 * times out mid-stall it arbitrates the target.
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
    throw wrapPreservingFailure(
      `native devtools is unavailable (${errMsg(err)}) — flows resolve selectors against the full view hierarchy it serves`,
      err
    );
  }
  // Auto-targeting draws its candidates from `listConnectedBundleIds`, the same
  // map `appConnectionState` reads, so an empty list is exactly the set of
  // states that explain a missing connection — and the error it raises there
  // ("Launch or restart the app first") is the restart loop this measurement
  // exists to break. The flow's launched id does not come from that map, so it
  // survives the disconnection auto-targeting could not describe.
  //
  // Tested directly rather than by catching the throw: its failure code travels
  // on a module-local symbol, so a duplicate `@argent/registry` instance would
  // read it as absent and silently fall back to the stock message.
  if (launchedNativeApp !== undefined && nativeApi.listConnectedBundleIds().length === 0) {
    throw new Error(await unreadableHierarchyReason(nativeApi, launchedNativeApp));
  }
  // resolveNativeTargetApp asks the caller to provide a bundleId, which a flow
  // selector step cannot do: this call hardcodes auto-targeting. Each branch
  // below replaces that advice with a remedy for its own failure. If apps are
  // connected but none is uniquely frontmost, the remedy is to foreground the
  // intended one, not to relaunch instrumentation it already has. Only "no
  // connected app" means the target started outside Argent (Metro/Expo, Xcode,
  // or its home-screen icon) and needs an Argent relaunch.
  let target: { bundleId: string };
  try {
    target = await resolveNativeTargetApp(nativeApi, undefined);
  } catch (err) {
    const failureCode = getFailureSignal(err)?.error_code;
    // The `launch:` hint arbitrates a timeout only. The `Application.getState`
    // probe runs on the app's main thread, so a stall (first Hermes parse,
    // Lottie decode) times it out even for the app the flow just launched. Any
    // resolution that answers wins, including the deliberate "single app but
    // backgrounded" error, so the hint never bypasses a guard that fired.
    if (
      failureCode === FAILURE_CODES.NATIVE_DEVTOOLS_RPC_TIMEOUT &&
      launchedNativeApp !== undefined &&
      nativeApi.listConnectedBundleIds().includes(launchedNativeApp)
    ) {
      target = { bundleId: launchedNativeApp };
    } else {
      const terminate = await terminateCommand(device);
      if (failureCode === FAILURE_CODES.NATIVE_TARGET_MULTIPLE_APPS_AMBIGUOUS) {
        // The reason does not offer to background the other apps. They stay
        // connected, so the set stays ambiguous, and iOS then suspends one until
        // it no longer answers the state probe. That turns this failure into the
        // harder indeterminate one below.
        throw wrapPreservingFailure(
          // Short header: the embedded diagnostic already says the set is
          // ambiguous, and the per-app entries need those 90 characters.
          `could not target an app to read the view hierarchy from:\n` +
            `${cappedAppDiagnostic(withoutExplicitBundleIdAdvice(errMsg(err)))}\n` +
            `Flow selectors auto-target and cannot name a bundleId. Foreground the intended app with ` +
            `launch-app (it does not terminate), then retry; clear the others with ` +
            `\`${terminate}\` (argent has no terminate tool, and ` +
            `restart-app would just bring that app back to the front).`,
          err
        );
      }
      if (failureCode === FAILURE_CODES.NATIVE_TARGET_SINGLE_APP_NOT_FOREGROUND) {
        // The one connected app answered the state probe, so it is instrumented
        // and not suspended. It is either just backgrounded, or it keeps running
        // in the background (audio, location, VoIP). A permission dialog does not
        // land here: the app keeps a foreground-inactive scene and resolves
        // normally. Foregrounding fixes the read, so the relaunch advice below
        // would misdiagnose this state. Keep resolveNativeTargetApp's per-app
        // applicationState diagnostic.
        throw wrapPreservingFailure(
          `the only native-devtools-connected app is not foreground, so it cannot be auto-targeted:\n` +
            `${withoutExplicitBundleIdAdvice(errMsg(err))}\n` +
            `Flow selector steps auto-target and cannot provide a bundleId. Bring that app to the ` +
            `foreground with launch-app (it does not terminate — the app is already instrumented, ` +
            `just not frontmost), then retry.`,
          err
        );
      }
      // No verdict at all: resolveNativeTargetApp probes applicationState for
      // every connected app in one Promise.all, so one stale connection rejects
      // the whole read. iOS suspends a backgrounded app after about a second,
      // and a suspended app stops answering. The connections are still live, so
      // the relaunch advice below does not apply: a relaunch discards the state
      // the flow built up, and cannot help when another app is the stale one.
      const stillConnected = nativeApi.listConnectedBundleIds();
      if (stillConnected.length > 0) {
        throw wrapPreservingFailure(
          `could not read the state of the native-devtools-connected apps, so none could be ` +
            `auto-targeted (${firstClause(err)}). Connected: ${cappedList(stillConnected)}. ` +
            `They are instrumented — do not relaunch. A suspended app stops answering: foreground ` +
            `the app the flow drives with launch-app (it does not terminate), then retry.` +
            // Say this only when another connection exists to clear, and name a
            // command that exists: argent has no terminate tool, and restart-app
            // would bring the other app to the front.
            (stillConnected.length > 1
              ? ` To clear the others use \`${terminate}\` — argent ` +
                `exposes no terminate tool, and restart-app would bring that app to the front instead.`
              : ``),
          err
        );
      }
      // Kept short: every failed selector read repeats this reason verbatim, and
      // the recorder repeats it once per captured tap.
      throw wrapPreservingFailure(
        `no app is connected to native devtools, so flow selectors have no instrumented process to ` +
          `read the view hierarchy from (${firstClause(err)}). Relaunch with restart-app (or a flow ` +
          `\`launch\` step): launch-app does not terminate, so on an app already running from ` +
          `Metro/Expo, Xcode, or its icon it only foregrounds that uninstrumented process. ` +
          // "feature tools", not "the native-* tools": only the six that run the
          // throwing 3-arg precheck refuse a com.apple.* bundle.
          // native-devtools-status runs the 2-arg form and reports
          // injectable:false, and the native-profiler-* tools do not precheck.
          // The broader claim would hide the one tool that confirms this state.
          `Argent treats an Apple system app (com.apple.*) as non-injectable — the native-devtools ` +
          `feature tools refuse it too — so if one never connects, drive it with raw point taps ` +
          `and tool: await-ui-element steps.`,
        err
      );
    }
  }

  // Only a disconnect race reaches this. `resolveNativeTargetApp(api,
  // undefined)` returns ids from `listConnectedBundleIds()`, so an id missing
  // from that same live map means the socket dropped after the resolve. The app
  // was instrumented, so the "launched before argent's instrumentation loaded"
  // diagnosis of an explicitly-named bundle is wrong here.
  if (!nativeApi.listConnectedBundleIds().includes(target.bundleId)) {
    throw new Error(
      `${target.bundleId} answered the target probe and then dropped its native-devtools ` +
        `connection before the view hierarchy could be read. It was instrumented, so a retry may ` +
        `ride this out; if the connection does not come back, relaunch with restart-app (or a ` +
        `flow \`launch\` step) — launch-app would only foreground the process that just lost it.`
    );
  }

  const rawResult = (await nativeApi.queryViewHierarchy(
    target.bundleId,
    "ViewHierarchy.getFullHierarchy",
    {
      fields: FULL_HIERARCHY_FIELDS,
      maxDepth: FLOW_TREE_MAX_DEPTH,
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

/**
 * The `xcrun simctl terminate` command an agent can run against this device. Two
 * targeting reasons offer it to clear a competing connected app, because argent
 * has no terminate tool.
 *
 * simctl scopes each operation to one device set, so a UDID from a configured
 * `ios.additionalDeviceSets` set (Radon IDE's, for example) needs `--set` to
 * resolve. See `simctlArgsForUdid`, which argent's own call sites use. Only the
 * prefix is resolved. The udid and bundleId stay placeholders, because the agent
 * knows its device and picks the app to clear. A default-set device gets the
 * plain command, so its reason keeps the same size budget (see
 * {@link MAX_TARGETING_REASON_CHARS}).
 */
async function terminateCommand(device: DeviceInfo): Promise<string> {
  const prefix = simctlPrefix(await deviceSetForUdid(device.id));
  return `xcrun ${prefix.join(" ")} terminate <udid> <bundleId>`;
}

// The first sentence of a diagnostic's first line: what went wrong, without the
// remedy each source appends for its own callers. A sentence ends at a period
// plus whitespace or the end of the line. Messages that reach here carry dotted
// identifiers (`Application.getState`), which a bare period cuts in half. A line
// with no sentence break is already the clause.
function firstClause(err: unknown): string {
  const firstLine = errMsg(err).split("\n", 1)[0];
  const sentenceEnd = /\.(?=\s|$)/.exec(firstLine);
  return sentenceEnd === null ? firstLine : firstLine.slice(0, sentenceEnd.index + 1);
}

/**
 * How many connected apps a targeting reason may list.
 *
 * The ambiguous and indeterminate branches both embed a per-app list, so without
 * a cap the reason grows with the connected-app count: 778 characters for 2
 * apps, 1000 for 4 and 1444 for 8. That cost is paid per step, because
 * `captureTapSelector` embeds the reason in the warning of every recorded tap
 * and a failing `await:` repeats it once per poll. Two entries are enough to act
 * on: the remedy is to foreground the app you want and clear the rest. The
 * dropped count is still reported.
 */
export const MAX_LISTED_APPS = 2;

/**
 * Ceiling every reason thrown from {@link queryFullHierarchyTree} must fit,
 * enforced by `keeps every targeting reason short enough to repeat per step`.
 *
 * Measured on the raw message, before the prefix a caller adds, and without the
 * `--set <dir>` that an `ios.additionalDeviceSets` device adds to its terminate
 * command (see {@link terminateCommand}).
 *
 * The guard covers {@link unreadableHierarchyReason} too, which the recorder
 * repeats once per captured tap and which sets the ceiling: 775 characters for
 * `unregistered` against a 37-character bundle id, in wording shared with
 * `native-devtools-status` and iOS `describe`. The ambiguous branch is next at
 * 702, because it carries the two per-app `applicationState` diagnostics an
 * agent needs to pick the app to clear. Neither figure grows with the
 * connected-app count; see {@link MAX_LISTED_APPS}.
 */
export const MAX_TARGETING_REASON_CHARS = 800;

/** Keep the first {@link MAX_LISTED_APPS} entries, and say how many were not shown. */
function cappedList(bundleIds: readonly string[]): string {
  if (bundleIds.length <= MAX_LISTED_APPS) return bundleIds.join(", ");
  const dropped = bundleIds.length - MAX_LISTED_APPS;
  return `${bundleIds.slice(0, MAX_LISTED_APPS).join(", ")} (+${dropped} more)`;
}

/**
 * Cap the per-app lines of an embedded `resolveNativeTargetApp` diagnostic and
 * keep its leading summary line. The entries are its `- <bundleId>
 * (applicationState=…)` lines. Every other line passes through, so a reworded
 * source loses the cap instead of getting a mangled message.
 */
function cappedAppDiagnostic(message: string): string {
  const lines = message.split("\n");
  const isEntry = (line: string): boolean => line.startsWith("- ");
  const firstEntry = lines.findIndex(isEntry);
  if (firstEntry === -1) return message;
  const entries = lines.filter(isEntry);
  if (entries.length <= MAX_LISTED_APPS) return message;
  const kept = entries.slice(0, MAX_LISTED_APPS);
  const dropped = entries.length - MAX_LISTED_APPS;
  return [
    ...lines.slice(0, firstEntry),
    ...kept,
    `- (+${dropped} more connected app${dropped === 1 ? "" : "s"})`,
    ...lines.slice(firstEntry + entries.length).filter((line) => !isEntry(line)),
  ].join("\n");
}

// Strip resolveNativeTargetApp's trailing "Provide bundleId explicitly…" line:
// a flow selector step hardcodes auto-targeting and cannot act on it. Match the
// whole line, not the bare sentence, because the ambiguous and single-app cases
// end that line differently.
function withoutExplicitBundleIdAdvice(message: string): string {
  return message.replace(/\nProvide bundleId explicitly[^\n]*$/, "");
}

/** Add actionable flow-specific context without stripping FailureError data. */
function wrapPreservingFailure(message: string, err: unknown): Error {
  const cause = err instanceof Error ? err : new Error(String(err));
  const signal = getFailureSignal(err);
  return signal ? new FailureError(message, signal, { cause }) : new Error(message, { cause });
}
