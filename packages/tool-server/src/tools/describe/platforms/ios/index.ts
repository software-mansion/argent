import {
  FAILURE_CODES,
  getFailureSignal,
  type DeviceInfo,
  type Registry,
  type ToolDependency,
} from "@argent/registry";
import {
  axDaemonCrashSignal,
  axServiceRef,
  axStartFailureDegraded,
  AXServiceApi,
} from "../../../../blueprints/ax-service";
import {
  buildAppStateMessage,
  isInjectableBundleId,
  NON_INJECTABLE_NATIVE_WARNING,
  nativeDevtoolsRef,
  NativeDevtoolsApi,
} from "../../../../blueprints/native-devtools";
import { resolveNativeTargetApp } from "../../../../utils/native-target-app";
import { isTvOsSimulator } from "../../../../utils/ios-devices";
import {
  externalSupportHint,
  findExternalDevice,
  isExternalId,
} from "../../../../utils/external-devices";
import { parseNativeDescribeScreenResult } from "../../../native-devtools/native-describe-contract";
import {
  DescribeTreeData,
  parseDescribeResult,
  type DescribeNode,
  type UiOrientation,
} from "../../contract";
import {
  noteUiOrientation,
  readUiOrientation,
  unknownOrientationNote,
} from "../../../../utils/ios-ui-orientation";
import { isTurned, nativeTreeToUi } from "../../../../utils/ui-orientation";
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

/**
 * The two caveats above, re-addressed to the provider that owns the device:
 * their remedy (`boot-device force=true`) is refused on one, so telling an
 * agent to reboot it is a dead end. Same blind/standing split, different
 * audience.
 */
function externalCaveat(deviceId: string, body: string): string {
  return `${externalSupportHint(deviceId) ?? "This device is supplied by an external provider."} ${body}`;
}

const EXTERNAL_BLIND_TAIL =
  ", and argent cannot reboot this device to apply the pre-boot accessibility settings. Restart it " +
  "from that application, or take a screenshot to see the screen.";

const EXTERNAL_BLIND_BODY = `The accessibility read returned no elements${EXTERNAL_BLIND_TAIL}`;

const EXTERNAL_STANDING_BODY =
  "System dialogs and native modals may not appear in this tree; everything else reads normally. " +
  "Argent cannot reboot this device to apply the full accessibility settings — restart it from that " +
  "application if something you expect is missing.";

/**
 * Which caveat a hint carries, in either wording. The provider's version names
 * the provider, so there is no single constant to compare against, but its body
 * is fixed. Without this, a provider's device is the one device told the
 * standing caveat on every call.
 */
function isStandingCaveat(hint: string | undefined): boolean {
  return hint === DEGRADED_STANDING_HINT || Boolean(hint?.endsWith(EXTERNAL_STANDING_BODY));
}

function isBlindCaveat(hint: string | undefined): boolean {
  return hint === DEGRADED_BLIND_HINT || Boolean(hint?.endsWith(EXTERNAL_BLIND_BODY));
}

function startFailure(err: unknown): string {
  return `The accessibility service failed to start (${errMsg(err)})`;
}

// The blind caveat for a daemon that never came up, appended to the failure
// above. No read took place, so it does not say that one returned no elements,
// and it has no blank-screen exception, which is about a read. The reboot stays
// worth one attempt: the boot is the one thing known to be wrong with this sim.
// The last sentence is the exit for a start that fails before the boot state is
// measured, where the caveat would otherwise come back after every reboot.
const DEGRADED_START_FAILED_TAIL =
  ", and this simulator was not booted through argent, so the pre-boot accessibility settings were " +
  "never applied. Call boot-device with force=true to reboot it with those settings — this restarts " +
  "the simulator. If it fails to start again after that reboot, do not reboot again: the boot was " +
  "not the cause.";

// A daemon that a fault signal killed says nothing about how the simulator was
// booted, so it must not be reported as the boot caveat. On a host where it
// crashes every time (#800: SIGSEGV on every attach on Intel Macs) the reboot
// that caveat prescribes starts the same binary into the same crash, and an
// agent that obeyed it rebooted a healthy simulator without end. Restarting the
// tool-server does the same and cuts off every agent that shares it. The hint
// rules both out by name, because both are what an agent tries next.
//
// One crash does not show that the next read crashes too, and every read starts
// the daemon again, so the hint makes its repeat the test instead of claiming a
// permanent fault from one observation.
//
// Never deduped, unlike DEGRADED_STANDING_HINT: it reports this read's own
// failure, the agent has to be able to see it repeat, and the tree that comes
// with it is empty or is the native fallback's, which can lack a system dialog
// that covers the screen.
function axCrashHint(signal: string): string {
  return (
    `The accessibility service (ax-service) crashed with ${signal}, so the accessibility tree could not be read. ` +
    "Every describe starts the service again. If this hint repeats, the crash is in the service on " +
    "this host: rebooting the simulator (boot-device with force=true) or restarting the tool-server " +
    "will not fix it, because both start the same binary again. While it crashes, system dialogs and " +
    "SpringBoard chrome cannot be read through describe. describe continues on the app's native view " +
    "hierarchy where that is available, and `screenshot` shows the rest."
  );
}

const NATIVE_FALLBACK_LEAD =
  "The native fallback has no tree for this read, for a reason of its own, unrelated to the crash:";

// Devices already told DEGRADED_STANDING_HINT. Not cleared on shutdown or
// disposal — the externally-booted state outlives any one service instance —
// but cleared per device when a read comes back off that state, so a later
// external boot of the same udid is caveated again.
const bootCaveatToldDevices = new Set<string>();

/**
 * What a read learned beside its result. Kept beside the result and not on it:
 * the tree data is a contract every platform shares, and only the dedupe below
 * asks.
 */
interface IosReadFacts {
  /** How the sim was booted, as measured; undefined when nothing measured it. */
  degraded?: boolean;
  /** The daemon crashed or never started, so no read took place. */
  daemonGone?: boolean;
  /** An Apple TV, whose focus tree is not framed on a turned screen. */
  tvOs?: boolean;
  /** The interface orientation the accessibility read reported with its tree. */
  uiOrientation?: UiOrientation;
  /**
   * The accessibility read answered. Without an orientation, the daemon could
   * not name it or predates it, and asking it again would only repeat the walk.
   */
  axAnswered?: boolean;
}

const readFacts = new WeakMap<DescribeTreeData, IosReadFacts>();

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
  if (!isStandingCaveat(data.hint)) {
    // A read that is not degraded at all means the caveat no longer describes
    // this device, so a later external boot has to be able to say it again. The
    // blind caveat is the same degraded state read blind, so it does not reset.
    //
    // A read whose daemon was gone has a hint that is neither caveat, on a sim
    // booted either way, so there the answer is what the factory measured. Only
    // a sim measured as booted through argent is off the degraded state.
    const facts = readFacts.get(data);
    const stillDegraded = facts?.daemonGone ? facts.degraded !== false : isBlindCaveat(data.hint);
    if (!stillDegraded) bootCaveatToldDevices.delete(deviceId);
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

/**
 * The only shape in which the fallback can run on a device we did not boot.
 */
function lendsNativeDevtools(deviceId: string): boolean {
  const external = findExternalDevice(deviceId);
  return Boolean(external?.capabilities.has("native-devtools") && external.nativeDevtools);
}

interface DescribeIosParams {
  bundleId?: string;
}

interface DescribeIosOptions {
  // Pre-resolved tvOS verdict, so poll/retry callers don't re-shell `xcrun` each
  // iteration. Omitted callers probe once.
  isTvOs?: boolean;
  // `native` leaves the frames in the screen's portrait-native space, for the
  // preview page, which draws them over the native video stream. Everything
  // else, and every agent, gets the UI's upright space (see `toUprightFrames`).
  frameSpace?: "upright" | "native";
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
  const facts: IosReadFacts = {};
  const data = await readIos(registry, device, params, options, facts);
  readFacts.set(data, facts);
  if (options.frameSpace !== "native" && !facts.tvOs) {
    await toUprightFrames(data, device, facts);
  }
  return data;
}

/**
 * Turn the frames of an iOS simulator read from the screen's portrait-native
 * space into the UI's upright one, the space screenshots come in and touches
 * are taken in (`utils/ios-ui-orientation.ts`). Both sources frame on the
 * native axes: the ax-service, and the native-devtools fallback.
 *
 * The orientation is the one the accessibility read reported with its tree,
 * else a read of its own (the daemon may have been down for the tree). When
 * neither names it the frames stay native, and the hint says so. In place, so
 * the read facts keyed on `data` still find it.
 */
async function toUprightFrames(
  data: DescribeTreeData,
  device: DeviceInfo,
  facts: IosReadFacts
): Promise<void> {
  let orientation = facts.uiOrientation;
  if (orientation === undefined) {
    if (facts.axAnswered || data.tree.children.length === 0) return;
    // The daemon that would name it did not come up for this read; starting it
    // again here would only repeat the failure the hint already reports.
    const read = facts.daemonGone
      ? { unknownReason: "the accessibility service is not running" }
      : await readUiOrientation(device.id);
    orientation = read.orientation;
    if (orientation === undefined) {
      if (read.unknownReason === undefined) return;
      const note = unknownOrientationNote(read, "these frames are in");
      data.hint = data.hint ? `${data.hint} ${note}` : note;
      return;
    }
  }
  if (!isTurned(orientation)) return;
  data.tree = nativeTreeToUi(data.tree, orientation);
}

async function readIos(
  registry: Registry,
  device: DeviceInfo,
  params: DescribeIosParams,
  options: DescribeIosOptions,
  facts: IosReadFacts
): Promise<DescribeTreeData> {
  // The focus-engine tree is served by tv-control, not the iOS ax-service.
  const isTvOs = options.isTvOs ?? (await isTvOsSimulator(device.id));
  facts.tvOs = isTvOs;
  if (isTvOs) {
    return { tree: emptyTree(), source: "ax-service", hint: TVOS_HINT };
  }

  let tree: DescribeNode = emptyTree();
  let degraded: boolean;
  // A resolver failure that names its own cause, which outranks the boot caveat.
  let resolverHint: string | undefined;
  // The daemon came up but the read itself failed (a query timeout, an RPC
  // error). That says nothing about how the sim was booted, so it must not be
  // reported as the boot caveat — which prescribes a reboot the developer pays
  // for and that would not have helped.
  let readFailureHint: string | undefined;
  // The daemon did not come up, for a reason the two hints around this one do
  // not cover. Always reported with its error: no read took place, and why is
  // the one thing the agent can act on.
  let startFailureHint: string | undefined;
  // The daemon died on a fault signal, while it started or during the read.
  // Reported in place of the boot caveat and the read failure it would
  // otherwise come out as: see `axCrashHint`.
  let crashSignal: string | undefined;

  let axApi: AXServiceApi | undefined;
  try {
    const axRef = axServiceRef(device);
    axApi = await registry.resolveService<AXServiceApi>(axRef.urn, axRef.options);
    degraded = axApi.degraded;
    facts.degraded = degraded;
  } catch (err) {
    // Not an empty screen, and the reboot the empty tree prescribes is refused too.
    if (isFirstLaunchRefusal(err)) throw err;
    // Carry on with an empty tree so the native-devtools fallback below still
    // runs. A missing TCP-transport artifact is a config error, not a boot-state
    // one, so it must not read as degraded. Nor must a daemon that crashed.
    resolverHint = tcpArtifactHint(err);
    crashSignal = axDaemonCrashSignal(err);
    // The factory measures the boot state before it starts the daemon, so a
    // start that failed after that says which it was. Only a failure from
    // before the measurement is still taken for a sim not booted through
    // argent: taking every failed start for one prescribed the reboot again
    // after each reboot, whatever had gone wrong.
    facts.degraded = axStartFailureDegraded(err);
    const explained = resolverHint !== undefined || crashSignal !== undefined;
    degraded = !explained && facts.degraded !== false;
    if (!explained) {
      facts.daemonGone = true;
      // On a provider's device the reboot is refused, so the remedy is theirs.
      startFailureHint = !degraded
        ? `${startFailure(err)}.`
        : isExternalId(device.id)
          ? externalCaveat(device.id, `${startFailure(err)}${EXTERNAL_BLIND_TAIL}`)
          : `${startFailure(err)}${DEGRADED_START_FAILED_TAIL}`;
    }
  }

  if (axApi) {
    try {
      const response = await axApi.describe();
      facts.axAnswered = true;
      facts.uiOrientation = response.interfaceOrientation;
      noteUiOrientation(device.id, response.interfaceOrientation, response.screenFrame);
      tree = adaptAXDescribeToDescribeResult(response);
    } catch (err) {
      crashSignal = axDaemonCrashSignal(err);
      if (crashSignal === undefined) {
        readFailureHint = `The accessibility read failed (${errMsg(err)}).`;
      }
    }
  }
  const crashHint = crashSignal === undefined ? undefined : axCrashHint(crashSignal);
  if (crashHint !== undefined) facts.daemonGone = true;

  // Keyed to what the ACCESSIBILITY read produced, not to the tree finally
  // returned: the native-devtools fallback fills it from the injected app's own
  // view hierarchy, which carries no SpringBoard chrome and no system dialogs,
  // so it is no evidence the AX subsystem works.
  //
  // A crash leaves no degraded hint at all, also on a sim that was booted
  // externally: the blind caveat would say the read returned no elements, when
  // no read took place, and prescribe the reboot. A start that failed has its
  // own wording of the caveat, for the same reason.
  const degradedHint =
    !degraded || crashHint !== undefined || startFailureHint !== undefined
      ? undefined
      : tree.children.length === 0
        ? DEGRADED_BLIND_HINT
        : DEGRADED_STANDING_HINT;
  // Both degraded hints end in "boot-device with force=true", which is refused
  // on a provider's device. Keep the blind/standing split, redirect the remedy.
  // Redirected before the composition below, so the comparison still sees a
  // bare constant.
  const deviceDegradedHint =
    degradedHint !== undefined && isExternalId(device.id)
      ? externalCaveat(
          device.id,
          degradedHint === DEGRADED_BLIND_HINT ? EXTERNAL_BLIND_BODY : EXTERNAL_STANDING_BODY
        )
      : degradedHint;

  const hint =
    resolverHint ??
    crashHint ??
    startFailureHint ??
    (readFailureHint
      ? deviceDegradedHint
        ? `${deviceDegradedHint}. ${readFailureHint}`
        : readFailureHint
      : deviceDegradedHint);

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
  //
  // A daemon that crashed, or failed to start on a sim booted through argent,
  // is the other way round: no remedy brings its read of this app back, so the
  // terminal hint follows that one. Alone, it leaves the empty tree unexplained,
  // and the crash hint's "where that is available" unanswered.
  const daemonGoneHint = crashHint ?? (degraded ? undefined : startFailureHint);
  if (params.bundleId && !isInjectableBundleId(params.bundleId)) {
    return {
      tree,
      source: "ax-service",
      hint: daemonGoneHint
        ? `${daemonGoneHint} ${NON_INJECTABLE_HINT}`
        : (hint ?? NON_INJECTABLE_HINT),
    };
  }

  // Without a lent socket the fallback would inject our own dylib, which is
  // refused here. Say so rather than let that error replace describe's real
  // empty-tree result. An unexplained "no elements" reads as a bug. After a
  // daemon that is gone the same is said without the claim about the read.
  if (isExternalId(device.id) && !lendsNativeDevtools(device.id)) {
    const provider =
      externalSupportHint(device.id) ?? "This device is supplied by an external provider.";
    return {
      hint: daemonGoneHint
        ? `${daemonGoneHint} ${provider} The native view-hierarchy fallback is unavailable on it. ` +
          `Take a screenshot to see the screen.`
        : (hint ??
          `${provider} ` +
            `The native view-hierarchy fallback is unavailable on it, so an empty tree here ` +
            `means the accessibility tree itself was empty. Take a screenshot to see the screen.`),
      source: "ax-service",
      tree,
    };
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
    // remedy into a bare "could not be read". A refusal is not an unmeasured
    // app, which would be told to restart, so it goes to the outer catch.
    const state = await nativeApi.appConnectionState(target.bundleId).catch((err: unknown) => {
      if (isFirstLaunchRefusal(err)) throw err;
      return "indeterminate" as const;
    });
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
      //
      // After a crash hint the diagnosis is set apart as the fallback's own: two
      // states prescribe a tool-server restart, which that hint has just said
      // does not fix the crash, and both statements are true of their subject.
      const diagnosis = buildAppStateMessage(target.bundleId, state);
      const merged = crashHint
        ? `${crashHint} ${NATIVE_FALLBACK_LEAD} ${diagnosis}`
        : hint
          ? `${hint} ${diagnosis}`
          : diagnosis;
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
    // auto-target, an ambiguous frontmost, the query threw, or measuring the
    // app was refused because Xcode's component install is pending. That
    // refusal says nothing about the accessibility read, so it is not thrown:
    // a wait keeps polling until the tree fills, and the hint carries the
    // refusal's reason. Returning the
    // bare tree would say the screen is empty when it could not be read — and
    // `await-ui-element`'s blind-read guard keys off `hint` / `should_restart`,
    // so with neither set a `hidden` wait resolves against an element that may
    // still be on screen. Nothing was resolved here, so there is no remedy to
    // invent beyond the message the resolver already carries.
    return { tree, source: "ax-service", hint: unexplainedHint(hint, errMsg(err), params) };
  }
}

function isFirstLaunchRefusal(err: unknown): boolean {
  return getFailureSignal(err)?.error_code === FAILURE_CODES.TOOL_XCODE_FIRST_LAUNCH_PENDING;
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
