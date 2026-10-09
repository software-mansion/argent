import { z } from "zod";
import { canonicalDeviceId, isLogicalKeyedDevice } from "../../utils/debugger/device-alias";
import * as crypto from "node:crypto";
import type { DeviceInfo, Registry, ToolDefinition } from "@argent/registry";
import { RN_ONLY_TOOL_CAPABILITY } from "./debugger-service-ref";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";
import { nativeDevtoolsRef, type NativeDevtoolsApi } from "../../blueprints/native-devtools";
import { makeComponentTreeScript } from "../../utils/debugger/scripts/component-tree";
import { metroPort, metroPortField } from "../../utils/debugger/metro-port";
import { isIosSimulator, resolveDevice, stripRemotePrefix } from "../../utils/device-info";
import { findIosSimulator, listIosSimulators } from "../../utils/ios-devices";
import { simctlListDevices } from "../../utils/sim-remote";
import { resolveNativeTargetApp } from "../../utils/native-target-app";
import { asUiOrientation, type UiOrientation } from "../describe/contract";
import { uiPointToNative } from "../flows/flow-orientation";

export interface RawEntry {
  id: number;
  name: string;
  rect: { x: number; y: number; w: number; h: number } | null;
  parentIdx: number;
  testID?: string;
  accLabel?: string;
  text?: string;
}

export interface RawResult {
  screenW: number;
  screenH: number;
  components: RawEntry[];
  error?: string;
  totalFibers?: number;
  skippedCounts?: Record<string, number>;
}

function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number }
): boolean {
  return (
    Math.abs(a.x - b.x) < 8 &&
    Math.abs(a.y - b.y) < 8 &&
    Math.abs(a.w - b.w) < 8 &&
    Math.abs(a.h - b.h) < 8
  );
}

/**
 * How the UI lies on the axes the gesture tools take. The layout rects are in
 * the app window's axes. An iOS simulator takes touches on the screen's fixed
 * (portrait-native) axes, and a landscape UI — a rotated device, or an unfolded
 * foldable — is turned on them. `unknown` is an iOS simulator whose orientation
 * could not be read; `ambiguous` a session that two booted simulators of one
 * name could run, with no `udid` to tell them apart; `mismatched` a `udid`
 * that is not the app's simulator, in such a session; absent is a device whose
 * touches use the window's axes.
 */
type TapAxes = UiOrientation | "unknown" | "ambiguous" | "mismatched";

/** What {@link readTapAxes} found, as {@link buildTextTree} takes it. */
interface TapAxesRead {
  uiOrientation?: TapAxes;
  /** The app's simulator, read in place of a `udid` that is another one. */
  readInsteadOfUdid?: string;
  /** Another booted simulator has the app's device name, so the `udid` could not be checked. */
  udidUnchecked?: boolean;
}

export function buildTextTree(
  data: RawResult,
  opts: TapAxesRead & {
    onScreenOnly: boolean;
    maxNodes?: number;
    includeSkipped?: boolean;
  }
): string {
  const { screenW, screenH, components } = data;

  if (components.length === 0) {
    return "No visible components found on screen.";
  }

  const canNormalize = screenW > 0 && screenH > 0;
  const removed = new Set<number>();

  const filterStats = {
    sameNameDedup: { count: 0, names: new Map<string, number>() },
    offScreen: { count: 0 },
    sameTestID: { count: 0 },
    fullScreenWrapper: { count: 0 },
    ancestorText: { count: 0 },
    contentFreeWrapper: { count: 0 },
    soleChildLeaf: { count: 0 },
  };

  // Collapse parent→child when both have the same name and nearly identical rects.
  // Walk up through already-removed parents so chains of 3+ (e.g. ScrollView×3) fully collapse.
  for (const c of components) {
    if (removed.has(c.id)) continue;
    let effectiveParentIdx = c.parentIdx;
    while (effectiveParentIdx >= 0 && removed.has(effectiveParentIdx)) {
      effectiveParentIdx = components[effectiveParentIdx].parentIdx;
    }
    const parent = effectiveParentIdx >= 0 ? components[effectiveParentIdx] : null;
    if (
      parent &&
      parent.name === c.name &&
      parent.rect &&
      c.rect &&
      rectsOverlap(parent.rect, c.rect)
    ) {
      removed.add(c.id);
      filterStats.sameNameDedup.count++;
      filterStats.sameNameDedup.names.set(
        c.name,
        (filterStats.sameNameDedup.names.get(c.name) ?? 0) + 1
      );
    }
  }

  // Prune the whole subtree: children of off-canvas stacks (drawer, hidden tabs)
  // lack rects and would otherwise survive.
  if (canNormalize && opts.onScreenOnly) {
    const tempChildren = new Map<number, number[]>();
    for (const c of components) {
      if (c.parentIdx >= 0) {
        let list = tempChildren.get(c.parentIdx);
        if (!list) {
          list = [];
          tempChildren.set(c.parentIdx, list);
        }
        list.push(c.id);
      }
    }

    function removeSubtree(id: number) {
      removed.add(id);
      filterStats.offScreen.count++;
      const ch = tempChildren.get(id);
      if (ch) for (const cid of ch) removeSubtree(cid);
    }

    for (const c of components) {
      if (removed.has(c.id) || !c.rect) continue;
      const centerY = c.rect.y + c.rect.h / 2;
      const centerX = c.rect.x + c.rect.w / 2;
      if (
        centerY < -screenH * 0.1 ||
        centerY > screenH * 1.05 ||
        centerX < -screenW * 0.05 ||
        centerX > screenW * 1.05
      ) {
        removeSubtree(c.id);
      }
    }

    // Rectless components hanging off an ancestor that was just removed off-screen.
    for (const c of components) {
      if (removed.has(c.id) || c.rect) continue;
      let ancestor = c.parentIdx;
      while (ancestor >= 0 && !components[ancestor].rect) {
        if (removed.has(ancestor)) break;
        ancestor = components[ancestor].parentIdx;
      }
      if (ancestor >= 0 && removed.has(ancestor)) {
        removed.add(c.id);
        filterStats.offScreen.count++;
      }
    }
  }

  // Collapse same-testID chains from prop drilling through HOC layers
  // (ScreenWrapper → ScreenWrapperContainer → View, all [testID=X]); keep the topmost.
  for (const c of components) {
    if (removed.has(c.id) || !c.testID) continue;
    let ancestor = c.parentIdx;
    while (ancestor >= 0) {
      const a = components[ancestor];
      if (!removed.has(a.id) && a.testID === c.testID) {
        removed.add(c.id);
        filterStats.sameTestID.count++;
        break;
      }
      ancestor = a.parentIdx;
    }
  }

  // Full-screen spans with no text, testID or accLabel are pure layout
  // infrastructure — nothing but indentation noise.
  if (canNormalize) {
    for (const c of components) {
      if (removed.has(c.id) || c.text || c.testID || c.accLabel) continue;
      if (!c.rect) continue;
      if (
        Math.abs(c.rect.x) <= 5 &&
        Math.abs(c.rect.y) <= 5 &&
        Math.abs(c.rect.w - screenW) <= 5 &&
        Math.abs(c.rect.h - screenH) <= 5
      ) {
        removed.add(c.id);
        filterStats.fullScreenWrapper.count++;
      }
    }
  }

  // Drop display text already contained in an ancestor's, up to 6 levels:
  //   Link "Browse topic X" → Button "Browse topic X" → Text "X"
  for (const c of components) {
    const cDisplay = c.text ?? c.accLabel;
    if (removed.has(c.id) || !cDisplay || c.testID) continue;
    let ancestor = c.parentIdx;
    let depth = 0;
    while (ancestor >= 0 && depth < 6) {
      if (removed.has(ancestor)) {
        ancestor = components[ancestor].parentIdx;
        continue;
      }
      const a = components[ancestor];
      const aDisplay = a.text ?? a.accLabel;
      if (aDisplay && aDisplay.length >= cDisplay.length && aDisplay.includes(cDisplay)) {
        removed.add(c.id);
        filterStats.ancestorText.count++;
        break;
      }
      ancestor = a.parentIdx;
      depth++;
    }
  }

  // A content-free component overlapping its parent's rect is a layout wrapper:
  // indentation noise with no navigation value.
  for (const c of components) {
    if (removed.has(c.id) || c.text || c.testID || c.accLabel) continue;
    if (!c.rect) continue;
    let effectiveParentIdx = c.parentIdx;
    while (effectiveParentIdx >= 0 && removed.has(effectiveParentIdx)) {
      effectiveParentIdx = components[effectiveParentIdx].parentIdx;
    }
    const parent = effectiveParentIdx >= 0 ? components[effectiveParentIdx] : null;
    if (parent && parent.rect && rectsOverlap(parent.rect, c.rect)) {
      removed.add(c.id);
      filterStats.contentFreeWrapper.count++;
    }
  }

  const childrenOf = new Map<number, number[]>();
  const roots: number[] = [];
  for (const c of components) {
    if (removed.has(c.id)) {
      continue;
    }
    let effectiveParent = c.parentIdx;
    while (effectiveParent >= 0 && removed.has(effectiveParent)) {
      effectiveParent = components[effectiveParent].parentIdx;
    }
    if (effectiveParent === -1) {
      roots.push(c.id);
    } else {
      let list = childrenOf.get(effectiveParent);
      if (!list) {
        list = [];
        childrenOf.set(effectiveParent, list);
      }
      list.push(c.id);
    }
  }

  // Drop content-free sole-child leaves under a parent that already carries
  // text/testID — e.g. ShareMenuButton [testID=postShareBtn] → Trigger "Open share menu".
  {
    const toRemove: number[] = [];
    for (const [parentId, children] of childrenOf) {
      if (children.length !== 1) continue;
      const childId = children[0];
      const child = components[childId];
      const parent = components[parentId];
      if (child.testID) continue;
      if (!parent.text && !parent.accLabel && !parent.testID) continue;
      if (childrenOf.has(childId)) continue; // not a leaf
      toRemove.push(childId);
    }
    if (toRemove.length > 0) {
      for (const id of toRemove) {
        removed.add(id);
        filterStats.soleChildLeaf.count++;
      }
      childrenOf.clear();
      roots.length = 0;
      for (const c of components) {
        if (removed.has(c.id)) continue;
        let effectiveParent = c.parentIdx;
        while (effectiveParent >= 0 && removed.has(effectiveParent)) {
          effectiveParent = components[effectiveParent].parentIdx;
        }
        if (effectiveParent === -1) {
          roots.push(c.id);
        } else {
          let list = childrenOf.get(effectiveParent);
          if (!list) {
            list = [];
            childrenOf.set(effectiveParent, list);
          }
          list.push(c.id);
        }
      }
    }
  }

  function countNodes(id: number): number {
    let n = 1;
    const ch = childrenOf.get(id);
    if (ch) for (const cid of ch) n += countNodes(cid);
    return n;
  }

  let totalVisible = 0;
  for (const rid of roots) totalVisible += countNodes(rid);

  function isWrapper(id: number): boolean {
    const c = components[id];
    const ch = childrenOf.get(id);
    if (!ch || ch.length !== 1) return false;
    return !c.text && !c.testID && !c.accLabel;
  }

  const collapsed = new Map<number, number>();
  let collapsedCount = 0;

  if (opts.maxNodes !== undefined && totalVisible > opts.maxNodes) {
    type Chain = { startId: number; length: number };
    const chains: Chain[] = [];

    function findChains(id: number) {
      if (isWrapper(id)) {
        let len = 0;
        let cur = id;
        while (isWrapper(cur)) {
          len++;
          cur = childrenOf.get(cur)![0];
        }
        if (len >= 2) {
          chains.push({ startId: id, length: len });
        }
      }
      const ch = childrenOf.get(id);
      if (ch) {
        for (const cid of ch) {
          if (!collapsed.has(cid)) findChains(cid);
        }
      }
    }

    for (const rid of roots) findChains(rid);

    chains.sort((a, b) => b.length - a.length);

    const excess = totalVisible - opts.maxNodes;
    for (const chain of chains) {
      if (collapsedCount >= excess) break;
      collapsed.set(chain.startId, chain.length);
      collapsedCount += chain.length - 1;
    }
  }

  const lines: string[] = [];

  const turn =
    opts.uiOrientation &&
    opts.uiOrientation !== "unknown" &&
    opts.uiOrientation !== "ambiguous" &&
    opts.uiOrientation !== "mismatched"
      ? opts.uiOrientation
      : undefined;

  if (canNormalize) {
    lines.push(`Screen: ${screenW}x${screenH}`);
    if (opts.uiOrientation === "mismatched") {
      lines.push(
        "Note: The udid is not the UDID of the simulator that shows this app. Thus, the tool did not use the udid. If the UI is landscape, the tap points are not correct. The describe tool gives correct tap points. This tool also gives correct tap points with the UDID of the simulator that shows this app."
      );
    } else if (turn && turn !== "portrait") {
      lines.push(
        `The UI is ${turn} on the screen. The tap points are on the screen's axes, which the gesture tools use.`
      );
    } else if (opts.uiOrientation === "ambiguous" && screenW > screenH) {
      lines.push(
        "Note: the UI is landscape, and two booted simulators have this device's name, so its orientation could not be read. The tap points are on the UI's axes, so a tap can miss. Use describe for tap points, or call again with the udid of the simulator that shows this app."
      );
    } else if (opts.uiOrientation === "unknown" && screenW > screenH) {
      lines.push(
        "Note: the UI is landscape, and its orientation could not be read. The tap points are on the UI's axes, so a tap can miss. Use describe for tap points."
      );
    }
    if (opts.readInsteadOfUdid) {
      lines.push(
        `Note: the udid is not the UDID of the simulator that shows this app. The tool used ${opts.readInsteadOfUdid}, the UDID of that simulator.`
      );
    }
    // A wrong udid moves no point while the UI and the simulator read are both portrait.
    if (opts.udidUnchecked && (screenW > screenH || (turn !== undefined && turn !== "portrait"))) {
      lines.push(
        "Note: two booted simulators have this device's name, so the tool could not check that the udid is the simulator that shows this app. If it is another simulator, a tap can miss. Use describe for tap points."
      );
    }
    lines.push("");
  }

  function formatLabel(c: RawEntry): string {
    let label = c.name;
    const displayText = c.text ?? c.accLabel;
    if (displayText) label += ` "${displayText}"`;
    if (c.testID) label += ` [testID=${c.testID}]`;
    if (c.rect && canNormalize) {
      const tap = uiPointToNative(
        { x: (c.rect.x + c.rect.w / 2) / screenW, y: (c.rect.y + c.rect.h / 2) / screenH },
        turn
      );
      label += ` (tap: ${tap.x.toFixed(2)},${tap.y.toFixed(2)})`;
    }
    return label;
  }

  function renderNode(id: number, depth: number) {
    const c = components[id];
    if (!c) return;

    const chainLen = collapsed.get(id);
    if (chainLen !== undefined) {
      let cur = id;
      for (let i = 0; i < chainLen; i++) {
        cur = childrenOf.get(cur)![0];
      }
      const indent = "  ".repeat(depth);
      lines.push(`${indent}${formatLabel(c)}`);
      lines.push(`${indent}  ... via ${chainLen} wrapper${chainLen > 1 ? "s" : ""}`);
      renderNode(cur, depth + 1);
      return;
    }

    lines.push("  ".repeat(depth) + formatLabel(c));

    const children = childrenOf.get(id);
    if (children) {
      let prevSibling: RawEntry | null = null;
      for (const childId of children) {
        const child = components[childId];
        if (
          prevSibling &&
          child.name === prevSibling.name &&
          child.rect &&
          prevSibling.rect &&
          rectsOverlap(child.rect, prevSibling.rect)
        ) {
          continue;
        }
        renderNode(childId, depth + 1);
        prevSibling = child;
      }
    }
  }

  for (const rootId of roots) {
    renderNode(rootId, 0);
  }

  if (collapsedCount > 0) {
    lines.push("");
    lines.push(
      `... ${collapsedCount} wrapper node${collapsedCount > 1 ? "s" : ""} collapsed. Call without maxNodes to see full tree.`
    );
  }

  if (opts.includeSkipped) {
    const tsTotal =
      filterStats.sameNameDedup.count +
      filterStats.offScreen.count +
      filterStats.sameTestID.count +
      filterStats.fullScreenWrapper.count +
      filterStats.ancestorText.count +
      filterStats.contentFreeWrapper.count +
      filterStats.soleChildLeaf.count;

    lines.push("");
    lines.push("--- Filtered ---");

    if (data.totalFibers !== undefined) {
      lines.push(`Total fibers walked: ${data.totalFibers}`);
    }

    if (data.skippedCounts && Object.keys(data.skippedCounts).length > 0) {
      const jsTotal = Object.values(data.skippedCounts).reduce((a, b) => a + b, 0);
      const top = Object.entries(data.skippedCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([name, count]) => `${name}: ${count}`)
        .join(", ");
      lines.push(`JS-side skipped: ${jsTotal} (${top})`);
    }

    if (tsTotal > 0) {
      lines.push(`TS-side removed: ${tsTotal}`);
      if (filterStats.sameNameDedup.count > 0) {
        const detail = Array.from(filterStats.sameNameDedup.names.entries())
          .map(([name, count]) => `${name} x${count}`)
          .join(", ");
        lines.push(`  Same-name dedup: ${filterStats.sameNameDedup.count} (${detail})`);
      }
      if (filterStats.offScreen.count > 0) {
        lines.push(`  Off-screen: ${filterStats.offScreen.count}`);
      }
      if (filterStats.fullScreenWrapper.count > 0) {
        lines.push(`  Full-screen wrapper: ${filterStats.fullScreenWrapper.count}`);
      }
      if (filterStats.sameTestID.count > 0) {
        lines.push(`  Same-testID chain: ${filterStats.sameTestID.count}`);
      }
      if (filterStats.ancestorText.count > 0) {
        lines.push(`  Ancestor text dedup: ${filterStats.ancestorText.count}`);
      }
      if (filterStats.contentFreeWrapper.count > 0) {
        lines.push(`  Content-free wrapper: ${filterStats.contentFreeWrapper.count}`);
      }
      if (filterStats.soleChildLeaf.count > 0) {
        lines.push(`  Sole-child leaf: ${filterStats.soleChildLeaf.count}`);
      }
    }
  }

  return lines.join("\n");
}

/** Past this the tree prints without the orientation rather than wait longer. */
const ORIENTATION_READ_TIMEOUT_MS = 3_000;

/**
 * The bundle id of the app the debugger is attached to, on the simulator `api`
 * serves. Its Metro target is named after it ("com.example.app (iPhone 16)").
 * A target named after a bundle id that is not connected here is another
 * simulator's app, or an app this simulator cannot read: undefined, never a
 * stand-in. Only a target named some other way falls back to the frontmost
 * connected app.
 */
async function debuggedBundleId(
  api: NativeDevtoolsApi,
  appName: string
): Promise<string | undefined> {
  const named = api
    .listConnectedBundleIds()
    .filter((id) => appName === id || appName.startsWith(`${id} `));
  if (named.length === 1) return named[0]!;
  if (BUNDLE_ID_NAMED_TARGET.test(appName)) return undefined;
  return (await resolveNativeTargetApp(api)).bundleId;
}

/** A Metro target named after a bundle id: "com.example.app (iPhone 16)". */
const BUNDLE_ID_NAMED_TARGET = /^[\w-]+(\.[\w-]+)+( \(|$)/;

/** What the tree's debugger session is attached to, as the debugger knows it. */
interface DebuggedApp {
  /** The `device_id` the tool was called with. */
  deviceId: string;
  /** The simulator the caller says shows the app, checked against the listing and `device_id`. */
  udid?: string;
  /** The Metro target's name, `<bundle id> (<device name>)`. */
  appName: string;
  deviceName: string;
  logicalDeviceId: string | undefined;
}

const AMBIGUOUS_SIMULATOR = "ambiguous-simulator";
const MISMATCHED_UDID = "mismatched-udid";
const UNLISTED_UDID = "unlisted-udid";

/** The simulator to read, and what the result owes the caller about the `udid`. */
type SimulatorPick = { device: DeviceInfo } & Omit<TapAxesRead, "uiOrientation">;

/**
 * The iOS simulator the session runs on; undefined for any other device. A
 * `udid` is read only when it can be that simulator: the one `device_id`
 * names, or a booted simulator with the app's device name. Any other `udid`
 * gives way to the simulator the session finds by itself, and is mismatched
 * when two booted simulators of the app's name leave the session unable to
 * name one. A `udid` the listing does not have is unlisted.
 *
 * debugger-connect takes any `device_id` for the one app on a Metro, so a
 * `device_id` that names a simulator is no proof that the app runs there. A
 * `udid` booted with the app's device name outranks such a `device_id` when
 * that simulator does not have the name itself.
 */
async function iosSimulatorOf(
  app: DebuggedApp
): Promise<
  | SimulatorPick
  | typeof AMBIGUOUS_SIMULATOR
  | typeof MISMATCHED_UDID
  | typeof UNLISTED_UDID
  | undefined
> {
  if (!app.udid) {
    const session = await iosSimulatorOfSession(app);
    return session === AMBIGUOUS_SIMULATOR || !session ? session : { device: session };
  }
  const named = resolveDevice(app.udid);
  const own = resolveDevice(canonicalDeviceId(app.deviceId) ?? app.deviceId);
  if (isIosSimulator(own)) {
    if (own.id === named.id) return { device: own };
    if (isIosSimulator(named)) {
      const [listed, ownListed] = await Promise.all([
        listedAs(named, app.deviceName),
        listedAs(own, app.deviceName),
      ]);
      if (listed === "booted" && ownListed !== "booted") return { device: named };
    }
    return { device: own, readInsteadOfUdid: own.id };
  }
  const [listed, session] = await Promise.all([
    isIosSimulator(named) ? listedAs(named, app.deviceName) : undefined,
    iosSimulatorOfSession(app),
  ]);
  if (listed === "booted" || listed === "twin") {
    const sole =
      session === undefined || (session !== AMBIGUOUS_SIMULATOR && session.id === named.id);
    return listed === "booted" && sole ? { device: named } : { device: named, udidUnchecked: true };
  }
  if (session === AMBIGUOUS_SIMULATOR) return MISMATCHED_UDID;
  if (session) {
    return session.id === named.id
      ? { device: session }
      : { device: session, readInsteadOfUdid: session.id };
  }
  return listed === "unlisted" ? UNLISTED_UDID : undefined;
}

/**
 * How the `udid`'s own listing reports it: simctl's for a local simulator,
 * sim-remote's for a `remote:` one. `twin` is booted with the app's device name
 * beside another booted `remote:` simulator of that name (the session's own
 * lookup counts the local ones); `unlisted` is not in the listing, as when the
 * listing could not be read.
 */
async function listedAs(
  device: DeviceInfo,
  name: string
): Promise<"booted" | "twin" | "other" | "unlisted"> {
  if (device.platform !== "ios-remote") {
    const sim = await findIosSimulator(device.id);
    if (!sim) return "unlisted";
    return sim.state === "Booted" && sim.name === name ? "booted" : "other";
  }
  const listing = Object.values(
    (
      await simctlListDevices({ timeoutMs: ORIENTATION_READ_TIMEOUT_MS }).catch(() => ({
        devices: {},
      }))
    ).devices
  ).flat();
  const sim = listing.find((d) => d.udid === stripRemotePrefix(device.id));
  if (!sim) return "unlisted";
  if (sim.state !== "Booted" || sim.name !== name) return "other";
  return listing.some((d) => d !== sim && d.state === "Booted" && d.name === name)
    ? "twin"
    : "booted";
}

/**
 * A session keyed by a Metro logicalDeviceId (two devices share one Metro)
 * names no device, so it is found by name among the booted simulators; a name
 * two of them share leaves it ambiguous.
 */
async function iosSimulatorOfSession(
  app: DebuggedApp
): Promise<DeviceInfo | typeof AMBIGUOUS_SIMULATOR | undefined> {
  const device = resolveDevice(canonicalDeviceId(app.deviceId) ?? app.deviceId);
  if (isIosSimulator(device)) return device;
  const logicalKeyed = app.deviceId === app.logicalDeviceId || isLogicalKeyedDevice(app.deviceId);
  if (!logicalKeyed) return undefined;
  const named = (await listIosSimulators()).filter(
    (sim) => sim.state === "Booted" && sim.runtimeKind === "mobile" && sim.name === app.deviceName
  );
  if (named.length === 1) return resolveDevice(named[0]!.udid);
  return named.length > 1 ? AMBIGUOUS_SIMULATOR : undefined;
}

/**
 * How the UI of the debugged app lies on the axes the gesture tools take (see
 * {@link TapAxes}), read from the app's view hierarchy as flows read it. Only an
 * iOS simulator needs it: an Android device takes touches on the rotated
 * display's axes, the same axes as the layout rects. Never fails the tree: a
 * read that errors or takes too long is `unknown`.
 */
export async function readTapAxes(
  registry: Pick<Registry, "resolveService">,
  app: DebuggedApp
): Promise<TapAxesRead> {
  const read = (async (): Promise<TapAxesRead> => {
    const pick = await iosSimulatorOf(app);
    if (pick === undefined) return {};
    if (pick === AMBIGUOUS_SIMULATOR) return { uiOrientation: "ambiguous" };
    if (pick === MISMATCHED_UDID) return { uiOrientation: "mismatched" };
    if (pick === UNLISTED_UDID) return { uiOrientation: "unknown" };
    const { device, ...udid } = pick;
    const ref = nativeDevtoolsRef(device);
    const api = await registry.resolveService<NativeDevtoolsApi>(ref.urn, ref.options);
    const bundleId = await debuggedBundleId(api, app.appName);
    if (!bundleId) return { uiOrientation: "unknown", ...udid };
    const raw = (await api.queryViewHierarchy(bundleId, "ViewHierarchy.getFullHierarchy", {
      fields: ["className"],
      maxDepth: 1,
    })) as { screen?: { interfaceOrientation?: unknown } } | null;
    return {
      uiOrientation: asUiOrientation(raw?.screen?.interfaceOrientation) ?? "unknown",
      ...udid,
    };
  })().catch((): TapAxesRead => ({ uiOrientation: "unknown" }));

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<TapAxesRead>((resolve) => {
    timer = setTimeout(() => resolve({ uiOrientation: "unknown" }), ORIENTATION_READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const zodSchema = z.object({
  port: metroPortField,
  device_id: z
    .string()
    .describe(
      "Device id from list-devices — the SAME id you passed to debugger-connect (iOS simulator UDID or Android serial)."
    ),
  udid: z
    .string()
    .optional()
    .describe(
      "iOS simulator UDID from list-devices. Pass it when device_id is a logicalDeviceId (two or more devices share one Metro), so that the tap coordinates of a landscape UI are on the screen's axes. Give the UDID of the simulator that shows the app."
    ),
  onScreenOnly: z
    .boolean()
    .default(true)
    .describe(
      "When true (default), only components visible on screen are returned. " +
        "Set to false to include all mounted components including those scrolled " +
        "off-screen. Useful when you need to understand the full page structure."
    ),
  maxNodes: z.coerce
    .number()
    .optional()
    .describe(
      "Maximum total nodes to include. When exceeded, intermediate single-child " +
        "wrapper chains are collapsed to preserve both root structure and leaf elements. " +
        "Default: no limit."
    ),
  includeSkipped: z
    .boolean()
    .default(false)
    .describe(
      "When true, appends a summary of all filtered components: total fiber count, " +
        "JS-side skip counts by name, and TS-side filter pass removals. " +
        "Useful for understanding what was pruned from the tree."
    ),
});

export function createDebuggerComponentTreeTool(
  registry: Registry
): ToolDefinition<z.infer<typeof zodSchema>, string> {
  return {
    id: "debugger-component-tree",
    interaction: {
      startedMsg: () => "Reading React component tree",
      completedMsg: () => "Read React component tree",
      failedMsg: ({ failureSignal }) =>
        `Failed to read React component tree: ${failureSignal.error_code}`,
    },
    description: `Fetch the current screen of a running React Native app as a compact component text tree.
Only shows on-screen components with unique positions — off-screen (scrolled) content,
full-screen transparent wrappers, and implementation-detail components are pruned.

Each visible component is listed with its name, text content, and normalized
tap coordinates in [0,1] space (fractions of the screen, not pixels — same space as tap/swipe/gesture).
On an iOS simulator with a landscape UI (a rotated device, or an unfolded foldable), the tap
coordinates are on the screen's axes, which the gesture tools use. When two or more devices share
one Metro, pass the simulator's udid too. If the result says that the orientation could not be
read, take tap coordinates from describe.

This is the preferred element discovery tool for React Native apps. More information in argent-react-native-app-workflow skill.

Workflow:
  1. Call this tool to get the component tree.
  2. Find the desired element by name, text, testID, or accessibilityLabel.
  3. Use the (tap: x,y) coordinates directly with the tap tool.

Call again after navigation or state changes since positions may shift.
Set includeSkipped=true to see a summary of all filtered components.
Use when you need tap coordinates for a React Native UI element. Returns a compact text tree with (tap: x,y) coords. Fails if Metro debugger is not connected.`,
    alwaysLoad: true,
    searchHint: "react native component tree discovery tap coordinates",
    zodSchema,
    // RN-only: needs the React DevTools backend from the dev JS bundle. Chromium has
    // no equivalent — use `describe` there.
    capability: RN_ONLY_TOOL_CAPABILITY,
    services: (params) => ({
      debugger: `JsRuntimeDebugger:${metroPort(params)}:${canonicalDeviceId(params.device_id)}`,
    }),
    async execute(services, params) {
      const api = services.debugger as JsRuntimeDebuggerApi;
      // Read alongside the tree; it never fails, so it never fails the tree.
      const tapAxes = readTapAxes(registry, {
        deviceId: params.device_id,
        udid: params.udid,
        appName: api.appName,
        deviceName: api.deviceName,
        logicalDeviceId: api.logicalDeviceId,
      });
      const requestId = crypto.randomUUID();
      const script = makeComponentTreeScript({
        includeSkipped: params.includeSkipped,
        requestId,
      });
      const response = await api.cdp.evaluateWithBinding(script, requestId, {
        timeout: 15_000,
      });

      const raw = response.result;
      if (typeof raw !== "string") {
        return "Error: no result from component tree script";
      }

      const parsed: RawResult = JSON.parse(raw);
      if (parsed.error) {
        return `Error: ${parsed.error}`;
      }

      const tree = buildTextTree(parsed, {
        onScreenOnly: params.onScreenOnly,
        maxNodes: params.maxNodes,
        includeSkipped: params.includeSkipped,
        ...(await tapAxes),
      });

      const deviceLine = [
        `device: ${api.deviceName}`,
        `app: ${api.appName}`,
        ...(api.logicalDeviceId ? [`logicalDeviceId: ${api.logicalDeviceId}`] : []),
      ].join(" | ");

      return `[${deviceLine}]\n${tree}`;
    },
  };
}
