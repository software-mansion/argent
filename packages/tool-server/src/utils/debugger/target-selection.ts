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
      const distinctDeviceIds = [
        ...new Set(
          targets
            .map((t) => t.reactNative?.logicalDeviceId)
            .filter((id): id is string => id !== undefined && id !== "")
        ),
      ];
      if (distinctDeviceIds.length > 1) {
        throw new Error(
          `No debugger target matches device_id "${deviceId}". ` +
            `${distinctDeviceIds.length} devices are connected to Metro on port ${port}: ` +
            `${distinctDeviceIds.join(", ")}. Pass one of these as device_id ` +
            `(the logicalDeviceId returned by debugger-connect).`
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
