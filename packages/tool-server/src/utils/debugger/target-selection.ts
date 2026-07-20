import type { CDPTarget } from "./discovery";

export interface SelectedTarget {
  target: CDPTarget;
  webSocketUrl: string;
  isNewDebugger: boolean;
  deviceName: string;
}

/**
 * Pick the most appropriate CDP target from the Metro /json/list response.
 *
 * Selection priority (matches Argent's DebuggerTarget.ts):
 * 1. prefersFuseboxFrontend === true (RN >= 0.76 new debugger)
 * 2. description ends with "[C++ connection]"
 * 3. title starts with "React Native Bridge" (legacy)
 * 4. Fallback: first target
 */
/**
 * Identify the DEVICE a target belongs to.
 *
 * Modern (Fusebox) targets carry a logicalDeviceId. Legacy ones (RN 0.72, which
 * is what Vega/Kepler serves) carry no `reactNative` block at all, so fall back
 * to the `device` index the proxy puts in the debugger URL — that is unique per
 * attached device. deviceName is only a last resort because it names a device
 * *class*, not an instance ("kepler-device" for every VVD), so two identical
 * devices would collapse into one and defeat the guard below.
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
  // discoverMetro has already dropped the legacy proxy's unusable
  // `vm: "don't use"` page, so every target here is a real runtime.
  const pool = targets;
  let candidates = pool;

  if (typeof options?.deviceId === "string" && options.deviceId) {
    const deviceId = options.deviceId;
    const filtered = candidates.filter((t) => t.reactNative?.logicalDeviceId === deviceId);
    if (filtered.length) {
      candidates = filtered;
    } else {
      // No target matches the requested device. Silently falling back to the
      // first/priority target here would route EVERY unmatched device_id to the
      // same device — so two debugger sessions opened with different device_ids
      // would both land on whichever device Metro happens to list first. Only
      // fall back when there is a single device to fall back to; with multiple
      // distinct devices connected, refuse to guess and report the valid ids so
      // the caller can re-target (the logicalDeviceId is what debugger-connect
      // returns and what subsequent debugger-* calls must pass).
      //
      // Count devices via deviceKey, NOT logicalDeviceId alone: a legacy device
      // has none, so keying on it made those devices invisible here. A Vega
      // device_id would then match no target, count zero devices, look like
      // "nothing to disambiguate" and fall through to the priority target — i.e.
      // straight into another device's runtime (a Fusebox iOS/Android app on the
      // same Metro wins the priority list), so debugger-evaluate would run JS in
      // the wrong app.
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
        // Only a logicalDeviceId is a usable device_id, so never print the
        // internal key for a legacy device — it would read like an id the caller
        // could pass back, and it is not one.
        const listed = [...distinctDevices.values()]
          .map((d) =>
            d.logicalId
              ? `${d.name ?? "unknown"} (${d.logicalId})`
              : `${d.name ?? "unknown"} (legacy inspector — no logicalDeviceId)`
          )
          .join(", ");
        throw new Error(
          `No debugger target matches device_id "${deviceId}". ` +
            `${distinctDevices.size} devices are connected to Metro on port ${port}: ` +
            `${listed}. Re-target with the logicalDeviceId in parentheses — that is what ` +
            `debugger-connect returns and what subsequent debugger-* calls must pass. ` +
            `A legacy-inspector device (RN 0.72 / Vega) reports none and cannot be singled ` +
            `out of a shared Metro: give it its own Metro port.`
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
  if (fusebox) return makeResult(fusebox, port, true);

  const cppConn = candidates.find((t) => t.description?.endsWith("[C++ connection]"));
  if (cppConn) return makeResult(cppConn, port, true);

  const bridge = candidates.find((t) => t.title?.startsWith("React Native Bridge"));
  if (bridge) return makeResult(bridge, port, false);

  return makeResult(candidates[0]!, port, false);
}

function makeResult(target: CDPTarget, port: number, isNewDebugger: boolean): SelectedTarget {
  return {
    target,
    webSocketUrl: normalizeWsUrl(target.webSocketDebuggerUrl, port),
    isNewDebugger,
    deviceName: target.deviceName ?? target.title ?? "unknown",
  };
}

/**
 * Normalize the WebSocket URL from Metro:
 * - Rewrite hostname to localhost (Android emulator returns 10.0.2.2)
 * - Rewrite port to the known Metro port (proxy may return wrong port)
 */
function normalizeWsUrl(wsUrl: string, port: number): string {
  const url = new URL(wsUrl);
  url.hostname = "localhost";
  url.port = port.toString();
  return url.toString();
}
