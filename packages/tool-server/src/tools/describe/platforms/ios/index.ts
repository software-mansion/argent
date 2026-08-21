import type { DeviceInfo, Registry, ToolDependency } from "@argent/registry";
import { axServiceRef, AXServiceApi } from "../../../../blueprints/ax-service";
import {
  buildAppStateMessage,
  isInjectableBundleId,
  NON_INJECTABLE_NATIVE_WARNING,
  nativeDevtoolsRef,
  NativeDevtoolsApi,
} from "../../../../blueprints/native-devtools";
import { resolveNativeTargetApp } from "../../../../utils/native-target-app";
import { isTvOsSimulator } from "../../../../utils/ios-devices";
import { parseNativeDescribeScreenResult } from "../../../native-devtools/native-describe-contract";
import { DescribeTreeData, parseDescribeResult, type DescribeNode } from "../../contract";
import { adaptAXDescribeToDescribeResult } from "./ios-ax-adapter";
import { adaptNativeDescribeToDescribeResult } from "./ios-native-adapter";

// `degraded` means the pre-boot accessibility prefs were never written — the one
// thing boot-device does that an external `xcrun simctl boot` (Xcode, `expo
// run:ios`, a developer's own simulator) cannot. It describes how the simulator
// was booted, not how the read went: `IgnoreAXServerEntitlements` only bypasses
// a check that exists on iOS 26.5+, so on earlier runtimes an externally-booted
// sim serves the complete tree, system alerts included (verified on iOS 18.6:
// the Maps location prompt is read with all three buttons).
//
// Restarting the simulator costs the developer whatever is running on it — a
// Metro session, a dev client, staged app state — so the caveat splits on what
// the accessibility read actually produced. Only a read that came back blind
// has anything to gain from the reboot; a populated accessibility read is its
// own proof the reboot is not needed, and says so without ordering one.
const DEGRADED_BLIND_HINT =
  "The accessibility read returned no elements, and this simulator was not booted through argent, " +
  "so the pre-boot accessibility settings were never applied. Unless the screen is genuinely blank, " +
  "call boot-device with force=true to reboot it with those settings — this restarts the simulator";

// Emitted once per device per server lifetime by `withBootCaveatOncePerDevice`:
// it holds for every describe against this simulator until the sim is booted
// through argent, and a session makes dozens of describe calls.
const DEGRADED_STANDING_HINT =
  "This simulator was not booted through argent, so system dialogs and native modals may not appear " +
  "in this tree; everything else reads normally. If something you expect is missing, boot-device with " +
  "force=true reboots the simulator with the full accessibility settings";

// Devices already told DEGRADED_STANDING_HINT. Bounded by the number of
// simulators driven in one server lifetime, and not cleared on shutdown or
// disposal: the caveat holds for as long as the sim stays externally booted,
// which outlives any one service instance.
//
// It IS cleared when a read comes back off that state, because the state can
// come back: a udid booted through argent (or a fresh sim reusing the udid)
// reads healthy, and if it is later booted externally again the caveat is true
// once more and has never been told about that boot. Keying "already told" to
// the tool-server's lifetime instead would silence it for good on the first
// reboot cycle.
const bootCaveatToldDevices = new Set<string>();

export function __resetBootCaveatStateForTests(): void {
  bootCaveatToldDevices.clear();
}

/**
 * Drop DEGRADED_STANDING_HINT from a result whose device has already been told
 * it. Applied only at the `describe` tool boundary, the one surface that repeats
 * the caveat to the agent call after call. Internal callers (await-ui-element,
 * flows, await-screen-idle, preview) keep every copy: they gate blind-read
 * detection on `hint` being present and fold it into a single terminal note, so
 * they never pay per poll for it.
 */
export function withBootCaveatOncePerDevice(
  deviceId: string,
  data: DescribeTreeData
): DescribeTreeData {
  if (data.hint !== DEGRADED_STANDING_HINT) {
    // A read that is not degraded at all — the sim was booted through argent, or
    // a different sim now holds this udid — means the caveat no longer describes
    // this device, so a later external boot has to be able to say it again. The
    // blind caveat is the one exception: it is the same degraded state, just
    // read blind, and it is never deduped anyway.
    if (data.hint !== DEGRADED_BLIND_HINT) bootCaveatToldDevices.delete(deviceId);
    return data;
  }
  if (!bootCaveatToldDevices.has(deviceId)) {
    bootCaveatToldDevices.add(deviceId);
    return data;
  }
  const { hint: _alreadyTold, ...rest } = data;
  return rest;
}

// The ios-remote (sim-remote) path needs the TCP-transport ax-service binary and
// dylibs, which are shipped/built separately and can be absent in a local or old
// build. When they are, the ax-service factory throws a "TCP-transport ... not
// found" error that has nothing to do with the simulator's boot state — so
// steer clear of the degraded caveat (which points at boot-device, a dead end
// here) and surface the resolver's actionable message verbatim instead.
function tcpArtifactHint(err: unknown): string | undefined {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /TCP-transport (?:binary|dylib) not found/.test(message) ? message : undefined;
}

// tvOS classifies as platform "ios" by UDID shape. The `describe` tool routes
// TV targets to the focus-driven `describeTv` before this iOS branch runs, so
// the short-circuit below is only reached by internal callers that invoke
// `describeIos` directly (preview / match-element-frame). The iOS ax-service
// can't read the Apple TV focus engine — surface the right tool instead of
// spawning a daemon that times out and degrades with the misleading
// boot-device hint.
const TVOS_HINT =
  "This is an Apple TV (tvOS) simulator, which the iOS accessibility service does not support. " +
  "Use the `describe` tool to read the focused and focusable elements, `tv-remote` " +
  "(up/down/left/right/select/back/menu/home) to move focus, and `keyboard` to type. " +
  "See the argent-tv-interact skill.";

// Apple system apps (`com.apple.*`) cannot be relied on to load argent's dylib,
// so the native-devtools fallback can't read their view hierarchy and restarting
// them would never help — returning `should_restart` here puts the agent in an
// unbounded restart-app → describe loop. This hint is reached only once
// `describe`'s own ax-service path has already returned empty, so it leads with
// `screenshot` (re-recommending `describe` would be circular) and shares the
// `native-*` dead-end warning verbatim with the precheck throw and
// `native-devtools-status`.
const NON_INJECTABLE_HINT =
  "This is an Apple system app (com.apple.*), which cannot be relied on to load argent's native-devtools " +
  "instrumentation — the native view hierarchy is unavailable and restarting the app will NOT " +
  "help. Take a `screenshot` to see the screen and interact by coordinate. " +
  NON_INJECTABLE_NATIVE_WARNING;

function emptyTree(): DescribeNode {
  return parseDescribeResult({
    role: "AXGroup",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children: [],
  });
}

export interface DescribeIosParams {
  bundleId?: string;
}

export interface DescribeIosOptions {
  // Pre-resolved tvOS verdict, passed by poll/retry callers so the hot path
  // skips re-shelling `xcrun` each iteration. Omitted callers probe once.
  isTvOs?: boolean;
}

// describe on iOS resolves the ax-service via Registry; the blueprint factory
// shells out to `xcrun simctl spawn` (spawnDaemon).
// Without xcrun on PATH the spawn ENOENTs deep inside the factory and the
// HTTP layer returns a 500 with a raw "spawn xcrun ENOENT" message — declare
// the dep here so the preflight emits a 424 with the install hint instead,
// matching launch-app / restart-app / open-url / reinstall-app.
export const iosRequires: ToolDependency[] = ["xcrun"];

export async function describeIos(
  registry: Registry,
  device: DeviceInfo,
  params: DescribeIosParams,
  options: DescribeIosOptions = {}
): Promise<DescribeTreeData> {
  // tvOS short-circuit: the focus-engine accessibility tree is served by the
  // tv-control daemons, not the iOS ax-service. Without this, describe would
  // try to spawn ax-service inside the Apple TV sim, time out on the daemon
  // connection, and degrade with the wrong (boot-device) hint.
  const isTvOs = options.isTvOs ?? (await isTvOsSimulator(device.id));
  if (isTvOs) {
    return { tree: emptyTree(), source: "ax-service", hint: TVOS_HINT };
  }

  let tree: DescribeNode;
  let degraded: boolean;
  // A resolver failure that names its own cause, which outranks the boot caveat.
  let resolverHint: string | undefined;

  try {
    const axRef = axServiceRef(device);
    const axApi = await registry.resolveService<AXServiceApi>(axRef.urn, axRef.options);
    const response = await axApi.describe();
    tree = adaptAXDescribeToDescribeResult(response);
    degraded = axApi.degraded;
  } catch (err) {
    // ax-service failed to start or timed out — treat as degraded with an
    // empty tree so we still attempt the native-devtools fallback below. A
    // missing TCP-transport artifact (ios-remote) is a config error, not a boot
    // state one: surface its actionable message instead of the boot caveat.
    tree = emptyTree();
    resolverHint = tcpArtifactHint(err);
    degraded = resolverHint === undefined;
  }

  // Resolved against what the ACCESSIBILITY read produced, which is not always
  // what comes back: the native-devtools fallback below can fill a tree the AX
  // read left empty, out of the injected app's own view hierarchy. Those
  // elements carry no SpringBoard chrome and no system dialog at all, so a
  // populated tree from that source is no evidence the AX subsystem is
  // working — it is precisely the blind read a reboot fixes. Only a populated
  // AX read proves the reboot is not worth its cost.
  const degradedHint = !degraded
    ? undefined
    : tree.children.length === 0
      ? DEGRADED_BLIND_HINT
      : DEGRADED_STANDING_HINT;
  const hint = resolverHint ?? degradedHint;

  if (tree.children.length > 0) {
    return { tree, source: "ax-service", hint };
  }

  // The launchd env carrying the bootstrap dylib is simulator-wide, so a system
  // app's process inherits the very tokens the measurement reads and scores as
  // injected — landing on `stale_process` (restart-app) or `unregistered`
  // (restart the tool-server) by nothing but its age. Both are wrong for an app
  // no restart can help, and the first rebuilds the restart-app → describe loop.
  // Return the (empty) AX result with the terminal screenshot hint instead.
  // The gate sits BEFORE the native-devtools fallback: injectability is a
  // static property of the explicit bundle id, so the terminal hint must not
  // depend on service resolution succeeding (a downed ios-remote tunnel or a
  // dispose race would otherwise swallow it into the generic catch below), and
  // no native-devtools service is spawned for an app that may never inject.
  // Auto-resolution (no bundleId) needs no gate — it only ever yields a
  // connected, hence injected, app. If the ax-service was degraded (sim not
  // booted through argent, so `hint` is DEGRADED_BLIND_HINT — the tree is empty
  // on this path), keep that re-boot guidance: a proper boot may let the
  // ax-service read this system app's tree (Settings et al. expose a full AX
  // tree), at which point `describe` — not a screenshot — is the right tool. On
  // a healthy sim `hint` is undefined and this falls back to the terminal
  // non-injectable hint.
  if (params.bundleId && !isInjectableBundleId(params.bundleId)) {
    return { tree, source: "ax-service", hint: hint ?? NON_INJECTABLE_HINT };
  }

  // AX returned zero elements (or failed entirely) — attempt native-devtools fallback
  let nativeApi: NativeDevtoolsApi;
  try {
    const ndRef = nativeDevtoolsRef(device);
    nativeApi = await registry.resolveService<NativeDevtoolsApi>(ndRef.urn, ndRef.options);
  } catch (err) {
    // The blueprint is registered unconditionally, so on an iOS target this
    // rejects only when the service failed to come up — a socket bind losing to
    // a concurrent same-udid server, a host that could not be picked. A failed
    // attempt at corroboration, not an absence of one, so the empty read is as
    // unexplained here as it is below.
    return { tree, source: "ax-service", hint: unexplainedHint(hint, errMsg(err), params) };
  }

  try {
    const target = await resolveNativeTargetApp(nativeApi, params.bundleId);

    // Degrade a rejection (the env re-apply this runs first fails on a sim that
    // went away mid-call) rather than letting the outer catch turn a named
    // remedy into a bare "could not be read".
    const state = await nativeApi
      .appConnectionState(target.bundleId)
      .catch(() => "indeterminate" as const);
    if (state !== "connected") {
      // The diagnosis rides out as a hint in every state: `hint` is describe's
      // only prose channel, and the one place `should_restart` is rendered as
      // English — await-ui-element's timeout note — spells it "call restart-app
      // and retry", the loop instruction with no escape. It costs most on
      // `indeterminate`, the only state a running app reaches on ios-remote,
      // whose message is the one saying to stop restarting the app.
      //
      // `should_restart` stays limited to the states a relaunch fixes:
      // `unregistered` already launched under the terms a restart recreates, and
      // `connecting` is the handshake exec begins, so flagging either would
      // rebuild the restart-app → describe loop.
      const diagnosis = buildAppStateMessage(target.bundleId, state);
      const merged = hint ? `${hint} ${diagnosis}` : diagnosis;
      return state === "unregistered" || state === "connecting"
        ? { tree, source: "ax-service", hint: merged }
        : { tree, source: "ax-service", should_restart: true, hint: merged };
    }

    const rawResult = (await nativeApi.queryViewHierarchy(
      target.bundleId,
      "ViewHierarchy.describeScreen"
    )) as { screenFrame?: unknown; elements?: unknown[]; error?: string };

    if (rawResult.error) {
      return { tree, source: "ax-service", hint: unexplainedHint(hint, rawResult.error, params) };
    }

    const parsed = parseNativeDescribeScreenResult(rawResult);
    const nativeTree = adaptNativeDescribeToDescribeResult(parsed);
    return { tree: nativeTree, source: "native-devtools", hint };
  } catch (err) {
    // The service answered but no hierarchy came back: no connected app to
    // auto-target, an ambiguous frontmost, or the query threw. Returning the
    // bare tree would say the screen is empty when it could not be read — and
    // `await-ui-element`'s blind-read guard keys off `hint` / `should_restart`,
    // so with neither set a `hidden` wait resolves against an element that may
    // still be on screen.
    //
    // This is the DEFAULT (no `bundleId`) form's path: auto-targeting draws its
    // candidates from the connected list, so every state the diagnosis above
    // explains throws here before anything is measured. Nothing was resolved, so
    // there is nothing to measure and no remedy to invent — the resolver's own
    // message already carries one.
    return { tree, source: "ax-service", hint: unexplainedHint(hint, errMsg(err), params) };
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Mark an empty accessibility read as unexplained rather than empty.
 *
 * Any hint already set is kept ahead of it: `DEGRADED_HINT`'s "boot-device with
 * force=true" is corrective for the simulator itself, and dropping it would
 * trade a repairable sim for a note about one read.
 *
 * `screenshot` is named on every path — the one action available whatever went
 * wrong. Only the `bundleId` half is conditional, so a caller who supplied one
 * is not told to take the step they already took.
 */
function unexplainedHint(
  hint: string | undefined,
  detail: string,
  params: DescribeIosParams
): string {
  const next = params.bundleId
    ? "Take a `screenshot` to see what is there."
    : "Pass `bundleId` to have the connection state measured, or take a `screenshot` to see what is there.";
  const why =
    `The native view hierarchy could not be read (${detail}), so this empty accessibility tree is ` +
    `not evidence that nothing is on screen. ${next}`;
  return hint ? `${hint} ${why}` : why;
}
