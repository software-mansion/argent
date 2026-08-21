import WebSocket from "ws";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { SimulatorServerApi } from "../blueprints/simulator-server";
import { toSimulatorNetworkError } from "./format-error";
import { sleep } from "./timing";
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

// A simulator-server captures screenshots from its live frame stream, so the
// first frame must have arrived before a capture can succeed. Right after the
// server starts streaming it replies HTTP 200 `{ error: "no image to export" }`
// until that first frame lands — typically ~0.5-1s, and reliably so for a
// backgrounded simulator when more than one is booted (the regression in
// https://github.com/software-mansion/argent/issues/391). Poll past that
// transient instead of surfacing it as a hard failure.
const NO_IMAGE_ERROR = /no image to export/i;
export const FIRST_FRAME_WAIT_MS = 6_000;
const FIRST_FRAME_POLL_MS = 250;

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
 * Toggle simulator-server's on-screen touch visualizer (its "pointer" overlay).
 * When on, every touch argent sends is drawn into the frame stream server-side —
 * a pulse for a tap, a comet trail for a swipe/drag, two markers for a two-finger
 * pinch/rotate — which is what makes those gestures visible in a screen
 * recording. Needs the streaming/pointer simulator-server build (the bundled
 * argent one has it). Best-effort: returns false instead of throwing, so a
 * recording is never lost to a pointer toggle.
 */
export function setPointerVisible(
  api: SimulatorServerApi,
  show: boolean,
  signal?: AbortSignal
): Promise<boolean> {
  return pointerPost(api, { show }, signal);
}

/** Length of the fading comet trail behind a moving touch (0 disables it). */
export function setPointerTrail(
  api: SimulatorServerApi,
  trail: number,
  signal?: AbortSignal
): Promise<boolean> {
  return pointerPost(api, { trail }, signal);
}

async function pointerPost(
  api: SimulatorServerApi,
  body: { show: boolean } | { trail: number },
  signal?: AbortSignal
): Promise<boolean> {
  // Remote (MoQ) sims expose no HTTP pointer endpoint; recording gates them out,
  // so the stubbed apiUrl simply makes this fetch fail and return false.
  try {
    const res = await fetch(`${api.apiUrl}/api/pointer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) return false;
    const parsed = (await res.json().catch(() => null)) as {
      status?: string;
      error?: string;
    } | null;
    return parsed?.status === "ok";
  } catch {
    return false;
  }
}

/** What simulator-server hands back once it has muxed a finished recording. */
export interface ServerRecordingResult {
  /** Path to the mp4 on the simulator-server host (its session media dir). */
  path: string;
  sizeBytes: number;
  /** Length of the video, i.e. what static trimming left. */
  durationMs: number;
  /** Real elapsed recording time. */
  wallClockMs: number;
  /** Wall-clock time trimming removed; null when trimming was off or never applied. */
  trimmedMs: number | null;
  warning: string | null;
}

/**
 * Start recording the device screen inside simulator-server: it taps the frames
 * it already encodes for the live stream (touch overlay included), paces them
 * onto a constant 30fps timeline, trims static stretches and stamps the
 * watermark, then muxes an h264 mp4 when `stopServerRecording` is called.
 *
 * Returns the id simulator-server keys the recording to; `stopServerRecording`
 * has to present it, so a second client sharing this server cannot collect (and
 * end) a recording it did not start.
 *
 * Returns null when this build exposes no recording route (HTTP 404), so the
 * caller can fall back to capturing the frame stream itself. The route is
 * compiled out of the software-encoder builds, and absent from every
 * simulator-server predating it — including the one argent currently pins — so
 * the fallback is the common case, not an edge one.
 */
export async function startServerRecording(
  api: SimulatorServerApi,
  opts: { watermark: boolean; trimStatic: boolean; timeLimitSeconds: number },
  signal?: AbortSignal
): Promise<string | null> {
  const body = await recordingPost<{ status?: string; id?: string; error?: string }>(
    api,
    "start",
    {
      watermark: opts.watermark,
      trim_static: opts.trimStatic,
      time_limit_secs: opts.timeLimitSeconds,
    },
    signal
  );
  if (body === null) return null;
  if (body.status !== "ok" || typeof body.id !== "string") {
    // Neither the success reply nor a recognized rejection, so whether a
    // recording is now running is unknown — and a success without an id is no
    // better, since nothing could ever stop it. Fail instead of falling back: a
    // second capture over one that did start would record the screen twice and
    // strand the server's copy with nothing left to stop it.
    throw new FailureError(
      `screen-recording-start failed: simulator-server answered the recording command with ` +
        `${JSON.stringify(body).slice(0, 200)} instead of a status.`,
      {
        error_code: FAILURE_CODES.SCREEN_RECORDING_PROCESS_ERROR,
        failure_stage: "screen_recording_server_start",
        failure_area: "tool_server",
        error_kind: "unknown",
        failure_command: "simulator_server",
      }
    );
  }
  return body.id;
}

/**
 * Finalize the recording {@link startServerRecording} began, identified by the
 * id it returned. simulator-server refuses a stop that names anything else.
 */
export async function stopServerRecording(
  api: SimulatorServerApi,
  id: string,
  signal?: AbortSignal
): Promise<ServerRecordingResult> {
  const body = await recordingPost<{
    path?: string;
    size_bytes?: number;
    duration_ms?: number;
    wall_clock_ms?: number;
    trimmed_ms?: number | null;
    warning?: string | null;
    error?: string;
  }>(api, "stop", { id }, signal);
  if (body === null) {
    // `serverStop` is only ever stamped by a start that the route answered, so
    // the same server answering 404 now means it stopped serving that route
    // mid-recording. Never observed; handled rather than falling back, because
    // there is no video to hand over either way.
    throw new FailureError(
      `screen-recording-stop failed: simulator-server no longer exposes a recording endpoint, ` +
        `so the recording in progress cannot be finalized.`,
      {
        error_code: FAILURE_CODES.SCREEN_RECORDING_OUTPUT_MISSING,
        failure_stage: "screen_recording_server_stop",
        failure_area: "tool_server",
        error_kind: "not_found",
        failure_command: "simulator_server",
      }
    );
  }
  if (typeof body.path !== "string" || typeof body.duration_ms !== "number") {
    throw new FailureError(
      `screen-recording-stop failed: simulator-server returned a recording result with no video ` +
        `path (${JSON.stringify(body).slice(0, 200)}).`,
      {
        error_code: FAILURE_CODES.SCREEN_RECORDING_OUTPUT_MISSING,
        failure_stage: "screen_recording_server_stop",
        failure_area: "tool_server",
        error_kind: "not_found",
      }
    );
  }
  return {
    path: body.path,
    sizeBytes: body.size_bytes ?? 0,
    durationMs: body.duration_ms,
    wallClockMs: body.wall_clock_ms ?? body.duration_ms,
    trimmedMs: body.trimmed_ms ?? null,
    warning: body.warning ?? null,
  };
}

/**
 * POST a recording command, returning null when the route does not exist.
 *
 * Deliberately not `simulatorPost`: a build without the recording feature has
 * no route at all, so its answer comes from the router's unmatched-route
 * fallback — 404 with an empty body, which that helper would surface as
 * "non-JSON response", indistinguishable from a server in a bad state and the
 * one answer callers must be able to act on. Every failure a recording handler
 * reports for itself comes back as HTTP 200 carrying an `error` field, so an
 * empty-bodied 404 identifies the missing route on its own.
 *
 * The body has to be part of that test, not just the status. A 404 that
 * carries one came from a handler, which means the route does exist and the
 * command was refused — falling back there would start a second capture over a
 * recording that is already running and strand the server's copy. Verified
 * against the shipped macOS simulator-server, which has no recording route:
 * `POST /api/recording/start` answers 404 with `content-length: 0`.
 */
async function recordingPost<T extends { error?: string }>(
  api: SimulatorServerApi,
  stage: "start" | "stop",
  reqBody: unknown,
  signal?: AbortSignal
): Promise<T | null> {
  const toolLabel = `screen-recording-${stage}`;
  let res: Response;
  try {
    res = await fetch(`${api.apiUrl}/api/recording/${stage}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reqBody),
      signal,
    });
  } catch (err) {
    throw toSimulatorNetworkError(toolLabel, err, api.apiUrl);
  }

  // Read as text, so a body that never finishes arriving stays a network
  // failure instead of being flattened into "the server rejected the command".
  let raw: string;
  try {
    raw = await res.text();
  } catch (err) {
    throw toSimulatorNetworkError(toolLabel, err, api.apiUrl);
  }
  if (res.status === 404 && raw.trim() === "") return null;

  let body: T | null = null;
  if (raw.trim() !== "") {
    try {
      body = JSON.parse(raw) as T;
    } catch {
      throw new FailureError(
        `${toolLabel} failed: simulator-server returned non-JSON response (HTTP ${res.status}). ` +
          `The server may be in a bad state. Restart the simulator-server and retry.`,
        {
          error_code: FAILURE_CODES.SIMULATOR_NON_JSON_RESPONSE,
          failure_stage: "simulator_server_parse_response",
          failure_area: "tool_server",
          error_kind: "network",
          network_failure: "invalid_response",
        }
      );
    }
  }
  if (!res.ok || !body || body.error) {
    throw new FailureError(
      `${toolLabel} failed: simulator-server rejected the recording command ` +
        `(HTTP ${res.status}${body?.error ? `: ${body.error}` : ""}).`,
      {
        error_code: FAILURE_CODES.SCREEN_RECORDING_PROCESS_ERROR,
        failure_stage: `screen_recording_server_${stage}`,
        failure_area: "tool_server",
        error_kind: "unknown",
        failure_command: "simulator_server",
      }
    );
  }
  return body;
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
    throw new FailureError(
      `${toolLabel} failed: simulator-server returned non-JSON response (HTTP ${res.status}). ` +
        `The server may be in a bad state. Restart the simulator-server and retry.`,
      {
        error_code: FAILURE_CODES.SIMULATOR_NON_JSON_RESPONSE,
        failure_stage: "simulator_server_parse_response",
        failure_area: "tool_server",
        error_kind: "network",
        network_failure: "invalid_response",
      }
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

  const deadline = Date.now() + FIRST_FRAME_WAIT_MS;
  for (;;) {
    const { res, body: resBody } = await simulatorPost<{
      url?: string;
      path?: string;
      error?: string;
    }>("Screenshot", api, "/api/screenshot", body, signal);

    if (!res.ok) {
      const serverMsg = resBody.error ?? `HTTP ${res.status}`;
      throw new FailureError(
        `Screenshot failed: ${serverMsg}. ` +
          `Ensure the simulator is booted and the simulator-server is running.`,
        {
          error_code: FAILURE_CODES.SIMULATOR_HTTP_ERROR_RESPONSE,
          failure_stage: "simulator_screenshot_http_response",
          failure_area: "tool_server",
          error_kind: "network",
          network_failure: "invalid_response",
        }
      );
    }
    if (resBody.url != null && resBody.path != null) {
      return { url: resBody.url, path: resBody.path };
    }

    // HTTP 200 with no url/path. A "no image to export" means the frame stream
    // hasn't produced its first frame yet; poll until it does (or the deadline
    // passes) rather than failing a freshly-spawned or backgrounded simulator.
    if (
      resBody.error &&
      NO_IMAGE_ERROR.test(resBody.error) &&
      !signal?.aborted &&
      Date.now() + FIRST_FRAME_POLL_MS < deadline
    ) {
      await sleep(FIRST_FRAME_POLL_MS);
      continue;
    }

    // Other HTTP-200 capture failures carry an `error` field rather than a
    // non-2xx status (e.g. Android full-resolution requests that exceed what
    // the emulator framebuffer can stream: "wrong data size, expected X got
    // Y"). Surface that message instead of the misleading generic hint so the
    // real cause is visible rather than sending callers to restart a perfectly
    // healthy server.
    if (resBody.error) {
      // HTTP 200 with an in-band `error` field: the server was reachable and
      // answered, so this is a server-reported capture failure, not a transport
      // problem — classify it as such rather than as a network error.
      throw new FailureError(`Screenshot failed: ${resBody.error}.`, {
        error_code: FAILURE_CODES.SIMULATOR_SCREENSHOT_FAILED,
        failure_stage: "simulator_screenshot_error_field",
        failure_area: "tool_server",
        error_kind: "unknown",
      });
    }
    throw new FailureError(
      "Screenshot failed: server response missing url or path. " +
        "The simulator-server may be misconfigured. Try restarting it.",
      {
        error_code: FAILURE_CODES.SIMULATOR_MISSING_RESPONSE_FIELDS,
        failure_stage: "simulator_screenshot_response_shape",
        failure_area: "tool_server",
        error_kind: "network",
        network_failure: "invalid_response",
      }
    );
  }
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
