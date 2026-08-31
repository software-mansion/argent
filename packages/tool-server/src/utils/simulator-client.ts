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
