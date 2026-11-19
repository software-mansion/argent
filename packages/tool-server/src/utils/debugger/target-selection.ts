import { createHash } from "node:crypto";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import { MACOS_APP_ID_PREFIX, resolveDevice } from "../device-info";
import { listIosSimulators } from "../ios-devices";
import type { CDPTarget } from "./discovery";

interface SelectedTarget {
  target: CDPTarget;
  webSocketUrl: string;
  isNewDebugger: boolean;
  /**
   * Served by the legacy Hermes inspector, whose -32601 means the method does
   * not exist, not that a modern host has no JS instance yet. Not
   * `!isNewDebugger`: the experimental bridge page is a modern host on the old
   * frontend.
   */
  legacyInspector: boolean;
  deviceName: string;
}

/**
 * Identify the device a target belongs to.
 *
 * Legacy targets (RN 0.72 / Vega) carry no `reactNative` block, so fall back to
 * the `device` index the proxy puts in the debugger URL — unique per attached
 * device. deviceName is last resort: it names a device *class* ("kepler-device"
 * for every VVD), so two identical devices would collapse into one.
 */
function deviceKey(target: CDPTarget): string | undefined {
  const logicalId = target.reactNative?.logicalDeviceId;
  if (logicalId) return logicalId;
  try {
    const device = new URL(target.webSocketDebuggerUrl).searchParams.get("device");
    if (device) return `device=${device}`;
  } catch {
    // Malformed URL — fall through to the name.
  }
  return target.deviceName;
}

/**
 * The bundle id of the Mac app whose runtime a target is, or undefined for
 * any other target.
 *
 * React Native's Apple inspector registers its device as the first 40 hex
 * digits of `sha256("apple-<identifierForVendor>-<bundle id>-<fusebox|legacy>")`.
 * A Mac has no identifierForVendor, and react-native-macos 0.76 and later
 * leave it empty, so a Mac app's id follows from its bundle id alone. An iOS
 * app's id holds a vendor id argent cannot know, so it never matches.
 */
function macosAppBundleIdOf(target: CDPTarget): string | undefined {
  const logicalId = target.reactNative?.logicalDeviceId;
  const bundleId = target.appId ?? target.description;
  if (!logicalId || !bundleId) return undefined;
  for (const mode of ["fusebox", "legacy"]) {
    const id = createHash("sha256").update(`apple--${bundleId}-${mode}`).digest("hex").slice(0, 40);
    if (id === logicalId) return bundleId;
  }
  return undefined;
}

/** How a device reads in a target list for the agent. */
function describeDevice(target: CDPTarget): string {
  const macBundleId = macosAppBundleIdOf(target);
  const logicalId = target.reactNative?.logicalDeviceId;
  if (macBundleId) return `Mac app ${macBundleId} (${logicalId})`;
  return logicalId
    ? `${target.deviceName ?? "unknown"} (${logicalId})`
    : `${target.deviceName ?? "unknown"} (legacy inspector — no logicalDeviceId)`;
}

/** Each device Metro lists, keyed by {@link deviceKey}, as it reads for the agent. */
function metroDevices(pool: CDPTarget[]): Map<string, string> {
  const devices = new Map<string, string>();
  for (const t of pool) {
    const key = deviceKey(t);
    if (key && !devices.has(key)) devices.set(key, describeDevice(t));
  }
  return devices;
}

/** The targets of the one Metro device that reports `name`; undefined when none or several do. */
function targetsOfOnlyDeviceNamed(
  pool: CDPTarget[],
  name: string | undefined
): CDPTarget[] | undefined {
  if (name === undefined) return undefined;
  const named = pool.filter((t) => t.deviceName === name);
  return new Set(named.map(deviceKey)).size === 1 ? named : undefined;
}

/**
 * The name of the booted local iOS simulator `deviceId` names, for a Metro that
 * lists several devices. Metro never sees a UDID, only the name the app
 * reports, so {@link selectTarget} matches on that name. Undefined when another
 * booted simulator has the same name.
 */
export async function simulatorNameOnSharedMetro(
  deviceId: string,
  targets: CDPTarget[]
): Promise<string | undefined> {
  const device = resolveDevice(deviceId);
  if (device.platform !== "ios" || device.kind !== "simulator") return undefined;
  if (metroDevices(targets).size < 2) return undefined;
  const simulators = await listIosSimulators().catch(() => []);
  const booted = simulators.filter((sim) => sim.state === "Booted");
  const name = booted.find((sim) => sim.udid === deviceId)?.name;
  if (name === undefined) return undefined;
  return booted.filter((sim) => sim.name === name).length === 1 ? name : undefined;
}

/**
 * The runtime of the Mac app a `macos-app-<bundle id>` names. A Mac app's
 * inspector id follows from its bundle id (see `macosAppBundleIdOf`), so the
 * match is exact, and with no match there is no runtime to fall back to: the
 * one device Metro lists is then another app.
 */
function macosAppTargets(pool: CDPTarget[], bundleId: string, port: number): CDPTarget[] {
  // Launch Services treats bundle ids as case-insensitive.
  const own = pool.filter((t) => macosAppBundleIdOf(t)?.toLowerCase() === bundleId.toLowerCase());
  if (own.length) return own;
  const devices = metroDevices(pool);
  throw new FailureError(
    `No JS runtime of the Mac app ${bundleId} is connected to Metro on port ${port}. ` +
      `Metro lists: ${[...devices.values()].join(", ")}. ` +
      `If the app does not run, start it (launch-app), wait a few seconds for the bundle ` +
      `to load, then retry. Otherwise the app must be a Debug build of react-native-macos ` +
      `0.76 or later that loads its bundle from this Metro; a Release build has no JS ` +
      `debugger. If the app uses another Metro, pass that port.`,
    {
      error_code: FAILURE_CODES.DEBUGGER_TARGET_DEVICE_MISMATCH,
      failure_stage: "debugger_select_target",
      failure_area: "tool_server",
      error_kind: "not_found",
    }
  );
}

/** logicalDeviceIds Metro has ever listed in this process. */
const seenLogicalDeviceIds = new Set<string>();

export function selectTarget(
  targets: CDPTarget[],
  port: number,
  options?: Record<string, unknown>
): SelectedTarget {
  // discoverMetro already dropped the legacy proxy's `vm: "don't use"` decoy,
  // so every target here is a real runtime.
  const pool = targets;
  for (const t of pool) {
    const id = t.reactNative?.logicalDeviceId;
    if (id) seenLogicalDeviceIds.add(id);
  }
  let candidates = pool;

  // By the prefix alone, as the capability gate classifies the id, so that a
  // Mac app id with a bundle id macOS does not accept takes no fallback either.
  const macosBundleId =
    typeof options?.deviceId === "string" && options.deviceId.startsWith(MACOS_APP_ID_PREFIX)
      ? options.deviceId.slice(MACOS_APP_ID_PREFIX.length)
      : null;
  if (macosBundleId !== null) {
    candidates = macosAppTargets(pool, macosBundleId, port);
  } else if (typeof options?.deviceId === "string" && options.deviceId) {
    const deviceId = options.deviceId;
    const filtered = candidates.filter((t) => t.reactNative?.logicalDeviceId === deviceId);
    const simulatorName =
      typeof options.simulatorName === "string" ? options.simulatorName : undefined;
    const sameName = targetsOfOnlyDeviceNamed(pool, simulatorName);
    if (filtered.length) {
      candidates = filtered;
    } else if (sameName) {
      candidates = sameName;
    } else {
      // Falling back to the priority target would route every unmatched
      // device_id to whichever device Metro lists first, so only fall back when
      // there is a single device; otherwise refuse to guess and report the ids.
      //
      // Count via deviceKey, not logicalDeviceId alone: a legacy device has
      // none, so a Vega device_id would count zero devices, look like "nothing
      // to disambiguate" and fall through into another device's runtime.
      const distinctDevices = metroDevices(pool);
      if (distinctDevices.size > 1) {
        // Only a logicalDeviceId is a usable device_id; a legacy device's
        // internal key would read like one without being one.
        const listed = [...distinctDevices.values()].join(", ");
        throw new FailureError(
          `No debugger target matches device_id "${deviceId}". ` +
            `${distinctDevices.size} devices are connected to Metro on port ${port}: ` +
            `${listed}. Re-target with the logicalDeviceId in parentheses — that is what ` +
            `debugger-connect returns and what subsequent debugger-* calls must pass. ` +
            `A legacy-inspector device (RN 0.72 / Vega) reports none and cannot be singled ` +
            `out of a shared Metro: give it its own Metro port.`,
          {
            error_code: FAILURE_CODES.DEBUGGER_TARGET_DEVICE_MISMATCH,
            failure_stage: "debugger_select_target",
            failure_area: "tool_server",
            error_kind: "not_found",
          }
        );
      }
      // The single-device fallback exists for UDIDs/serials Metro never echoes.
      // A logicalDeviceId we have seen before that has vanished is usually a
      // device that left; falling back would silently drive another device while
      // reporting success. It can also be the same iOS app under a new id, since
      // iOS derives the id from identifierForVendor, which a reinstall can reset.
      // Neither case can be told apart here, so the message covers both.
      if (seenLogicalDeviceIds.has(deviceId)) {
        throw new FailureError(
          `Device with logicalDeviceId "${deviceId}" is no longer attached to Metro on port ${port} — ` +
            `its app likely exited or reloaded onto another Metro. ` +
            `Not falling back to the remaining device: ${[...distinctDevices.values()].join(", ")}. ` +
            `If the app exited, relaunch it on the target device (launch-app / restart-app), then ` +
            `retry with the same id: a relaunched app keeps its logicalDeviceId. If it was ` +
            `reinstalled (reinstall-app), iOS can give it a new logicalDeviceId: when the device ` +
            `listed above is your target, retry with the id shown for it.`,
          {
            error_code: FAILURE_CODES.DEBUGGER_METRO_NO_TARGETS,
            failure_stage: "debugger_select_target",
            failure_area: "tool_server",
            error_kind: "not_found",
          }
        );
      }
    }
  }
  if (options?.deviceName) {
    const filtered = candidates.filter((t) => t.deviceName === options.deviceName);
    if (filtered.length) candidates = filtered;
  }

  const fusebox = candidates.find(
    (t) => t.reactNative?.capabilities?.prefersFuseboxFrontend === true
  );
  if (fusebox) return makeResult(fusebox, port, true, false);

  const cppConn = candidates.find((t) => t.description?.endsWith("[C++ connection]"));
  if (cppConn) return makeResult(cppConn, port, true, false);

  const bridge = candidates.find((t) => t.title?.startsWith("React Native Bridge"));
  if (bridge) return makeResult(bridge, port, false, false);

  // The legacy inspector also lists worklet runtimes (Reanimated's "Reanimated
  // UI runtime", or one named by `createWorkletRuntime`), in any order. They are
  // not the app's runtime, and an idle one leaves `Runtime.enable` unanswered,
  // so the app's runtime is picked by the title React Native registers it under.
  const hermes = candidates.find((t) =>
    LEGACY_APP_RUNTIME_TITLES.has(t.title?.replace(CXX_CONNECTION_SUFFIX, ""))
  );
  if (hermes) return makeResult(hermes, port, false, true);

  return makeResult(candidates[0]!, port, false, true);
}

/** The bridge's (`HermesExecutorFactory`) and bridgeless (`HermesInstance`) names. */
const LEGACY_APP_RUNTIME_TITLES = new Set([
  "Hermes React Native",
  "Hermes Bridgeless React Native",
]);

/** RN 0.74's opt-in C++ packager connection appends this to every page title. */
const CXX_CONNECTION_SUFFIX = / \[C\+\+ connection\]$/;

function makeResult(
  target: CDPTarget,
  port: number,
  isNewDebugger: boolean,
  legacyInspector: boolean
): SelectedTarget {
  return {
    target,
    webSocketUrl: normalizeWsUrl(target.webSocketDebuggerUrl, port),
    isNewDebugger,
    legacyInspector,
    deviceName: target.deviceName ?? target.title ?? "unknown",
  };
}

/**
 * Force the host to localhost (Android emulator returns 10.0.2.2) and the port
 * to the known Metro port (the proxy may report a wrong one).
 */
function normalizeWsUrl(wsUrl: string, port: number): string {
  const url = new URL(wsUrl);
  url.hostname = "localhost";
  url.port = port.toString();
  return url.toString();
}
