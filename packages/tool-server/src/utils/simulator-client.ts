import WebSocket from "ws";
import type { SimulatorServerApi } from "../blueprints/simulator-server";
import { toSimulatorNetworkError } from "./format-error";

const DEFAULT_SCREENSHOT_SCALE = 0.3;

const connections = new Map<string, WebSocket>();
let cmdId = 0;

function getOrCreateWs(api: SimulatorServerApi): WebSocket {
  const key = api.apiUrl;
  const existing = connections.get(key);
  if (
    existing &&
    (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)
  ) {
    return existing;
  }
  const { host } = new URL(api.apiUrl);
  const ws = new WebSocket(`ws://${host}/ws`);
  ws.on("error", () => connections.delete(key));
  ws.on("close", () => connections.delete(key));
  connections.set(key, ws);
  return ws;
}

/**
 * Send a command to the simulator-server over WebSocket.
 * Reuses a single connection per apiUrl.
 */
export function sendCommand(api: SimulatorServerApi, cmd: object): void {
  const ws = getOrCreateWs(api);
  const payload = JSON.stringify({ id: String(++cmdId), ...cmd });
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(payload);
  } else {
    ws.once("open", () => ws.send(payload));
  }
}

/**
 * POST to a simulator-server endpoint, handling network errors and non-JSON
 * responses uniformly.  Callers handle domain-specific response validation.
 */
async function simulatorPost<T>(
  toolLabel: string,
  api: SimulatorServerApi,
  endpoint: string,
  reqBody: unknown,
  signal?: AbortSignal,
  fallbackHint?: string
): Promise<{ res: Response; body: T }> {
  let res: Response;
  try {
    res = await fetch(`${api.apiUrl}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reqBody),
      signal,
    });
  } catch (err) {
    throw toSimulatorNetworkError(toolLabel, err, api.apiUrl, fallbackHint);
  }

  let body: T;
  try {
    body = (await res.json()) as T;
  } catch {
    throw new Error(
      `${toolLabel} failed: simulator-server returned non-JSON response (HTTP ${res.status}). ` +
        `The server may be in a bad state. Restart the simulator-server and retry.`
    );
  }

  return { res, body };
}

export function getScreenshotScale(): number {
  const v = process.env.ARGENT_SCREENSHOT_SCALE;
  if (v) {
    const n = parseFloat(v);
    if (!Number.isNaN(n) && n > 0 && n <= 1) return n;
  }
  return DEFAULT_SCREENSHOT_SCALE; // default: halve the resolution
}

/**
 * Take a screenshot via the simulator-server HTTP API.
 */
export async function httpScreenshot(
  api: SimulatorServerApi,
  rotation?: string,
  signal?: AbortSignal,
  scale?: number
): Promise<{ url: string; path: string }> {
  const resolvedScale = scale ?? getScreenshotScale();
  const body: Record<string, unknown> = {};
  if (rotation) body.rotation = rotation;
  if (resolvedScale !== 1.0) body.scale = resolvedScale;

  const { res, body: resBody } = await simulatorPost<{
    url?: string;
    path?: string;
    error?: string;
  }>("Screenshot", api, "/api/screenshot", body, signal);

  // Streaming-disabled / license-gated radon builds answer 200 OK with
  // {"error": "Screenshot is not available for your license plan"}, so the
  // status check alone isn't enough — surface any `error` field we get back.
  if (resBody.error) {
    throw new Error(`Screenshot failed: ${resBody.error}`);
  }
  if (!res.ok) {
    throw new Error(
      `Screenshot failed: HTTP ${res.status}. ` +
        `Ensure the simulator is booted and the simulator-server is running.`
    );
  }
  if (resBody.url == null || resBody.path == null) {
    throw new Error(
      "Screenshot failed: server response missing url or path. " +
        "The simulator-server may be misconfigured. Try restarting it."
    );
  }
  return { url: resBody.url, path: resBody.path };
}
