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

// Context cost is pixel area, so this constant is the whole lever. 0.25 measured
// as the lowest scale where Opus 5 and Haiku 4.5 both still read every label and
// selected-tab underline (#878).
const DEFAULT_SCREENSHOT_SCALE = 0.25;

// A simulator-server captures from its live frame stream, so it answers HTTP 200
// `{ error: "no image to export" }` until the first frame lands — reliably so for
// a backgrounded simulator when more than one is booted
// (https://github.com/software-mansion/argent/issues/391). Poll past that
// transient instead of surfacing it as a hard failure.
const NO_IMAGE_ERROR = /no image to export/i;
export const FIRST_FRAME_WAIT_MS = 6_000;
const FIRST_FRAME_POLL_MS = 250;

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
  paste(text: string): Promise<void> | void;
  pressKey(direction: KeyActionName, keyCode: number): void;
  screenshot(opts?: {
    rotation?: RotationName;
    scale?: number;
    signal?: AbortSignal;
  }): Promise<{ url: string; path: string }>;
}

// A command ack is a localhost round-trip behind an already-open socket: 0.06ms
// p50 / 0.17ms max, measured over 200 sends against a booted iOS sim. The budget
// is for a server that is reachable but no longer answering (a wedged device),
// not for normal latency, so it can be generous without ever being reached in a
// healthy run.
const COMMAND_ACK_TIMEOUT_MS = 5_000;

interface PendingCommand {
  settle: (err?: FailureError) => void;
  cmd: string;
}

interface Connection {
  ws: WebSocket;
  /**
   * Outstanding commands in send order. simulator-server answers in the order
   * it received them, and `sendCommand` awaits each ack, so this normally holds
   * at most one entry — the ordering matters only for an id-less reply (below)
   * when two tools drive one device at once.
   */
  pending: Map<string, PendingCommand>;
}

const connections = new Map<string, Connection>();
let cmdId = 0;

/**
 * A reply to a command. simulator-server echoes the request id on success
 * (`{"id":"7","status":"ok"}`) but NOT on failure — a rejected command answers
 * `{"status":"error","message":"parse error: unknown variant ..."}` with no id
 * at all, so an error can only be matched positionally, against the oldest
 * command still outstanding.
 */
interface CommandAck {
  id?: string;
  status?: string;
  message?: string;
}

function failAllPending(conn: Connection, makeError: (cmd: string) => FailureError): void {
  const entries = [...conn.pending.values()];
  conn.pending.clear();
  for (const entry of entries) entry.settle(makeError(entry.cmd));
}

function transportError(cmd: string, apiUrl: string, detail: string): FailureError {
  return new FailureError(
    `simulator-server did not accept the '${cmd}' command: ${detail}. ` +
      `The command was NOT delivered to the device. Check that the simulator is still booted ` +
      `and the simulator-server for ${apiUrl} is running.`,
    {
      error_code: FAILURE_CODES.SIMULATOR_COMMAND_TRANSPORT_FAILED,
      failure_stage: "simulator_command_transport",
      failure_area: "tool_server",
      error_kind: "network",
      network_failure: "connection_reset",
      failure_command: "simulator_server",
    }
  );
}

function getOrCreateConnection(api: SimulatorServerApi): Connection {
  const key = api.apiUrl;
  const existing = connections.get(key);
  if (
    existing &&
    (existing.ws.readyState === WebSocket.OPEN || existing.ws.readyState === WebSocket.CONNECTING)
  ) {
    return existing;
  }
  const { host } = new URL(api.apiUrl);
  const ws = new WebSocket(`ws://${host}/ws`);
  const conn: Connection = { ws, pending: new Map() };

  ws.on("message", (data: WebSocket.RawData) => {
    const text = Buffer.isBuffer(data)
      ? data.toString()
      : Array.isArray(data)
        ? Buffer.concat(data).toString()
        : Buffer.from(data).toString();
    let ack: CommandAck;
    try {
      ack = JSON.parse(text) as CommandAck;
    } catch {
      return; // Not a command reply; the socket carries nothing else today.
    }
    if (ack.status !== "ok" && ack.status !== "error") return;

    // A reply that names an id argent is no longer waiting on is stale — a late
    // ack for a command that already timed out. Dropping it matters: falling
    // back to positional matching here would settle whatever command is in
    // flight *now* with an answer meant for an earlier one, reintroducing the
    // phantom success this whole change exists to remove.
    if (ack.id != null && !conn.pending.has(ack.id)) return;
    // Only an id-less reply (i.e. an error) is matched positionally, against
    // the oldest outstanding command, which is what an in-order server means by it.
    const id = ack.id ?? conn.pending.keys().next().value;
    if (id == null) return;
    const entry = conn.pending.get(id);
    if (entry == null) return;
    conn.pending.delete(id);

    if (ack.status === "ok") {
      entry.settle();
      return;
    }
    entry.settle(
      new FailureError(
        `simulator-server rejected the '${entry.cmd}' command: ${ack.message ?? "unknown error"}. ` +
          `The command was NOT delivered to the device.`,
        {
          error_code: FAILURE_CODES.SIMULATOR_COMMAND_REJECTED,
          failure_stage: "simulator_command_rejected",
          failure_area: "tool_server",
          error_kind: "unknown",
          failure_command: "simulator_server",
        }
      )
    );
  });

  // A socket that dies with commands in flight is the shut-the-simulator-down
  // case: nothing was delivered, and without this the callers would hang until
  // their ack timeout instead of failing at once.
  ws.on("error", (err: Error) => {
    connections.delete(key);
    failAllPending(conn, (cmd) => transportError(cmd, key, err.message));
  });
  ws.on("close", () => {
    connections.delete(key);
    failAllPending(conn, (cmd) => transportError(cmd, key, "the connection closed"));
  });

  connections.set(key, conn);
  return conn;
}

/**
 * Send a JSON command to the simulator-server and resolve once it has been
 * acknowledged. Call sites always speak the WebSocket command shape
 * (`{cmd: "touch", ...}`); with `api.transport` set it is re-encoded onto MoQ
 * instead.
 *
 * Rejects — rather than reporting a phantom success — when the server answers
 * `status: "error"`, when the socket fails or closes with the command in
 * flight, or when no reply arrives within `COMMAND_ACK_TIMEOUT_MS`. Awaiting
 * the ack is what separates a delivered input from a lost one: every one of
 * those cases used to be indistinguishable from a landed tap
 * (https://github.com/software-mansion/argent/issues/932).
 */
export function sendCommand(api: SimulatorServerApi, cmd: Record<string, unknown>): Promise<void> {
  if (api.transport) {
    routeViaTransport(api.transport, cmd);
    return Promise.resolve();
  }
  const conn = getOrCreateConnection(api);
  const id = String(++cmdId);
  const cmdName = typeof cmd.cmd === "string" ? cmd.cmd : "unknown";
  const payload = JSON.stringify({ id, ...cmd });

  return new Promise<void>((resolve, reject) => {
    let done = false;
    const settle = (err?: FailureError) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      conn.pending.delete(id);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(
      () =>
        settleAndDropConnection(
          new FailureError(
            `simulator-server did not acknowledge the '${cmdName}' command within ` +
              `${COMMAND_ACK_TIMEOUT_MS}ms. The command may not have reached the device — ` +
              `the simulator may be wedged or the simulator-server unresponsive.`,
            {
              error_code: FAILURE_CODES.SIMULATOR_COMMAND_ACK_TIMEOUT,
              failure_stage: "simulator_command_ack",
              failure_area: "tool_server",
              error_kind: "timeout",
              network_failure: "timeout",
              failure_command: "simulator_server",
            }
          )
        ),
      COMMAND_ACK_TIMEOUT_MS
    );
    // `unref` so a pending ack never holds the process open on shutdown.
    timer.unref?.();

    // A timeout leaves the reply stream permanently out of step with `pending`:
    // the answer to this command is still owed, and once it lands nothing can
    // tell it apart from the answer to a later one. Drop the socket instead of
    // guessing — the next command reconnects, and `close` fails anything else
    // still in flight rather than leaving it to mismatch.
    const settleAndDropConnection = (err: FailureError) => {
      settle(err);
      connections.delete(api.apiUrl);
      conn.ws.close();
    };

    conn.pending.set(id, { settle, cmd: cmdName });

    const write = () =>
      conn.ws.send(payload, (err) => {
        if (err) settle(transportError(cmdName, api.apiUrl, err.message));
      });
    // A socket still CONNECTING queues the write; if it never opens, the
    // `error`/`close` handlers above fail the command instead of dropping it.
    if (conn.ws.readyState === WebSocket.OPEN) write();
    else conn.ws.once("open", write);
  });
}

/**
 * Toggle simulator-server's on-screen touch visualizer: taps, swipe/drag comet
 * trails and two-finger markers are drawn into the frame stream server-side,
 * which is what makes gestures visible in a screen recording. Returns false
 * instead of throwing, so a recording is never lost to a pointer toggle.
 */
export function setPointerVisible(
  api: SimulatorServerApi,
  show: boolean,
  signal?: AbortSignal
): Promise<boolean> {
  return pointerPost(api, { show }, signal);
}

/** Frames of comet trail left behind a moving touch. */
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
  // Remote (MoQ) sims are gated out of recording and expose no HTTP pointer
  // endpoint; their stubbed apiUrl simply makes this fetch fail and return false.
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
  /** Real elapsed recording time; null when the stop reply omitted it. */
  wallClockMs: number | null;
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
        `${JSON.stringify(body).slice(0, 200)} instead of a status. A recording an earlier ` +
        `start attempt began may still be running inside simulator-server — for example one ` +
        `whose reply was lost — and ends at its own time limit; retrying after that should succeed.`,
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
    // there is no video to hand over either way. Classified `unsupported` (a
    // route/capability problem, like the clipboard's missing-endpoint case), not
    // `not_found` — that kind means "the video file is absent" everywhere else.
    throw new FailureError(
      `screen-recording-stop failed: simulator-server no longer exposes a recording endpoint, ` +
        `so the recording in progress cannot be finalized.`,
      {
        error_code: FAILURE_CODES.SCREEN_RECORDING_OUTPUT_MISSING,
        failure_stage: "screen_recording_server_stop",
        failure_area: "tool_server",
        error_kind: "unsupported",
        failure_command: "simulator_server",
      }
    );
  }
  if (typeof body.path !== "string" || typeof body.duration_ms !== "number") {
    throw new FailureError(
      `screen-recording-stop failed: simulator-server returned a recording result missing its video ` +
        `path or duration (${JSON.stringify(body).slice(0, 200)}).`,
      {
        error_code: FAILURE_CODES.SCREEN_RECORDING_OUTPUT_MISSING,
        failure_stage: "screen_recording_server_stop",
        failure_area: "tool_server",
        error_kind: "not_found",
        failure_command: "simulator_server",
      }
    );
  }
  return {
    path: body.path,
    sizeBytes: body.size_bytes ?? 0,
    durationMs: body.duration_ms,
    wallClockMs: typeof body.wall_clock_ms === "number" ? body.wall_clock_ms : null,
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
 * one answer callers must be able to act on. A present route (per
 * software-mansion/radon#155) answers HTTP 200 with a JSON body for both
 * outcomes — success, or an in-band `{error}` — so an empty-bodied 404
 * identifies the missing route on its own.
 *
 * The body has to be part of that test, not just the status. A 404 that
 * carries one came from a handler, which means the route does exist and the
 * command was refused — falling back there would start a second capture over a
 * recording that is already running and strand the server's copy. Verified
 * against the shipped macOS simulator-server, which has no recording route:
 * `POST /api/recording/start` answers 404 with `content-length: 0`. The one
 * ambiguity this cannot resolve — a handler answering an unknown id with a bare
 * 404 — reads as "no route", which is harmless here: there is no video to hand
 * over either way, and the fallback it triggers only ever runs at start, where
 * a "route present" server would have answered 200.
 */
async function recordingPost<T extends { error?: string }>(
  api: SimulatorServerApi,
  stage: "start" | "stop",
  reqBody: unknown,
  signal?: AbortSignal
): Promise<T | null> {
  const toolLabel = `screen-recording-${stage}`;
  // A start whose request may have been received but whose reply was lost (a
  // timeout, or a generic network error) can leave a recording running inside
  // simulator-server: same story the ambiguous-reply branch tells, but reached
  // through the network path. Append it so the caller knows why the device is
  // unrecordable and that waiting out the server's own cap is the fix, rather
  // than reading a bare "the simulator may be unresponsive". `toSimulatorNetworkError`
  // adds it only to the timeout and generic messages, never to connection-
  // refused/reset — where the request never landed and no recording began.
  const startHint =
    stage === "start"
      ? "A recording an earlier start attempt began may still be running inside " +
        "simulator-server — for example one whose reply was lost — and ends at its own " +
        "time limit; retrying after that should succeed."
      : undefined;
  let res: Response;
  try {
    res = await fetch(`${api.apiUrl}/api/recording/${stage}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reqBody),
      signal,
    });
  } catch (err) {
    throw toSimulatorNetworkError(toolLabel, err, api.apiUrl, startHint);
  }

  // Read as text, so a body that never finishes arriving stays a network
  // failure instead of being flattened into "the server rejected the command".
  let raw: string;
  try {
    raw = await res.text();
  } catch (err) {
    throw toSimulatorNetworkError(toolLabel, err, api.apiUrl, startHint);
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
  if (res.ok && body === null) {
    // A 2xx from a present route always carries a JSON body — success or an
    // in-band `{error}`. An empty one is an unreadable reply, not a rejection,
    // so it is actionable the same way a non-JSON body is (restart), rather than
    // blaming the server for refusing a command it never saw. (A non-2xx empty
    // reply falls through to the rejection below, so an empty 500 still reads as
    // "HTTP 500", distinct from the empty-404 missing route handled above.)
    throw new FailureError(
      `${toolLabel} failed: simulator-server returned an empty response (HTTP ${res.status}). ` +
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
 * Put `text` on the DEVICE clipboard through simulator-server's
 * `POST /api/clipboard/text`; the host clipboard is untouched. Resolves once the
 * device pasteboard holds the text, so a paste keystroke sent afterwards cannot
 * race the fill.
 *
 * A simulator-server built without clipboard support answers the route with a
 * bare 404, reported as "unsupported" rather than as a network fault.
 */
export async function setSimulatorClipboardText(
  api: SimulatorServerApi,
  text: string,
  signal?: AbortSignal
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${api.apiUrl}/api/clipboard/text`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal,
    });
  } catch (err) {
    throw toSimulatorNetworkError("Paste", err, api.apiUrl);
  }
  if (res.status === 404) {
    throw new FailureError(
      "Paste failed: this simulator-server build has no clipboard endpoint. " +
        "Update argent so its bundled simulator-server includes clipboard support, " +
        "or type the text with the keyboard tool instead.",
      {
        error_code: FAILURE_CODES.PASTE_CLIPBOARD_UNSUPPORTED,
        failure_stage: "simulator_clipboard_endpoint_missing",
        failure_area: "tool_server",
        error_kind: "unsupported",
      }
    );
  }
  // Like the other simulator-server POST routes, this one answers HTTP 200 for
  // both outcomes and reports a failure in-band (`{ error }`).
  const body = (await res.json().catch(() => null)) as { status?: string; error?: string } | null;
  if (!res.ok || body?.status !== "ok") {
    throw new FailureError(
      `Paste failed: could not set the device clipboard (${body?.error ?? `HTTP ${res.status}`}).`,
      {
        error_code: FAILURE_CODES.PASTE_CLIPBOARD_SET_FAILED,
        failure_stage: "simulator_clipboard_set",
        failure_area: "tool_server",
        error_kind: "unknown",
      }
    );
  }
}

/**
 * POST to simulator-server, normalizing network and non-JSON failures. Callers
 * validate the body.
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
  return DEFAULT_SCREENSHOT_SCALE;
}

/**
 * Take a screenshot over the simulator-server HTTP API, or through
 * `api.transport` when set (MoQ for ios-remote); the `{ url, path }` shape is
 * the same either way.
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

    // "no image to export" means the frame stream has no first frame yet; poll
    // until it does rather than failing a fresh or backgrounded simulator.
    if (
      resBody.error &&
      NO_IMAGE_ERROR.test(resBody.error) &&
      !signal?.aborted &&
      Date.now() + FIRST_FRAME_POLL_MS < deadline
    ) {
      await sleep(FIRST_FRAME_POLL_MS);
      continue;
    }

    // Other capture failures also arrive as HTTP 200 with an `error` field (e.g.
    // Android full-resolution requests the emulator framebuffer cannot stream:
    // "wrong data size, expected X got Y"). The server answered, so surface its
    // message as a capture failure instead of the generic restart-the-server hint.
    if (resBody.error) {
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
      // Call sites speak the WebSocket protocol's snake_case second_x/second_y
      // (null when absent); the proto encoder takes optional secondX/secondY.
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
    default:
      throw new Error(`MoQ transport does not implement sendCommand cmd '${String(cmd.cmd)}'`);
  }
}

/**
 * Build a `SimulatorServerTransport` that routes touch/button/rotate/key/
 * screenshot operations over a `MoqClient`. Screenshots are written to disk to
 * match the local HTTP path's `{ url, path }` contract.
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
      // The pasteboard fill and ⌘V pair live in the caller's `pasteText`, so
      // this transport stays platform-agnostic.
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
