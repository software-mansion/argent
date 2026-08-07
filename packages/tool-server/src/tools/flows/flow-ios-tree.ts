import {
  FAILURE_CODES,
  FailureError,
  getFailureSignal,
  type DeviceInfo,
  type Registry,
} from "@argent/registry";
import { nativeDevtoolsRef, type NativeDevtoolsApi } from "../../blueprints/native-devtools";
import {
  resolveNativeTargetApp,
  type ResolvedNativeTargetApp,
} from "../../utils/native-target-app";
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
 * Depth ceiling for the flow selector tree. This counts RAW UIView nesting, so
 * it has to clear the invisible wrapper layers RN stacks on every screen —
 * nested navigators (RNSScreenStackView → RNSScreenView, often two deep) plus a
 * drawer/root wrapper routinely bury on-screen content 40–60 levels down before
 * the first tappable view. At 40, plainly visible interactive elements in a
 * deeply nested production RN app were truncated at depths 41–62, so `id:` and
 * `text:` selectors silently failed to resolve and only coordinate taps worked.
 * Because an overflow is silent (nothing reports "truncated" — selectors just
 * stop matching), the cap carries generous headroom rather than hugging the
 * deepest observed measurement.
 *
 * Cost note: the tree itself is never returned — `selectorToFrame` /
 * `evaluateCondition` consume it — so no tool RESULT carries it. Text derived
 * from it does reach the agent though, and one such path grows with this cap:
 * `assertReason`'s `text` arm (flow-actions.ts) quotes `assertText(first)`,
 * i.e. the matched node's hoisted `subtreeText` — every on-screen descendant's
 * text up to the next identified node — verbatim into a failing `assert`/`await`
 * reason, and nothing truncates it on the way out. Descendants a depth-40 read
 * truncated away now hoist, so the quoted string grows with the cap: measured
 * on a `testID`'d collection view with 60 mounted rows, one failing
 * `assert { text }` came back at 87 chars under a device cap of 40 and 466
 * under 100 (686 with no scroll container to clip the hoist). That is the
 * trade this cap accepts, and it is worth it — under the old cap those
 * selectors did not resolve AT ALL. `compatibilityMissNote` is NOT this path:
 * it short-circuits on its first hit and quotes exactly one candidate, so it
 * does not grow with the tree.
 *
 * Otherwise the cap only grows the getFullHierarchy payload over the
 * native-devtools socket, which is field-limited (`FULL_HIERARCHY_FIELDS`). In
 * the measured production tree, depth-40 was ~11KB and depth-48 ~15KB; past the
 * tree's real depth a higher cap adds nothing at all, so 100 stays modest.
 */
const FLOW_TREE_MAX_DEPTH = 100;

/**
 * Query the raw UIView tree via native-devtools `getFullHierarchy` and adapt
 * it. Throws — with the reason — when native-devtools is unavailable / not yet
 * connected / errored, or when the resolved target returns no windows (a
 * non-injectable or backgrounded app): flows never degrade to the AX tree (see
 * `fetchFlowTree`), so the caller's retry loop either rides out a transient
 * failure or surfaces this message as the step's failure reason.
 */
export async function queryFullHierarchyTree(
  registry: Registry,
  device: DeviceInfo
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
  // resolveNativeTargetApp's own errors suggest providing a bundleId — a flow
  // selector step has no way to express one (this call hardcodes
  // auto-targeting) — so replace that advice with the remedy available for the
  // specific failure. When apps ARE connected but none is uniquely frontmost
  // (ambiguous set, or a lone backgrounded app) the remedy is to foreground the
  // intended one, NOT to relaunch it for instrumentation it already has. Only
  // "no connected app" means the target was launched outside Argent (Metro/Expo,
  // Xcode, or the home-screen icon) and needs an Argent relaunch.
  let target: ResolvedNativeTargetApp;
  try {
    target = await resolveNativeTargetApp(nativeApi, undefined);
  } catch (err) {
    const failureCode = getFailureSignal(err)?.error_code;
    if (failureCode === FAILURE_CODES.NATIVE_TARGET_MULTIPLE_APPS_AMBIGUOUS) {
      // Backgrounding the others is deliberately NOT offered: it leaves them
      // connected, so the set stays ambiguous, and once iOS suspends one it
      // stops answering the state probe entirely — turning this failure into
      // the harder indeterminate one below. That rationale lives here rather
      // than in the reason, which is repeated per step.
      throw wrapPreservingFailure(
        // The header stays short because the embedded diagnostic's own first
        // line already says the set is ambiguous; repeating it cost 90 chars of
        // a budget the per-app entries need.
        `could not target an app to read the view hierarchy from:\n` +
          `${cappedAppDiagnostic(withoutExplicitBundleIdAdvice(errMsg(err)))}\n` +
          `Flow selectors auto-target and cannot name a bundleId. Foreground the intended app with ` +
          `launch-app (it does not terminate), then retry; clear the others with ` +
          `\`xcrun simctl terminate <udid> <bundleId>\` (argent has no terminate tool, and ` +
          `restart-app would just bring that app back to the front).`,
        err
      );
    }
    if (failureCode === FAILURE_CODES.NATIVE_TARGET_SINGLE_APP_NOT_FOREGROUND) {
      // The lone connected app is already instrumented; it is just not
      // foreground-like. Reaching this verdict means the app ANSWERED the state
      // probe, so it is not merely suspended (that path rejects the probe and
      // is handled below): the window is a just-backgrounded app before iOS
      // suspends it, or one that keeps running in the background (audio,
      // location, VoIP) and so keeps answering. A permission dialog does NOT
      // land here — the app stays inactive with a foreground-inactive scene,
      // which resolves normally. Foregrounding fixes the read, so the generic
      // relaunch-for-instrumentation advice below would misdiagnose the state.
      // Keep resolveNativeTargetApp's per-app applicationState diagnostic.
      throw wrapPreservingFailure(
        `the only native-devtools-connected app is not foreground, so it cannot be auto-targeted:\n` +
          `${withoutExplicitBundleIdAdvice(errMsg(err))}\n` +
          `Flow selector steps auto-target and cannot provide a bundleId. Bring that app to the ` +
          `foreground with launch-app (it does not terminate — the app is already instrumented, ` +
          `just not frontmost), then retry.`,
        err
      );
    }
    // Neither verdict — the applicationState probe resolveNativeTargetApp runs
    // over EVERY connected app failed, so it reached no verdict at all. iOS
    // suspends a backgrounded app within about a second and a suspended app
    // stops answering that probe, so one stale connection rejects the whole
    // read (the probe is a single Promise.all). That is not the "nothing is
    // instrumented" state the relaunch advice below describes: the connections
    // are live. Relaunching discards whatever state the flow built up, and when
    // the unresponsive connection belongs to a DIFFERENT app than the one being
    // driven, relaunching the target cannot fix the read at all.
    const stillConnected = nativeApi.listConnectedBundleIds();
    if (stillConnected.length > 0) {
      throw wrapPreservingFailure(
        `could not read the state of the native-devtools-connected apps, so none could be ` +
          `auto-targeted (${firstClause(err)}). Connected: ${cappedList(stillConnected)}. ` +
          `They are instrumented — do not relaunch. A suspended app stops answering: foreground ` +
          `the app the flow drives with launch-app (it does not terminate), then retry.` +
          // Only worth saying when there IS another connection to clear, and it
          // has to name a command that exists: argent exposes no terminate tool,
          // and restart-app on the other app would make it frontmost instead.
          (stillConnected.length > 1
            ? ` To clear the others use \`xcrun simctl terminate <udid> <bundleId>\` — argent ` +
              `exposes no terminate tool, and restart-app would bring that app to the front instead.`
            : ``),
        err
      );
    }
    // Kept short on purpose: every selector read that fails repeats this reason
    // verbatim, and the recorder repeats it once per captured tap.
    throw wrapPreservingFailure(
      `no app is connected to native devtools, so flow selectors have no instrumented process to ` +
        `read the view hierarchy from (${firstClause(err)}). Relaunch with restart-app (or a flow ` +
        `\`launch\` step): launch-app does not terminate, so on an app already running from ` +
        `Metro/Expo, Xcode, or its icon it only foregrounds that uninstrumented process. ` +
        // "the native-devtools FEATURE tools", not "the native-* tools": only
        // the six that run the throwing 3-arg precheck refuse a com.apple.*
        // bundle. native-devtools-status runs the 2-arg form and reports
        // injectable:false instead, and the native-profiler-* tools do not
        // precheck at all — so the broader claim would send an agent away from
        // the one native-* tool that can confirm this state.
        `Argent treats an Apple system app (com.apple.*) as non-injectable — the native-devtools ` +
        `feature tools refuse it too — so if one never connects, drive it with raw point taps ` +
        `and tool: await-ui-element steps.`,
      err
    );
  }

  // Reachable only through a disconnect race. The target came from
  // `resolveNativeTargetApp(api, undefined)`, which returns ids out of
  // `listConnectedBundleIds()`, and `requiresAppRestart` answers false for
  // anything in `connections` — so getting `true` here means the socket dropped
  // between the resolve and this call. The app therefore WAS instrumented, and
  // the "launched before argent's instrumentation loaded" diagnosis that fits
  // an explicitly-named bundle is exactly wrong for this one.
  if (await nativeApi.requiresAppRestart(target.bundleId)) {
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

// The first SENTENCE of a diagnostic's first line — the part that names what
// went wrong, without the remedy paragraph each source appends for its own
// callers. A sentence ends at a period followed by whitespace (or the end of
// the line): every message that reaches here carries a dotted identifier
// (`Application.getState`, `bundleId: com.acme.app`), and keying on the bare
// period chopped mid-identifier, leaving `RPC timed out: Application.`.
// A line with no sentence break is already the clause — return it whole.
function firstClause(err: unknown): string {
  const firstLine = errMsg(err).split("\n", 1)[0];
  const sentenceEnd = /\.(?=\s|$)/.exec(firstLine);
  return sentenceEnd === null ? firstLine : firstLine.slice(0, sentenceEnd.index + 1);
}

/**
 * How many connected apps any targeting reason may enumerate.
 *
 * Two of these reasons embed a per-app list — the ambiguous branch keeps
 * `resolveNativeTargetApp`'s per-app `applicationState` diagnostic (~110 chars
 * a line) and the indeterminate branch names every live connection — so
 * without a cap the reason grows with the connected-app count: measured at 778
 * chars for 2 apps, 1000 for 4 and 1444 for 8. That is the wrong thing to let
 * grow. `captureTapSelector`'s catch embeds the whole reason in the warning for
 * every recorded tap, and a failing `await:` repeats it once per poll, so the
 * cost is paid per step for as long as the screen stays stuck — and the
 * ambiguous state is the most persistent of them, holding until somebody
 * foregrounds or terminates something.
 *
 * Two is enough to act on: the remedy is "foreground the one you want, clear
 * the rest", which does not change with the fourth entry. The count of what was
 * dropped is still reported, so nothing is silently truncated.
 */
const MAX_LISTED_APPS = 2;

/**
 * Ceiling every reason thrown from {@link queryFullHierarchyTree} must fit,
 * enforced by `keeps every targeting reason short enough to repeat per step`.
 *
 * Measured against the RAW message. Callers prefix it before an agent sees it —
 * `waitForCondition` adds "could not read the UI tree: " (27 chars) and a
 * `when:` guard adds "could not evaluate when guard (<label>): " with a
 * caller-supplied label — so this is not the number the agent ends up reading.
 *
 * The ceiling is set by the ambiguous branch, which carries two full per-app
 * `applicationState` diagnostics: that IS the diagnosis on the one branch where
 * the agent has to choose which app to clear, so it is not the thing to cut.
 * What matters is that the figure no longer moves with the connected-app count
 * — see {@link MAX_LISTED_APPS}. Every other branch has well over 100 chars of
 * slack.
 */
export const MAX_TARGETING_REASON_CHARS = 760;

/** Keep the first {@link MAX_LISTED_APPS} entries, and say how many were not shown. */
function cappedList(bundleIds: readonly string[]): string {
  if (bundleIds.length <= MAX_LISTED_APPS) return bundleIds.join(", ");
  const dropped = bundleIds.length - MAX_LISTED_APPS;
  return `${bundleIds.slice(0, MAX_LISTED_APPS).join(", ")} (+${dropped} more)`;
}

/**
 * Cap the per-app lines of an embedded `resolveNativeTargetApp` diagnostic,
 * keeping its leading summary line intact. The entries are its `- <bundleId>
 * (applicationState=…)` lines; anything else is passed through untouched, so a
 * reworded source degrades to "no cap applied" rather than to a mangled
 * message.
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

// Strip resolveNativeTargetApp's trailing "Provide bundleId explicitly…" line —
// a flow selector step hardcodes auto-targeting and cannot act on it. Matching
// the whole line (not just the bare sentence) covers both wordings it emits:
// the ambiguous case ends "Provide bundleId explicitly." and the single-app case
// ends "Provide bundleId explicitly if you still want to target this app.".
function withoutExplicitBundleIdAdvice(message: string): string {
  return message.replace(/\nProvide bundleId explicitly[^\n]*$/, "");
}

/** Add actionable flow-specific context without stripping FailureError data. */
function wrapPreservingFailure(message: string, err: unknown): Error {
  const cause = err instanceof Error ? err : new Error(String(err));
  const signal = getFailureSignal(err);
  return signal ? new FailureError(message, signal, { cause }) : new Error(message, { cause });
}
