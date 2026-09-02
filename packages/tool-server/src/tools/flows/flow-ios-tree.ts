import { FAILURE_CODES, FailureError, getFailureSignal } from "@argent/registry";
import type { DeviceInfo, Registry } from "@argent/registry";
import {
  buildAppStateMessage,
  isInjectableBundleId,
  nativeDevtoolsRef,
  type NativeAppState,
  type NativeDevtoolsApi,
} from "../../blueprints/native-devtools";
import { chooseFrontmostConnectedApp, resolveNativeTargetApp } from "../../utils/native-target-app";
import { deviceSetForUdid, simctlPrefix } from "../../utils/ios-device-sets";
import type { FlowTreeTarget } from "./flow-actions";
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
function adaptFullHierarchy(raw: unknown): {
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

/**
 * Depth ceiling for the flow selector tree, counting raw UIView nesting. React
 * Native wrappers alone run 40 to 60 levels deep, so the old cap of 40 silently
 * truncated a production app's visible elements and left `id:` and `text:`
 * selectors unresolvable. Headroom past a tree's real depth is free: the
 * payload is field-limited (see {@link FULL_HIERARCHY_FIELDS}).
 */
const FLOW_TREE_MAX_DEPTH = 100;

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
 * A `com.apple.*` app is refused by policy, which is terminal for a selector,
 * yet the state measurement cannot see that: the launchd env carrying the
 * bootstrap dylib is simulator-wide, so such a process inherits the injection
 * tokens the measurement reads and can score as merely `unregistered`. The
 * launch gate lets these apps through so a coordinate-driven flow still runs, so
 * selector resolution is where the refusal bites and where the flow-level
 * remedy is named. Everything else is measured off the running process, whose
 * rejection degrades to `indeterminate`.
 */
async function unreadableHierarchyReason(
  nativeApi: NativeDevtoolsApi,
  bundleId: string
): Promise<string> {
  if (!isInjectableBundleId(bundleId)) {
    return (
      `${bundleId} is an Apple system app: it is never the app under test, so ` +
      `argent's native devtools refuse to read one, and without them a flow has ` +
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

/** Shared verbatim by the pinned gate and the unpinned arbiter. */
function systemAppFlowTargetRefusal(bundleId: string): string {
  return `${bundleId} is an Apple system app (com.apple.*) - never a valid flow target: it is not the app under test, and argent's native devtools refuse to read one (a system process either never services the read, or describes offscreen UI as if it were the launched app), so this flow has no view hierarchy to resolve selectors against and no relaunch or retry changes this verdict. Replace the selector steps with coordinate ones - \`tap: { x: 0.5, y: 0.35 }\` takes a point directly and reads no tree - or point this flow's \`launch\` step at the app under test.`;
}

/**
 * Query the raw UIView tree via native-devtools `getFullHierarchy` and adapt
 * it. Flows never degrade to the AX tree (see `fetchFlowTree`), so every
 * failure throws with its reason: the caller's poll rides out a transient one,
 * and whatever is still failing at its deadline becomes the step's failure
 * reason.
 *
 * A PINNED {@link FlowTreeTarget} is read directly, skipping auto-resolve's
 * `Application.getState` fan-out — injection is simulator-wide, and one
 * background system process that never answers getState sinks the whole
 * fan-out — and re-deciding against the pinned app alone what that fan-out
 * would otherwise have decided.
 *
 * An UNPINNED target is only a hint: auto-resolve decides and its own errors
 * propagate unwrapped, and the hint takes the read solely when that fan-out
 * times out and the hint vouches for itself with a probe of its own.
 */
export async function queryFullHierarchyTree(
  registry: Registry,
  device: DeviceInfo,
  target?: FlowTreeTarget
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

  let bundleId: string;
  if (target?.pinned) {
    bundleId = target.bundleId;
    // Nothing upstream of a pinned flow target applies the policy gate every
    // other explicit-bundleId hierarchy read gets from precheckNativeDevtools:
    // `launch` runs its 2-arg overload, and treeSourceGate only waits for
    // isConnected, which simulator-wide injection lets a background system
    // process satisfy. Before the gates below so the refusal costs neither.
    if (!isInjectableBundleId(bundleId)) {
      throw new FailureError(systemAppFlowTargetRefusal(bundleId), {
        error_code: FAILURE_CODES.NATIVE_DEVTOOLS_NOT_INJECTABLE,
        failure_stage: "flow_tree_pinned_target",
        failure_area: "tool_server",
        error_kind: "validation",
      });
    }
    // Gate on isConnected (a pure map lookup), never appConnectionState: its
    // miss path runs reverifyEnv - a full env re-setup with 10s simctl
    // timeouts - and tree reads poll every 300ms, so a dead pin would drive
    // that repair once per poll until three failures latch the device's
    // process-wide give-up. The pinned app launched with the instrumentation
    // loaded, so a missing connection means the process is gone.
    if (!nativeApi.isConnected(bundleId)) {
      throw new FailureError(
        `${bundleId} lost its devtools connection after launch (the app crashed, was terminated, or its socket closed) - restart it (restart-app, or a flow \`launch\` step) so the full view hierarchy is readable; launch-app recovers only the causes that killed the process, since on iOS it just foregrounds one that is still alive`,
        {
          error_code: FAILURE_CODES.NATIVE_DEVTOOLS_NOT_CONNECTED,
          failure_stage: "flow_tree_pinned_target",
          failure_area: "tool_server",
          error_kind: "not_found",
        }
      );
    }
    // Connected only proves the process is alive. The pin bypasses
    // auto-resolve's frontmost guard, and the dylib serves getFullHierarchy for
    // a backgrounded app too, so an unguarded read would describe a screen that
    // is not on screen. Probe ONLY the pinned app: one suspended sibling's
    // getState is the fan-out failure the pin exists to avoid.
    //
    // A probe that never answers means opposite things before and after this
    // pin's first answer (see FlowTreeTarget.probeAnswered): a cold start
    // pinning the main thread, which is ridden out, versus an app that stopped
    // servicing a queue it demonstrably serviced, which is refused rather than
    // parked on for the longer getFullHierarchy timeout.
    let pinnedState: NativeAppState | undefined;
    try {
      pinnedState = await nativeApi.getAppState(bundleId);
      target.probeAnswered = true;
    } catch (err) {
      if (getFailureSignal(err)?.error_code !== FAILURE_CODES.NATIVE_DEVTOOLS_RPC_TIMEOUT) {
        throw err;
      }
      if (target.probeAnswered) {
        throw new FailureError(
          `${bundleId} (the launched app) stopped answering Application.getState - the probe timed out although an earlier one in this run answered, so the app's main queue is no longer being serviced. For a pinned app that is usually the suspension iOS applies once a flow leaves it (e.g. a tap that opened another app), and a suspended app's hierarchy is not what is on screen; in-app work blocking the main thread past the probe timeout looks the same from here. Reading anyway parks on that same unserviced queue: certain to time out if the app is suspended, and paying the longer hierarchy timeout to find that out if it is not. If this flow's subject IS the other app, give the flow a \`launch:\` step for that app - it re-pins reads to it, and a pinned read probes only the app it names, so the silent ${bundleId} is never touched; \`tool: launch-app\` or \`tool: restart-app\` naming that app works too - each re-targets reads at the app it starts, and is how a recorded flow switches apps. A foreground-NEUTRAL raw \`tool:\` step does not work here, because demoting the pin sends reads back to auto-resolve, which probes every connection at once and is sunk by this same silent one. If the flow left ${bundleId} but is still about it, make it return before reading the UI. If it never left, the main thread is busy: raise the step's \`timeout:\` so the poll re-reads past the work, or \`launch\` ${bundleId} again.`,
          {
            // The timeout's own code, NOT
            // NATIVE_TARGET_SINGLE_APP_NOT_FOREGROUND: nothing answered, so no
            // app state was observed to classify it by.
            error_code: FAILURE_CODES.NATIVE_DEVTOOLS_RPC_TIMEOUT,
            failure_stage: "flow_tree_pinned_target",
            failure_area: "tool_server",
            error_kind: "timeout",
          },
          err instanceof Error ? { cause: err } : undefined
        );
      }
    }
    // Deliberately as lenient as auto-resolve is over a single app:
    // `chooseFrontmostConnectedApp` accepts the transition window - under a
    // system alert, in the app switcher's first frames - where the app is still
    // what is on screen. A strict "active only" check would fail the very flows
    // that assert on such an alert.
    if (pinnedState && !chooseFrontmostConnectedApp([pinnedState])) {
      throw new FailureError(
        `${bundleId} (the launched app) has no foreground presence at all (applicationState=${pinnedState.applicationState}, foregroundActiveScenes=${pinnedState.foregroundActiveSceneCount}, foregroundInactiveScenes=${pinnedState.foregroundInactiveSceneCount}) - a step in this flow left the app (e.g. a tap that opened another app), so a read of its hierarchy would describe a screen that is not on screen. Transitional states are NOT refused here: an \`inactive\` app, or one still holding a foreground scene, is read as usual - under a system alert or mid-transition it is still the app on screen. If this flow's subject IS another app, give the flow a \`launch:\` step for that app - it re-pins reads to it, and no wedged sibling connection can sink a pinned read; a raw \`tool:\` step demotes the pin and returns reads to frontmost auto-resolve, which works when the app on screen answers but is sunk by a single wedged connection. Otherwise make the flow return to ${bundleId} before reading the UI, or \`launch\` it again.`,
        {
          error_code: FAILURE_CODES.NATIVE_TARGET_SINGLE_APP_NOT_FOREGROUND,
          failure_stage: "flow_tree_pinned_target",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }
  } else {
    // The target does not come from `listConnectedBundleIds`, the map
    // auto-resolve draws its candidates from, so it survives a disconnection
    // auto-resolve could not describe - and the error auto-resolve raises there
    // ("Launch or restart the app first") is the restart loop this measurement
    // exists to break.
    //
    // Tested directly rather than by catching the throw: its failure code
    // travels on a module-local symbol, so a duplicate `@argent/registry`
    // instance would read it as absent and silently fall back to the stock
    // message.
    if (target && nativeApi.listConnectedBundleIds().length === 0) {
      throw new Error(await unreadableHierarchyReason(nativeApi, target.bundleId));
    }
    // resolveNativeTargetApp's own errors (no connected app / ambiguous
    // frontmost) already carry the actionable next step, so they propagate
    // unwrapped - with one exception. Its `Application.getState` fan-out probes
    // every connection at once, so one process whose main thread is pinned
    // times the whole resolution out and leaves the read no target at all. ONLY
    // then, and only while the target names an injectable app whose connection
    // is still up and whose own probe answers foreground-like, read it instead.
    // A resolution that ANSWERS (including the deliberate "single app but
    // backgrounded" error) always wins: the arbiter never overrides a guard
    // that fired, it only rides out a probe the stall made unanswerable.
    let resolved: { bundleId: string };
    try {
      resolved = await resolveNativeTargetApp(nativeApi, undefined);
    } catch (err) {
      const timedOut =
        getFailureSignal(err)?.error_code === FAILURE_CODES.NATIVE_DEVTOOLS_RPC_TIMEOUT;
      if (!timedOut || !target) throw await explainTargetingFailure(err, nativeApi, device);
      // Checked before the connections list to keep the refusal terminal
      // either way.
      if (!isInjectableBundleId(target.bundleId)) {
        throw new FailureError(
          systemAppFlowTargetRefusal(target.bundleId),
          {
            error_code: FAILURE_CODES.NATIVE_DEVTOOLS_NOT_INJECTABLE,
            failure_stage: "flow_tree_unpinned_hint",
            failure_area: "tool_server",
            error_kind: "validation",
          },
          err instanceof Error ? { cause: err } : undefined
        );
      }
      if (!nativeApi.listConnectedBundleIds().includes(target.bundleId)) {
        throw await explainTargetingFailure(err, nativeApi, device);
      }
      // The timed-out fan-out proved nothing about what is on screen, so the
      // hint must vouch for itself before taking the read. A probe it cannot
      // answer is nothing to vouch for: the fan-out's own timeout stands.
      let hintState: NativeAppState;
      try {
        hintState = await nativeApi.getAppState(target.bundleId);
      } catch (probeErr) {
        if (getFailureSignal(probeErr)?.error_code === FAILURE_CODES.NATIVE_DEVTOOLS_RPC_TIMEOUT) {
          throw await explainTargetingFailure(err, nativeApi, device);
        }
        throw probeErr;
      }
      // Same leniency as the pinned guard over one app: transitional states
      // still read; only no foreground presence at all is refused.
      if (!chooseFrontmostConnectedApp([hintState])) {
        throw new FailureError(
          `${target.bundleId} (the launched app) has no foreground presence at all (applicationState=${hintState.applicationState}, foregroundActiveScenes=${hintState.foregroundActiveSceneCount}, foregroundInactiveScenes=${hintState.foregroundInactiveSceneCount}) - auto-resolve's probe of every connection timed out and the read fell back to the launched app, but a step in this flow left it (e.g. a tap that opened another app), so reading its hierarchy would describe a screen that is not on screen. Transitional states are NOT refused here: an \`inactive\` app, or one still holding a foreground scene, is read as usual. If this flow's subject IS another app, give the flow a \`launch:\` step for that app; otherwise make the flow return to ${target.bundleId} before reading the UI, or \`launch\` it again.`,
          {
            error_code: FAILURE_CODES.NATIVE_TARGET_SINGLE_APP_NOT_FOREGROUND,
            failure_stage: "flow_tree_unpinned_hint",
            failure_area: "tool_server",
            error_kind: "validation",
          },
          err instanceof Error ? { cause: err } : undefined
        );
      }
      resolved = { bundleId: target.bundleId };
    }
    bundleId = resolved.bundleId;
    // Only a disconnect race reaches this. `resolveNativeTargetApp(api,
    // undefined)` returns ids from `listConnectedBundleIds()`, so an id missing
    // from that same live map means the socket dropped after the resolve. The
    // app was instrumented, so the "launched before argent's instrumentation
    // loaded" diagnosis of an explicitly-named bundle is wrong here.
    if (!nativeApi.listConnectedBundleIds().includes(bundleId)) {
      throw new Error(
        `${bundleId} answered the target probe and then dropped its native-devtools ` +
          `connection before the view hierarchy could be read. It was instrumented, so a retry may ` +
          `ride this out; if the connection does not come back, relaunch with restart-app (or a ` +
          `flow \`launch\` step) — launch-app would only foreground the process that just lost it.`
      );
    }
  }

  const rawResult = (await nativeApi.queryViewHierarchy(
    bundleId,
    "ViewHierarchy.getFullHierarchy",
    {
      fields: FULL_HIERARCHY_FIELDS,
      maxDepth: FLOW_TREE_MAX_DEPTH,
    }
  )) as { windows?: unknown[]; error?: string };

  if (rawResult.error) {
    throw new Error(`getFullHierarchy failed for ${bundleId}: ${rawResult.error}`);
  }

  // No windows is an untrustworthy read (the app is backgrounded, or its first
  // window has not attached yet), not a blank screen — and an empty tree is the
  // one thing a `hidden`/absent check accepts, so trusting it would false-pass.
  // Key on raw windows, not flattened children: windows-but-no-leaves is a
  // genuinely sparse, trusted screen.
  if (!Array.isArray(rawResult.windows) || rawResult.windows.length === 0) {
    throw new Error(
      `getFullHierarchy returned no windows for ${bundleId} - it has no window attached to read ` +
        `(backgrounded, or its first window not attached yet), so flows cannot resolve selectors ` +
        `against its view hierarchy; foreground or relaunch it, and if that bundle id is a ` +
        `com.apple.* system process the read resolved to a background system app rather than the ` +
        `app under test, so give this flow a \`launch\` step to pin reads to the right app`
    );
  }

  const { tree, screen } = adaptFullHierarchy(rawResult);
  return { tree, source: "native-devtools", ...(screen ? { screen } : {}) };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Why auto-targeting could not pick an app to read, in terms a flow can act on.
 *
 * `resolveNativeTargetApp` asks the caller to provide a bundleId, which a flow
 * selector step cannot do: the unpinned read hardcodes auto-targeting. Each
 * branch replaces that advice with a remedy for its own failure. If apps are
 * connected but none is uniquely frontmost, the remedy is to foreground the
 * intended one, not to relaunch instrumentation it already has. Only "no
 * connected app" means the target started outside Argent (Metro/Expo, Xcode, or
 * its home-screen icon) and needs an Argent relaunch.
 *
 * Returns the error to throw rather than throwing, so each call site reads as
 * the `throw` it is.
 */
async function explainTargetingFailure(
  err: unknown,
  nativeApi: NativeDevtoolsApi,
  device: DeviceInfo
): Promise<Error> {
  const failureCode = getFailureSignal(err)?.error_code;
  if (failureCode === FAILURE_CODES.NATIVE_TARGET_MULTIPLE_APPS_AMBIGUOUS) {
    const terminate = await terminateCommand(device);
    // The reason does not offer to background the other apps. They stay
    // connected, so the set stays ambiguous, and iOS then suspends one until it
    // no longer answers the state probe. That turns this failure into the
    // harder indeterminate one below.
    return wrapPreservingFailure(
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
    // The one connected app answered the state probe, so it is instrumented and
    // not suspended. It is either just backgrounded, or it keeps running in the
    // background (audio, location, VoIP). A permission dialog does not land
    // here: the app keeps a foreground-inactive scene and resolves normally.
    // Foregrounding fixes the read, so the relaunch advice below would
    // misdiagnose this state. Keep resolveNativeTargetApp's per-app
    // applicationState diagnostic.
    return wrapPreservingFailure(
      `the only native-devtools-connected app is not foreground, so it cannot be auto-targeted:\n` +
        `${withoutExplicitBundleIdAdvice(errMsg(err))}\n` +
        `Flow selector steps auto-target and cannot provide a bundleId. Bring that app to the ` +
        `foreground with launch-app (it does not terminate — the app is already instrumented, ` +
        `just not frontmost), then retry.`,
      err
    );
  }
  // No verdict at all: resolveNativeTargetApp probes applicationState for every
  // connected app in one Promise.all, so one stale connection rejects the whole
  // read. iOS suspends a backgrounded app after about a second, and a suspended
  // app stops answering. The connections are still live, so the relaunch advice
  // below does not apply: a relaunch discards the state the flow built up, and
  // cannot help when another app is the stale one.
  const stillConnected = nativeApi.listConnectedBundleIds();
  if (stillConnected.length > 0) {
    // Say this only when another connection exists to clear, and name a command
    // that exists: argent has no terminate tool, and restart-app would bring the
    // other app to the front.
    const clearOthers =
      stillConnected.length > 1
        ? ` To clear the others use \`${await terminateCommand(device)}\` — argent ` +
          `exposes no terminate tool, and restart-app would bring that app to the front instead.`
        : ``;
    return wrapPreservingFailure(
      `could not read the state of the native-devtools-connected apps, so none could be ` +
        `auto-targeted (${firstClause(err)}). Connected: ${cappedList(stillConnected)}. ` +
        `They are instrumented — do not relaunch. A suspended app stops answering: foreground ` +
        `the app the flow drives with launch-app (it does not terminate), then retry.` +
        clearOthers,
      err
    );
  }
  // Kept short: every failed selector read repeats this reason verbatim, and the
  // recorder repeats it once per captured tap.
  return wrapPreservingFailure(
    `no app is connected to native devtools, so flow selectors have no instrumented process to ` +
      `read the view hierarchy from (${firstClause(err)}). Relaunch with restart-app (or a flow ` +
      `\`launch\` step): launch-app does not terminate, so on an app already running from ` +
      `Metro/Expo, Xcode, or its icon it only foregrounds that uninstrumented process. ` +
      // "feature tools", not "the native-* tools": only the six that run the
      // throwing 3-arg precheck refuse a com.apple.* bundle.
      // native-devtools-status runs the 2-arg form and reports injectable:false,
      // and the native-profiler-* tools do not precheck. The broader claim would
      // hide the one tool that confirms this state.
      `Argent treats an Apple system app (com.apple.*) as non-injectable — the native-devtools ` +
      `feature tools refuse it too — so if one never connects, drive it with raw point taps ` +
      `and tool: await-ui-element steps.`,
    err
  );
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
 *
 * Call this only from a branch that interpolates the result. With additional
 * sets configured, a default-set UDID matches none of them, so `deviceSetForUdid`
 * caches nothing and re-runs the whole `simctl list devices` sweep on every
 * call - seconds, and a failing `await:` rebuilds its reason once per poll.
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
 * Ceiling every reason thrown from {@link queryFullHierarchyTree}'s auto-target
 * path must fit, enforced by `keeps every targeting reason short enough to
 * repeat per step`.
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

// Strip resolveNativeTargetApp's trailing "Provide bundleId explicitly…" line: a
// flow selector step hardcodes auto-targeting and cannot act on it. Match the
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
