import { FAILURE_CODES, FailureError, getFailureSignal } from "@argent/registry";
import type { DeviceInfo, Registry } from "@argent/registry";
import {
  axDaemonCrashSignal,
  axServiceRef,
  axStartFailureDegraded,
  type AXServiceApi,
} from "../../blueprints/ax-service";
import {
  externalClaimForNativeId,
  externalSupportHint,
  isExternalId,
} from "../../utils/external-devices";
import { nodeText } from "../../utils/ui-tree-match";
import { redactTypedSecrets, secretTypedOn, WITHHELD_INPUT_TEXT } from "../../utils/typed-secrets";
import { noteUiOrientation } from "../../utils/ios-ui-orientation";
import { describeIosDevice } from "../describe/platforms/ios-device";
import { tcpArtifactHint } from "../describe/platforms/ios";
import { adaptAxTree } from "../ui-tree/ios";
import type { UiTree, UiTreeNode } from "../ui-tree";
import type { FlowTreeTarget } from "./flow-actions";
import { flattenHoisting, type ClipRect, type FlatNode } from "./flow-tree-flatten";
import {
  type DescribeFrame,
  type DescribeNode,
  type DescribeTreeData,
  parseDescribeResult,
} from "../describe/contract";

/**
 * Flow-owned iOS tree sources (per-platform dispatch: `flow-tree.ts`).
 *
 * Simulators (`queryIosSimulatorFlowTree`): the accessibility tree the
 * ax-service daemon walks — the tree `describe` shows, with the hidden and
 * covered elements describe drops and the unlabelled containers it does not
 * print. Recording and replay therefore read one tree, so a selector copied
 * from `describe` (id, text, role) resolves at replay. Frames are in the UI's
 * upright space, as `describe` frames them (`adaptAxTree`).
 *
 * Physical devices (`queryIosDeviceFlowTree`): the XCUITest runner accessibility
 * snapshot, the same tree `describe` serves, reshaped into the flow contract.
 *
 * Both sources honor the contract `fetchFlowTree` states: a read that isn't
 * the screen THROWS rather than hand back a degraded tree. An empty tree is the
 * one thing a `hidden`/absent check accepts, and `settleTree` fingerprints two
 * identical blind reads as a settled screen, so returning one would flip flow
 * outcomes; see `fetchFlowTree`.
 */

// XCUIElementType names of containers that scroll. `scroll-to` anchors its
// settle on them, and a tap in their padding records as a scroll area.
const SCROLLING_TYPES = new Set(["ScrollView", "Table", "CollectionView", "WebView"]);

/**
 * UIKit's scroll indicator ("Vertical scroll bar, 3 pages"): an adjustable
 * element of no type of its own and no id, in a scrolling container. Nobody
 * taps it or reads it as content, so it is neither a leaf nor hoisted text.
 * An app's own adjustable view with an id (a rating control) stays.
 */
function isScrollIndicator(node: UiTreeNode): boolean {
  return (
    node.type === "Other" &&
    node.traits?.length === 1 &&
    node.traits[0] === "adjustable" &&
    !node.identifier
  );
}

/** A toggle's "0"/"1" is its state, not text the row shows. */
function isToggleState(node: UiTreeNode): boolean {
  return node.checked !== undefined && (node.value === "0" || node.value === "1");
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function roundNormalized(value: number): number {
  return Math.round(value * 1e12) / 1e12;
}

/** The on-screen part of a frame, as describe's adapter clamps it; undefined when nothing is on screen. */
function onScreenFrame(frame: DescribeFrame): DescribeFrame | undefined {
  const x1 = clamp01(frame.x);
  const y1 = clamp01(frame.y);
  const x2 = clamp01(frame.x + frame.width);
  const y2 = clamp01(frame.y + frame.height);
  if (x2 - x1 <= 0 || y2 - y1 <= 0) return undefined;
  return {
    x: roundNormalized(x1),
    y: roundNormalized(y1),
    width: roundNormalized(x2 - x1),
    height: roundNormalized(y2 - y1),
  };
}

/**
 * Project one accessibility node for the shared flatten (see
 * `flow-tree-flatten`). A scroller's indicators are dropped; covered subtrees
 * are left to {@link adaptIosUiTreeForFlows}. What a scrolling
 * container has scrolled out of its frame is pruned by the flatten's scroll
 * clip (`rect` + `scrolls`). Only scrolling ancestors clip: a UIKit stack view
 * reports a frame smaller than its children, so clipping by every framed
 * ancestor (the tree's `hidden`) would drop buttons describe shows. A leaf is emitted for every node
 * describe would print — an id, a label, a value, a non-group role, input
 * focus — and for a scrolling container. An identifier shields hoisted text
 * to the nearest identified ancestor; a password never contributes its value.
 *
 * With `quoted` the node is projected as a result may quote it, on a device a
 * secret was typed on (see `utils/typed-secrets`): a text input's value is the
 * note that it is withheld, since the field can hold the secret in a form no
 * typed value matches (capitalized, corrected, formatted), and every other
 * label and value is what `quoted` makes of it. Which nodes become leaves does
 * not depend on either text, so the two projections of one tree give the same
 * nodes in the same order.
 */
function projectAxNode(node: UiTreeNode, quoted?: (text: string) => string): FlatNode<UiTreeNode> {
  const frame = node.frame && onScreenFrame(node.frame);
  const scrollable = node.type !== undefined && SCROLLING_TYPES.has(node.type);
  const addressable =
    scrollable ||
    Boolean(node.identifier || node.label || node.value || node.placeholder || node.focused) ||
    node.role !== "AXGroup";
  // An empty input reports its placeholder as its value, as `describe` prints it.
  const read = node.value ?? (node.hintShowing ? node.placeholder : undefined);
  const value =
    quoted && read !== undefined ? (node.editable ? WITHHELD_INPUT_TEXT : quoted(read)) : read;
  const label = quoted && node.label !== undefined ? quoted(node.label) : node.label;
  let leaf: DescribeNode | null = null;
  if (frame && addressable) {
    leaf = {
      role: node.role,
      frame,
      children: [],
      ...(label !== undefined ? { label } : {}),
      // A secure field's placeholder is not its secret.
      ...(value !== undefined && (!node.password || node.hintShowing) ? { value } : {}),
      // The text a filled field holds names no element (see `resolveSelector`).
      // `node.value` is unset while the field shows its placeholder.
      ...(node.editable && node.value !== undefined && !node.password ? { typedValue: true } : {}),
      ...(node.identifier !== undefined ? { identifier: node.identifier } : {}),
      ...(node.focused ? { focused: true } : {}),
      ...(node.disabled ? { disabled: true } : {}),
      ...(node.selected ? { selected: true } : {}),
      ...(node.password ? { password: true } : {}),
      ...(node.checked !== undefined ? { checked: node.checked } : {}),
      ...(scrollable ? { scrollable: true } : {}),
    };
  }
  return {
    skip: false,
    children: scrollable ? node.children.filter((c) => !isScrollIndicator(c)) : node.children,
    // Off-screen text must not hoist: a `text` assert guards what the screen shows.
    ownText: leaf ? nodeText(isToggleState(node) ? { ...leaf, value: undefined } : leaf) : "",
    leaf,
    shield: Boolean(node.identifier) || node.password === true,
    // Scroll-clip inputs, unclamped and in the tree's normalized space.
    rect: node.frame && {
      x: node.frame.x,
      y: node.frame.y,
      w: node.frame.width,
      h: node.frame.height,
    },
    scrolls: scrollable,
  };
}

/**
 * Whether a window of an app (a child of its root) is the on-screen keyboard:
 * it holds an element of type Keyboard. The whole window is keyboard, not only
 * that element's subtree: the prediction bar, the globe and dictation keys,
 * the iPad's undo/redo/Paste bar and the emoji search field sit beside it.
 * A Keyboard element that is itself the root's child holds itself. The
 * window with the app's input accessory and edit menu holds none.
 */
export function holdsKeyboard(node: UiTreeNode): boolean {
  return node.type === "Keyboard" || node.children.some(holdsKeyboard);
}

const SKIPPED: FlatNode<UiTreeNode> = {
  skip: true,
  children: [],
  ownText: "",
  leaf: null,
  shield: false,
};

/** Flatten one window of an app into `out`, marking every leaf of a keyboard window. */
function flattenWindow(
  window: UiTreeNode,
  project: (node: UiTreeNode, clip: ClipRect | null) => FlatNode<UiTreeNode>,
  out: DescribeNode[]
): void {
  const first = out.length;
  flattenHoisting(window, project, out);
  if (holdsKeyboard(window)) {
    for (let i = first; i < out.length; i++) out[i]!.keyboard = true;
  }
}

/**
 * Flatten the accessibility tree into the flow contract: flat leaves under one
 * synthetic root, descendant text hoisted onto container leaves. Each app root
 * (the daemon lists the system app first while an alert shows) contributes its
 * children; the Application nodes themselves are not leaves. Every leaf of a
 * keyboard window ({@link holdsKeyboard}) is marked `keyboard`. `quoted` builds
 * the projection a result may quote (see {@link projectAxNode}).
 *
 * What an alert, sheet or popover covers (`covered`, and the app below a
 * system alert, whose root is `covered`) is not in the tree, as describe drops
 * it. With `coveredOut`, its leaves go there instead, flattened as they would
 * be in place (the same projection, the same scroll clip), so a miss can tell
 * a covered target from an absent one. Their text never hoists onto an
 * uncovered container, so the tree is the same with or without `coveredOut`.
 */
export function adaptIosUiTreeForFlows(
  tree: UiTree,
  quoted?: (text: string) => string,
  coveredOut?: DescribeNode[]
): DescribeNode {
  const children: DescribeNode[] = [];
  const keep = (node: UiTreeNode): FlatNode<UiTreeNode> => projectAxNode(node, quoted);
  const project = (node: UiTreeNode, clip: ClipRect | null): FlatNode<UiTreeNode> => {
    if (!node.covered) return keep(node);
    if (coveredOut) flattenHoisting(node, keep, coveredOut, clip);
    return SKIPPED;
  };
  for (const root of tree.roots) {
    if (root.covered) {
      if (coveredOut) for (const window of root.children) flattenWindow(window, keep, coveredOut);
      continue;
    }
    for (const window of root.children) flattenWindow(window, project, children);
  }
  return parseDescribeResult({
    role: "AXGroup",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children,
  });
}

const UPDATE_REMEDY =
  "The accessibility service bundled with this argent is too old for e2e tests: update argent " +
  "(the `update-argent` tool or `npm i -g @swmansion/argent@latest`), then run " +
  "`argent server stop` so the new service starts.";

const BOOT_REMEDY =
  "Boot the simulator with `boot-device` (`force: true` when it is already booted), then " +
  "run the e2e test again.";

// A crash says nothing about how the simulator was booted, and on a host where
// the service crashes every time, a reboot or a tool-server restart starts the
// same binary into the same crash (see `axCrashHint` in describe).
const CRASH_REMEDY =
  "Every read starts the accessibility service again, so run the e2e test again. If it " +
  "crashes again, the crash is in the service on this host: rebooting the simulator or " +
  "restarting the tool-server starts the same binary and does not fix it.";

// A daemon that stopped is torn down by the registry, and the next read starts
// a new one, so a reboot is not the fix. For the stop to reach a reason, the
// reads failed until the end of the window, hence the exit.
const DAEMON_STOPPED_REMEDY =
  "The accessibility service stopped. Argent starts it again at the next read: run the e2e " +
  "test again. If it stops again, report the error.";

// A start that failed with the settings verified: `describe` does not
// prescribe a reboot there either (see `axStartFailureDegraded`).
const START_FAILED_REMEDY =
  "The accessibility service did not start, although this simulator's pre-boot accessibility " +
  "settings are in place, so a reboot does not fix it: run the e2e test again, and if it fails " +
  "the same way, report the error.";

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A tree source too old for flows: the launch gate reports it without waiting. */
function unsupportedTree(message: string): FailureError {
  return new FailureError(message, {
    error_code: FAILURE_CODES.AX_TREE_UNSUPPORTED,
    failure_stage: "flow_tree_read",
    failure_area: "tool_server",
    error_kind: "unknown",
  });
}

/**
 * The provider that owns the device, named as `boot-device` names it when it
 * refuses to boot one; undefined on a simulator argent owns.
 */
function providerHint(device: DeviceInfo): string | undefined {
  if (isExternalId(device.id)) {
    return externalSupportHint(device.id) ?? "This device is supplied by an external provider.";
  }
  const claim = externalClaimForNativeId(device.id);
  return claim ? `This device is supplied by ${claim.provider.name}.` : undefined;
}

/** The reboot remedy, which `boot-device` refuses on a provider's device. */
function rebootRemedy(device: DeviceInfo): string {
  const provider = providerHint(device);
  return provider === undefined
    ? BOOT_REMEDY
    : `${provider} Argent cannot reboot this device: restart it from that application, then ` +
        `run the e2e test again.`;
}

/** The daemon stopped after it started (not a start that failed), so the next read starts it again. */
function daemonStopped(err: unknown, code: string | undefined): boolean {
  return (
    code === FAILURE_CODES.AX_DAEMON_PROCESS_ERROR ||
    code === FAILURE_CODES.REGISTRY_SERVICE_TERMINATING ||
    // Its code, AX_QUERY_FAILED, is also the daemon's own RPC error.
    errMsg(err) === "ax-service not connected"
  );
}

/** The reason a tree read failed, followed by what to do about it. */
function treeUnavailable(device: DeviceInfo, err: unknown): Error {
  const code = getFailureSignal(err)?.error_code;
  if (code === FAILURE_CODES.AX_TREE_UNSUPPORTED) {
    return unsupportedTree(
      `the accessibility tree of ${device.id} cannot be read: ${errMsg(err)}. ${UPDATE_REMEDY}`
    );
  }
  // Some errors end with a period of their own.
  const unreadable = `the accessibility tree of ${device.id} could not be read: ${errMsg(err).replace(/\.$/, "")}.`;
  // Errors that already name their cause and remedy: the provider did not
  // grant ax-service or withdrew the device, or a TCP artifact is not built.
  if (
    code === FAILURE_CODES.EXTERNAL_DEVICE_CAPABILITY_DENIED ||
    code === FAILURE_CODES.EXTERNAL_DEVICE_UNAVAILABLE ||
    tcpArtifactHint(err) !== undefined
  ) {
    return new Error(unreadable);
  }
  // Defined only for a start that failed, which can carry a process error too.
  const startDegraded = axStartFailureDegraded(err);
  // A crash also stops the daemon, so it goes first.
  const remedy =
    axDaemonCrashSignal(err) !== undefined
      ? CRASH_REMEDY
      : startDegraded === undefined && daemonStopped(err, code)
        ? DAEMON_STOPPED_REMEDY
        : startDegraded === false
          ? START_FAILED_REMEDY
          : code === FAILURE_CODES.AX_QUERY_TIMEOUT
            ? "The screen took too long to read: wait for the app to settle, or scroll a long list or " +
              "web page out of view, then run the e2e test again."
            : rebootRemedy(device);
  return new Error(`${unreadable} ${remedy}`);
}

/**
 * Added where a read that is `degraded` names no foreground app: without the
 * pre-boot accessibility settings, a system dialog can hide the app from the
 * tree (iOS 26.5 and later). The sentence says "can": the dialog does not hide
 * it on every boot, and the read cannot tell.
 */
export function degradedNoAppHint(device: DeviceInfo): string {
  const provider = providerHint(device);
  return provider === undefined
    ? "Argent could not verify this simulator's pre-boot accessibility settings, so a system " +
        "dialog on the screen can hide the app from the tree. If a dialog is on the screen, boot " +
        "the simulator with `boot-device` (`force: true`), then run the e2e test again."
    : `${provider} Argent could not verify its pre-boot accessibility settings, so a system ` +
        "dialog on the screen can hide the app from the tree. Argent cannot reboot this device: " +
        "restart it from that application.";
}

/**
 * One read of the simulator's accessibility tree, as `ui-tree` adapts it. Every
 * failure is rethrown with a remedy: an accessibility service too old for
 * flows (`AX_TREE_UNSUPPORTED`, also when it serves a tree without
 * `foregroundApp` or `interfaceOrientation`), a simulator the service cannot
 * reach, a read that timed out. Flows on a simulator have no other tree source.
 */
export async function readIosSimulatorUiTree(
  registry: Registry,
  device: DeviceInfo
): Promise<UiTree & { degraded: boolean }> {
  const ref = axServiceRef(device);
  let ax: AXServiceApi;
  let tree: UiTree;
  try {
    ax = await registry.resolveService<AXServiceApi>(ref.urn, ref.options);
    const response = await ax.tree();
    // As `readIosUiTree` does: the next touch need not ask for the orientation.
    noteUiOrientation(device.id, response.interfaceOrientation, response.screenFrame);
    tree = adaptAxTree(response);
  } catch (err) {
    throw treeUnavailable(device, err);
  }
  if (
    tree.unsupportedFields.includes("foregroundApp") ||
    tree.unsupportedFields.includes("interfaceOrientation")
  ) {
    throw unsupportedTree(
      `the accessibility tree of ${device.id} names no foreground app or interface ` +
        `orientation. ${UPDATE_REMEDY}`
    );
  }
  return { ...tree, degraded: ax.degraded };
}

/**
 * Simulator flow tree from the ax-service accessibility tree. Throws, with a
 * remedy, when the tree cannot be read, when a pinned launch's app is no
 * longer in the foreground (it crashed, or a tap opened another app), and on a
 * blind read: an app serving no accessible elements must not settle or satisfy
 * `hidden`. A walk the service cut short is returned flagged `truncated`.
 */
export async function queryIosSimulatorFlowTree(
  registry: Registry,
  device: DeviceInfo,
  target?: FlowTreeTarget
): Promise<DescribeTreeData> {
  const tree = await readIosSimulatorUiTree(registry, device);
  if (target?.pinned && tree.foregroundApp !== target.bundleId) {
    const hidden =
      tree.degraded && tree.foregroundApp === undefined ? ` ${degradedNoAppHint(device)}` : "";
    throw new Error(
      `${target.bundleId} is not the foreground app on ${device.id} ` +
        `(${tree.foregroundApp ? `${tree.foregroundApp} is` : "no app is"}). ` +
        `It may have crashed or opened another app. If the e2e test meant to leave it, switch apps ` +
        `with a \`tool: launch-app\` step first (a \`launch:\` step restarts the app).${hidden}`
    );
  }
  if (tree.roots.every((root) => root.children.length === 0)) {
    throw new Error(
      tree.degraded
        ? `the accessibility tree of ${device.id} is empty: argent could not verify the ` +
            `simulator's pre-boot accessibility settings, and without them its accessibility ` +
            `service cannot see the app. ${rebootRemedy(device)}`
        : `the accessibility tree of ${device.id} is empty: the foreground app ` +
            `(${tree.foregroundApp ?? "unknown"}) exposes no accessible elements. Wait for it to ` +
            `draw, or relaunch it with \`restart-app\`, then run the e2e test again.`
    );
  }
  // A field can hold a typed secret in a form no value matches, so once a
  // secret was typed on the device a quote reads a second projection, in which
  // that text is never present (see `utils/typed-secrets`).
  const quotableTree = secretTypedOn(device.id)
    ? adaptIosUiTreeForFlows(tree, (text) => redactTypedSecrets(device.id, text))
    : undefined;
  const covered: DescribeNode[] = [];
  const flowTree = adaptIosUiTreeForFlows(tree, undefined, covered);
  return {
    tree: flowTree,
    ...(quotableTree ? { quotableTree } : {}),
    ...(covered.length > 0
      ? {
          cover: {
            kind: "covered",
            leaves: parseDescribeResult({
              role: "AXGroup",
              frame: { x: 0, y: 0, width: 1, height: 1 },
              children: covered,
            }).children,
            systemAlert: tree.alertVisible === true,
          },
        }
      : {}),
    source: "ax-service",
    screen: tree.screen,
    ...(tree.truncated ? { truncated: true } : {}),
  };
}

/**
 * Project a runner node for the shared flatten (see `flow-tree-flatten`).
 */
function projectIosDeviceNode(node: DescribeNode): FlatNode<DescribeNode> {
  const onScreen = node.frame.width > 0 && node.frame.height > 0;
  return {
    skip: false,
    children: node.children,
    // Off-screen text must not hoist.
    ownText: onScreen ? nodeText(node) : "",
    leaf: { ...node, children: [] },
    shield: Boolean(node.identifier),
    // Scroll-clip inputs (see `flattenHoisting`), in the adapter's normalized
    // space. The runner drops only what lies outside the Application frame: a
    // row scrolled out of a nested ScrollView whose own frame is still on
    // screen arrives with its raw frame, so the scroller's frame must clip its
    // subtree exactly as the simulator and Android projections do.
    rect: { x: node.frame.x, y: node.frame.y, w: node.frame.width, h: node.frame.height },
    scrolls: node.scrollable === true,
  };
}

/**
 * Flatten the runner tree into the flow contract (flat leaves, hoisted text).
 */
function adaptIosDeviceTreeForFlows(tree: DescribeNode): DescribeNode {
  const children: DescribeNode[] = [];
  // Children only, never the Application root.
  for (const child of tree.children) {
    flattenHoisting(child, projectIosDeviceNode, children);
  }
  return parseDescribeResult({
    role: tree.role,
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children,
  });
}

/**
 * Physical-device flow tree from the XCUITest runner snapshot, with the nodes
 * of the keyboard's window marked `keyboard` (the runner keeps that boundary;
 * see `holdsKeyboard` in its snapshot code).
 * Throws on a blind read: an empty tree must not settle or satisfy hidden.
 * A snapshot the runner cut at its node budget comes flagged `truncated` (see
 * `describeIosDevice`).
 */
export async function queryIosDeviceFlowTree(
  registry: Registry,
  device: DeviceInfo
): Promise<DescribeTreeData> {
  const data = await describeIosDevice(registry, device, { markKeyboard: true });
  // Empty children plus a hint is the describe blind-read shape. A quality
  // hint on a non-empty tree still has nodes.
  if (data.tree.children.length === 0 && data.hint) {
    throw new Error(
      `${data.hint} E2E tests resolve selectors against this runner tree, so the step fails ` +
        `rather than treating the unreadable screen as empty.`
    );
  }
  return { ...data, tree: adaptIosDeviceTreeForFlows(data.tree) };
}
