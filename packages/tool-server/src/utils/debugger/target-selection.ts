import { createHash } from "node:crypto";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import { parseMacosAppBundleId } from "../device-info";
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
  const devices = new Map<string, string>();
  for (const t of pool) {
    const key = deviceKey(t);
    if (key && !devices.has(key)) devices.set(key, describeDevice(t));
  }
  throw new FailureError(
    `No JS runtime of the Mac app ${bundleId} is connected to Metro on port ${port}. ` +
      `Metro lists: ${[...devices.values()].join(", ")}. ` +
      `The app must be a Debug build of react-native-macos 0.76 or later that loads its ` +
      `bundle from this Metro; a Release build has no JS debugger. If the app uses another ` +
      `Metro, pass that port.`,
    {
      error_code: FAILURE_CODES.DEBUGGER_TARGET_DEVICE_MISMATCH,
      failure_stage: "debugger_select_target",
      failure_area: "tool_server",
      error_kind: "not_found",
    }
  );
}

export function selectTarget(
  targets: CDPTarget[],
  port: number,
  options?: Record<string, unknown>
): SelectedTarget {
  // discoverMetro already dropped the legacy proxy's `vm: "don't use"` decoy,
  // so every target here is a real runtime.
  const pool = targets;
  let candidates = pool;

  const macosBundleId =
    typeof options?.deviceId === "string" ? parseMacosAppBundleId(options.deviceId) : null;
  if (macosBundleId) {
    candidates = macosAppTargets(pool, macosBundleId, port);
  } else if (typeof options?.deviceId === "string" && options.deviceId) {
    const deviceId = options.deviceId;
    const filtered = candidates.filter((t) => t.reactNative?.logicalDeviceId === deviceId);
    if (filtered.length) {
      candidates = filtered;
    } else {
      // Falling back to the priority target would route every unmatched
      // device_id to whichever device Metro lists first, so only fall back when
      // there is a single device; otherwise refuse to guess and report the ids.
      //
      // Count via deviceKey, not logicalDeviceId alone: a legacy device has
      // none, so a Vega device_id would count zero devices, look like "nothing
      // to disambiguate" and fall through into another device's runtime.
      const distinctDevices = new Map<string, string>();
      for (const t of pool) {
        const key = deviceKey(t);
        if (key && !distinctDevices.has(key)) distinctDevices.set(key, describeDevice(t));
      }
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
