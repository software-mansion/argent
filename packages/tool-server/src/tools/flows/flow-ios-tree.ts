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

// The class name a suffix test can read. Swift classes arrive mangled
// (NSStringFromClass), and a GENERIC one carries its type arguments AFTER the
// class name - `_TtGC7SwiftUI19UIHostingScrollViewVS_7AnyView_`, SwiftUI's
// ScrollView backing view - so its suffix is not the view's kind. Module and
// class are `<length><name>` components after the prefix; the second is the
// class. Every other form already ends with the class name, mangled
// (`_TtC7SwiftUI33UpdateCoalescingCollectionView`) or module-qualified
// (`SwiftUI.ListCollectionViewCell`).
function baseClassName(cn: string): string {
  if (!cn.startsWith("_TtGC")) return cn;
  let at = "_TtGC".length;
  let name = "";
  for (let component = 0; component < 2; component++) {
    const len = /^\d+/.exec(cn.slice(at))?.[0];
    if (!len) return cn;
    at += len.length;
    name = cn.slice(at, at + Number(len));
    at += Number(len);
  }
  return name;
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
  // UIKit class names are suffix-typed, so the tail names the kind of view and
  // both tests below key on it rather than on a substring anywhere in the name.
  // A row (`UITableViewCell`, `UICollectionViewCell`) carries a scroller word
  // but does not scroll its content, and the edge-avoid nudge resolves a
  // target's container to the smallest containing scroller - a
  // scrollable-flagged cell would shadow its list. It is not a plain group
  // either: a stock cell - like an app's own `MyPhotoCell` - carries no
  // identifier and no label, so the leaf gate below would drop it and a tap on
  // a row's dead space would resolve to the whole list. A role of its own keeps
  // the row in the tree while staying out of the scroller set, which
  // `isScrollContainer` reads off the role by matching "scroll". Reading `Cell`
  // anywhere in the name would take genuine scrollers down with the rows:
  // `UITableViewCellScrollView` (the swipe-actions scroller UIKit puts under a
  // row) and an app's own `PhotoCellCollectionView`.
  const base = baseClassName(cn);
  if (/Cell$/i.test(base)) return "AXCell";
  if (/(ScrollView|TableView|CollectionView)$/i.test(base)) return "AXScrollArea";
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

  // Nothing nameable, no leaf: a row whose whole subtree is unnamed plain views
  // is absent from the tree, so it carries none of the list's motion into
  // `treeFingerprint` (settle detection, end-of-scroll), and a tap on its dead
  // space resolves to the list instead. Anything nameable in the row covers it -
  // its own testID/label, or a descendant with text or an image, each emitted
  // and moving with the row. A UIKit cell needs none of that: `AXCell` is a
  // specific role (see roleFromClassName), so a stock id-less, label-less row
  // clears this gate on its own terms. The residual is the unnamed React Native
  // or custom row class, which this gate has always dropped.
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
    throw new Error(
      `native devtools is unavailable (${errMsg(err)}) — flows resolve selectors against the full view hierarchy it serves`,
      { cause: err }
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
      if (!timedOut || !target) throw err;
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
      if (!nativeApi.listConnectedBundleIds().includes(target.bundleId)) throw err;
      // The timed-out fan-out proved nothing about what is on screen, so the
      // hint must vouch for itself before taking the read. A probe it cannot
      // answer is nothing to vouch for: the fan-out's own timeout stands.
      let hintState: NativeAppState;
      try {
        hintState = await nativeApi.getAppState(target.bundleId);
      } catch (probeErr) {
        if (getFailureSignal(probeErr)?.error_code === FAILURE_CODES.NATIVE_DEVTOOLS_RPC_TIMEOUT) {
          throw err;
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
  }

  const rawResult = (await nativeApi.queryViewHierarchy(
    bundleId,
    "ViewHierarchy.getFullHierarchy",
    {
      fields: FULL_HIERARCHY_FIELDS,
      maxDepth: 40,
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
