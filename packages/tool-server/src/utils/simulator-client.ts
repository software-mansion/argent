import WebSocket from "ws";
import { exec } from "node:child_process";
import type { SimulatorServerApi } from "../blueprints/simulator-server";
import { toSimulatorNetworkError } from "./format-error";
import { simulatorServerBinaryPath } from "@argent/native-devtools-ios";

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

function getSimulatorServerBinaryPath(): string {
  return simulatorServerBinaryPath();
}

function openAccessibilitySettings(): void {
  exec(
    'open "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility"'
  );
}

function revealBinaryInFinder(binaryPath: string): void {
  exec(`open -R "${binaryPath}"`);
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

const DESCRIBE_FALLBACK =
  "Fallback: use the screenshot tool to visually inspect the screen instead.";

/**
 * Fetch the iOS accessibility element tree via the simulator-server HTTP API.
 * Returns normalized [0,1] frame coordinates matching the touch coordinate space.
 */
export async function httpDescribe(
  api: SimulatorServerApi,
  signal?: AbortSignal
): Promise<unknown> {
  const { res, body } = await simulatorPost<{ error?: string } & Record<string, unknown>>(
    "Describe",
    api,
    "/api/ui/describe",
    {},
    signal,
    DESCRIBE_FALLBACK
  );

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
        `5. Retry the "describe" tool — it should work immediately (no restart needed).`
    );
  }

  if (!res.ok || body.error) {
    const serverMsg = body.error ?? `HTTP ${res.status}`;
    throw new Error(
      `Describe failed: ${serverMsg}. ` +
        `Verify the simulator is booted and an app is running. ${DESCRIBE_FALLBACK}`
    );
  }

  return body;
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

  if (!res.ok) {
    const serverMsg = resBody.error ?? `HTTP ${res.status}`;
    throw new Error(
      `Screenshot failed: ${serverMsg}. ` +
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
