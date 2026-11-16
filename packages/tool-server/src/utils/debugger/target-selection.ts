import { FAILURE_CODES, FailureError } from "@argent/registry";
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

/** logicalDeviceIds Metro has ever listed in this process. */
const seenLogicalDeviceIds = new Set<string>();

/**
 * Formats devices for an error message. Only a logicalDeviceId is a usable
 * device_id, so a legacy device is labelled instead of showing its internal
 * key, which would read like one without being one.
 */
function listDevices(devices: Iterable<{ name?: string; logicalId?: string }>): string {
  return [...devices]
    .map((d) =>
      d.logicalId
        ? `${d.name ?? "unknown"} (${d.logicalId})`
        : `${d.name ?? "unknown"} (legacy inspector — no logicalDeviceId)`
    )
    .join(", ");
}

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

  if (typeof options?.deviceId === "string" && options.deviceId) {
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
      const distinctDevices = new Map<string, { name?: string; logicalId?: string }>();
      for (const t of pool) {
        const key = deviceKey(t);
        if (key && !distinctDevices.has(key)) {
          distinctDevices.set(key, {
            name: t.deviceName,
            logicalId: t.reactNative?.logicalDeviceId,
          });
        }
      }
      if (distinctDevices.size > 1) {
        const listed = listDevices(distinctDevices.values());
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
            `Not falling back to the remaining device: ${listDevices(distinctDevices.values())}. ` +
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
