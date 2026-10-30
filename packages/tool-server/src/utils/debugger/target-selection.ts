import { FAILURE_CODES, FailureError, type FailureCode } from "@argent/registry";
import type { CDPTarget } from "./discovery";
import type { MetroDeviceNames } from "./metro-device-name";

interface SelectedTarget {
  target: CDPTarget;
  webSocketUrl: string;
  isNewDebugger: boolean;
  deviceName: string;
  /** Whether `deviceId` itself picked the target, rather than the single-device fallback. */
  matchedDeviceId: boolean;
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

export function selectTarget(
  targets: CDPTarget[],
  port: number,
  options?: Record<string, unknown>
): SelectedTarget {
  // discoverMetro already dropped the legacy proxy's `vm: "don't use"` decoy,
  // so every target here is a real runtime.
  const pool = targets;
  let candidates = pool;
  let matchedDeviceId = false;

  if (typeof options?.deviceId === "string" && options.deviceId) {
    const deviceId = options.deviceId;
    const filtered = candidates.filter((t) => t.reactNative?.logicalDeviceId === deviceId);
    const byName = filtered.length
      ? []
      : matchByDeviceName(
          pool,
          deviceId,
          port,
          options.deviceNames as MetroDeviceNames | undefined
        );
    if (filtered.length) {
      candidates = filtered;
      matchedDeviceId = true;
    } else if (byName.length) {
      candidates = byName;
      matchedDeviceId = true;
    } else {
      // Falling back to the priority target would route every unmatched
      // device_id to whichever device Metro lists first, so only fall back when
      // there is a single device; otherwise refuse to guess and report the ids.
      //
      // Count via deviceKey, not logicalDeviceId alone: a legacy device has
      // none, so a Vega device_id would count zero devices, look like "nothing
      // to disambiguate" and fall through into another device's runtime.
      const devices = describeDevices(pool);
      if (devices.count > 1) {
        throw new FailureError(
          `No debugger target matches device_id "${deviceId}". ` +
            `${devices.count} devices are connected to Metro on port ${port}: ` +
            `${devices.listed}. Re-target with the logicalDeviceId in parentheses — that is what ` +
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
  if (fusebox) return makeResult(fusebox, port, true, matchedDeviceId);

  const cppConn = candidates.find((t) => t.description?.endsWith("[C++ connection]"));
  if (cppConn) return makeResult(cppConn, port, true, matchedDeviceId);

  const bridge = candidates.find((t) => t.title?.startsWith("React Native Bridge"));
  if (bridge) return makeResult(bridge, port, false, matchedDeviceId);

  return makeResult(candidates[0]!, port, false, matchedDeviceId);
}

/**
 * One entry per device (or, with `perApp`, per app connection) in `pool`.
 * Only a logicalDeviceId is a usable device_id; a legacy device's internal key
 * would read like one without being one, so those are flagged instead.
 */
function describeDevices(pool: CDPTarget[], perApp = false): { count: number; listed: string } {
  const distinct = new Map<string, CDPTarget>();
  for (const t of pool) {
    const key = deviceKey(t);
    if (key && !distinct.has(key)) distinct.set(key, t);
  }
  const listed = [...distinct.values()]
    .map((t) => {
      const label = perApp ? appLabel(t) : (t.deviceName ?? "unknown");
      const id = t.reactNative?.logicalDeviceId;
      return id ? `${label} (${id})` : `${label} (legacy inspector — no logicalDeviceId)`;
    })
    .join(", ");
  return { count: distinct.size, listed };
}

/**
 * The app's bundle id. Inspector-proxies before RN 0.77 list no `appId` and
 * carry the bundle id in `description` instead.
 */
function appLabel(target: CDPTarget): string {
  return target.appId || target.description || target.deviceName || "unknown";
}

/**
 * Resolve an iOS simulator UDID to its target by the device name the app
 * reported to Metro, which never sees the UDID.
 *
 * Returns the matching targets, or [] to fall back to the id-only rules, which
 * includes a same-named simulator's app being the only device on Metro.
 * Throws when the name proves the simulator's app is not on this Metro, or
 * cannot single out one target.
 */
function matchByDeviceName(
  pool: CDPTarget[],
  deviceId: string,
  port: number,
  hint: MetroDeviceNames | undefined
): CDPTarget[] {
  // Older inspector-proxies list no deviceName at all.
  if (!hint || !pool.length || !pool.every((t) => t.deviceName)) return [];
  const matched = pool.filter((t) => hint.forms.includes(t.deviceName!));
  const failure = (message: string, code: FailureCode) =>
    new FailureError(message, {
      error_code: code,
      failure_stage: "debugger_select_target",
      failure_area: "tool_server",
      error_kind: "not_found",
    });

  if (!hint.booted) {
    throw failure(
      `device_id "${deviceId}" is the simulator "${hint.name}", which is not booted, so no app ` +
        `on it can be connected to Metro on port ${port}. Boot it and launch the app, then retry.`,
      FAILURE_CODES.DEBUGGER_TARGET_DEVICE_MISMATCH
    );
  }
  if (!matched.length) {
    throw failure(
      `device_id "${deviceId}" is the simulator "${hint.name}", but no app on that simulator ` +
        `is connected to Metro on port ${port}. Connected: ${describeDevices(pool).listed}. ` +
        `Launch or reload the app on "${hint.name}", then retry. If the simulator was renamed ` +
        `since it booted, shut it down and boot it first, since an app keeps reporting the name ` +
        `its simulator booted with.`,
      FAILURE_CODES.DEBUGGER_TARGET_DEVICE_MISMATCH
    );
  }
  if (hint.bootedTwins > 0) {
    if (describeDevices(pool).count === 1) return [];
    throw failure(
      `device_id "${deviceId}" is the simulator "${hint.name}", and ${hint.bootedTwins} other ` +
        `booted simulator(s) have the same name, so Metro on port ${port} cannot tell them apart. ` +
        `Rename the simulators so each name is unique (xcrun simctl rename <udid> <name>), ` +
        `then shut down and boot each renamed simulator, since an app keeps reporting the name ` +
        `its simulator booted with. Relaunch the app, then retry.`,
      FAILURE_CODES.DEBUGGER_TARGET_DEVICE_MISMATCH
    );
  }
  const apps = describeDevices(matched, true);
  if (apps.count > 1) {
    throw failure(
      `device_id "${deviceId}" is the simulator "${hint.name}", which has ${apps.count} apps ` +
        `connected to Metro on port ${port}: ${apps.listed}. Pass the logicalDeviceId in ` +
        `parentheses of the app you mean.`,
      FAILURE_CODES.DEBUGGER_TARGET_DEVICE_MISMATCH
    );
  }
  return matched;
}

function makeResult(
  target: CDPTarget,
  port: number,
  isNewDebugger: boolean,
  matchedDeviceId: boolean
): SelectedTarget {
  return {
    target,
    webSocketUrl: normalizeWsUrl(target.webSocketDebuggerUrl, port),
    isNewDebugger,
    deviceName: target.deviceName ?? target.title ?? "unknown",
    matchedDeviceId,
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
