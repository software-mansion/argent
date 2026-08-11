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
// thing boot-device does that an external `xcrun simctl boot` cannot. It
// describes how the simulator was booted, not how the read went.
//
// Rebooting costs the developer whatever is running on the sim, so the caveat
// splits on what the accessibility read produced: only a blind read has
// anything to gain from the reboot.
const DEGRADED_BLIND_HINT =
  "The accessibility read returned no elements, and this simulator was not booted through argent, " +
  "so the pre-boot accessibility settings were never applied. Unless the screen is genuinely blank, " +
  "call boot-device with force=true to reboot it with those settings — this restarts the simulator";

// Deduped to once per device per server lifetime by
// `withBootCaveatOncePerDevice`: it holds for every describe against this
// simulator until the sim is booted through argent, and a session makes dozens
// of describe calls.
const DEGRADED_STANDING_HINT =
  "This simulator was not booted through argent, so system dialogs and native modals may not appear " +
  "in this tree; everything else reads normally. If something you expect is missing, boot-device with " +
  "force=true reboots the simulator with the full accessibility settings";

// Devices already told DEGRADED_STANDING_HINT. Not cleared on shutdown or
// disposal — the externally-booted state outlives any one service instance —
// but cleared per device when a read comes back off that state, so a later
// external boot of the same udid is caveated again.
const bootCaveatToldDevices = new Set<string>();

export function __resetBootCaveatStateForTests(): void {
  bootCaveatToldDevices.clear();
}

/**
 * Drop DEGRADED_STANDING_HINT from a result whose device has already been told
 * it. Applied only at the `describe` tool boundary, the one surface that repeats
 * the caveat to the agent call after call; internal poll loops keep every copy,
 * which their blind-read guards key off.
 */
export function withBootCaveatOncePerDevice(
  deviceId: string,
  data: DescribeTreeData
): DescribeTreeData {
  if (data.hint !== DEGRADED_STANDING_HINT) {
    // A read that is not degraded at all means the caveat no longer describes
    // this device, so a later external boot has to be able to say it again. The
    // blind caveat is the same degraded state read blind, so it does not reset.
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

// The TCP-transport artifacts the ios-remote path needs are built separately
// and can be absent in a local build. That failure says nothing about the
// simulator's boot state, so surface the resolver's own actionable message
// instead of the boot caveat, which points at boot-device — a dead end here.
function tcpArtifactHint(err: unknown): string | undefined {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /TCP-transport (?:binary|dylib) not found/.test(message) ? message : undefined;
}

// tvOS classifies as platform "ios" by UDID shape, and the iOS ax-service can't
// read the Apple TV focus engine. The `describe` tool routes TV targets to
// `describeTv` before this branch, so the short-circuit below catches the
// internal callers of `describeIos`, which would otherwise spawn a daemon that
// times out and degrades with the misleading boot-device hint.
const TVOS_HINT =
  "This is an Apple TV (tvOS) simulator, which the iOS accessibility service does not support. " +
  "Use the `describe` tool to read the focused and focusable elements, `tv-remote` " +
  "(up/down/left/right/select/back/menu/home) to move focus, and `keyboard` to type. " +
  "See the argent-tv-interact skill.";

// Apple system apps (`com.apple.*`) are not targets argent's native devtools
// support, so the fallback can't read their view hierarchy and restarting them
// would never help — returning `should_restart` here puts the agent in an
// unbounded restart-app → describe loop. Reached only once the ax-service path
// has already returned empty, so it leads with `screenshot`: re-recommending
// `describe` would be circular.
const NON_INJECTABLE_HINT =
  "This is an Apple system app (com.apple.*), which argent's native-devtools instrumentation " +
  "does not support — the native view hierarchy is unavailable and restarting the app will NOT " +
  "help. Take a `screenshot` to see the screen and interact by coordinate. " +
  NON_INJECTABLE_NATIVE_WARNING;

function emptyTree(): DescribeNode {
  return parseDescribeResult({
    role: "AXGroup",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children: [],
  });
}

interface DescribeIosParams {
  bundleId?: string;
}

interface DescribeIosOptions {
  // Pre-resolved tvOS verdict, so poll/retry callers don't re-shell `xcrun` each
  // iteration. Omitted callers probe once.
  isTvOs?: boolean;
}

// The ax-service blueprint factory shells out to `xcrun simctl spawn`. Without
// xcrun on PATH that ENOENTs deep inside the factory and the HTTP layer returns
// a raw 500 — declaring the dep makes the preflight emit a 424 with the install
// hint instead, matching launch-app / restart-app / open-url / reinstall-app.
export const iosRequires: ToolDependency[] = ["xcrun"];

export async function describeIos(
  registry: Registry,
  device: DeviceInfo,
  params: DescribeIosParams,
  options: DescribeIosOptions = {}
): Promise<DescribeTreeData> {
  // The focus-engine tree is served by tv-control, not the iOS ax-service.
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
    // Carry on with an empty tree so the native-devtools fallback below still
    // runs. A missing TCP-transport artifact is a config error, not a boot-state
    // one, so it must not read as degraded.
    tree = emptyTree();
    resolverHint = tcpArtifactHint(err);
    degraded = resolverHint === undefined;
  }

  // Keyed to what the ACCESSIBILITY read produced, not to the tree finally
  // returned: the native-devtools fallback fills it from the injected app's own
  // view hierarchy, which carries no SpringBoard chrome and no system dialogs,
  // so it is no evidence the AX subsystem works.
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
  // app's process inherits the very tokens the connection measurement reads and
  // scores as injected — landing on `stale_process` or `unregistered` by nothing
  // but its age. Both are wrong for an app no restart can help, and the first
  // rebuilds the restart-app → describe loop.
  //
  // The gate sits BEFORE the native-devtools fallback: injectability is a static
  // property of the explicit bundle id, so the terminal hint must not depend on
  // service resolution succeeding, and no service is spawned for an app the gate
  // refuses. Auto-resolution (no bundleId) needs no gate — it only ever
  // yields a connected, hence injected, app. A degraded ax-service keeps its
  // reboot guidance instead: a proper boot may let the ax-service read this
  // system app's tree, at which point `describe`, not a screenshot, is the
  // right tool.
  if (params.bundleId && !isInjectableBundleId(params.bundleId)) {
    return { tree, source: "ax-service", hint: hint ?? NON_INJECTABLE_HINT };
  }

  let nativeApi: NativeDevtoolsApi;
  try {
    const ndRef = nativeDevtoolsRef(device);
    nativeApi = await registry.resolveService<NativeDevtoolsApi>(ndRef.urn, ndRef.options);
  } catch (err) {
    // The blueprint is registered unconditionally, so on an iOS target this
    // rejects only when the service failed to come up. A failed attempt at
    // corroboration, not an absence of one, so the empty read is as unexplained
    // here as it is below.
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
      // and retry", the loop instruction with no escape.
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
    // still be on screen. Nothing was resolved here, so there is no remedy to
    // invent beyond the message the resolver already carries.
    return { tree, source: "ax-service", hint: unexplainedHint(hint, errMsg(err), params) };
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Mark an empty accessibility read as unexplained rather than empty.
 *
 * Any hint already set is kept ahead of it: the boot caveat is corrective for
 * the simulator itself, and dropping it would trade a repairable sim for a note
 * about one read. Only the `bundleId` half of the advice is conditional, so a
 * caller who supplied one is not told to take the step they already took.
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
