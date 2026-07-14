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
export function selectTarget(
  targets: CDPTarget[],
  port: number,
  options?: Record<string, unknown>
): SelectedTarget {
  let candidates = targets;

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
      // Identify a device by its logicalDeviceId, falling back to deviceName:
      // the LEGACY inspector-proxy (RN 0.72, which is what Vega/Kepler serves)
      // emits no `reactNative` block at all, so keying only on logicalDeviceId
      // makes those devices invisible here. A Vega device_id would then match no
      // target, count zero devices, look like "nothing to disambiguate" and fall
      // through to the priority target — i.e. straight into another device's
      // runtime (a Fusebox iOS/Android app on the same Metro wins the priority
      // list), so debugger-evaluate would run JS in the wrong app.
      const distinctDevices = new Map<string, string | undefined>();
      for (const t of targets) {
        const logicalId = t.reactNative?.logicalDeviceId;
        const key = logicalId || t.deviceName;
        if (key && !distinctDevices.has(key)) {
          // Only report a name alongside the key when the key is an opaque id;
          // for a legacy target the key already IS the device name.
          distinctDevices.set(key, logicalId ? t.deviceName : undefined);
        }
      }
      if (distinctDevices.size > 1) {
        const listed = [...distinctDevices.entries()]
          .map(([id, name]) => (name ? `${name} (${id})` : id))
          .join(", ");
        throw new Error(
          `No debugger target matches device_id "${deviceId}". ` +
            `${distinctDevices.size} devices are connected to Metro on port ${port}: ` +
            `${listed}. Re-target with the id of the device you want — debugger-connect ` +
            `returns it as logicalDeviceId. Devices on the legacy inspector ` +
            `(RN 0.72 / Vega) expose no logicalDeviceId and are listed by name; ` +
            `give one its own Metro port to debug it alongside another device.`
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
