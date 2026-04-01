import WebSocket from "ws";
import type { CDPTarget } from "./discovery";

export interface SelectedTarget {
  target: CDPTarget;
  webSocketUrl: string;
  isNewDebugger: boolean;
  deviceName: string;
  isExpoGo: boolean;
}

/**
 * Pick the most appropriate CDP target from the Metro /json/list response.
 *
 * Selection priority (matches Argent's DebuggerTarget.ts):
 * 1. prefersFuseboxFrontend === true (RN >= 0.76 new debugger)
 * 2. description ends with "[C++ connection]"
 * 3. title starts with "React Native Bridge" (legacy)
 * 4. Fallback: first target
 *
 * For new-debugger targets, Expo Go is detected by evaluating
 * `globalThis.__expo_hide_from_inspector__` on each candidate page.
 * Expo Go pages that return `"runtime"` are the real app runtime and are
 * flagged with `isExpoGo: true` so callers can skip the Origin header.
 */
export async function selectTarget(
  targets: CDPTarget[],
  port: number,
  options?: Record<string, unknown>
): Promise<SelectedTarget> {
  let candidates = targets;

  if (options?.deviceId) {
    const filtered = candidates.filter(
      (t) => t.reactNative?.logicalDeviceId === options.deviceId
    );
    if (filtered.length) candidates = filtered;
  }
  if (options?.deviceName) {
    const filtered = candidates.filter(
      (t) => t.deviceName === options.deviceName
    );
    if (filtered.length) candidates = filtered;
  }

  const fuseboxCandidates = candidates.filter(
    (t) => t.reactNative?.capabilities?.prefersFuseboxFrontend === true
  );
  if (fuseboxCandidates.length > 0) {
    // Multiple fusebox pages means Expo Go — probe each to find the app runtime.
    if (fuseboxCandidates.length > 1) {
      for (const candidate of [...fuseboxCandidates].reverse()) {
        const wsUrl = normalizeWsUrl(candidate.webSocketDebuggerUrl, port);
        if (await isExpoGoAppRuntime(wsUrl)) {
          return makeResult(candidate, port, true, true);
        }
      }
    }
    return makeResult(fuseboxCandidates[0]!, port, true, false);
  }

  const cppConn = candidates.find((t) =>
    t.description?.endsWith("[C++ connection]")
  );
  if (cppConn) return makeResult(cppConn, port, true, false);

  const bridge = candidates.find((t) =>
    t.title?.startsWith("React Native Bridge")
  );
  if (bridge) return makeResult(bridge, port, false, false);

  return makeResult(candidates[0]!, port, false, false);
}

/**
 * Check whether a CDP page is the Expo Go app runtime by evaluating a global
 * variable that Expo sets only on its host/infrastructure pages. If the global
 * is absent the expression returns `"runtime"`, confirming this is the app page.
 */
async function isExpoGoAppRuntime(wsUrl: string): Promise<boolean> {
  const EXPR = "(globalThis.__expo_hide_from_inspector__ || 'runtime')";
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    let settled = false;

    const done = (result: boolean) => {
      if (settled) return;
      settled = true;
      ws.close();
      resolve(result);
    };

    const timeout = setTimeout(() => done(false), 3_000);

    ws.once("open", () => {
      ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: EXPR } }));
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          id?: number;
          result?: { result?: { value?: unknown } };
        };
        if (msg.id === 1) {
          clearTimeout(timeout);
          done(msg.result?.result?.value === "runtime");
        }
      } catch {
        // ignore parse errors
      }
    });

    ws.once("error", () => { clearTimeout(timeout); done(false); });
    ws.once("close", () => { clearTimeout(timeout); done(false); });
  });
}

function makeResult(
  target: CDPTarget,
  port: number,
  isNewDebugger: boolean,
  isExpoGo: boolean,
): SelectedTarget {
  return {
    target,
    webSocketUrl: normalizeWsUrl(target.webSocketDebuggerUrl, port),
    isNewDebugger,
    deviceName: target.deviceName ?? target.title ?? "unknown",
    isExpoGo,
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
