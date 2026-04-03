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

  if (options?.deviceId) {
    const filtered = candidates.filter((t) => t.reactNative?.logicalDeviceId === options.deviceId);
    if (filtered.length) candidates = filtered;
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
