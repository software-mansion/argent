import WebSocket from "ws";
import type { SimulatorServerApi } from "../blueprints/simulator-server";
import { toSimulatorNetworkError } from "./format-error";
import {
  encodeButton,
  encodeKey,
  encodeRotate,
  encodeTouch,
  type ButtonName,
  type KeyActionName,
  type RotationName,
  type TouchActionName,
} from "./datachannel-proto";
import type { MoqClient } from "./moq-client";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const DEFAULT_SCREENSHOT_SCALE = 0.3;

/**
 * Transport-level interface every `SimulatorServerApi` produces. Local sims
 * back this with the WebSocket+HTTP client; remote sims back it with a MoQ
 * client. Keeping the high-level shape (touch/button/rotate/screenshot)
 * here means every tool call site stays transport-agnostic.
 */
export interface SimulatorServerTransport {
  touch(opts: {
    type: TouchActionName;
    x: number;
    y: number;
    secondX?: number;
    secondY?: number;
  }): void;
  button(opts: { direction: KeyActionName; button: ButtonName }): void;
  rotate(direction: RotationName): void;
  /** Multi-character text paste (host pasteboard → simulator pasteboard + Cmd+V on remote). */
  paste(text: string): Promise<void> | void;
  pressKey(direction: KeyActionName, keyCode: number): void;
  screenshot(opts?: {
    rotation?: RotationName;
    scale?: number;
    signal?: AbortSignal;
  }): Promise<{ url: string; path: string }>;
}

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
 * Send a JSON command to the simulator-server.
 *
 * On local sims this goes over the WebSocket; on remote sims (when
 * `api.transport` is set) it is routed through the MoQ-backed transport.
 * Call sites stay transport-agnostic — they always speak the WebSocket
 * command shape (`{cmd: "touch", ...}`).
 */
export function sendCommand(api: SimulatorServerApi, cmd: Record<string, unknown>): void {
  if (api.transport) {
    routeViaTransport(api.transport, cmd);
    return;
  }
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
 *
 * If the api has a `transport` field set (e.g. MoQ for ios-remote), the
 * transport's screenshot method is used instead — the response shape
 * (`{ url, path }`) is preserved either way.
 */
export async function httpScreenshot(
  api: SimulatorServerApi,
  rotation?: string,
  signal?: AbortSignal,
  scale?: number
): Promise<{ url: string; path: string }> {
  if (api.transport) {
    return api.transport.screenshot({
      rotation: rotation as RotationName | undefined,
      scale,
      signal,
    });
  }
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

function routeViaTransport(
  transport: SimulatorServerTransport,
  cmd: Record<string, unknown>
): void {
  switch (cmd.cmd) {
    case "touch": {
      // Local WebSocket protocol uses snake_case second_x/second_y (set to
      // null when absent); the proto-encoder takes optional secondX/secondY.
      const sx = (cmd.second_x ?? cmd.secondX) as number | null | undefined;
      const sy = (cmd.second_y ?? cmd.secondY) as number | null | undefined;
      transport.touch({
        type: cmd.type as TouchActionName,
        x: cmd.x as number,
        y: cmd.y as number,
        secondX: sx == null ? undefined : sx,
        secondY: sy == null ? undefined : sy,
      });
      return;
    }
    case "button":
      transport.button({
        direction: cmd.direction as KeyActionName,
        button: cmd.button as ButtonName,
      });
      return;
    case "rotate":
      transport.rotate(cmd.direction as RotationName);
      return;
    case "paste": {
      // paste() may be async on remote (pbcopy + Cmd+V); fire and forget
      // here to preserve sendCommand's sync shape. Errors land in the host
      // process's unhandledRejection logger — same as a websocket send fail.
      void Promise.resolve(transport.paste(cmd.text as string));
      return;
    }
    default:
      throw new Error(`MoQ transport does not implement sendCommand cmd '${String(cmd.cmd)}'`);
  }
}

// ── MoQ transport adapter ─────────────────────────────────────────────────

/**
 * Build a `SimulatorServerTransport` that routes touch/button/rotate/key/
 * screenshot operations over an `@moq/net`-backed `MoqClient`. Screenshots
 * are written into argent's temp dir to match the local HTTP path's
 * `{ url, path }` contract.
 */
export function createMoqTransport(
  moq: MoqClient,
  options: { pasteText: (text: string) => Promise<void> }
): SimulatorServerTransport {
  const screenshotDir = path.join(os.tmpdir(), "argent-remote-screenshots");

  const writeScreenshotToDisk = async (bytes: Buffer): Promise<{ url: string; path: string }> => {
    await fs.mkdir(screenshotDir, { recursive: true });
    const file = path.join(screenshotDir, `${randomUUID()}.png`);
    await fs.writeFile(file, bytes);
    return { url: pathToFileURL(file).toString(), path: file };
  };

  return {
    touch(opts) {
      void moq.sendControl(
        encodeTouch({
          action: opts.type,
          x: opts.x,
          y: opts.y,
          secondX: opts.secondX,
          secondY: opts.secondY,
        })
      );
    },
    button(opts) {
      void moq.sendControl(encodeButton({ action: opts.direction, button: opts.button }));
    },
    rotate(direction) {
      void moq.sendControl(encodeRotate(direction));
    },
    async paste(text) {
      // sim-remote pbcopy + Cmd+V on the remote sim. The cmd+v sequence is
      // emitted on the host via the option's pasteText callback so the
      // transport stays platform-agnostic.
      await options.pasteText(text);
    },
    pressKey(direction, keyCode) {
      void moq.sendControl(encodeKey({ action: direction, code: keyCode }));
    },
    async screenshot(opts) {
      const scale = opts?.scale ?? getScreenshotScale();
      const bytes = await moq.screenshot({ scale });
      return writeScreenshotToDisk(bytes);
    },
  };
}
