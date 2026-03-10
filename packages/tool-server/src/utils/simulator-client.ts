import WebSocket from "ws";
import type { SimulatorServerApi } from "../blueprints/simulator-server";

const connections = new Map<string, WebSocket>();
let cmdId = 0;

function getOrCreateWs(api: SimulatorServerApi): WebSocket {
  const key = api.apiUrl;
  const existing = connections.get(key);
  if (
    existing &&
    (existing.readyState === WebSocket.OPEN ||
      existing.readyState === WebSocket.CONNECTING)
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
 * Fetch the iOS accessibility element tree via the simulator-server HTTP API.
 * Returns normalized [0,1] frame coordinates matching the touch coordinate space.
 */
export async function httpDescribe(
  api: SimulatorServerApi,
  signal?: AbortSignal
): Promise<unknown> {
  const res = await fetch(`${api.apiUrl}/api/ui/describe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal,
  });
  const body = (await res.json()) as { error?: string } & Record<string, unknown>;
  if (!res.ok || body.error) throw new Error(body.error ?? `describe ${res.status}`);
  return body;
}

/**
 * Take a screenshot via the simulator-server HTTP API.
 */
export async function httpScreenshot(
  api: SimulatorServerApi,
  rotation?: string,
  signal?: AbortSignal
): Promise<{ url: string; path: string }> {
  const res = await fetch(`${api.apiUrl}/api/screenshot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rotation ? { rotation } : {}),
    signal,
  });
  const body = (await res.json()) as {
    url?: string;
    path?: string;
    error?: string;
  };
  if (!res.ok) throw new Error(body.error ?? `screenshot ${res.status}`);
  if (body.url == null || body.path == null) {
    throw new Error("screenshot response missing url or path");
  }
  return { url: body.url, path: body.path };
}
