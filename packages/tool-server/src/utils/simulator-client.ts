import WebSocket from "ws";
import { exec } from "node:child_process";
import * as path from "node:path";
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

function getSimulatorServerBinaryPath(): string {
  const dir =
    process.env.RADON_SIMULATOR_SERVER_DIR ??
    path.join(__dirname, "..", "..", "..", "..");
  return path.join(dir, "simulator-server");
}

function openAccessibilitySettings(): void {
  exec(
    'open "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility"',
  );
}

function revealBinaryInFinder(binaryPath: string): void {
  exec(`open -R "${binaryPath}"`);
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

  if (body.error === "accessibility_not_trusted") {
    const binaryPath = getSimulatorServerBinaryPath();

    openAccessibilitySettings();
    revealBinaryInFinder(binaryPath);

    throw new Error(
      `macOS Accessibility permission required.\n\n` +
      `The "describe" tool needs macOS Accessibility access to read the iOS Simulator's UI element tree.\n\n` +
      `System Settings and Finder have been opened automatically. Follow these steps:\n\n` +
      `1. In the System Settings window that opened, look for "Privacy & Security > Accessibility".\n` +
      `2. Click the "+" button at the bottom of the app list.\n` +
      `3. In the Finder file-picker, navigate to the simulator-server binary that was revealed in a separate Finder window, ` +
      `or paste this path in the Go dialog (Cmd+Shift+G in Finder):\n\n` +
      `   ${binaryPath}\n\n` +
      `4. Toggle the switch ON for "simulator-server" in the Accessibility list.\n` +
      `5. Retry the "describe" tool — it should work immediately (no restart needed).`,
    );
  }

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
